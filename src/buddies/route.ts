import { Hono } from 'hono'
import type { AppContext, Environment } from '../types'
import { Sentry } from '../sentry'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import {
  BUDDIES_ALWAYS_ALLOWED_OPS,
  BUDDIES_ERROR_STATUS,
  BUDDIES_OPS,
  BUDDIES_PAYLOAD_PARSERS,
  BUDDIES_UNSIGNED_OPS,
  decodeSignature,
  ok,
  type BuddiesErrorCode,
  type BuddiesOp,
  type BuddiesPayloads,
  type BuddiesResult,
  type BuddiesSignedOp,
  type BuddiesUnsignedOp,
  type PushJob,
  type Signed,
} from './contracts'
import { parseEnvelope, readEnvelopeText, type Envelope } from './envelope'
import { isBuddiesEnabled } from './killSwitch'
import { defaultApnsDependencies, type ApnsDependencies } from '../apns'
import { deliverPushJob } from './push'

/**
 * `POST /buddies/v1/{op}` — the Buddies relay (see docs/buddies-protocol.md).
 *
 * Privacy: every id travels in the body, and nothing here logs or reports the
 * body, the payload, or any value from it. Errors are `{ "error": "<code>" }`.
 */

export interface BuddiesRouteDependencies {
  apns: ApnsDependencies
}

interface OpOutcome {
  body: Record<string, unknown>
  push?: PushJob | null
}

type Outcome = BuddiesResult<OpOutcome>

const inbox = (env: Environment, inboxId: string) =>
  env.BUDDY_INBOX.get(env.BUDDY_INBOX.idFromName(inboxId))

const invite = (env: Environment, inviteId: string) =>
  env.BUDDY_INVITE.get(env.BUDDY_INVITE.idFromName(inviteId))

const empty = (result: BuddiesResult<unknown>): Outcome =>
  result.ok ? ok({ body: {} }) : result

const withSeq = (result: BuddiesResult<{ seq: number }>): Outcome =>
  result.ok ? ok({ body: { seq: result.value.seq } }) : result

type SignedRunners = {
  [K in BuddiesSignedOp]: (
    env: Environment,
    call: Signed<BuddiesPayloads[K]>
  ) => Promise<Outcome>
}

const SIGNED_OPS: SignedRunners = {
  'inbox/register': async (env, call) =>
    empty(await inbox(env, call.inboxId).register(call)),
  'inbox/sync': async (env, call) => {
    const result = await inbox(env, call.inboxId).sync(call)
    return result.ok ? ok({ body: { ...result.value } }) : result
  },
  'inbox/delete': async (env, call) =>
    empty(await inbox(env, call.inboxId).deleteInbox(call)),
  'device/register': async (env, call) =>
    empty(await inbox(env, call.inboxId).registerDevice(call)),
  'device/unregister': async (env, call) =>
    empty(await inbox(env, call.inboxId).unregisterDevice(call)),
  'slot/add': async (env, call) =>
    empty(await inbox(env, call.inboxId).addSlot(call)),
  'slot/remove': async (env, call) =>
    empty(await inbox(env, call.inboxId).removeSlot(call)),
  'roster/put': async (env, call) =>
    withSeq(await inbox(env, call.inboxId).putRoster(call)),
  'invite/create': async (env, call) =>
    empty(await inbox(env, call.inboxId).createInvite(call)),
  'invite/delete': async (env, call) =>
    empty(await inbox(env, call.inboxId).deleteInvite(call)),
  'card/put': async (env, call) =>
    withSeq(await inbox(env, call.inboxId).putCard(call)),
  'event/put': async (env, call) => {
    const result = await inbox(env, call.inboxId).putEvent(call)
    return result.ok
      ? ok({ body: { seq: result.value.seq }, push: result.value.push })
      : result
  },
  'slot/leave': async (env, call) =>
    empty(await inbox(env, call.inboxId).leaveSlot(call)),
}

