import { bytesToBase64Url, sha256Hex } from '../crypto'
import {
  BUDDIES_ID_PATTERN,
  decodeB64u,
  isPlainObject,
} from '../buddies/contracts'

/**
 * The accounts wire contract (witness-work `docs/accounts-protocol.md`). An
 * account is a random `accountId` the server mints and the public key of the
 * account signing key, which every device derives from the User's account key.
 *
 * Requests use the Buddies envelope
 * `{ "payload": b64u(JSON), "signature": b64u(Ed25519) }` under their own signing context, so no account signature can pass for a
 * Buddies one or the other way round.
 */

/** Ops signed by the account key (the old phone's, for handoff). */
export const ACCOUNTS_OPS = [
  'account/register',
  'account/info',
  'handoff/open',
  'handoff/status',
  'handoff/send',
  'handoff/cancel',
  'backup/put',
  'backup/list',
  'backup/get',
  'backup/delete',
  'session/open',
  'sync/request',
] as const
export type AccountsOp = (typeof ACCOUNTS_OPS)[number]

/** `backup/put` sends its signed envelope in these headers; the body is the blob. */
export const ACCOUNT_ENVELOPE_HEADERS = {
  payload: 'x-ww-payload',
  signature: 'x-ww-signature',
} as const
/** The short header names older app builds send; still accepted. */
export const LEGACY_ACCOUNT_ENVELOPE_HEADERS = {
  payload: 'x-ww-p',
  signature: 'x-ww-s',
} as const

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const MIB = 1_024 * 1_024

/** Handoff and backup limits from the contract's "Handoff" and "Backup". */
export const ACCOUNT_LIMITS = {
  /** A handoff channel lives this long from `handoff/open`. */
  handoffLifetimeMs: 10 * MINUTE_MS,
  /** Wrong `claimToken`s before the channel is burned (`cancelled`). */
  handoffBadTokens: 5,
  /** `handoff/open` per account per rolling day. */
  handoffOpensPerDay: 20,
  handoffOpenWindowMs: DAY_MS,
  /** The sealed hello, b64u characters. */
  handoffHelloChars: 2 * 1_024,
  /** The sealed account key, b64u characters. */
  handoffKeyChars: 1_024,
  /** One backup blob. */
  backupBytes: 20 * MIB,
  /** Backup slots per account. */
  backupSlots: 8,
  /** One `backup/put` per slot this often. */
  backupPutIntervalMs: MINUTE_MS,
  /** An access token lives this long. */
  accessTokenMs: 15 * MINUTE_MS,
  /** A session lives this long from opening; refreshing never extends it. */
  sessionMs: 90 * DAY_MS,
  /** The refresh token just replaced still works this long (a lost response). */
  refreshGraceMs: MINUTE_MS,
  /** Live sessions per account; opening another ends the oldest. */
  sessionsPerAccount: 10,
  /** Sessions opened per account key per rolling day. */
  sessionOpensPerDay: 20,
  /** The sealed device label, b64u characters. */
  sessionDeviceChars: 512,
  /** Ended sessions (revoked or expired) are deleted after this long. */
  endedSessionRetentionMs: 7 * DAY_MS,
} as const

/** A slot's R2 object key; `v1/<accountId>/` lists an account's slots. */
export const backupObjectKey = (accountId: string, slotId: string): string =>
  `${backupPrefix(accountId)}${slotId}`

export const backupPrefix = (accountId: string): string => `v1/${accountId}/`

const SIGNING_CONTEXT = 'ww-account/v1\n'
const encoder = new TextEncoder()

const concat = (prefix: Uint8Array, rest: Uint8Array): Uint8Array => {
  const message = new Uint8Array(prefix.byteLength + rest.byteLength)
  message.set(prefix, 0)
  message.set(rest, prefix.byteLength)
  return message
}

/** The bytes an account op's signature covers: context, op, then `payload` decoded. */
export const accountSignedMessage = (
  op: AccountsOp,
  payloadBytes: Uint8Array
): Uint8Array =>
  concat(encoder.encode(`${SIGNING_CONTEXT}${op}\n`), payloadBytes)

/**
 * What the account signing key signs to claim an inbox. `inbox/register`
 * carries it, inside a payload the inbox's owner key signs, so the link takes
 * both keys.
 */
export const inboxLinkMessage = (
  accountId: string,
  inboxId: string,
  ownerPub: string
): Uint8Array =>
  encoder.encode(
    `${SIGNING_CONTEXT}inbox/link\n${accountId}\n${inboxId}\n${ownerPub}`
  )

