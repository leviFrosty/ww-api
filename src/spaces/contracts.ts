import { bytesToBase64Url, sha256Bytes } from '../crypto'
import { apiError } from '../errors'
import {
  BUDDIES_ERROR_STATUS,
  BUDDIES_ID_PATTERN,
  decodeB64u,
  decodedLength,
  isB64u,
  isId,
  isPlainObject,
  isSafeInteger,
} from '../buddies/contracts'
import { buddiesErrorResponse } from '../buddies/errorResponse'

/**
 * Shared Spaces wire contract (witness-work ADR 0037, `docs/shared-cars-protocol.md`
 * there): the ops, limits, live socket messages, and body parsing the route
 * and the `SharedSpace` Durable Object share.
 *
 * The server is blind and generic: records are opaque sealed blobs under
 * random ids, members are token hashes and public keys, and wraps are
 * opaque. Nothing here logs a value, and callers must never log one from a
 * body: ids, tokens, keys, verifiers, wraps, and blobs are all user-linked.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const KIB = 1_024
const MIB = 1_024 * KIB

/**
 * The contract's "Limits and retention", each sized from the heaviest real
 * use (a family of 10 on one car, seeding years of trips at once).
 */
export const SPACES_LIMITS = {
  /**
   * Members plus open invites per space when KV `spaces:maxMembers` is
   * absent or unusable: a large family on one car.
   */
  defaultMaxMembers: 10,
  /** The most KV `spaces:maxMembers` may raise it to (the contract's 1–100). */
  maxMembersCeiling: 100,
  /** `invite/create` `expiresAt ≤ now + this`: 7 days, plus 5 minutes of clock slack. */
  maxInviteLifetimeMs: 7 * DAY_MS + 5 * MINUTE_MS,
  /** Wrong join secrets an invite takes; the last one burns it. */
  badJoins: 5,
  /**
   * Records per space, deletions included (they're kept as long as the
   * space): 10 years of a pioneer's daily trips is ~4,000, so 10× with room.
   */
  records: 50_000,
  /**
   * Decoded blob bytes per space, deletions included: 50,000 records at a
   * typical ~2 KB is ~100 MiB, so room for long notes.
   */
  spaceBytes: 256 * MIB,
  /** One record's sealed blob, decoded: a trip with a long note is ~2 KB. */
  blobBytes: 16 * KIB,
  /** Records per `put`. */
  putRecords: 100,
  /**
   * One `put` body: 100 typical records (a trip seals to ~2 KB, ~2.7 KB as
   * b64u) fit with room. Near the 16 KiB blob cap only about 45 do, so a
   * device splits puts by size as well as count.
   */
  putBytes: 1 * MIB,
  /**
   * Every other op's body: a rekey's wraps are ~140 characters each, and its
   * link at most a blob's ~22,000.
   */
  requestBytes: 256 * KIB,
  /** One wrap, decoded (today's are 105 bytes). */
  wrapBytes: 512,
  /**
   * Puts per member a rolling minute: a device puts 2 s after a change, so a
   * member's few devices put ~20 a minute at most while seeding. Counted in
   * the space's SQLite, so it holds across eviction.
   */
  memberPuts: 60,
  memberPutWindowMs: MINUTE_MS,
  /**
   * Records put per space per rolling day: seeding a car's whole history
   * (~4,000 at most) plus a busy day of edits.
   */
  spaceRecordsPerDay: 10_000,
  spaceRecordWindowMs: DAY_MS,
  /** Spaces one account creates per rolling day (a counter, not a list). */
  spacesPerDay: 20,
  /**
   * Open live sockets per member the cap allows (`4 × maxMembers`, 40 at
   * 10): each member's phone, tablet, and a spare or two.
   */
  liveSocketsPerMember: 4,
  /** The most characters `x-ww-space-auth` may carry. */
  liveHeaderChars: 1_024,
  /** A record's `stamp` may be at most this far past the server's clock. */
  stampSkewMs: DAY_MS,
  /** A space is deleted after this long without a `sync` or `put`. */
  retentionMs: 400 * DAY_MS,
  /**
   * A `sync` records the space's activity only once this much has passed
   * since it was last recorded, so most syncs write nothing. Retention waits
   * this much longer to make up for it.
   */
  activityGranularityMs: DAY_MS,
  /** Records per `sync` page; `limit` may ask for fewer. */
  syncRecords: 1_000,
  /**
   * A `sync` page stops adding records once their blobs would pass this many
   * characters (always at least one), and says `more`.
   */
  syncChars: 4 * MIB,
} as const

