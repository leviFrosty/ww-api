import { Hono } from 'hono'
import type { AppContext, Environment } from '../types'
import { Sentry } from '../sentry'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import {
  BUDDIES_ALWAYS_ALLOWED_OPS,
  BUDDIES_ERROR_STATUS,
  BUDDIES_LIMITS,
  BUDDIES_LIVE_OP,
  BUDDIES_OPS,
  BUDDIES_PAYLOAD_PARSERS,
  BUDDIES_UNSIGNED_OPS,
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
import {
  isWebSocketUpgrade,
  parseEnvelope,
  readEnvelopeText,
  readLiveCall,
  signedCall,
  verifyBuddiesSignature,
  type Envelope,
} from './envelope'
import { isBuddiesEnabled } from './killSwitch'
import {
  EDGE_RETRY_AFTER_SECONDS,
  allowBuddiesCaller,
  buddiesCallerKey,
  logLimitHit,
} from './limits'
import { defaultApnsDependencies, type ApnsDependencies } from '../apns'
import { deliverPushJob } from './push'

/**
 * `POST /buddies/v1/{op}` — the Buddies relay (docs/buddies-protocol.md) —
 * and `GET /buddies/v1/inbox/live`, the owner's live socket.
 *
 * Privacy: every id travels in the body (or, for the live socket, in headers),
 * and nothing here logs or reports the body, headers, payload, or any value
 * from them. Errors are `{ "error": "<code>" }`.
 *
 * Abuse limits (src/buddies/limits.ts): every request first counts against its
 * op tier's per-caller limit, keyed on the client IP (IPv6 by /64), never on
 * the target inbox. Malformed, stale, and (for `inbox/register`) badly signed
 * requests are refused here, before any Durable Object wakes.
 */

export interface BuddiesRouteDependencies {
  apns: ApnsDependencies
}

interface OpOutcome {
  body: Record<string, unknown>
  push?: PushJob | null
}

/** A failure may say how long to wait (`Retry-After`). */
type Outcome =
  | { ok: true; value: OpOutcome }
  | { ok: false; error: BuddiesErrorCode; retryAfterSeconds?: number }

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

/** The inbox DO checks this too; here it spares a wake-up. */
const isStale = (ts: number, now: number): boolean =>
  Math.abs(now - ts) > BUDDIES_LIMITS.timestampSkewMs

const registrationQuotaName = async (callerKey: string): Promise<string> =>
  bytesToBase64Url(
    await sha256Bytes(
      new TextEncoder().encode(`ww-buddies/v1/register-caller\n${callerKey}`)
    )
  )

/**
 * Gates `inbox/register` before the inbox DO: the self-signature (checkable
 * without the inbox, so junk never wakes a DO or spends quota), then the
 * caller's rolling-day registration quota. The DO stays the authority on the
 * signature; a quota outage lets registrations through.
 */
const admitRegistration = async (
  env: Environment,
  call: Signed<BuddiesPayloads['inbox/register']>,
  callerKey: string
): Promise<Outcome | null> => {
  const valid = await verifyBuddiesSignature(
    call.ownerPub,
    'inbox/register',
    call.payloadBytes,
    call.signature
  )
  if (!valid) return { ok: false, error: 'bad_signature' }
  let admission
  try {
    const name = await registrationQuotaName(callerKey)
    const quota = env.BUDDY_REGISTRATION_QUOTA
    admission = await quota.get(quota.idFromName(name)).admit(Date.now())
  } catch (error) {
    console.warn('buddies: registration quota unavailable; allowing')
    Sentry.captureException(error)
    return null
  }
  if (admission.ok) return null
  logLimitHit('inbox/register', 'registrationsPerDay')
  return {
    ok: false,
    error: 'rate_limited',
    retryAfterSeconds: admission.retryAfterSeconds,
  }
}

const runSigned = async <K extends BuddiesSignedOp>(
  op: K,
  env: Environment,
  envelope: Envelope,
  callerKey: string
): Promise<Outcome> => {
  const now = Date.now()
  const call = signedCall(op, envelope, now)
  if (!call.ok) return call
  if (isStale(call.value.ts, now)) return { ok: false, error: 'stale' }
  if (op === 'inbox/register') {
    const refused = await admitRegistration(
      env,
      call.value as unknown as Signed<BuddiesPayloads['inbox/register']>,
      callerKey
    )
    if (refused) return refused
  }
  return SIGNED_OPS[op](env, call.value)
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

const errorResponse = (
  c: AppContext,
  error: BuddiesErrorCode,
  retryAfterSeconds?: number
): Response =>
  c.json(
    { error },
    BUDDIES_ERROR_STATUS[error],
    retryAfterSeconds == null
      ? undefined
      : { 'Retry-After': String(retryAfterSeconds) }
  )

/** A per-caller edge limit refused the request. */
const edgeLimited = (c: AppContext): Response =>
  errorResponse(c, 'rate_limited', EDGE_RETRY_AFTER_SECONDS)

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
    const callerKey = buddiesCallerKey(c.req.header('CF-Connecting-IP'))
    if (!(await allowBuddiesCaller(c.env, op, callerKey)))
      return edgeLimited(c)

    const text = await readEnvelopeText(c.req.raw)
    const envelope = text == null ? null : parseEnvelope(text)
    if (!envelope) return errorResponse(c, 'bad_request')

    const result = isUnsignedOp(op)
      ? await runUnsigned(op, c.env, envelope)
      : await runSigned(op, c.env, envelope, callerKey)
    if (!result.ok)
      return errorResponse(c, result.error, result.retryAfterSeconds)

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

/**
 * Upgrades to the owner's live socket. The signed envelope rides in the
 * `x-buddies-p` / `x-buddies-s` headers because a WebSocket upgrade has no
 * body (and ids never go in URLs). The Worker counts it as a read and checks
 * its shape and `ts` to find the inbox; the inbox DO verifies it and accepts
 * the socket.
 */
const handleLive = async (c: AppContext): Promise<Response> => {
  try {
    if (!(await isBuddiesEnabled(c.env))) return errorResponse(c, 'disabled')
    const callerKey = buddiesCallerKey(c.req.header('CF-Connecting-IP'))
    if (!(await allowBuddiesCaller(c.env, BUDDIES_LIVE_OP, callerKey)))
      return edgeLimited(c)
    if (!isWebSocketUpgrade(c.req.raw))
      return errorResponse(c, 'upgrade_required')
    const now = Date.now()
    const call = readLiveCall(c.req.raw.headers, now)
    if (!call.ok) return errorResponse(c, call.error)
    if (isStale(call.value.ts, now)) return errorResponse(c, 'stale')
    return await inbox(c.env, call.value.inboxId).fetch(c.req.raw)
  } catch (error) {
    console.error('buddies: request failed', { op: BUDDIES_LIVE_OP })
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
  routes.get(`/${BUDDIES_LIVE_OP}`, handleLive)
  return routes
}
