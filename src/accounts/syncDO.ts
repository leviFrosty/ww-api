import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import { captureFailure } from '../sentry'
import {
  BUDDIES_LIMITS,
  fail,
  ok,
  type BuddiesFailure,
  type BuddiesResult,
} from '../buddies/contracts'
import { isWebSocketUpgrade } from '../buddies/envelope'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import { logLimitHit } from '../buddies/limits'
import {
  closeExpiredSockets,
  readLiveExpiry,
  readLiveTicketHash,
  isTicketOpen,
  LIVE_TICKET_HEADER,
  soonestSocketExpiry,
} from '../liveSubprotocol'
import { accountsDb } from './store'
import { isSessionLive, listLiveSessions } from './sessionStore'
import type { SessionPlatform } from './schema'
import {
  SYNC_HEADERS,
  SYNC_LIMITS,
  SYNC_LIVE_CLOSE,
  SYNC_PHOTO_LIMITS,
  isSyncSlotId,
  syncObjectKey,
  syncPhotoLimitBytes,
  syncPhotoObjectKey,
  syncPrefix,
  type SyncIfMatch,
  type SyncLiveMessage,
  type SyncPhotoListed,
  type SyncPhotoUsage,
  type SyncPhotoView,
} from './syncContracts'

/**
 * Cloud Sync's per-account index (witness-work ADR 0030): one SQLite Durable
 * Object per account id. It holds each slot's metadata (slot id, ETag, size,
 * server time of the last put, the session that wrote it), the account's
 * change `seq`, the put limits, and the devices' live sockets. The ciphertext
 * is in R2 (`ACCOUNT_SYNC`) at `v1/<accountId>/<slotId>`.
 *
 * A put is three steps so the metadata never names bytes R2 doesn't have:
 * `beginPut` checks the limits and `If-Match` and reserves the slot (one put
 * a slot at a time), the Worker writes R2, then `commitPut` records the slot,
 * advances `seq`, and tells the account's other sockets. A put whose commit
 * never comes frees the slot after `putReservationMs`; the daily alarm
 * deletes any object no slot names.
 *
 * Retention (the daily alarm): a slot not written for 30 days whose writer's
 * session has ended, and any slot not written for 400 days, is deleted.
 *
 * The alarm also closes browser sockets when their token expires. One alarm
 * serves both, so it's set for the sooner of the next retention run (kept in
 * `alarm_schedule`) and the soonest socket expiry, and each run does only
 * what's due.
 *
 * It also holds the account's Cloud Sync request (witness-work ADR 0040 §5):
 * the time a browser asked the account's phones to switch to Cloud Sync. It
 * clears itself once every live phone session has written a slot since then,
 * or `requestLapseMs` after it was last asked for; a browser can withdraw it.
 *
 * Photos (witness-work ADR 0040 §6): a row per name (size, digest, sealed
 * meta, the current put's id, times), the account's live usage, the photo
 * reservations, the purge queue, and the photo rate counters. Each put's
 * blob is in R2 (`ACCOUNT_PHOTOS`) at `v1/<accountId>/<name>/<putId>`, so no
 * two puts share an object. A put reserves its size before its body is read
 * (`beginPhotoPut`), the Worker writes R2, and `commitPhotoPut` checks the
 * limit again and makes the name live. A delete marks the row and queues
 * that put's object; the daily alarm purges it 30 days later, so a re-put of
 * the name (a new object) can't be purged. A delete during an upload cancels
 * its reservation: the commit answers `conflict` and deletes its object.
 *
 * Privacy: nothing here logs or reports ids, sessions, names, metas, digests,
 * sizes, or bytes.
 */

type SlotRow = {
  slotId: string
  etag: string
  size: number
  updatedAt: number
  sessionId: string
}

/** A slot as `list` gives it to the Worker, which adds the session's state. */
export type SyncSlotListed = SyncSlotView & {
  sessionId: string
  /** The writing session's platform; null for slots put before it was kept. */
  platform: SessionPlatform | null
}

export type SyncSlotView = {
  slotId: string
  etag: string
  size: number
  updatedAt: number
}

export interface BeginSyncPutArgs {
  accountId: string
  slotId: string
  size: number
  ifMatch: SyncIfMatch
  /** A re-seal (`x-ww-reseal`): the slot must exist, and keeps its writer. */
  reseal?: boolean
}

export interface CommitSyncPutArgs {
  accountId: string
  slotId: string
  reservation: string
  /** Keep the slot's session, platform, and `updatedAt` (`beginPut`'s). */
  reseal?: boolean
  etag: string
  size: number
  updatedAt: number
  sessionId: string
  platform: SessionPlatform
}

