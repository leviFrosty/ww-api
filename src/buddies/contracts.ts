import { base64ToBytes, bytesToBase64Url } from '../crypto'
import { APNS_DEVICE_TOKEN_PATTERN, type ApnsEnvironment } from '../apns'
import { FCM_TOKEN_PATTERN } from '../fcm'

/**
 * Buddies relay wire contract (protocol v1). The source of truth is
 * `docs/buddies-protocol.md`; this module holds the constants, error codes, and
 * payload validation that the route and both Durable Objects share.
 *
 * Everything here treats blobs as opaque ciphertext. Nothing in this module
 * logs, and callers must never log payload values: ids, keys, tokens, and blobs
 * are all user-linked.
 */

export const BUDDIES_OWNER_OPS = [
  'inbox/sync',
  'inbox/delete',
  'device/register',
  'device/unregister',
  'slot/add',
  'slot/remove',
  'roster/put',
  'invite/create',
  'invite/delete',
] as const

export const BUDDIES_WRITER_OPS = [
  'card/put',
  'event/put',
  'slot/leave',
] as const

export const BUDDIES_UNSIGNED_OPS = ['invite/fetch', 'invite/claim'] as const

/**
 * The owner's live socket, `GET /buddies/v1/inbox/live`. Signed and verified
 * like an owner op, but carried in request headers on a WebSocket upgrade, so
 * it is not in `BUDDIES_OPS` and has no POST route.
 */
export const BUDDIES_LIVE_OP = 'inbox/live'
/** Request headers that carry the live upgrade's `p` and `s`. */
export const BUDDIES_LIVE_HEADERS = {
  payload: 'x-buddies-p',
  signature: 'x-buddies-s',
} as const
/** Close codes the relay sends on live sockets. */
export const BUDDIES_LIVE_CLOSE = {
  /** The inbox was deleted or wiped for inactivity. */
  gone: { code: 4001, reason: 'gone' },
  /** A newer socket for the inbox pushed this one past the cap. */
  replaced: { code: 4002, reason: 'replaced' },
} as const

export type BuddiesOwnerOp = (typeof BUDDIES_OWNER_OPS)[number]
export type BuddiesWriterOp = (typeof BUDDIES_WRITER_OPS)[number]
export type BuddiesUnsignedOp = (typeof BUDDIES_UNSIGNED_OPS)[number]
export type BuddiesSignedOp =
  | 'inbox/register'
  | BuddiesOwnerOp
  | BuddiesWriterOp
export type BuddiesOp = BuddiesSignedOp | BuddiesUnsignedOp
export type BuddiesLiveOp = typeof BUDDIES_LIVE_OP
/** Every op a signature can name: the signed POST ops and the live socket. */
export type BuddiesSigningOp = BuddiesSignedOp | BuddiesLiveOp

export const BUDDIES_OPS: readonly BuddiesOp[] = [
  'inbox/register',
  ...BUDDIES_OWNER_OPS,
  ...BUDDIES_WRITER_OPS,
  ...BUDDIES_UNSIGNED_OPS,
]

/** Ops that keep working with the kill switch off, so people can always leave. */
export const BUDDIES_ALWAYS_ALLOWED_OPS: ReadonlySet<BuddiesOp> = new Set([
  'inbox/delete',
  'slot/remove',
  'slot/leave',
])

export const BUDDIES_ERROR_STATUS = {
  bad_request: 400,
  bad_signature: 401,
  stale: 401,
  replay: 409,
  not_found: 404,
  conflict: 409,
  gone: 410,
  limit: 429,
  rate_limited: 429,
  disabled: 503,
  /** `inbox/live` without a WebSocket upgrade. */
  upgrade_required: 426,
} as const

export type BuddiesErrorCode = keyof typeof BUDDIES_ERROR_STATUS

/** Result shape shared by every Durable Object method (RPC-serializable). */
export type BuddiesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BuddiesErrorCode }

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

export const fail = (
  error: BuddiesErrorCode
): { ok: false; error: BuddiesErrorCode } => ({
  ok: false,
  error,
})

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const KIB = 1_024