/** Every op; each is `POST /spaces/v1/{op}`. */
export const SPACES_OPS = [
  'create',
  'sync',
  'put',
  'invite/create',
  'invite/delete',
  'join',
  'leave',
  'member/remove',
  'rekey',
  'delete',
] as const

export type SpacesOp = (typeof SPACES_OPS)[number]

/** The live socket, `GET /spaces/v1/live`; not a POST op. */
export const SPACES_LIVE_OP = 'live'

/** Ops that keep working with the kill switch off, so people can always leave. */
export const SPACES_ALWAYS_ALLOWED_OPS: ReadonlySet<SpacesOp> = new Set([
  'leave',
  'member/remove',
  'delete',
])

/**
 * Ops that reach other people, refused with 403 `suspended` when the
 * session's account is suspended. Reading, leaving, removing, rekeying, and
 * deleting stay open, so a suspended person can still protect the others.
 */
export const SPACES_SUSPENDED_REFUSED_OPS: ReadonlySet<SpacesOp> = new Set([
  'create',
  'put',
  'invite/create',
  'join',
])

export const SPACES_HEADERS = {
  /**
   * The live upgrade's `b64u(UTF-8 JSON { spaceId, memberId })`. Its name
   * holds "auth" so Cloudflare's logs redact it.
   */
  live: 'x-ww-space-auth',
  /**
   * The live upgrade's member token, `b64u(token)`. Its name holds "token"
   * so Cloudflare's logs redact it; it never goes past the Worker.
   */
  liveToken: 'x-ww-space-token',
  /**
   * The live upgrade's member as the Worker verified its shape and hashed
   * its token, plus the member cap, on the request it hands the space DO.
   * It carries the token's hash, so its name holds "token" for Cloudflare's
   * logs to redact it too. Set only by the Worker; any client copy is
   * replaced.
   */
  member: 'x-ww-space-member-token',
} as const

// --- Errors -----------------------------------------------------------------

/**
 * The shared envelope's codes (`BUDDIES_ERROR_STATUS`), plus Shared Spaces'
 * own: `stale_key`, a `put` or `invite/create` for an epoch that isn't
 * current, or a `rekey` to anything but the next (nothing was stored). The
 * client syncs, opens its new wrap, and tries again.
 */
export const SPACES_ERROR_STATUS = {
  ...BUDDIES_ERROR_STATUS,
  stale_key: 409,
} as const

export type SpacesErrorCode = keyof typeof SPACES_ERROR_STATUS

/** A refusal; time-bound limits say how long to wait (`Retry-After`). */
export type SpacesFailure = {
  ok: false
  error: SpacesErrorCode
  retryAfterSeconds?: number
}

/** What every `SharedSpace` method answers (RPC-serializable). */
export type SpacesResult<T> = { ok: true; value: T } | SpacesFailure

export const fail = (
  error: SpacesErrorCode,
  retryAfterSeconds?: number
): SpacesFailure =>
  retryAfterSeconds == null
    ? { ok: false, error }
    : { ok: false, error, retryAfterSeconds }

