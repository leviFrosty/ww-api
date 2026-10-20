import type { AppContext, Environment } from '../types'
import { bytesToBase64Url, sha256Bytes, timingSafeEqual } from '../crypto'
import { RevenueCatError } from '../revenuecat'
import { captureFailure } from '../sentry'
import { isPlainObject } from '../buddies/contracts'
import { isWebSocketUpgrade, readBlobBody } from '../buddies/envelope'
import {
  buddiesErrorResponse,
  buddiesInternalError,
} from '../buddies/errorResponse'
import { authenticateAccount, readPlainJson, type AccountAuth } from './auth'
import { guarded, refuseAtEdge } from './signed'
import { accountSupporterStatus } from './supporter'
import { accountsDb } from './store'
import {
  SYNC_ETAG_PATTERN,
  SYNC_HEADERS,
  SYNC_LIMITS,
  isSyncSlotId,
  parseIfMatch,
  syncObjectKey,
} from './syncContracts'
import { syncSwitches } from './syncSwitch'

/**
 * Cloud Sync (witness-work ADR 0030, `docs/accounts-protocol.md`, "Sync"):
 * each device of an account keeps one end-to-end encrypted snapshot in a
 * slot, and every device merges the others'. One `AccountSync` Durable
 * Object per account holds the slots' metadata and live sockets; R2
 * (`ACCOUNT_SYNC`) holds the ciphertext.
 *
 * Every route is bearer. `GET /sync` (the account's status) and
 * `sync/delete` always work; `sync/put`, `sync/list`, `sync/get`, and the
 * live socket need the kill switch on (503 `disabled`) and an entitled
 * account (403 `supporter_required`; RevenueCat unreachable is 503
 * `unavailable`, never a "not a Supporter"). A suspended account keeps
 * syncing: sync never reaches another person.
 *
 * `sync/put` counts against the Buddies write edge tier, the rest against
 * the read tier.
 *
 * Privacy: nothing here logs or reports bodies, account ids, slot ids,
 * session ids, or tokens.
 */

/** Per isolate, so a device's puts don't each read D1 (or RevenueCat). */
const ENTITLEMENT_CACHE_MS = 60_000
const ENTITLEMENT_CACHE_ENTRIES = 1_000
const supporterCache = new Map<string, { supporter: boolean; at: number }>()

/** Clears the per-isolate Supporter cache (tests). */
export const resetSyncEntitlementCache = (): void => supporterCache.clear()

const cachedSupporter = async (
  env: Environment,
  accountId: string
): Promise<boolean> => {
  const now = Date.now()
  const cached = supporterCache.get(accountId)
  if (cached && now - cached.at < ENTITLEMENT_CACHE_MS) return cached.supporter
  const { supporter } = await accountSupporterStatus(
    env,
    accountsDb(env.ACCOUNTS_DB!),
    accountId
  )
  supporterCache.delete(accountId)
  if (supporterCache.size >= ENTITLEMENT_CACHE_ENTRIES)
    supporterCache.delete(supporterCache.keys().next().value!)
  supporterCache.set(accountId, { supporter, at: now })
  return supporter
}

/** The account's sync index. */
const syncIndex = (env: Environment, accountId: string) =>
  env.ACCOUNT_SYNC_INDEX.get(env.ACCOUNT_SYNC_INDEX.idFromName(accountId))

/** Off without the bucket or the accounts database. */
const unavailableHere = (env: Environment): Response | null =>
  env.ACCOUNT_SYNC && env.ACCOUNTS_DB ? null : buddiesErrorResponse('disabled')

/** The token's account, after the edge tier; or the refusal. */
const caller = async (
  c: AppContext,
  tier: 'write' | 'read',
  options?: { requireLiveSession?: boolean }
): Promise<{ account: AccountAuth } | { refusal: Response }> => {
  const limited = await refuseAtEdge(
    c,
    tier === 'write' ? 'event/put' : 'inbox/sync'
  )
  if (limited) return { refusal: limited }
  const auth = await authenticateAccount(c, options)
  return auth.ok ? { account: auth.account } : { refusal: auth.response }
}

/**
 * The switches and the account's entitlement for put, list, get, and live:
 * null admits.
 */