/** Caps, windows, and retention from the contract's "Limits and retention". */
export const BUDDIES_LIMITS = {
  /** `slot/add` and `invite/create` fail with `limit` at this many slots + open invites. */
  slotsPlusOpenInvites: 5,
  openInvites: 3,
  inviteCreations: 20,
  inviteCreationWindowMs: DAY_MS,
  writesPerSlot: 60,
  writeWindowMs: HOUR_MS,
  pushesPerSlot: 10,
  pushWindowMs: DAY_MS,
  /** Immediate kinds skip it; `pushesPerSlot` still applies to them. */
  pushSpacingMs: MINUTE_MS,
  devices: 10,
  /** Open `inbox/live` sockets per inbox; past it the oldest is replaced. */
  liveSockets: 10,
  badClaims: 5,
  eventRetentionMs: 30 * DAY_MS,
  /** Invites are deleted at `expiresAt` plus this grace. */
  inviteGraceMs: 10 * MINUTE_MS,
  inboxInactivityMs: 180 * DAY_MS,
  maxInviteLifetimeMs: 7 * DAY_MS + 5 * MINUTE_MS,
  timestampSkewMs: 5 * MINUTE_MS,
  nonceRetentionMs: 10 * MINUTE_MS,
  rosterBytes: 32 * KIB,
  cardBytes: 16 * KIB,
  eventBytes: 8 * KIB,
  inviteBytes: 4 * KIB,
  claimBytes: 4 * KIB,
  templateChars: 200,
  /** Not in the contract: bounds per-device template storage. */
  templates: 32,
  kindChars: 40,
  /** Not in the contract: a whole-envelope ceiling checked before parsing. */
  requestBytes: 256 * KIB,
  /**
   * Not in the contract: `inbox/sync` stops adding events once their blobs pass
   * this many characters and returns `seq` as the cursor it reached, so the next
   * sync continues from there. Real inboxes never get close.
   */
  syncEventChars: 4 * 1_024 * KIB,
} as const

/**
 * Kinds that invite someone or answer them (confirm a pairing, reply to a
 * share, invite to a Plan or Follow-up, ask to join) alert right away instead
 * of waiting out the 60 s push spacing, but still count toward the daily cap.
 * Updates and cancellations keep the spacing. `invite.claimed` is a relay
 * event outside the slot budget altogether.
 */
export const BUDDIES_IMMEDIATE_PUSH_KINDS: ReadonlySet<string> = new Set([
  'pair.confirmed',
  'share.reply',
  'plan.invite',
  'followup.invite',
])
/** `join.request.<tag>`: the tag is per buddy, so it matches by prefix. */
export const BUDDIES_IMMEDIATE_PUSH_PREFIX = 'join.request.'

export const isImmediatePushKind = (kind: string): boolean =>
  BUDDIES_IMMEDIATE_PUSH_KINDS.has(kind) ||
  kind.startsWith(BUDDIES_IMMEDIATE_PUSH_PREFIX)

export const BUDDIES_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const B64U_PATTERN = /^[A-Za-z0-9_-]*$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/
const KIND_PATTERN = /^[a-z][a-z0-9.]*$/
export interface PushTemplate {
  title: string
  body: string
}

/** How a device gets pushes: APNs (iOS, the default) or FCM (Android). */
export type PushService = 'apns' | 'fcm'

/** A device's push address. `apnsTopic` null means the worker's `IOS_BUNDLE_ID`. */
export type PushAddress =
  | {
      service: 'apns'
      token: string
      apnsEnvironment: ApnsEnvironment
      apnsTopic: string | null
    }
  | { service: 'fcm'; token: string }

export type PushTarget = PushAddress & {
  deviceId: string
  title: string
  body: string
}

/** What a Durable Object asks the Worker to push. Never logged. */
export interface PushJob {
  inboxId: string
  kind: string
  targets: PushTarget[]
}

/** Decodes unpadded base64url; null when the alphabet or length is invalid. */
export const decodeB64u = (value: string): Uint8Array | null => {
  if (!B64U_PATTERN.test(value) || value.length % 4 === 1) return null
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}

/** Decoded size of a valid unpadded base64url string. */
const decodedLength = (value: string): number =>
  Math.floor((value.length * 3) / 4)

export const decodeSignature = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) return null
  const bytes = decodeB64u(value)
  return bytes && bytes.length === 64 ? bytes : null
}

export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isId = (value: unknown): value is string =>
  typeof value === 'string' && BUDDIES_ID_PATTERN.test(value)

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

export const isEventKind = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= BUDDIES_LIMITS.kindChars &&
  KIND_PATTERN.test(value)

/** Canonical base64url of a value that must decode to exactly `size` bytes. */
const fixedBytes = (value: unknown, size: number): string | null => {
  if (typeof value !== 'string') return null
  const bytes = decodeB64u(value)
  return bytes && bytes.length === size ? bytesToBase64Url(bytes) : null
}

/** An opaque sealed blob: valid base64url, 1..maxBytes once decoded. */
const blob = (value: unknown, maxBytes: number): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!B64U_PATTERN.test(value) || value.length % 4 === 1) return null
  return decodedLength(value) <= maxBytes ? value : null
}

const codePoints = (value: string): number => {
  let count = 0
  for (const _ of value) count++
  return count
}

const templateText = (value: unknown): value is string =>
  typeof value === 'string' && codePoints(value) <= BUDDIES_LIMITS.templateChars