/** `account/register` and `account/info` both name the signing key. */
export interface AccountKeyPayload {
  accountPub: string
  ts: number
  nonce: string
}

export const isAccountId = (value: unknown): value is string =>
  typeof value === 'string' && BUDDIES_ID_PATTERN.test(value)

/** Canonical b64u of exactly `size` bytes, or null. */
const canonicalBytes = (value: unknown, size: number): string | null => {
  if (typeof value !== 'string') return null
  const bytes = decodeB64u(value)
  return bytes && bytes.length === size ? bytesToBase64Url(bytes) : null
}

/** Canonical b64u of exactly 32 bytes, or null. */
const publicKey = (value: unknown): string | null => canonicalBytes(value, 32)

/** A 16-byte id (channel, slot, claim token) in its one canonical spelling. */
const id16 = (value: unknown): string | null => {
  const canonical = canonicalBytes(value, 16)
  return canonical != null && canonical === value ? canonical : null
}

/** A sealed blob as b64u: decodable, non-empty, at most `maxChars`. */
const sealed = (value: unknown, maxChars: number): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length > maxChars) return null
  return decodeB64u(value) ? value : null
}

/**
 * Validates `account/register`'s or `account/info`'s payload; null means
 * `bad_request`.
 */
export const parseAccountKeyPayload = (
  payload: unknown
): AccountKeyPayload | null => {
  if (!isPlainObject(payload)) return null
  const accountPub = publicKey(payload.accountPub)
  const ts = payload.ts
  if (!accountPub) return null
  if (typeof ts !== 'number' || !Number.isSafeInteger(Math.floor(ts)))
    return null
  if (!isAccountId(payload.nonce)) return null
  return { accountPub, ts: Math.floor(ts), nonce: payload.nonce }
}

// --- Handoff and backup payloads -------------------------------------------

export interface HandoffOpenFields {
  channelId: string
  /** b64u SHA-256 of the claim token, 32 bytes. */
  verifier: string
}

export interface HandoffChannelFields {
  channelId: string
}

export interface HandoffSendFields {
  channelId: string
  key: string
}

export interface BackupPutFields {
  slotId: string
  size: number
  sha256: string
}

export interface BackupSlotFields {
  slotId: string
}

export interface BackupDeleteFields {
  slotId: string | null
}

export interface SessionOpenFields {
  /**
   * The answer to a `POST /attestation/v1/challenge` challenge for purpose
   * `account-session`; checked by `src/accounts/attestation.ts`. Null only
   * when the request leaves it out (the development bypass).
   */
  attestation: Record<string, unknown> | null
  /** The sealed device label, stored opaque. */
  device: string | null
}

type Fields = Record<string, unknown>

/**
 * The fields each signed op adds to `accountPub`, `ts`, and `nonce`. Null
 * means `bad_request`. `too_large` is the route's call, so `backup/put`
 * accepts any positive `size` here.
 */
export const ACCOUNT_FIELD_PARSERS = {
  'account/register': (): Fields => ({}),
  'account/info': (): Fields => ({}),
  'handoff/open': (p: Fields): HandoffOpenFields | null => {
    const channelId = id16(p.channelId)
    const verifier = canonicalBytes(p.verifier, 32)
    return channelId && verifier ? { channelId, verifier } : null
  },
  'handoff/status': (p: Fields): HandoffChannelFields | null => {
    const channelId = id16(p.channelId)
    return channelId ? { channelId } : null
  },
  'handoff/send': (p: Fields): HandoffSendFields | null => {
    const channelId = id16(p.channelId)
    const key = sealed(p.key, ACCOUNT_LIMITS.handoffKeyChars)
    return channelId && key ? { channelId, key } : null
  },
  'handoff/cancel': (p: Fields): HandoffChannelFields | null => {
    const channelId = id16(p.channelId)
    return channelId ? { channelId } : null
  },
  'backup/put': (p: Fields): BackupPutFields | null => {
    const slotId = id16(p.slotId)
    const sha256 = canonicalBytes(p.sha256, 32)
    const size = p.size
    if (!slotId || !sha256) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1)
      return null
    return { slotId, size, sha256 }
  },
  'backup/list': (): Fields => ({}),
  'backup/get': (p: Fields): BackupSlotFields | null => {
    const slotId = id16(p.slotId)
    return slotId ? { slotId } : null
  },
  'backup/delete': (p: Fields): BackupDeleteFields | null => {
    if (p.slotId === undefined || p.slotId === null) return { slotId: null }
    const slotId = id16(p.slotId)
    return slotId ? { slotId } : null
  },
  'session/open': (p: Fields): SessionOpenFields | null => {
    const attestation = p.attestation ?? null
    if (attestation !== null && !isPlainObject(attestation)) return null
    if (p.device === undefined || p.device === null)
      return { attestation, device: null }
    const device = sealed(p.device, ACCOUNT_LIMITS.sessionDeviceChars)
    return device ? { attestation, device } : null
  },
  // The envelope proves the account key: a leaked token alone can't ask.
  'sync/request': (): Fields => ({}),
} satisfies Record<AccountsOp, (payload: Fields) => object | null>

