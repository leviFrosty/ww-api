/**
 * Cloud Sync's wire constants (witness-work ADR 0030, `docs/accounts-protocol.md`,
 * "Sync"): slot ids, R2 keys, headers, the live socket's messages, and the
 * abuse limits, each sized from the heaviest real use.
 */
import { LIVE_EXPIRED_CLOSE } from '../liveSubprotocol'

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const DAY_MS = 24 * 60 * MINUTE_MS
const MIB = 1_024 * 1_024

export const SYNC_LIMITS = {
  /** One snapshot: backup's cap. Real datasets with notes run to a few MiB. */
  blobBytes: 20 * MIB,
  /**
   * Slots an account: 10 live sessions plus devices that left within the
   * 30-day retention, with room to spare.
   */
  slots: 20,
  /**
   * One put a slot this often. The engine debounces pushes by 5 s, so a
   * device typing without pause puts every 5 s; retries back off from 5 s.
   */
  slotPutIntervalMs: 2 * SECOND_MS,
  /**
   * Puts an account a rolling day: 5 devices each pushing every 5 s for an
   * hour straight is 3,600; a real heavy day is ~100 a device (~500), so
   * this only stops runaway clients. Refusals tell the client when to retry.
   */
  accountPutsPerDay: 1_000,
  /** Bytes an account a rolling day: those ~500 puts at ~4 MiB ≈ 2 GiB. */
  accountBytesPerDay: 2 * 1_024 * MIB,
  /** A put whose commit never came (the Worker died) frees its slot after this. */
  putReservationMs: 2 * MINUTE_MS,
  /** Live sockets an account: one a device, 10 sessions, twice over. */
  liveSockets: 20,
  /** A slot whose writer's session ended is kept this long after its last put. */
  endedSessionRetentionMs: 30 * DAY_MS,
  /** Any slot is kept at most this long after its last put (R2's rule too). */
  maxRetentionMs: 400 * DAY_MS,
  /** The retention alarm's period while the account has slots. */
  retentionCheckMs: DAY_MS,
} as const

/** The device's sync id: the `<deviceId>` in `witness-work-<deviceId>.json`. */
export const SYNC_SLOT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export const isSyncSlotId = (value: unknown): value is string =>
  typeof value === 'string' && SYNC_SLOT_ID_PATTERN.test(value)

/** `b64u(SHA-256(blob))`, the slot's ETag. */
export const SYNC_ETAG_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const syncPrefix = (accountId: string): string => `v1/${accountId}/`

export const syncObjectKey = (accountId: string, slotId: string): string =>
  `${syncPrefix(accountId)}${slotId}`

export const SYNC_HEADERS = {
  slotId: 'x-ww-slot-id',
  sha256: 'x-ww-sha256',
  updatedAt: 'x-ww-updated-at',
  /**
   * The verified account on a live upgrade the Worker forwards to the DO.
   * Set only by the Worker, from a valid token; any client copy is dropped.
   */
  account: 'x-ww-sync-account',
  /**
   * A browser socket's token expiry (epoch ms) on the upgrade the Worker
   * forwards; the DO closes the socket then. Set only by the Worker; any
   * client copy is dropped, so a native socket never has one.
   */
  expiresAt: 'x-ww-sync-expires-at',
} as const

/** Live socket messages: change notices only, never data. */
export type SyncLiveMessage = { type: 'hello' | 'changed'; seq: number }

export const SYNC_LIVE_CLOSE = {
  replaced: { code: 4000, reason: 'replaced' },
  /** A browser socket's token expired (`LIVE_EXPIRED_CLOSE`). */
  expired: LIVE_EXPIRED_CLOSE,
} as const

/** `If-Match`: a quoted ETag, or `*` (the slot exists). */
export type SyncIfMatch = { etag: string } | { any: true } | null

/** Null without the header; undefined when it's malformed. */
export const parseIfMatch = (header: string | null): SyncIfMatch | undefined => {
  if (header == null) return null
  const value = header.trim()
  if (value === '*') return { any: true }
  const match = /^(?:W\/)?"([A-Za-z0-9_-]{43})"$/.exec(value)
  return match ? { etag: match[1] } : undefined
}