const refuseUnentitled = async (
  env: Environment,
  accountId: string
): Promise<Response | null> => {
  const { enabled, entitlement } = await syncSwitches(env)
  if (!enabled) return buddiesErrorResponse('disabled')
  if (entitlement === 'everyone') return null
  try {
    return (await cachedSupporter(env, accountId))
      ? null
      : buddiesErrorResponse('supporter_required')
  } catch (error) {
    if (error instanceof RevenueCatError)
      return buddiesErrorResponse('unavailable')
    throw error
  }
}

/** The JSON body's `slotId` (optional for delete), or `bad_request`. */
const readSlotField = async (
  c: AppContext,
  required: boolean
): Promise<{ slotId: string | null } | { refusal: Response }> => {
  const body = await readPlainJson(c)
  if (!isPlainObject(body))
    return { refusal: buddiesErrorResponse('bad_request') }
  if (body.slotId === undefined && !required) return { slotId: null }
  return isSyncSlotId(body.slotId)
    ? { slotId: body.slotId }
    : { refusal: buddiesErrorResponse('bad_request') }
}

/**
 * `GET /accounts/v1/sync`: the account's answer, for Settings and the
 * Cloud Sync default. A RevenueCat failure says `supporter: false` with
 * `supporterCheckFailed: true`, never a 5xx. Works while disabled.
 */
const handleStatus = guarded('sync', async (c) => {
  if (!c.env.ACCOUNTS_DB) return buddiesErrorResponse('disabled')
  const who = await caller(c, 'read')
  if ('refusal' in who) return who.refusal
  const { enabled, entitlement } = await syncSwitches(c.env)
  let supporter = false
  let supporterCheckFailed = false
  try {
    supporter = await cachedSupporter(c.env, who.account.accountId)
  } catch (error) {
    if (!(error instanceof RevenueCatError)) throw error
    supporterCheckFailed = true
  }
  const entitled = enabled && (entitlement === 'everyone' || supporter)
  return c.json({
    ok: true,
    enabled: enabled && unavailableHere(c.env) == null,
    entitled: entitled && unavailableHere(c.env) == null,
    entitlement,
    supporter,
    ...(supporterCheckFailed ? { supporterCheckFailed: true } : {}),
  })
})

/**
 * `sync/put`: the blob as the raw body, with `x-ww-slot-id`, `x-ww-sha256`,
 * `Content-Length`, and optionally `If-Match`. A declared size over the cap
 * is refused before anything else; the body is read and checked against its
 * size and digest before the slot is reserved, so a bad upload never holds
 * the slot.
 */
const handlePut = guarded('sync/put', async (c) => {
  const declared = c.req.header('content-length')
  const off = unavailableHere(c.env)
  if (declared != null && Number(declared) > SYNC_LIMITS.blobBytes)
    return off ?? buddiesErrorResponse('too_large')
  if (off) return off
  const who = await caller(c, 'write')
  if ('refusal' in who) return who.refusal
  const { accountId, sessionId } = who.account
  const refused = await refuseUnentitled(c.env, accountId)
  if (refused) return refused

  const slotId = c.req.header(SYNC_HEADERS.slotId)
  const sha256 = c.req.header(SYNC_HEADERS.sha256)
  const size = declared == null ? NaN : Number(declared)
  const ifMatch = parseIfMatch(c.req.header('if-match') ?? null)
  if (
    !isSyncSlotId(slotId) ||
    typeof sha256 !== 'string' ||
    !SYNC_ETAG_PATTERN.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    ifMatch === undefined
  )
    return buddiesErrorResponse('bad_request')

  const body = await readBlobBody(c.req.raw, size, SYNC_LIMITS.blobBytes)
  if (!body.ok) return buddiesErrorResponse(body.error)
  const digest = await sha256Bytes(body.value)
  if (!timingSafeEqual(bytesToBase64Url(digest), sha256))
    return buddiesErrorResponse('bad_request')

  const index = syncIndex(c.env, accountId)
  const begun = await index.beginPut({ accountId, slotId, size, ifMatch })
  if (!begun.ok)
    return buddiesErrorResponse(begun.error, {
      retryAfterSeconds: begun.retryAfterSeconds,
    })
  const { reservation } = begun.value
  const updatedAt = Date.now()
  try {
    await c.env.ACCOUNT_SYNC!.put(syncObjectKey(accountId, slotId), body.value, {
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(
        ''
      ),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { etag: sha256, updatedAt: String(updatedAt) },
    })
  } catch (error) {
    await index.abortPut({ slotId, reservation }).catch(() => undefined)
    throw error
  }
  const committed = await index.commitPut({
    accountId,
    slotId,
    reservation,
    etag: sha256,
    size,
    updatedAt,
    sessionId,
  })
  if (!committed.ok) return buddiesErrorResponse(committed.error)
  return c.json({ ok: true, ...committed.value }, 200, {
    ETag: `"${sha256}"`,
  })
})