/** A refusal in the shared envelope, as Buddies and accounts send theirs. */
export const spacesErrorResponse = (
  error: SpacesErrorCode,
  options: { retryAfterSeconds?: number } = {}
): Response =>
  error === 'stale_key'
    ? apiError(SPACES_ERROR_STATUS[error], error)
    : buddiesErrorResponse(error, options)

/** Logs a limit hit for tuning: the op and the limit's name, nothing else. */
export const logSpacesLimitHit = (op: string, limit: string): void => {
  console.warn('spaces: limit hit', { op, limit })
}

/** Live socket messages: change notices only, never content. */
export type SpacesLiveMessage = { type: 'hello' | 'changed'; seq: number }

export const SPACES_LIVE_CLOSE = {
  /** The space was deleted, or this member left or was removed. */
  gone: { code: 4001, reason: 'gone' },
  /** A newer socket on the space pushed this one past the cap. */
  replaced: { code: 4002, reason: 'replaced' },
} as const

// --- Parsing ----------------------------------------------------------------

/** `spaceId`, `memberId`, and `inviteId`: 16 random bytes, 22 b64u characters. */
export const SPACES_ID_PATTERN = BUDDIES_ID_PATTERN
/** `recordId`: mileage records use their UUIDs; `m.`, `i.`, and `k.` prefix others. */
export const SPACES_RECORD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** A member's own record, `m.<memberId>`: only that member puts it. */
const MEMBER_RECORD_PREFIX = 'm.'
/** The key chain's links, `k.<x>`: only the owner puts them. */
const KEY_RECORD_PREFIX = 'k.'

/**
 * Whether `memberId` may put `recordId`: `m.<memberId>` is that member's
 * alone (any other `m.` id is someone else's, a member yet to join
 * included), and `k.<x>` the owner's. So no member overwrites another's
 * record or the key chain. Every other id is anyone's.
 */
export const mayPutRecord = (
  recordId: string,
  memberId: string,
  ownerId: string
): boolean => {
  if (recordId.startsWith(MEMBER_RECORD_PREFIX))
    return recordId === `${MEMBER_RECORD_PREFIX}${memberId}`
  if (recordId.startsWith(KEY_RECORD_PREFIX)) return memberId === ownerId
  return true
}

/** The 32 bytes of a canonical b64u value (tokens, secrets, hashes), or null. */
export const bytes32 = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || value.length !== 43) return null
  const bytes = decodeB64u(value)
  return bytes && bytes.length === 32 && bytesToBase64Url(bytes) === value
    ? bytes
    : null
}

const isHash = (value: unknown): value is string => bytes32(value) != null

/** A member's X25519 public key: 32 bytes, canonical b64u. */
const isDhPub = isHash

const isWrap = (value: unknown): value is string =>
  isB64u(value) && decodedLength(value) <= SPACES_LIMITS.wrapBytes

const encoder = new TextEncoder()

/**
 * The member id `dhPub` commits to in `spaceId`:
 * `b64u(SHA-256("ww-spaces/v1/member-id|" + spaceId + "|" + dhPub)[0..16])`,
 * `dhPub` as its b64u text. `create` and `join` refuse a `memberId` that
 * isn't this (`bad_request`), so nobody can wrap a key to a swapped-in one.
 */
export const spacesMemberId = async (
  spaceId: string,
  dhPub: string
): Promise<string> =>
  bytesToBase64Url(
    (
      await sha256Bytes(
        encoder.encode(`ww-spaces/v1/member-id|${spaceId}|${dhPub}`)
      )
    ).slice(0, 16)
  )

/** Why a body didn't parse: `too_large` for a record or put over its cap. */
export type SpacesParseError = 'bad_request' | 'too_large'

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: SpacesParseError }

const parsed = <T>(value: T): Parsed<T> => ({ ok: true, value })
const refused = (error: SpacesParseError = 'bad_request'): Parsed<never> => ({
  ok: false,
  error,
})

/** A member op's credentials, as the client sends them. */
export interface MemberFields {
  spaceId: string
  memberId: string
  /** The member token's 32 bytes; only its SHA-256 reaches the space DO. */
  token: Uint8Array
}