type UnsignedRunners = {
  [K in BuddiesUnsignedOp]: (
    env: Environment,
    payload: BuddiesPayloads[K]
  ) => Promise<Outcome>
}

const UNSIGNED_OPS: UnsignedRunners = {
  'invite/fetch': async (env, payload) => {
    const result = await invite(env, payload.inviteId).read(payload.inviteId)
    return result.ok ? ok({ body: { ...result.value } }) : result
  },
  'invite/claim': async (env, payload) => {
    // Only the hash crosses into the DO; it's compared in constant time there.
    const claimHash = bytesToBase64Url(await sha256Bytes(payload.claimSecret))
    const result = await invite(env, payload.inviteId).claim({
      inviteId: payload.inviteId,
      claimHash,
      blob: payload.blob,
    })
    return result.ok ? ok({ body: {}, push: result.value.push }) : result
  },
}

const isUnsignedOp = (op: BuddiesOp): op is BuddiesUnsignedOp =>
  (BUDDIES_UNSIGNED_OPS as readonly BuddiesOp[]).includes(op)

const runSigned = async <K extends BuddiesSignedOp>(
  op: K,
  env: Environment,
  envelope: Envelope
): Promise<Outcome> => {
  const payload = BUDDIES_PAYLOAD_PARSERS[op](envelope.payload, Date.now())
  if (!payload) return { ok: false, error: 'bad_request' }
  const signature = decodeSignature(envelope.signature)
  if (!signature) return { ok: false, error: 'bad_signature' }
  return SIGNED_OPS[op](env, {
    ...payload,
    payloadBytes: envelope.payloadBytes,
    signature,
  })
}

const runUnsigned = async <K extends BuddiesUnsignedOp>(
  op: K,
  env: Environment,
  envelope: Envelope
): Promise<Outcome> => {
  const payload = BUDDIES_PAYLOAD_PARSERS[op](envelope.payload, Date.now())
  if (!payload) return { ok: false, error: 'bad_request' }
  return UNSIGNED_OPS[op](env, payload)
}

const errorResponse = (c: AppContext, error: BuddiesErrorCode): Response =>
  c.json({ error }, BUDDIES_ERROR_STATUS[error])

const handleBuddiesOp = async (
  c: AppContext,
  op: BuddiesOp,
  deps: BuddiesRouteDependencies
): Promise<Response> => {
  try {
    if (
      !BUDDIES_ALWAYS_ALLOWED_OPS.has(op) &&
      !(await isBuddiesEnabled(c.env))
    ) {
      return errorResponse(c, 'disabled')
    }
    const unsigned = isUnsignedOp(op)
    if (unsigned) {
      const key = c.req.header('CF-Connecting-IP') ?? 'unknown'
      const { success } = await c.env.BUDDIES_RATE_LIMITER.limit({ key })
      if (!success) return errorResponse(c, 'rate_limited')
    }

    const text = await readEnvelopeText(c.req.raw)
    const envelope = text == null ? null : parseEnvelope(text)
    if (!envelope) return errorResponse(c, 'bad_request')

    const result = unsigned
      ? await runUnsigned(op, c.env, envelope)
      : await runSigned(op, c.env, envelope)
    if (!result.ok) return errorResponse(c, result.error)

    const { body, push } = result.value
    if (push) c.executionCtx.waitUntil(deliverPushJob(c.env, push, deps.apns))
    return c.json({ ok: true, ...body })
  } catch (error) {
    // Report the failure, never the request: bodies hold ids, keys, and blobs.
    console.error('buddies: request failed', { op })
    Sentry.captureException(error)
    return c.json({ error: 'internal' }, 500)
  }
}

/** Mounted at `/buddies/v1` by the Worker entry point. */
export const createBuddiesRoutes = (
  deps: BuddiesRouteDependencies = { apns: defaultApnsDependencies }
) => {
  const routes = new Hono<{ Bindings: Environment }>()
  for (const op of BUDDIES_OPS) {
    routes.post(`/${op}`, (c) => handleBuddiesOp(c, op, deps))
  }
  return routes
}