/** `sync/list`: every slot's ETag, size, and server time, and the account's `seq`. */
const handleList = guarded('sync/list', async (c) => {
  const off = unavailableHere(c.env)
  if (off) return off
  const who = await caller(c, 'read')
  if ('refusal' in who) return who.refusal
  const { accountId } = who.account
  const refused = await refuseUnentitled(c.env, accountId)
  if (refused) return refused
  const listed = await syncIndex(c.env, accountId).list()
  return c.json({ ok: true, ...listed })
})

/** `sync/get`: one slot's bytes exactly as put. */
const handleGet = guarded('sync/get', async (c) => {
  const off = unavailableHere(c.env)
  if (off) return off
  const who = await caller(c, 'read')
  if ('refusal' in who) return who.refusal
  const { accountId } = who.account
  const refused = await refuseUnentitled(c.env, accountId)
  if (refused) return refused
  const field = await readSlotField(c, true)
  if ('refusal' in field) return field.refusal
  const object = await c.env.ACCOUNT_SYNC!.get(
    syncObjectKey(accountId, field.slotId!)
  )
  if (!object) return buddiesErrorResponse('not_found')
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  const etag = object.customMetadata?.etag
  if (etag) headers.ETag = `"${etag}"`
  const updatedAt = Number(object.customMetadata?.updatedAt)
  headers[SYNC_HEADERS.updatedAt] = String(
    Number.isSafeInteger(updatedAt) ? updatedAt : object.uploaded.getTime()
  )
  return new Response(object.body, { headers })
})

/**
 * `sync/delete`: one slot, or every slot without `slotId`. Idempotent, and
 * it works while Cloud Sync is off or the account isn't entitled, so a
 * device can always take its data off the server. Deleting every slot needs
 * a live session (Delete Buddies runs it before closing its own).
 */
const handleDelete = guarded('sync/delete', async (c) => {
  const off = unavailableHere(c.env)
  if (off) return off
  const field = await readSlotField(c, false)
  if ('refusal' in field) return field.refusal
  const who = await caller(c, 'read', {
    requireLiveSession: field.slotId == null,
  })
  if ('refusal' in who) return who.refusal
  const { accountId } = who.account
  const { seq } = await syncIndex(c.env, accountId).deleteSlots({
    accountId,
    slotId: field.slotId,
  })
  return c.json({ ok: true, seq })
})

/**
 * `GET sync/live`: upgrades to the account's live socket. The token and the
 * device's own slot id (`x-ww-slot-id`) ride in headers; the DO gets the
 * verified account in `SYNC_HEADERS.account`, and any copy a client sent is
 * dropped.
 */
const handleLive = async (c: AppContext): Promise<Response> => {
  try {
    const off = unavailableHere(c.env)
    if (off) return off
    const who = await caller(c, 'read')
    if ('refusal' in who) return who.refusal
    const { accountId } = who.account
    const refused = await refuseUnentitled(c.env, accountId)
    if (refused) return refused
    if (!isWebSocketUpgrade(c.req.raw))
      return buddiesErrorResponse('upgrade_required')
    if (!isSyncSlotId(c.req.header(SYNC_HEADERS.slotId)))
      return buddiesErrorResponse('bad_request')
    const headers = new Headers(c.req.raw.headers)
    headers.set(SYNC_HEADERS.account, accountId)
    return await syncIndex(c.env, accountId).fetch(
      new Request(c.req.raw, { headers })
    )
  } catch (error) {
    console.error('accounts: request failed', { op: 'sync/live' })
    captureFailure(error, 'sync/live')
    return buddiesInternalError()
  }
}

export const syncHandlers = {
  status: handleStatus,
  put: handlePut,
  list: handleList,
  get: handleGet,
  delete: handleDelete,
  live: handleLive,
}