export type AccountFields<K extends AccountsOp> = NonNullable<
  ReturnType<(typeof ACCOUNT_FIELD_PARSERS)[K]>
>

/** The new phone's requests: plain JSON, authorized by the claim token. */
export interface HandoffTokenRequest {
  channelId: string
  claimToken: string
}

export interface HandoffClaimRequest extends HandoffTokenRequest {
  claimPub: string
  hello: string
}

export const parseHandoffTokenRequest = (
  body: unknown
): HandoffTokenRequest | null => {
  if (!isPlainObject(body)) return null
  const channelId = id16(body.channelId)
  const claimToken = id16(body.claimToken)
  return channelId && claimToken ? { channelId, claimToken } : null
}

export const parseHandoffClaimRequest = (
  body: unknown
): HandoffClaimRequest | null => {
  const base = parseHandoffTokenRequest(body)
  if (!base || !isPlainObject(body)) return null
  const claimPub = publicKey(body.claimPub)
  const hello = sealed(body.hello, ACCOUNT_LIMITS.handoffHelloChars)
  return claimPub && hello ? { ...base, claimPub, hello } : null
}

const over = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > max

/** A sealed blob's cap broken, for `too_large` instead of `bad_request`. */
export const handoffBlobTooLarge = (body: unknown): boolean => {
  if (!isPlainObject(body)) return false
  return (
    over(body.hello, ACCOUNT_LIMITS.handoffHelloChars) ||
    over(body.key, ACCOUNT_LIMITS.handoffKeyChars)
  )
}

/** The session's sealed device label over its cap (`too_large`). */
export const sessionDeviceTooLarge = (payload: unknown): boolean =>
  isPlainObject(payload) &&
  over(payload.device, ACCOUNT_LIMITS.sessionDeviceChars)

// --- Sessions ----------------------------------------------------------------

/**
 * What an `account-session` attestation's `contentHash` and `requestHash`
 * must both be (on `POST /attestation/v1/challenge` and in the session's
 * `attestation`), so it covers the account key: lowercase hex
 * `SHA-256(UTF-8("ww-account/v1/session\n" + accountPub))`.
 */
export const sessionAttestationHash = (accountPub: string): Promise<string> =>
  sha256Hex(`ww-account/v1/session\n${accountPub}`)

/** A refresh token as presented, in its parts. */
export interface RefreshToken {
  /** The session it names. */
  sessionId: string
  /** `<sessionId>.<secret>`, what its MAC covers. */
  body: string
  /** The MAC's 32 bytes. */
  mac: Uint8Array
  /** The whole token. */
  token: string
}

/** The bytes of b64u for exactly `size` bytes, in its canonical spelling. */
const canonicalB64u = (value: string, size: number): Uint8Array | null => {
  const bytes = decodeB64u(value)
  return bytes != null &&
    bytes.length === size &&
    bytesToBase64Url(bytes) === value
    ? bytes
    : null
}

/**
 * A refresh token, opaque to the app: `<sessionId>.<secret>.<mac>`, the
 * session's id (b64u, 16 bytes), then b64u of 32 bytes twice, each in its
 * canonical spelling. Null for anything else, including the two-part
 * `<sessionId>.<secret>` tokens from before the MAC.
 */
export const parseRefreshToken = (value: unknown): RefreshToken | null => {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  if (parts.length !== 3) return null
  const [sessionId, secret, mac] = parts
  const macBytes = canonicalB64u(mac, 32)
  return canonicalB64u(sessionId, 16) && canonicalB64u(secret, 32) && macBytes
    ? { sessionId, body: `${sessionId}.${secret}`, mac: macBytes, token: value }
    : null
}