const memberFields = (body: Record<string, unknown>): MemberFields | null => {
  const token = bytes32(body.token)
  return isId(body.spaceId) && isId(body.memberId) && token
    ? { spaceId: body.spaceId, memberId: body.memberId, token }
    : null
}

export interface CreateFields {
  spaceId: string
  memberId: string
  /** The member's X25519 public key, which `memberId` commits to. */
  dhPub: string
  tokenHash: string
  wrap: string
}

export interface SyncFields extends MemberFields {
  since: number
  limit: number
}

export interface PutRecord {
  recordId: string
  epoch: number
  stamp: number
  deleted: boolean
  blob: string
}

export interface PutFields extends MemberFields {
  records: PutRecord[]
}

export interface InviteCreateFields extends MemberFields {
  inviteId: string
  joinVerifier: string
  expiresAt: number
  /** The epoch of the key the invitation carries; must be current. */
  epoch: number
}

export interface InviteDeleteFields extends MemberFields {
  inviteId: string
}

export interface JoinFields {
  spaceId: string
  inviteId: string
  /** The join secret's 32 bytes; only its SHA-256 reaches the space DO. */
  joinSecret: Uint8Array
  /** The invitation's epoch: a fresh join's must be current. */
  epoch: number
  memberId: string
  /** The member's X25519 public key, which `memberId` commits to. */
  dhPub: string
  tokenHash: string
  wrap: string
}

export interface RemoveFields extends MemberFields {
  removeId: string
}

export interface RekeyWrap {
  memberId: string
  wrap: string
}

/**
 * The record `k.<epoch>` a rekey stores with it: the previous epoch's key,
 * sealed under the new one.
 */
export interface RekeyLink {
  stamp: number
  blob: string
}

export interface RekeyFields extends MemberFields {
  epoch: number
  wraps: RekeyWrap[]
  link: RekeyLink
}

/** The link's record id for a rekey to `epoch`: the owner's, as every `k.` is. */
export const rekeyLinkId = (epoch: number): string => `${KEY_RECORD_PREFIX}${epoch}`

export interface SpacesFields {
  create: CreateFields
  sync: SyncFields
  put: PutFields
  'invite/create': InviteCreateFields
  'invite/delete': InviteDeleteFields
  join: JoinFields
  leave: MemberFields
  'member/remove': RemoveFields
  rekey: RekeyFields
  delete: MemberFields
}

const withMember = <T extends object>(
  body: Record<string, unknown>,
  rest: (member: MemberFields) => T | null
): T | null => {
  const member = memberFields(body)
  return member ? rest(member) : null
}

const asParsed = <T>(value: T | null): Parsed<T> =>
  value ? parsed(value) : refused()

const parseRecord = (
  value: unknown,
  now: number
): Parsed<PutRecord> => {
  if (!isPlainObject(value)) return refused()
  const { recordId, epoch, stamp, deleted, blob } = value
  if (
    typeof recordId !== 'string' ||
    !SPACES_RECORD_ID_PATTERN.test(recordId) ||
    !isSafeInteger(epoch) ||
    epoch < 1 ||
    !isSafeInteger(stamp) ||
    stamp < 0 ||
    stamp > now + SPACES_LIMITS.stampSkewMs ||
    (deleted !== undefined && typeof deleted !== 'boolean') ||
    !isB64u(blob)
  )
    return refused()
  if (decodedLength(blob) > SPACES_LIMITS.blobBytes) return refused('too_large')
  return parsed({ recordId, epoch, stamp, deleted: deleted === true, blob })
}