export interface SyncPutView {
  etag: string
  size: number
  updatedAt: number
  seq: number
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
    singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
    account_id TEXT NOT NULL,
    seq        INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slot (
    slot_id    TEXT PRIMARY KEY,
    etag       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    session_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reservation (
    slot_id TEXT PRIMARY KEY,
    token   TEXT NOT NULL,
    at      INTEGER NOT NULL,
    is_new  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS put_log (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at    INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  )`,
  // When retention runs next (null: not scheduled). An object from before
  // this table has an alarm that is retention's alone; see #retentionAt.
  `CREATE TABLE IF NOT EXISTS alarm_schedule (
    singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
    retention_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sync_request (
    singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
    requested_at INTEGER NOT NULL,
    asked_at     INTEGER NOT NULL
  )`,
  // Nonces of envelopes that set the request, kept past their `ts` window.
  `CREATE TABLE IF NOT EXISTS request_nonce (
    nonce TEXT PRIMARY KEY,
    at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS photo (
    name       TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    meta       TEXT NOT NULL,
    put_id     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS photo_reservation (
    name      TEXT PRIMARY KEY,
    put_id    TEXT NOT NULL,
    at        INTEGER NOT NULL,
    size      INTEGER NOT NULL,
    sha256    TEXT NOT NULL,
    meta      TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0
  )`,
  // A deleted put's object, purged `deletedRetentionMs` after the delete.
  `CREATE TABLE IF NOT EXISTS photo_purge (
    put_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    deleted_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS photo_purge_due ON photo_purge (deleted_at)',
  // Live usage, since when the account has had no slot, and whether an
  // abandoned put may have left an object behind.
  `CREATE TABLE IF NOT EXISTS photo_state (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    bytes         INTEGER NOT NULL,
    count         INTEGER NOT NULL,
    no_slot_since INTEGER,
    sweep         INTEGER NOT NULL DEFAULT 0
  )`,
  // Rolling-day counters in one-minute buckets: `put` (count and stored bytes), `get`.
  `CREATE TABLE IF NOT EXISTS photo_rate (
    kind   TEXT NOT NULL,
    minute INTEGER NOT NULL,
    n      INTEGER NOT NULL,
    bytes  INTEGER NOT NULL,
    PRIMARY KEY (kind, minute)
  )`,
]


type PhotoRow = SyncPhotoListed & { putId: string; deletedAt: number | null }

type PhotoReservationRow = {
  putId: string
  at: number
  size: number
  sha256: string
  meta: string
  cancelled: number
}

/** A refusal; `storage_full` carries the usage. */
export type SyncPhotoFailure = BuddiesFailure & { usage?: SyncPhotoUsage }

export type BeginSyncPhotoPut =
  | {
      ok: true
      value:
        | { existed: SyncPhotoView; usage: SyncPhotoUsage }
        | { reservation: string }
    }
  | SyncPhotoFailure

export type CommitSyncPhotoPut =
  | { ok: true; value: { photo: SyncPhotoView; usage: SyncPhotoUsage } }
  | SyncPhotoFailure

const MINUTE_MS = 60_000

const photoView = (row: SyncPhotoView): SyncPhotoView => ({
  name: row.name,
  size: row.size,
  sha256: row.sha256,
  createdAt: row.createdAt,
})

/** `?, ?, …` for `count` bindings. */
const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ')

/** Columns added to a table after it shipped: `[table, column, definition]`. */
const ADDED_COLUMNS = [['slot', 'platform', 'TEXT']] as const

/** Sessions that can switch to Cloud Sync when the account asks. */
const PHONE_PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android', 'dev'])

const DAY_MS = 24 * 60 * 60_000

/** `WebSocket.READY_STATE_OPEN`. */
const SOCKET_OPEN = 1

/**
 * Stored on each live socket; survives hibernation. `expiresAt` (epoch ms)
 * is a browser socket's token expiry and `ticket` its ticket's hash
 * (`LIVE_TICKET_HEADER`); native sockets have neither.
 */
type LiveAttachment = {
  openedAt: number
  slotId: string
  expiresAt?: number
  ticket?: string
}

const attachmentOf = (ws: WebSocket): LiveAttachment | null =>
  (ws.deserializeAttachment() as LiveAttachment | null) ?? null

const expiryOf = (ws: WebSocket): number | null =>
  attachmentOf(ws)?.expiresAt ?? null

const ticketOf = (ws: WebSocket): string | null =>
  attachmentOf(ws)?.ticket ?? null

const closeQuietly = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // Already closing or gone.
  }
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1_000))

const failure = (result: BuddiesFailure): Response =>
  buddiesErrorResponse(result.error, {
    retryAfterSeconds: result.retryAfterSeconds,
  })

export class AccountSync extends DurableObject<Environment> {
  #schemaReady = false

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env)
    // Keepalives get their answer from the runtime without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    )
  }

  // --- Puts ----------------------------------------------------------------

  /**
   * Checks a put's limits and `If-Match` and reserves the slot for it. Every
   * put admitted here counts against the account's daily budget, whether or
   * not it commits.
   */
  async beginPut(
    args: BeginSyncPutArgs
  ): Promise<BuddiesResult<{ reservation: string; updatedAt: number | null }>> {
    const now = Date.now()
    return this.ctx.storage.transactionSync(() => {
      this.#ensure(args.accountId)
      this.#dropExpiredReservations(now)
      const existing = this.#slot(args.slotId)
      const reserved = this.#reservation(args.slotId)
      if (reserved) {
        logLimitHit('sync/put', 'slotInFlight')
        return fail(
          'rate_limited',
          seconds(reserved.at + SYNC_LIMITS.putReservationMs - now)
        )
      }
      if (existing) {
        const wait = existing.updatedAt + SYNC_LIMITS.slotPutIntervalMs - now
        if (wait > 0) {
          logLimitHit('sync/put', 'slotPutInterval')
          return fail('rate_limited', seconds(wait))
        }
      }
      if (args.ifMatch) {
        const matches =
          existing != null &&
          ('any' in args.ifMatch || existing.etag === args.ifMatch.etag)
        if (!matches) return fail('precondition_failed')
      }
      // A re-seal replaces a slot's bytes, never makes one.
      if (args.reseal && !existing) return fail('precondition_failed')
      if (!existing) {
        const slots =
          this.#count('SELECT COUNT(*) AS n FROM slot') +
          this.#count('SELECT COUNT(*) AS n FROM reservation WHERE is_new = 1')
        if (slots >= SYNC_LIMITS.slots) {
          logLimitHit('sync/put', 'slots')
          return fail('limit')
        }
      }
      const budget = this.#refuseOverDailyBudget(args.size, now)
      if (budget) return budget
      const reservation = crypto.randomUUID()
      this.#sql.exec(
        'INSERT INTO put_log (at, bytes) VALUES (?, ?)',
        now,
        args.size
      )
      this.#sql.exec(
        'INSERT INTO reservation (slot_id, token, at, is_new) VALUES (?, ?, ?, ?)',
        args.slotId,
        reservation,
        now,
        existing ? 0 : 1
      )
      return ok({
        reservation,
        updatedAt: args.reseal ? existing!.updatedAt : null,
      })
    })
  }

  /**
   * Records the slot the Worker just wrote to R2, advances `seq`, and tells
   * the account's other sockets. `conflict` when the reservation is gone (it
   * expired, or the slot was deleted meanwhile); then an object no slot names
   * is deleted here.
   */
  async commitPut(args: CommitSyncPutArgs): Promise<BuddiesResult<SyncPutView>> {
    const result = this.ctx.storage.transactionSync(
      (): BuddiesResult<SyncPutView> => {
        this.#ensure(args.accountId)
        const reserved = this.#reservation(args.slotId)
        if (!reserved || reserved.token !== args.reservation)
          return fail('conflict')
        this.#sql.exec('DELETE FROM reservation WHERE slot_id = ?', args.slotId)
        if (args.reseal) {
          // The same slot under a new account key: its writer and time stay,
          // so retention and the Cloud Sync request see no new write.
          const existing = this.#slot(args.slotId)
          if (!existing) return fail('conflict')
          this.#sql.exec(
            'UPDATE slot SET etag = ?, size = ? WHERE slot_id = ?',
            args.etag,
            args.size,
            args.slotId
          )
          return ok({
            etag: args.etag,
            size: args.size,
            updatedAt: existing.updatedAt,
            seq: this.#advance(),
          })
        }
        this.#sql.exec(
          `INSERT INTO slot (slot_id, etag, size, updated_at, session_id, platform)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (slot_id) DO UPDATE SET
             etag = excluded.etag, size = excluded.size,
             updated_at = excluded.updated_at, session_id = excluded.session_id,
             platform = excluded.platform`,
          args.slotId,
          args.etag,
          args.size,
          args.updatedAt,
          args.sessionId,
          args.platform
        )
        // A slot put restarts the no-slot day.
        this.#sql.exec('UPDATE photo_state SET no_slot_since = NULL')
        const seq = this.#advance()
        return ok({
          etag: args.etag,
          size: args.size,
          updatedAt: args.updatedAt,
          seq,
        })
      }
    )
    if (!result.ok) {
      await this.#deleteUnnamedObject(args.accountId, args.slotId)
      return result
    }
    this.#broadcast(result.value.seq, args.slotId)
    await this.#ensureAlarm()
    return result
  }

  /** Frees a reservation whose R2 write failed. */
  async abortPut(args: { slotId: string; reservation: string }): Promise<void> {
    if (!this.#ready()) return
    this.#sql.exec(
      'DELETE FROM reservation WHERE slot_id = ? AND token = ?',
      args.slotId,
      args.reservation
    )
  }

  // --- Reads ---------------------------------------------------------------

  async list(): Promise<{ seq: number; slots: SyncSlotListed[] }> {
    if (!this.#ready()) return { seq: 0, slots: [] }
    const slots = this.#sql
      .exec<SyncSlotListed>(
        `SELECT slot_id AS slotId, etag, size, updated_at AS updatedAt,
                session_id AS sessionId, platform
         FROM slot ORDER BY slot_id`
      )
      .toArray()
    return { seq: this.#seq(), slots }
  }

  // --- Deletes -------------------------------------------------------------

  /**
   * Deletes one slot, or every slot without `slotId`, objects first, then
   * the rows (so a failed R2 delete leaves the slot listed, to try again).
   * Idempotent. Tells every socket when anything went.
   */
  async deleteSlots(args: {
    accountId: string
    slotId: string | null
  }): Promise<{ seq: number }> {
    this.#ensure(args.accountId)
    const bucket = this.env.ACCOUNT_SYNC
    const rows =
      args.slotId == null
        ? this.#slots().map((slot) => slot.slotId)
        : this.#slot(args.slotId)
          ? [args.slotId]
          : []
    const keys = new Set(rows.map((id) => syncObjectKey(args.accountId, id)))
    if (args.slotId != null) keys.add(syncObjectKey(args.accountId, args.slotId))
    else if (bucket)
      for (const key of await this.#listObjectKeys(bucket, args.accountId))
        keys.add(key)
    if (bucket) await this.#deleteObjects(bucket, [...keys])
    const now = Date.now()
    const seq = this.ctx.storage.transactionSync(() => {
      for (const id of rows) {
        this.#sql.exec('DELETE FROM slot WHERE slot_id = ?', id)
        this.#sql.exec('DELETE FROM reservation WHERE slot_id = ?', id)
      }
      // Every slot takes every photo with it (Delete Buddies on the last device).
      const photos = args.slotId == null ? this.#softDeletePhotos(null, now) : 0
      this.#markIfNoSlot(now)
      return rows.length || photos ? this.#advance() : null
    })
    if (seq == null) return { seq: this.#seq() }
    this.#broadcast(seq, null)
    await this.#ensureAlarm()
    return { seq }
  }

  // --- Photos --------------------------------------------------------------

  /**
   * Starts a photo put: counts it against the day's puts, answers `existed`
   * for a live name (nothing written), else checks the limits and reserves
   * the put's size and the name (one put a name at a time).
   */
  async beginPhotoPut(args: {
    accountId: string
    name: string
    size: number
    sha256: string
    meta: string
  }): Promise<BeginSyncPhotoPut> {
    const now = Date.now()
    const limit = syncPhotoLimitBytes(this.env)
    return this.ctx.storage.transactionSync((): BeginSyncPhotoPut => {
      this.#ensure(args.accountId)
      this.#dropExpiredPhotoReservations(now)
      const puts = this.#photoRate('put', now)
      if (puts.n >= SYNC_PHOTO_LIMITS.accountPutsPerDay) {
        logLimitHit('sync/photos/put', 'accountPutsPerDay')
        return fail('rate_limited', puts.retryAfter('n', 1))
      }
      const live = this.#photo(args.name)
      if (live && live.deletedAt == null) {
        // It counts as a put, adding no bytes.
        this.#countPhotoRate('put', now, 1, 0)
        return ok({ existed: photoView(live), usage: this.#photoUsage(limit) })
      }
      const reserved = this.#photoReservation(args.name)
      if (reserved) {
        logLimitHit('sync/photos/put', 'nameInFlight')
        return fail(
          'rate_limited',
          seconds(reserved.at + SYNC_PHOTO_LIMITS.putReservationMs - now)
        )
      }
      if (this.#count('SELECT COUNT(*) AS n FROM slot') === 0)
        return fail('no_slot')
      const usage = this.#photoUsage(limit)
      // A put a delete cancelled will never store.
      const pending = this.#sql
        .exec<{ n: number; bytes: number }>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
           FROM photo_reservation WHERE cancelled = 0`
        )
        .one()
      if (usage.count + pending.n >= SYNC_PHOTO_LIMITS.livePhotos) {
        logLimitHit('sync/photos/put', 'livePhotos')
        return fail('limit')
      }
      if (usage.bytes + pending.bytes + args.size > limit) {
        logLimitHit('sync/photos/put', 'storage')
        return { ...fail('storage_full'), usage }
      }
      const overBytes =
        puts.bytes + pending.bytes + args.size -
        SYNC_PHOTO_LIMITS.accountPutBytesPerDay
      if (overBytes > 0) {
        logLimitHit('sync/photos/put', 'accountPutBytesPerDay')
        return fail('rate_limited', puts.retryAfter('bytes', overBytes))
      }
      this.#countPhotoRate('put', now, 1, 0)
      const putId = crypto.randomUUID()
      this.#sql.exec(
        `INSERT INTO photo_reservation (name, put_id, at, size, sha256, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        args.name,
        putId,
        now,
        args.size,
        args.sha256,
        args.meta
      )
      return ok({ reservation: putId })
    })
  }

  /**
   * Makes the name live with the object the Worker just wrote, checks the
   * limit again, advances `seq`, and tells the other sockets. `conflict`
   * when the reservation is gone (it lapsed) or a delete cancelled it; then,
   * and on any refusal, that put's object is deleted here.
   */
  async commitPhotoPut(args: {
    accountId: string
    name: string
    reservation: string
    exceptSlot?: string | null
  }): Promise<CommitSyncPhotoPut> {
    const now = Date.now()
    const limit = syncPhotoLimitBytes(this.env)
    const result = this.ctx.storage.transactionSync(
      (): CommitSyncPhotoPut & { seq?: number } => {
        this.#ensure(args.accountId)
        const reserved = this.#photoReservation(args.name)
        if (!reserved || reserved.putId !== args.reservation)
          return fail('conflict')
        this.#sql.exec('DELETE FROM photo_reservation WHERE name = ?', args.name)
        if (
          reserved.cancelled ||
          now - reserved.at > SYNC_PHOTO_LIMITS.putReservationMs
        )
          return fail('conflict')
        if (this.#count('SELECT COUNT(*) AS n FROM slot') === 0)
          return fail('no_slot')
        const before = this.#photoUsage(limit)
        if (before.bytes + reserved.size > limit) {
          logLimitHit('sync/photos/put', 'storage')
          return { ...fail('storage_full'), usage: before }
        }
        this.#sql.exec(
          `INSERT INTO photo (name, size, sha256, meta, put_id, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (name) DO UPDATE SET
             size = excluded.size, sha256 = excluded.sha256, meta = excluded.meta,
             put_id = excluded.put_id, created_at = excluded.created_at,
             deleted_at = NULL`,
          args.name,
          reserved.size,
          reserved.sha256,
          reserved.meta,
          args.reservation,
          now
        )
        this.#sql.exec(
          'UPDATE photo_state SET bytes = bytes + ?, count = count + 1',
          reserved.size
        )
        this.#countPhotoRate('put', now, 0, reserved.size)
        return {
          ok: true,
          value: {
            photo: {
              name: args.name,
              size: reserved.size,
              sha256: reserved.sha256,
              createdAt: now,
            },
            usage: this.#photoUsage(limit),
          },
          seq: this.#advance(),
        }
      }
    )
    if (!result.ok) {
      await this.#deletePhotoObject(args.accountId, args.name, args.reservation)
      return result
    }
    const { seq, ...committed } = result
    this.#broadcast(seq!, args.exceptSlot ?? null)
    await this.#ensureAlarm()
    return committed
  }

  /**
   * Frees a reservation whose body or R2 write failed. A failed write may
   * still have landed (`wrote`), so the next alarm sweeps.
   */
  async abortPhotoPut(args: {
    name: string
    reservation: string
    wrote?: boolean
  }): Promise<void> {
    if (!this.#ready()) return
    this.#sql.exec(
      'DELETE FROM photo_reservation WHERE name = ? AND put_id = ?',
      args.name,
      args.reservation
    )
    if (args.wrote) this.#requestSweep()
  }

  /** Live photos by name, a page at a time, and the usage. */
  async listPhotos(args: { cursor: string | null }): Promise<{
    photos: SyncPhotoListed[]
    cursor: string | null
    usage: SyncPhotoUsage
  }> {
    const limit = syncPhotoLimitBytes(this.env)
    if (!this.#ready())
      return { photos: [], cursor: null, usage: this.#photoUsage(limit) }
    const page = SYNC_PHOTO_LIMITS.listPage
    const rows = this.#sql
      .exec<SyncPhotoListed>(
        `SELECT name, size, sha256, created_at AS createdAt, meta FROM photo
         WHERE deleted_at IS NULL AND name > ? ORDER BY name LIMIT ?`,
        args.cursor ?? '',
        page + 1
      )
      .toArray()
    const photos = rows.slice(0, page)
    return {
      photos,
      cursor: rows.length > page ? photos[photos.length - 1].name : null,
      usage: this.#photoUsage(limit),
    }
  }

  /**
   * Counts a get against the day's and answers the live photo's object, or
   * `not_found`.
   */
  async photoForGet(args: {
    accountId: string
    name: string
  }): Promise<BuddiesResult<SyncPhotoView & { putId: string }>> {
    if (!this.#ready()) return fail('not_found')
    const now = Date.now()
    return this.ctx.storage.transactionSync(() => {
      this.#ensure(args.accountId)
      const gets = this.#photoRate('get', now)
      if (gets.n >= SYNC_PHOTO_LIMITS.accountGetsPerDay) {
        logLimitHit('sync/photos/get', 'accountGetsPerDay')
        return fail('rate_limited', gets.retryAfter('n', 1))
      }
      this.#countPhotoRate('get', now, 1, 0)
      const row = this.#photo(args.name)
      return row && row.deletedAt == null
        ? ok({ ...photoView(row), putId: row.putId })
        : fail('not_found')
    })
  }

  /**
   * Deletes the named live photos, or every one without `names`: they stop
   * counting at once, and their objects are purged later. Idempotent. A
   * delete that deleted something advances `seq` and tells every socket but
   * `exceptSlot`'s.
   */
  async deletePhotos(args: {
    accountId: string
    names: string[] | null
    exceptSlot?: string | null
  }): Promise<{ usage: SyncPhotoUsage }> {
    const limit = syncPhotoLimitBytes(this.env)
    if (!this.#ready()) return { usage: this.#photoUsage(limit) }
    const now = Date.now()
    const seq = this.ctx.storage.transactionSync(() => {
      this.#ensure(args.accountId)
      return this.#softDeletePhotos(args.names, now) ? this.#advance() : null
    })
    if (seq != null) {
      this.#broadcast(seq, args.exceptSlot ?? null)
      await this.#ensureAlarm()
    }
    return { usage: this.#photoUsage(limit) }
  }

  async photoUsage(): Promise<SyncPhotoUsage> {
    return this.#photoUsage(syncPhotoLimitBytes(this.env))
  }

  // --- The Cloud Sync request ---------------------------------------------

  /**
   * The standing request's time, or null: none, it lapsed, or every live
   * phone session has written a slot since it was made (it clears itself).
   */
  async requestedAt(): Promise<number | null> {
    if (!this.#ready()) return null
    return this.#standingRequest(Date.now())
  }

  /**
   * Sets the request and answers its time. Asking again while it stands
   * keeps that time and restarts its `requestLapseMs`. An envelope is good
   * once: its nonce is kept for twice the `ts` window, and a reuse (a
   * captured envelope replayed, say after the User withdrew it) is `replay`.
   */
  async setRequest(args: {
    accountId: string
    nonce: string
  }): Promise<BuddiesResult<number>> {
    this.#ensure(args.accountId)
    const now = Date.now()
    await this.#standingRequest(now)
    return this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        'DELETE FROM request_nonce WHERE at <= ?',
        now - 2 * BUDDIES_LIMITS.timestampSkewMs
      )
      if (
        this.#count('SELECT COUNT(*) AS n FROM request_nonce WHERE nonce = ?', args.nonce)
      )
        return fail('replay')
      this.#sql.exec(
        'INSERT INTO request_nonce (nonce, at) VALUES (?, ?)',
        args.nonce,
        now
      )
      const kept = this.#requestRow()?.requestedAt ?? now
      this.#sql.exec(
        `INSERT INTO sync_request (singleton, requested_at, asked_at) VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           requested_at = excluded.requested_at, asked_at = excluded.asked_at`,
        kept,
        now
      )
      return ok(kept)
    })
  }

  /** Withdraws the request; idempotent. */
  async clearRequest(): Promise<null> {
    if (this.#ready()) this.#sql.exec('DELETE FROM sync_request')
    return null
  }

  // --- Retention -----------------------------------------------------------

  /**
   * Closes browser sockets whose token expired, then runs retention if it's
   * due, then sets the alarm for whichever comes next.
   */
  async alarm(): Promise<void> {
    if (!this.#ready()) return
    const now = Date.now()
    closeExpiredSockets(this.#liveSockets(), expiryOf, now)
    const retentionAt = this.#retentionAt()
    if (retentionAt !== null && retentionAt <= now) await this.#retain(now)
    await this.#reschedule()
  }

  /**
   * Daily while the account has slots: deletes slots past retention, and
   * objects no slot names (a commit that never came). A failed session read
   * keeps the slot until the next run.
   */
  async #retain(now: number): Promise<void> {
    const accountId = this.#accountId()
    if (!accountId) return this.#setRetentionAt(null)
    const expired: string[] = []
    for (const slot of this.#slots()) {
      const age = now - slot.updatedAt
      if (age > SYNC_LIMITS.maxRetentionMs) expired.push(slot.slotId)
      else if (
        age > SYNC_LIMITS.endedSessionRetentionMs &&
        !(await this.#sessionLive(accountId, slot.sessionId))
      )
        expired.push(slot.slotId)
    }
    const bucket = this.env.ACCOUNT_SYNC
    try {
      if (bucket) {
        await this.#deleteObjects(
          bucket,
          expired.map((id) => syncObjectKey(accountId, id))
        )
        await this.#sweepUnnamedObjects(bucket, accountId, now)
      }
      if (expired.length) {
        const seq = this.ctx.storage.transactionSync(() => {
          for (const id of expired)
            this.#sql.exec('DELETE FROM slot WHERE slot_id = ?', id)
          this.#markIfNoSlot(now)
          return this.#advance()
        })
        this.#broadcast(seq, null)
      }
    } catch (error) {
      console.error('sync: retention failed')
      captureFailure(error, 'sync retention')
    }
    this.#dropExpiredReservations(now)
    this.#sql.exec('DELETE FROM put_log WHERE at <= ?', now - DAY_MS)
    try {
      await this.#photoRetention(accountId, now)
    } catch (error) {
      console.error('sync: photo retention failed')
      captureFailure(error, 'sync photo retention')
    }
    this.#setRetentionAt(
      this.#needsAlarm() ? now + SYNC_LIMITS.retentionCheckMs : null
    )
  }

  // --- Live socket ---------------------------------------------------------

  /**
   * `GET sync/live`, forwarded by the Worker after it verified the token,
   * the switches, and the entitlement: the account in
   * `SYNC_HEADERS.account` (which only the Worker sets) and the device's own
   * slot in `x-ww-slot-id`, so its own puts don't echo back, and for a
   * browser socket its token's expiry in `SYNC_HEADERS.expiresAt`, when the
   * alarm closes it, and its ticket's hash in `LIVE_TICKET_HEADER`: while a
   * socket on that ticket is open, another is 409 `conflict`, so a copied
   * ticket can't push the account's sockets off. Says `hello` with the
   * current `seq`; past the cap the oldest sockets close.
   */
  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return failure(fail('upgrade_required'))
    const accountId = request.headers.get(SYNC_HEADERS.account)
    const slotId = request.headers.get(SYNC_HEADERS.slotId)
    const expiresAt = readLiveExpiry(request.headers.get(SYNC_HEADERS.expiresAt))
    const ticket = readLiveTicketHash(request.headers.get(LIVE_TICKET_HEADER))
    if (
      !accountId ||
      !isSyncSlotId(slotId) ||
      expiresAt === undefined ||
      ticket === undefined
    )
      return failure(fail('bad_request'))
    if (ticket != null && isTicketOpen(this.#liveSockets(), ticket, ticketOf))
      return failure(fail('conflict'))
    this.#ensure(accountId)

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    const attachment: LiveAttachment = {
      openedAt: Date.now(),
      slotId,
      ...(expiresAt == null ? {} : { expiresAt }),
      ...(ticket == null ? {} : { ticket }),
    }
    server.serializeAttachment(attachment)
    const others = this.#liveSockets()
      .filter((ws) => ws !== server)
      .sort((a, b) => (attachmentOf(a)?.openedAt ?? 0) - (attachmentOf(b)?.openedAt ?? 0))
    const excess = others.length + 1 - SYNC_LIMITS.liveSockets
    const { code, reason } = SYNC_LIVE_CLOSE.replaced
    for (const ws of others.slice(0, Math.max(0, excess)))
      closeQuietly(ws, code, reason)
    this.#signal(server, { type: 'hello', seq: this.#seq() })
    if (expiresAt != null) await this.#reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Closes every live socket of the account with `4005 "key_changed"` (ADR
   * 0039), after a key change: the other sessions ended, and the device that
   * changed the key reconnects with its new token.
   */
  async closeForKeyChange(): Promise<void> {
    const { code, reason } = SYNC_LIVE_CLOSE.keyChanged
    for (const ws of this.#liveSockets()) closeQuietly(ws, code, reason)
  }

  /** Sockets only listen; anything but the auto-answered `ping` is ignored. */
  webSocketMessage(): void {}

  /** Completes the close the client started. */
  webSocketClose(ws: WebSocket): void {
    closeQuietly(ws, 1000, '')
  }

  webSocketError(ws: WebSocket): void {
    closeQuietly(ws, 1011, '')
  }

  // --- Helpers -------------------------------------------------------------

  get #sql() {
    return this.ctx.storage.sql
  }

  /**
   * Whether this account was ever used. Its first call in an instance adds
   * tables a newer `SCHEMA` has, so reads of an older object find them.
   */
  #ready(): boolean {
    if (this.#schemaReady) return true
    const found = this.#sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
      )
      .one().n
    if (found > 0) this.#createTables()
    return this.#schemaReady
  }

  #createTables(): void {
    for (const statement of SCHEMA) this.#sql.exec(statement)
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const has = this.#sql
        .exec<{ name: string }>(`PRAGMA table_info(${table})`)
        .toArray()
        .some((row) => row.name === column)
      if (!has)
        this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.#schemaReady = true
  }

  /** Creates the tables and the meta row on first use. */
  #ensure(accountId: string): void {
    if (!this.#schemaReady) this.#createTables()
    this.#sql.exec(
      'INSERT OR IGNORE INTO meta (singleton, account_id, seq) VALUES (1, ?, 0)',
      accountId
    )
    this.#sql.exec(
      'INSERT OR IGNORE INTO photo_state (singleton, bytes, count) VALUES (1, 0, 0)'
    )
  }

  #requestRow(): { requestedAt: number; askedAt: number } | null {
    return (
      this.#sql
        .exec<{ requestedAt: number; askedAt: number }>(
          `SELECT requested_at AS requestedAt, asked_at AS askedAt
           FROM sync_request WHERE singleton = 1`
        )
        .toArray()[0] ?? null
    )
  }

  /** The request's time while it stands; one that lapsed or was met is dropped. */
  async #standingRequest(now: number): Promise<number | null> {
    const row = this.#requestRow()
    if (!row) return null
    const met =
      now - row.askedAt >= SYNC_LIMITS.requestLapseMs ||
      (await this.#everyPhoneWroteSince(row.requestedAt, now))
    if (!met) return row.requestedAt
    // Unless it was withdrawn and asked for anew meanwhile.
    this.#sql.exec(
      'DELETE FROM sync_request WHERE requested_at = ?',
      row.requestedAt
    )
    return null
  }

  /**
   * Whether every live phone session of the account has written a slot
   * since `since`. A failed read says no: the request keeps standing.
   */
  async #everyPhoneWroteSince(since: number, now: number): Promise<boolean> {
    const db = this.env.ACCOUNTS_DB
    const accountId = this.#accountId()
    if (!db || !accountId) return false
    let phones: string[]
    try {
      phones = (await listLiveSessions(accountsDb(db), accountId, now))
        .filter((session) => PHONE_PLATFORMS.has(session.platform))
        .map((session) => session.sessionId)
    } catch (error) {
      console.error('sync: session read failed')
      captureFailure(error, 'sync request sessions')
      return false
    }
    return phones.every(
      (sessionId) =>
        this.#count(
          'SELECT COUNT(*) AS n FROM slot WHERE session_id = ? AND updated_at >= ?',
          sessionId,
          since
        ) > 0
    )
  }

  #accountId(): string | null {
    return (
      this.#sql
        .exec<{ accountId: string }>(
          'SELECT account_id AS accountId FROM meta WHERE singleton = 1'
        )
        .toArray()[0]?.accountId ?? null
    )
  }

  #seq(): number {
    if (!this.#ready()) return 0
    return (
      this.#sql
        .exec<{ seq: number }>('SELECT seq FROM meta WHERE singleton = 1')
        .toArray()[0]?.seq ?? 0
    )
  }

  #advance(): number {
    this.#sql.exec('UPDATE meta SET seq = seq + 1 WHERE singleton = 1')
    return this.#seq()
  }

  #count(query: string, ...bindings: (string | number)[]): number {
    return this.#sql.exec<{ n: number }>(query, ...bindings).one().n
  }

  #slot(slotId: string): SlotRow | null {
    return (
      this.#sql
        .exec<SlotRow>(
          `SELECT slot_id AS slotId, etag, size, updated_at AS updatedAt,
                  session_id AS sessionId
           FROM slot WHERE slot_id = ?`,
          slotId
        )
        .toArray()[0] ?? null
    )
  }

  #slots(): SlotRow[] {
    if (!this.#ready()) return []
    return this.#sql
      .exec<SlotRow>(
        `SELECT slot_id AS slotId, etag, size, updated_at AS updatedAt,
                session_id AS sessionId
         FROM slot`
      )
      .toArray()
  }

  #reservation(slotId: string): { token: string; at: number } | null {
    return (
      this.#sql
        .exec<{ token: string; at: number }>(
          'SELECT token, at FROM reservation WHERE slot_id = ?',
          slotId
        )
        .toArray()[0] ?? null
    )
  }

  #dropExpiredReservations(now: number): void {
    if (!this.#ready()) return
    this.#sql.exec(
      'DELETE FROM reservation WHERE at <= ?',
      now - SYNC_LIMITS.putReservationMs
    )
  }

  /** `rate_limited` until the oldest put of the day ages out, or null. */
  #refuseOverDailyBudget(size: number, now: number): BuddiesFailure | null {
    this.#sql.exec('DELETE FROM put_log WHERE at <= ?', now - DAY_MS)
    const usage = this.#sql
      .exec<{ puts: number; bytes: number | null; oldest: number | null }>(
        'SELECT COUNT(*) AS puts, SUM(bytes) AS bytes, MIN(at) AS oldest FROM put_log'
      )
      .one()
    const overPuts = usage.puts >= SYNC_LIMITS.accountPutsPerDay
    const overBytes = (usage.bytes ?? 0) + size > SYNC_LIMITS.accountBytesPerDay
    if (!overPuts && !overBytes) return null
    logLimitHit('sync/put', overPuts ? 'accountPutsPerDay' : 'accountBytesPerDay')
    return fail('rate_limited', seconds((usage.oldest ?? now) + DAY_MS - now))
  }

  /** Schedules retention a day out, unless it's already scheduled. */
  async #ensureAlarm(): Promise<void> {
    if ((await this.#adoptLegacyAlarm()) == null)
      this.#setRetentionAt(Date.now() + SYNC_LIMITS.retentionCheckMs)
    await this.#reschedule()
  }

  /**
   * When retention runs next. An object from before `alarm_schedule` has
   * no row, and its alarm (if any) was retention's: the row-less answer is
   * "due now", so that alarm, whenever it fires, still runs retention.
   */
  #retentionAt(): number | null {
    const row = this.#sql
      .exec<{ at: number | null }>(
        'SELECT retention_at AS at FROM alarm_schedule WHERE singleton = 1'
      )
      .toArray()[0]
    return row ? row.at : 0
  }

  #setRetentionAt(at: number | null): void {
    this.#sql.exec(
      `INSERT INTO alarm_schedule (singleton, retention_at) VALUES (1, ?)
       ON CONFLICT (singleton) DO UPDATE SET retention_at = excluded.retention_at`,
      at
    )
  }

  /**
   * Writes the schedule row for an object from before it, keeping its
   * pending alarm as the retention time, so an earlier alarm can replace it
   * without losing it. Returns the retention time.
   */
  async #adoptLegacyAlarm(): Promise<number | null> {
    const hasRow =
      this.#count('SELECT COUNT(*) AS n FROM alarm_schedule') > 0
    if (hasRow) return this.#retentionAt()
    const pending = await this.ctx.storage.getAlarm()
    this.#setRetentionAt(pending)
    return pending
  }

  /** Sets the alarm for the sooner of retention and the soonest socket expiry. */
  async #reschedule(): Promise<void> {
    const retentionAt = await this.#adoptLegacyAlarm()
    const expiry = soonestSocketExpiry(this.#liveSockets(), expiryOf)
    const due = [retentionAt, expiry].filter((at) => at != null)
    if (!due.length) return
    const next = Math.min(...due)
    if ((await this.ctx.storage.getAlarm()) !== next)
      await this.ctx.storage.setAlarm(next)
  }

  /** A failed read counts as live: the slot waits for the next run. */
  async #sessionLive(accountId: string, sessionId: string): Promise<boolean> {
    const db = this.env.ACCOUNTS_DB
    if (!db) return true
    try {
      return await isSessionLive(accountsDb(db), accountId, sessionId)
    } catch (error) {
      console.error('sync: session read failed')
      captureFailure(error, 'sync retention session')
      return true
    }
  }

  async #listObjectKeys(bucket: R2Bucket, accountId: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await bucket.list({ prefix: syncPrefix(accountId), cursor })
      for (const object of page.objects) keys.push(object.key)
      if (!page.truncated) return keys
      cursor = page.cursor
    }
  }

  async #deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
    // R2 deletes at most 1,000 keys a call.
    for (let start = 0; start < keys.length; start += 1_000)
      await bucket.delete(keys.slice(start, start + 1_000))
  }

  /** After a failed commit: the object goes unless a slot or put names it. */
  async #deleteUnnamedObject(accountId: string, slotId: string): Promise<void> {
    const bucket = this.env.ACCOUNT_SYNC
    if (!bucket || this.#slot(slotId) || this.#reservation(slotId)) return
    try {
      await bucket.delete(syncObjectKey(accountId, slotId))
    } catch (error) {
      // The daily sweep gets it.
      captureFailure(error, 'sync orphan delete')
    }
  }

  /** Objects no slot names, older than any put that could still commit. */
  async #sweepUnnamedObjects(
    bucket: R2Bucket,
    accountId: string,
    now: number
  ): Promise<void> {
    const prefix = syncPrefix(accountId)
    const orphans: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await bucket.list({ prefix, cursor })
      for (const object of page.objects) {
        const slotId = object.key.slice(prefix.length)
        if (this.#slot(slotId) || this.#reservation(slotId)) continue
        if (now - object.uploaded.getTime() < SYNC_LIMITS.putReservationMs)
          continue
        orphans.push(object.key)
      }
      if (!page.truncated) break
      cursor = page.cursor
    }
    await this.#deleteObjects(bucket, orphans)
  }

  // --- Photo helpers -------------------------------------------------------

  #photo(name: string): PhotoRow | null {
    return (
      this.#sql
        .exec<PhotoRow>(
          `SELECT name, size, sha256, meta, put_id AS putId,
                  created_at AS createdAt, deleted_at AS deletedAt
           FROM photo WHERE name = ?`,
          name
        )
        .toArray()[0] ?? null
    )
  }

  #photoReservation(name: string): PhotoReservationRow | null {
    return (
      this.#sql
        .exec<PhotoReservationRow>(
          `SELECT put_id AS putId, at, size, sha256, meta, cancelled
           FROM photo_reservation WHERE name = ?`,
          name
        )
        .toArray()[0] ?? null
    )
  }

  #photoState(): { bytes: number; count: number; noSlotSince: number | null; sweep: number } {
    return (
      this.#sql
        .exec<{ bytes: number; count: number; noSlotSince: number | null; sweep: number }>(
          `SELECT bytes, count, no_slot_since AS noSlotSince, sweep
           FROM photo_state WHERE singleton = 1`
        )
        .toArray()[0] ?? { bytes: 0, count: 0, noSlotSince: null, sweep: 0 }
    )
  }

  #photoUsage(limit: number): SyncPhotoUsage {
    if (!this.#ready()) return { bytes: 0, count: 0, limit }
    const { bytes, count } = this.#photoState()
    return { bytes, count, limit }
  }

  /**
   * Marks the named live photos (every one without `names`) deleted, queues
   * their objects for the purge, and cancels any put of those names in
   * flight. Answers how many went.
   */
  #softDeletePhotos(names: string[] | null, now: number): number {
    if (names != null && names.length === 0) return 0
    const which = names == null ? '' : ` AND name IN (${placeholders(names.length)})`
    const bindings = names ?? []
    const gone = this.#sql
      .exec<{ n: number; bytes: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM photo
         WHERE deleted_at IS NULL${which}`,
        ...bindings
      )
      .one()
    this.#sql.exec(
      `UPDATE photo_reservation SET cancelled = 1${names == null ? '' : ` WHERE name IN (${placeholders(names.length)})`}`,
      ...bindings
    )
    if (gone.n === 0) return 0
    this.#sql.exec(
      `INSERT OR IGNORE INTO photo_purge (put_id, name, deleted_at)
       SELECT put_id, name, ? FROM photo WHERE deleted_at IS NULL${which}`,
      now,
      ...bindings
    )
    this.#sql.exec(
      `UPDATE photo SET deleted_at = ? WHERE deleted_at IS NULL${which}`,
      now,
      ...bindings
    )
    this.#sql.exec(
      'UPDATE photo_state SET bytes = bytes - ?, count = count - ?',
      gone.bytes,
      gone.n
    )
    return gone.n
  }

  /** Starts the no-slot day when the account's last slot just went. */
  #markIfNoSlot(now: number): void {
    if (this.#count('SELECT COUNT(*) AS n FROM slot') > 0) return
    this.#sql.exec(
      'UPDATE photo_state SET no_slot_since = COALESCE(no_slot_since, ?)',
      now
    )
  }

  /**
   * The rolling day's count and bytes for `kind`, and `retryAfter(field,
   * excess)`: seconds until buckets holding at least `excess` of `field` age
   * out, so a retry then is under the limit.
   */
  #photoRate(
    kind: 'put' | 'get',
    now: number
  ): {
    n: number
    bytes: number
    retryAfter: (field: 'n' | 'bytes', excess: number) => number
  } {
    // A minute bucket ages out once it ended a day ago.
    const oldestKept = Math.floor((now - DAY_MS) / MINUTE_MS)
    this.#sql.exec(
      'DELETE FROM photo_rate WHERE kind = ? AND minute < ?',
      kind,
      oldestKept
    )
    const buckets = this.#sql
      .exec<{ minute: number; n: number; bytes: number }>(
        'SELECT minute, n, bytes FROM photo_rate WHERE kind = ? ORDER BY minute',
        kind
      )
      .toArray()
    const sum = (field: 'n' | 'bytes') =>
      buckets.reduce((total, bucket) => total + bucket[field], 0)
    return {
      n: sum('n'),
      bytes: sum('bytes'),
      retryAfter: (field, excess) => {
        let freed = 0
        for (const bucket of buckets) {
          freed += bucket[field]
          if (freed >= excess)
            return seconds((bucket.minute + 1) * MINUTE_MS + DAY_MS - now)
        }
        // More than the day holds (a single put over the budget): a full day.
        return seconds(DAY_MS)
      },
    }
  }

  #countPhotoRate(kind: 'put' | 'get', now: number, n: number, bytes: number): void {
    this.#sql.exec(
      `INSERT INTO photo_rate (kind, minute, n, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, minute) DO UPDATE SET
         n = n + excluded.n, bytes = bytes + excluded.bytes`,
      kind,
      Math.floor(now / MINUTE_MS),
      n,
      bytes
    )
  }

  /** Frees lapsed reservations; their puts may have left an object behind. */
  #dropExpiredPhotoReservations(now: number): void {
    if (!this.#ready()) return
    const dropped = this.#count(
      'SELECT COUNT(*) AS n FROM photo_reservation WHERE at < ?',
      now - SYNC_PHOTO_LIMITS.putReservationMs
    )
    if (dropped === 0) return
    this.#sql.exec(
      'DELETE FROM photo_reservation WHERE at < ?',
      now - SYNC_PHOTO_LIMITS.putReservationMs
    )
    this.#requestSweep()
  }

  /**
   * Asks the next alarm to sweep. `sweep` is a generation: a sweep clears
   * only the one it started from, never a request made while it ran.
   */
  #requestSweep(): void {
    this.#sql.exec('UPDATE photo_state SET sweep = sweep + 1')
  }

  /** A refused or late put's own object; the sweep gets it if this fails. */
  async #deletePhotoObject(
    accountId: string,
    name: string,
    putId: string
  ): Promise<void> {
    const bucket = this.env.ACCOUNT_PHOTOS
    if (!bucket) return
    try {
      await bucket.delete(syncPhotoObjectKey(accountId, name, putId))
    } catch (error) {
      this.#requestSweep()
      captureFailure(error, 'sync photo orphan delete')
    }
  }

  /**
   * The daily photo pass: deletes every photo of an account with no slot for
   * `noSlotMs` (checked again here, after the slot pass), purges the objects
   * of photos deleted `deletedRetentionMs` ago, and sweeps objects no put
   * names once a put may have been abandoned.
   */
  async #photoRetention(accountId: string, now: number): Promise<void> {
    this.#dropExpiredPhotoReservations(now)
    const seq = this.ctx.storage.transactionSync(() => {
      const state = this.#photoState()
      if (this.#count('SELECT COUNT(*) AS n FROM slot') > 0 || state.count === 0)
        return null
      if (state.noSlotSince == null) {
        this.#markIfNoSlot(now)
        return null
      }
      if (now - state.noSlotSince < SYNC_PHOTO_LIMITS.noSlotMs) return null
      return this.#softDeletePhotos(null, now) ? this.#advance() : null
    })
    if (seq != null) this.#broadcast(seq, null)

    const bucket = this.env.ACCOUNT_PHOTOS
    if (!bucket) return
    const due = this.#sql
      .exec<{ putId: string; name: string }>(
        `SELECT put_id AS putId, name FROM photo_purge WHERE deleted_at <= ?`,
        now - SYNC_PHOTO_LIMITS.deletedRetentionMs
      )
      .toArray()
    if (due.length) {
      await this.#deleteObjects(
        bucket,
        due.map((row) => syncPhotoObjectKey(accountId, row.name, row.putId))
      )
      this.ctx.storage.transactionSync(() => {
        for (const row of due) {
          this.#sql.exec('DELETE FROM photo_purge WHERE put_id = ?', row.putId)
          // Unless the name came back with a new put meanwhile.
          this.#sql.exec(
            'DELETE FROM photo WHERE name = ? AND put_id = ? AND deleted_at IS NOT NULL',
            row.name,
            row.putId
          )
        }
      })
    }
    if (this.#photoState().sweep) await this.#sweepPhotoObjects(bucket, accountId, now)
  }

  /**
   * Objects no row, purge entry, or put in flight names, older than any put
   * that could still commit. Keys are unique per put, so a new put never
   * writes one of these.
   */
  async #sweepPhotoObjects(
    bucket: R2Bucket,
    accountId: string,
    now: number
  ): Promise<void> {
    const prefix = syncPrefix(accountId)
    const generation = this.#photoState().sweep
    let young = false
    let cursor: string | undefined
    for (;;) {
      const page = await bucket.list({ prefix, cursor })
      const orphans: string[] = []
      for (const object of page.objects) {
        const [name, putId] = object.key.slice(prefix.length).split('/')
        if (!putId) continue
        const named =
          this.#count(
            'SELECT COUNT(*) AS n FROM photo WHERE name = ? AND put_id = ?',
            name,
            putId
          ) +
          this.#count('SELECT COUNT(*) AS n FROM photo_purge WHERE put_id = ?', putId) +
          this.#count(
            'SELECT COUNT(*) AS n FROM photo_reservation WHERE put_id = ?',
            putId
          )
        if (named) continue
        if (now - object.uploaded.getTime() < SYNC_PHOTO_LIMITS.putReservationMs) {
          young = true
          continue
        }
        orphans.push(object.key)
      }
      await this.#deleteObjects(bucket, orphans)
      if (!page.truncated) break
      cursor = page.cursor
    }
    if (!young)
      this.#sql.exec('UPDATE photo_state SET sweep = 0 WHERE sweep = ?', generation)
  }

  /** Daily while the account has slots, photos, deleted photos, or puts in flight. */
  #needsAlarm(): boolean {
    const state = this.#photoState()
    return (
      this.#count('SELECT COUNT(*) AS n FROM slot') > 0 ||
      state.count > 0 ||
      state.sweep > 0 ||
      this.#count('SELECT COUNT(*) AS n FROM photo_purge') > 0 ||
      this.#count('SELECT COUNT(*) AS n FROM photo_reservation') > 0
    )
  }

  #liveSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === SOCKET_OPEN)
  }

  #signal(ws: WebSocket, message: SyncLiveMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // A socket mid-close; its close handler cleans up.
    }
  }

  /**
   * `changed` to every socket but the writer's own slot's (`exceptSlot`;
   * null tells everyone). Never fails the write that committed.
   */
  #broadcast(seq: number, exceptSlot: string | null): void {
    try {
      const message: SyncLiveMessage = { type: 'changed', seq }
      for (const ws of this.#liveSockets()) {
        if (exceptSlot != null && attachmentOf(ws)?.slotId === exceptSlot)
          continue
        this.#signal(ws, message)
      }
    } catch {
      // The write already committed; a socket problem must not surface.
    }
  }
}