const templates = (value: unknown): Record<string, PushTemplate> | null => {
  if (!isPlainObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length > BUDDIES_LIMITS.templates) return null
  const out: Record<string, PushTemplate> = {}
  for (const [kind, template] of entries) {
    if (!isEventKind(kind) || !isPlainObject(template)) return null
    const { title, body } = template
    if (!templateText(title) || !templateText(body)) return null
    out[kind] = { title, body }
  }
  return out
}

// --- Payloads -------------------------------------------------------------

export interface SignedFields {
  ts: number
  nonce: string
}

export interface InboxFields extends SignedFields {
  inboxId: string
}

export interface RegisterPayload extends InboxFields {
  ownerPub: string
}

export interface SyncPayload extends InboxFields {
  since: number
}

export interface DeviceRegisterPayload extends InboxFields {
  deviceId: string
  push: PushAddress
  templates: Record<string, PushTemplate>
}

export interface DeviceUnregisterPayload extends InboxFields {
  deviceId: string
}

export interface SlotPayload extends InboxFields {
  slotId: string
}

export interface SlotAddPayload extends SlotPayload {
  writerPub: string
}

export interface RosterPutPayload extends InboxFields {
  blob: string
}

export interface InviteCreatePayload extends InboxFields {
  inviteId: string
  claimVerifier: string
  blob: string
  expiresAt: number
}

export interface InviteDeletePayload extends InboxFields {
  inviteId: string
}

export interface CardPutPayload extends SlotPayload {
  blob: string
}

export interface EventPutPayload extends SlotPayload {
  eventId: string
  kind: string
  blob: string
  push: boolean
}

export interface InviteFetchPayload {
  inviteId: string
}

export interface InviteClaimPayload {
  inviteId: string
  claimSecret: Uint8Array
  blob: string
}

export interface BuddiesPayloads {
  'inbox/register': RegisterPayload
  'inbox/sync': SyncPayload
  'inbox/delete': InboxFields
  'device/register': DeviceRegisterPayload
  'device/unregister': DeviceUnregisterPayload
  'slot/add': SlotAddPayload
  'slot/remove': SlotPayload
  'roster/put': RosterPutPayload
  'invite/create': InviteCreatePayload
  'invite/delete': InviteDeletePayload
  'card/put': CardPutPayload
  'event/put': EventPutPayload
  'slot/leave': SlotPayload
  'invite/fetch': InviteFetchPayload
  'invite/claim': InviteClaimPayload
  'inbox/live': InboxFields
}

type Fields = Record<string, unknown>

/** A bundle id as Apple allows them; the inbox checks it's one this worker serves. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const MAX_BUNDLE_ID_CHARS = 155

/**
 * `pushService` picks the fields: APNs (also when absent, as builds before
 * Android sent it) takes `apnsToken`, `apnsEnvironment`, and `apnsTopic?`;
 * FCM takes `fcmToken`. The other service's fields are ignored.
 */
const pushAddress = (p: Fields): PushAddress | null => {
  const service = p.pushService ?? 'apns'
  if (service === 'fcm') {
    return typeof p.fcmToken === 'string' && FCM_TOKEN_PATTERN.test(p.fcmToken)
      ? { service, token: p.fcmToken }
      : null
  }
  if (service !== 'apns') return null
  if (
    typeof p.apnsToken !== 'string' ||
    !APNS_DEVICE_TOKEN_PATTERN.test(p.apnsToken)
  ) {
    return null
  }
  if (p.apnsEnvironment !== 'sandbox' && p.apnsEnvironment !== 'production') {
    return null
  }
  let apnsTopic: string | null = null
  if (p.apnsTopic !== undefined) {
    if (
      typeof p.apnsTopic !== 'string' ||
      p.apnsTopic.length > MAX_BUNDLE_ID_CHARS ||
      !BUNDLE_ID_PATTERN.test(p.apnsTopic)
    ) {
      return null
    }
    apnsTopic = p.apnsTopic
  }
  return {
    service,
    token: p.apnsToken.toLowerCase(),
    apnsEnvironment: p.apnsEnvironment,
    apnsTopic,
  }
}

const inboxFields = (p: Fields): InboxFields | null =>
  isSafeInteger(p.ts) && isId(p.nonce) && isId(p.inboxId)
    ? { ts: p.ts, nonce: p.nonce, inboxId: p.inboxId }
    : null

const slotFields = (p: Fields): SlotPayload | null => {
  const base = inboxFields(p)
  return base && isId(p.slotId) ? { ...base, slotId: p.slotId } : null
}

const withBlob = <T extends object>(
  base: T | null,
  value: unknown,
  maxBytes: number
): (T & { blob: string }) | null => {
  const b = blob(value, maxBytes)
  return base && b ? { ...base, blob: b } : null
}

