import type { AppContext, Environment } from '../types'
import { isPlainObject } from '../buddies/contracts'
import {
  isEnvelopeBody,
  parseEnvelope,
  readEnvelopeText,
} from '../buddies/envelope'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import {
  ACCOUNT_LIMITS,
  handoffBlobTooLarge,
  parseHandoffClaimRequest,
  parseHandoffTokenRequest,
} from './contracts'
import {
  accountForKey,
  guarded,
  quotaName,
  refuseAtEdge,
  refuseOverDailyQuota,
  replyWith,
  verifiedBody,
  verifyEnvelope,
} from './signed'

/**
 * Set Up Another Device (witness-work `docs/accounts-protocol.md`, "Handoff"):
 * the old phone opens a channel and the new phone claims it with the token
 * from the QR code; the server relays a sealed hello one way and the sealed
 * account key the other, through one `AccountHandoff` Durable Object per
 * channel. Old-phone ops are signed by the account key and need a registered
 * account; new-phone ops are plain JSON authorized by `claimToken`.
 *
 * `handoff/open` counts against the register edge tier and 20 opens per
 * account a rolling day; every other op against the read tier.
 *
 * Privacy: nothing here logs or reports bodies, keys, tokens, account ids, or
 * channel ids.
 */

const channel = (env: Environment, channelId: string) =>
  env.ACCOUNT_HANDOFF.get(env.ACCOUNT_HANDOFF.idFromName(channelId))

/** Accounts off (no database) answers `disabled` before anything else. */
const precheck = async (
  c: AppContext,
  tier: 'inbox/register' | 'inbox/sync'
): Promise<Response | null> => {
  if (!c.env.ACCOUNTS_DB) return buddiesErrorResponse('disabled')
  return refuseAtEdge(c, tier)
}

/** The new phone's JSON body, or null for `bad_request`. */
const readJson = async (c: AppContext): Promise<unknown> => {
  const text = await readEnvelopeText(c.req.raw)
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    // Never surface the parser message: V8 quotes the offending input.
    return null
  }
}

const handleOpen = guarded('handoff/open', async (c) => {
  const refused = await precheck(c, 'inbox/register')
  if (refused) return refused
  const verified = await verifiedBody(c, 'handoff/open')
  if ('refusal' in verified) return verified.refusal
  const found = await accountForKey(c.env, verified.payload.accountPub)
  if ('refusal' in found) return found.refusal
  const overQuota = await refuseOverDailyQuota(
    c.env,
    await quotaName('handoff-open', found.account.id),
    ACCOUNT_LIMITS.handoffOpensPerDay,
    'handoff/open',
    'handoffOpensPerDay'
  )
  if (overQuota) return overQuota
  const { channelId, verifier } = verified.fields
  return replyWith(
    c,
    await channel(c.env, channelId).open({
      channelId,
      accountId: found.account.id,
      verifier,
    })
  )
})

const handleStatus = guarded('handoff/status', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const verified = await verifiedBody(c, 'handoff/status')
  if ('refusal' in verified) return verified.refusal
  const found = await accountForKey(c.env, verified.payload.accountPub)
  if ('refusal' in found) return found.refusal
  const { channelId } = verified.fields
  return replyWith(
    c,
    await channel(c.env, channelId).status(channelId, found.account.id)
  )
})

const handleSend = guarded('handoff/send', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const verified = await verifiedBody(c, 'handoff/send')
  if ('refusal' in verified) return verified.refusal
  const found = await accountForKey(c.env, verified.payload.accountPub)
  if ('refusal' in found) return found.refusal
  const { channelId, key } = verified.fields
  return replyWith(
    c,
    await channel(c.env, channelId).send(channelId, found.account.id, key)
  )
})

const handleClaim = guarded('handoff/claim', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const body = await readJson(c)
  if (handoffBlobTooLarge(body)) return buddiesErrorResponse('too_large')
  const request = parseHandoffClaimRequest(body)
  if (!request) return buddiesErrorResponse('bad_request')
  return replyWith(c, await channel(c.env, request.channelId).claim(request))
})

const handleReceive = guarded('handoff/receive', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const request = parseHandoffTokenRequest(await readJson(c))
  if (!request) return buddiesErrorResponse('bad_request')
  return replyWith(c, await channel(c.env, request.channelId).receive(request))
})

const handleDone = guarded('handoff/done', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const request = parseHandoffTokenRequest(await readJson(c))
  if (!request) return buddiesErrorResponse('bad_request')
  return replyWith(c, await channel(c.env, request.channelId).done(request))
})

/**
 * Either phone: a signed envelope (`payload`, `signature`) is the old phone, anything else
 * must be the new phone's `channelId` and `claimToken`.
 */
const handleCancel = guarded('handoff/cancel', async (c) => {
  const refused = await precheck(c, 'inbox/sync')
  if (refused) return refused
  const text = await readEnvelopeText(c.req.raw)
  let body: unknown = null
  try {
    body = text == null ? null : JSON.parse(text)
  } catch {
    body = null
  }
  if (isPlainObject(body) && isEnvelopeBody(body)) {
    const verified = await verifyEnvelope(
      'handoff/cancel',
      text == null ? null : parseEnvelope(text)
    )
    if ('refusal' in verified) return verified.refusal
    const found = await accountForKey(c.env, verified.payload.accountPub)
    if ('refusal' in found) return found.refusal
    const { channelId } = verified.fields
    return replyWith(
      c,
      await channel(c.env, channelId).cancelByAccount(
        channelId,
        found.account.id
      )
    )
  }
  const request = parseHandoffTokenRequest(body)
  if (!request) return buddiesErrorResponse('bad_request')
  return replyWith(
    c,
    await channel(c.env, request.channelId).cancelByToken(request)
  )
})

export const handoffHandlers = {
  open: handleOpen,
  claim: handleClaim,
  status: handleStatus,
  send: handleSend,
  receive: handleReceive,
  done: handleDone,
  cancel: handleCancel,
}