const parsePut = (
  body: Record<string, unknown>,
  now: number
): Parsed<PutFields> => {
  const member = memberFields(body)
  const { records } = body
  if (!member || !Array.isArray(records) || records.length === 0)
    return refused()
  if (records.length > SPACES_LIMITS.putRecords) return refused('too_large')
  const out: PutRecord[] = []
  let tooLarge = false
  for (const record of records) {
    const result = parseRecord(record, now)
    if (!result.ok) {
      if (result.error === 'bad_request') return result
      tooLarge = true
      continue
    }
    out.push(result.value)
  }
  return tooLarge ? refused('too_large') : parsed({ ...member, records: out })
}

const parseWraps = (wraps: unknown): RekeyWrap[] | null => {
  // Empty is well formed: the owner is always a member, so the space answers
  // `conflict`, as for any list that misses one.
  if (!Array.isArray(wraps) || wraps.length > SPACES_LIMITS.maxMembersCeiling)
    return null
  const out: RekeyWrap[] = []
  const named = new Set<string>()
  for (const entry of wraps) {
    if (!isPlainObject(entry) || !isId(entry.memberId) || !isWrap(entry.wrap))
      return null
    // Naming a member twice is malformed; naming the wrong ones is the
    // space's `conflict` to answer.
    if (named.has(entry.memberId)) return null
    named.add(entry.memberId)
    out.push({ memberId: entry.memberId, wrap: entry.wrap })
  }
  return out
}

/**
 * `rekey`: the epoch (2 or later), the wraps, and `link`, checked as `put`
 * checks a record (`too_large` for its blob, `bad_request` for a stamp more
 * than 24 h ahead). Anything else malformed is `bad_request` first.
 */
const parseRekey = (
  body: Record<string, unknown>,
  now: number
): Parsed<RekeyFields> => {
  const member = memberFields(body)
  const { epoch, link } = body
  const wraps = parseWraps(body.wraps)
  if (!member || !isSafeInteger(epoch) || epoch < 2 || !wraps || !isPlainObject(link))
    return refused()
  const record = parseRecord(
    { recordId: rekeyLinkId(epoch), epoch, stamp: link.stamp, blob: link.blob },
    now
  )
  if (!record.ok) return record
  return parsed({
    ...member,
    epoch,
    wraps,
    link: { stamp: record.value.stamp, blob: record.value.blob },
  })
}

type Parsers = {
  [K in SpacesOp]: (body: Record<string, unknown>, now: number) => Parsed<SpacesFields[K]>
}

/**
 * Each op's body parser. Ids, tokens, keys, and hashes must be canonical; a
 * blob over its cap (a rekey's link included), or a put over 100 records, is
 * `too_large`; anything else malformed (a `stamp` more than 24 h past `now`,
 * or a rekey naming a member twice, included) is `bad_request`. `expiresAt`
 * is checked against `now` too. Whether `memberId` matches `dhPub` is
 * checked after parsing (`spacesMemberId`), since it takes a hash.
 */