type PayloadParsers = {
  [K in BuddiesOp | BuddiesLiveOp]: (
    payload: Fields,
    now: number
  ) => BuddiesPayloads[K] | null
}

/**
 * Validates a decoded payload for one op and returns only the contract fields
 * (unknown fields, including the reserved `attest`, are dropped). Keys and the
 * claim verifier come back canonically encoded. Null means `bad_request`.
 */
export const BUDDIES_PAYLOAD_PARSERS: PayloadParsers = {
  'inbox/register': (p) => {
    const base = inboxFields(p)
    const ownerPub = fixedBytes(p.ownerPub, 32)
    return base && ownerPub ? { ...base, ownerPub } : null
  },
  'inbox/sync': (p) => {
    const base = inboxFields(p)
    return base && isSafeInteger(p.since) && p.since >= 0
      ? { ...base, since: p.since }
      : null
  },
  'inbox/delete': inboxFields,
  'device/register': (p) => {
    const base = inboxFields(p)
    const parsedTemplates = templates(p.templates)
    const push = pushAddress(p)
    if (!base || !isId(p.deviceId) || !parsedTemplates || !push) return null
    return {
      ...base,
      deviceId: p.deviceId,
      push,
      templates: parsedTemplates,
    }
  },
  'device/unregister': (p) => {
    const base = inboxFields(p)
    return base && isId(p.deviceId) ? { ...base, deviceId: p.deviceId } : null
  },
  'slot/add': (p) => {
    const base = slotFields(p)
    const writerPub = fixedBytes(p.writerPub, 32)
    return base && writerPub ? { ...base, writerPub } : null
  },
  'slot/remove': slotFields,
  'roster/put': (p) =>
    withBlob(inboxFields(p), p.blob, BUDDIES_LIMITS.rosterBytes),
  'invite/create': (p, now) => {
    const base = withBlob(inboxFields(p), p.blob, BUDDIES_LIMITS.inviteBytes)
    const claimVerifier = fixedBytes(p.claimVerifier, 32)
    if (!base || !claimVerifier || !isId(p.inviteId)) return null
    const { expiresAt } = p
    if (!isSafeInteger(expiresAt) || expiresAt <= now) return null
    if (expiresAt > now + BUDDIES_LIMITS.maxInviteLifetimeMs) return null
    return { ...base, inviteId: p.inviteId, claimVerifier, expiresAt }
  },
  'invite/delete': (p) => {
    const base = inboxFields(p)
    return base && isId(p.inviteId) ? { ...base, inviteId: p.inviteId } : null
  },
  'card/put': (p) => withBlob(slotFields(p), p.blob, BUDDIES_LIMITS.cardBytes),
  'event/put': (p) => {
    const base = withBlob(slotFields(p), p.blob, BUDDIES_LIMITS.eventBytes)
    if (!base || !isId(p.eventId) || !isEventKind(p.kind)) return null
    if (typeof p.push !== 'boolean') return null
    return { ...base, eventId: p.eventId, kind: p.kind, push: p.push }
  },
  'slot/leave': slotFields,
  'invite/fetch': (p) => (isId(p.inviteId) ? { inviteId: p.inviteId } : null),
  'invite/claim': (p) => {
    if (!isId(p.inviteId) || typeof p.claimSecret !== 'string') return null
    const claimSecret = decodeB64u(p.claimSecret)
    const claimBlob = blob(p.blob, BUDDIES_LIMITS.claimBytes)
    if (!claimSecret || claimSecret.length !== 32 || !claimBlob) return null
    return { inviteId: p.inviteId, claimSecret, blob: claimBlob }
  },
  'inbox/live': inboxFields,
}

// --- Durable Object call shapes -------------------------------------------

/** The authenticated parts of a signed request, forwarded to the inbox DO. */
export interface SignedCall {
  /** Decoded bytes of the envelope's `p`, exactly as the client signed them. */
  payloadBytes: Uint8Array
  signature: Uint8Array
}

export type Signed<T> = T & SignedCall

export type SyncSlot = {
  slotId: string
  createdAt: number
}

export type SyncCard = {
  slotId: string
  blob: string
  seq: number
  updatedAt: number
}

export type SyncEvent = {
  eventId: string
  slotId: string
  kind: string
  blob: string
  seq: number
  createdAt: number
}

export interface SyncResponse {
  seq: number
  slots: SyncSlot[]
  cards: SyncCard[]
  events: SyncEvent[]
  roster: { blob: string; seq: number } | null
}

export interface InviteView {
  blob: string
  expiresAt: number
  status: 'open' | 'claimed'
}

/** Relay-created events carry this empty slot id. */
export const RELAY_SLOT_ID = ''
export const INVITE_CLAIMED_KIND = 'invite.claimed'
