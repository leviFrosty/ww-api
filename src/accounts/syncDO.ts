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
  soonestSocketExpiry,
} from '../liveSubprotocol'
import { accountsDb } from './store'
import { isSessionLive, listLiveSessions } from './sessionStore'
import type { SessionPlatform } from './schema'
import {
  SYNC_HEADERS,
  SYNC_LIMITS,
  SYNC_LIVE_CLOSE,
  isSyncSlotId,
  syncObjectKey,
  syncPrefix,
  type SyncIfMatch,
  type SyncLiveMessage,
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
 * Privacy: nothing here logs or reports ids, sessions, sizes, or bytes.
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
}

export interface CommitSyncPutArgs {
  accountId: string
  slotId: string
  reservation: string
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
]

/** Columns added to a table after it shipped: `[table, column, definition]`. */
const ADDED_COLUMNS = [['slot', 'platform', 'TEXT']] as const

/** Sessions that can switch to Cloud Sync when the account asks. */
const PHONE_PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android', 'dev'])

const DAY_MS = 24 * 60 * 60_000

/** `WebSocket.READY_STATE_OPEN`. */
const SOCKET_OPEN = 1

/**
 * Stored on each live socket; survives hibernation. `expiresAt` (epoch ms)
 * is a browser socket's token expiry; native sockets have none.
 */
type LiveAttachment = { openedAt: number; slotId: string; expiresAt?: number }

const attachmentOf = (ws: WebSocket): LiveAttachment | null =>
  (ws.deserializeAttachment() as LiveAttachment | null) ?? null

const expiryOf = (ws: WebSocket): number | null =>
  attachmentOf(ws)?.expiresAt ?? null

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
  ): Promise<BuddiesResult<{ reservation: string }>> {
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
      return ok({ reservation })
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
    if (!rows.length) return { seq: this.#seq() }
    const seq = this.ctx.storage.transactionSync(() => {
      for (const id of rows) {
        this.#sql.exec('DELETE FROM slot WHERE slot_id = ?', id)
        this.#sql.exec('DELETE FROM reservation WHERE slot_id = ?', id)
      }
      return this.#advance()
    })
    this.#broadcast(seq, null)
    return { seq }
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
    this.#setRetentionAt(
      this.#count('SELECT COUNT(*) AS n FROM slot') > 0
        ? now + SYNC_LIMITS.retentionCheckMs
        : null
    )
  }

  // --- Live socket ---------------------------------------------------------

  /**
   * `GET sync/live`, forwarded by the Worker after it verified the token,
   * the switches, and the entitlement: the account in
   * `SYNC_HEADERS.account` (which only the Worker sets) and the device's own
   * slot in `x-ww-slot-id`, so its own puts don't echo back, and for a
   * browser socket its token's expiry in `SYNC_HEADERS.expiresAt`, when the
   * alarm closes it. Says `hello` with the current `seq`; past the cap the
   * oldest sockets close.
   */
  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return failure(fail('upgrade_required'))
    const accountId = request.headers.get(SYNC_HEADERS.account)
    const slotId = request.headers.get(SYNC_HEADERS.slotId)
    const expiresAt = readLiveExpiry(request.headers.get(SYNC_HEADERS.expiresAt))
    if (!accountId || !isSyncSlotId(slotId) || expiresAt === undefined)
      return failure(fail('bad_request'))
    this.#ensure(accountId)

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    const attachment: LiveAttachment = {
      openedAt: Date.now(),
      slotId,
      ...(expiresAt == null ? {} : { expiresAt }),
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