export const SPACES_FIELD_PARSERS: Parsers = {
  create: (body) =>
    asParsed(
      isId(body.spaceId) &&
        isId(body.memberId) &&
        isDhPub(body.dhPub) &&
        isHash(body.tokenHash) &&
        isWrap(body.wrap)
        ? {
            spaceId: body.spaceId,
            memberId: body.memberId,
            dhPub: body.dhPub,
            tokenHash: body.tokenHash,
            wrap: body.wrap,
          }
        : null
    ),
  sync: (body) =>
    asParsed(
      withMember(body, (member) => {
        const { since, limit } = body
        if (!isSafeInteger(since) || since < 0) return null
        if (
          limit !== undefined &&
          (!isSafeInteger(limit) || limit < 1 || limit > SPACES_LIMITS.syncRecords)
        )
          return null
        return {
          ...member,
          since,
          limit: (limit as number | undefined) ?? SPACES_LIMITS.syncRecords,
        }
      })
    ),
  put: parsePut,
  'invite/create': (body, now) =>
    asParsed(
      withMember(body, (member) => {
        const { inviteId, joinVerifier, expiresAt, epoch } = body
        if (!isId(inviteId) || !isHash(joinVerifier)) return null
        if (!isSafeInteger(epoch) || epoch < 1) return null
        if (
          !isSafeInteger(expiresAt) ||
          expiresAt <= now ||
          expiresAt > now + SPACES_LIMITS.maxInviteLifetimeMs
        )
          return null
        return { ...member, inviteId, joinVerifier, expiresAt, epoch }
      })
    ),
  'invite/delete': (body) =>
    asParsed(
      withMember(body, (member) =>
        isId(body.inviteId) ? { ...member, inviteId: body.inviteId } : null
      )
    ),
  join: (body) => {
    const joinSecret = bytes32(body.joinSecret)
    const { epoch } = body
    return asParsed(
      isId(body.spaceId) &&
        isId(body.inviteId) &&
        joinSecret &&
        isSafeInteger(epoch) &&
        epoch >= 1 &&
        isId(body.memberId) &&
        isDhPub(body.dhPub) &&
        isHash(body.tokenHash) &&
        isWrap(body.wrap)
        ? {
            spaceId: body.spaceId,
            inviteId: body.inviteId,
            joinSecret,
            epoch,
            memberId: body.memberId,
            dhPub: body.dhPub,
            tokenHash: body.tokenHash,
            wrap: body.wrap,
          }
        : null
    )
  },
  leave: (body) => asParsed(memberFields(body)),
  'member/remove': (body) =>
    asParsed(
      withMember(body, (member) =>
        isId(body.removeId) ? { ...member, removeId: body.removeId } : null
      )
    ),
  rekey: parseRekey,
  delete: (body) => asParsed(memberFields(body)),
}

/** The body's size cap for `op`, checked before it's parsed. */
export const spacesBodyLimit = (op: SpacesOp): number =>
  op === 'put' ? SPACES_LIMITS.putBytes : SPACES_LIMITS.requestBytes

/**
 * The live upgrade's member: `x-ww-space-auth` is `b64u(UTF-8 JSON {
 * spaceId, memberId })` (at most `liveHeaderChars`), and `x-ww-space-token`
 * is `b64u(token)`. Null when either is missing or malformed.
 */
export const parseLiveHeaders = (
  space: string | null,
  token: string | null
): MemberFields | null => {
  if (space == null || !isB64u(space) || space.length > SPACES_LIMITS.liveHeaderChars)
    return null
  const bytes = decodeB64u(space)
  const tokenBytes = bytes32(token)
  if (!bytes || !tokenBytes) return null
  let body: unknown
  try {
    body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    )
  } catch {
    // Never surface the parser message: V8 quotes the offending input.
    return null
  }
  return isPlainObject(body) && isId(body.spaceId) && isId(body.memberId)
    ? { spaceId: body.spaceId, memberId: body.memberId, token: tokenBytes }
    : null
}

/** The verified live upgrade the Worker hands the space DO. */
export interface LiveMember {
  spaceId: string
  memberId: string
  tokenHash: string
  /** The member cap right now (KV `spaces:maxMembers`), which sets the socket cap. */
  maxMembers: number
}

export const encodeLiveMember = (member: LiveMember): string =>
  JSON.stringify(member)

export const decodeLiveMember = (value: string | null): LiveMember | null => {
  if (value == null) return null
  let body: unknown
  try {
    body = JSON.parse(value)
  } catch {
    return null
  }
  return isPlainObject(body) &&
    isId(body.spaceId) &&
    isId(body.memberId) &&
    isHash(body.tokenHash) &&
    isSafeInteger(body.maxMembers) &&
    body.maxMembers >= 1 &&
    body.maxMembers <= SPACES_LIMITS.maxMembersCeiling
    ? {
        spaceId: body.spaceId,
        memberId: body.memberId,
        tokenHash: body.tokenHash,
        maxMembers: body.maxMembers,
      }
    : null
}
