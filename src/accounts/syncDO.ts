import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import { captureFailure } from '../sentry'
import {
  fail,
  ok,
  type BuddiesFailure,
  type BuddiesResult,
} from '../buddies/contracts'
import { isWebSocketUpgrade } from '../buddies/envelope'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import { logLimitHit } from '../buddies/limits'
import { accountsDb } from './store'
import { isSessionLive } from './sessionStore'
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
 * Privacy: nothing here logs or reports ids, sessions, sizes, or bytes.
 */

type SlotRow = {
  slotId: string
  etag: string
  size: number
  updatedAt: number
  sessionId: string
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
]

const DAY_MS = 24 * 60 * 60_000

/** `WebSocket.READY_STATE_OPEN`. */
const SOCKET_OPEN = 1

/** Stored on each live socket; survives hibernation. */
type LiveAttachment = { openedAt: number; slotId: string }

const attachmentOf = (ws: WebSocket): LiveAttachment | null =>
  (ws.deserializeAttachment() as LiveAttachment | null) ?? null

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
          `INSERT INTO slot (slot_id, etag, size, updated_at, session_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (slot_id) DO UPDATE SET
             etag = excluded.etag, size = excluded.size,
             updated_at = excluded.updated_at, session_id = excluded.session_id`,
          args.slotId,
          args.etag,
          args.size,
          args.updatedAt,
          args.sessionId
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

  async list(): Promise<{ seq: number; slots: SyncSlotView[] }> {
    if (!this.#ready()) return { seq: 0, slots: [] }
    const slots = this.#sql
      .exec<SyncSlotView>(
        `SELECT slot_id AS slotId, etag, size, updated_at AS updatedAt
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

  // --- Retention -----------------------------------------------------------

  /**
   * Daily while the account has slots: deletes slots past retention, and
   * objects no slot names (a commit that never came). A failed session read
   * keeps the slot until the next run.
   */
  async alarm(): Promise<void> {
    if (!this.#ready()) return
    const accountId = this.#accountId()
    if (!accountId) return
    const now = Date.now()
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
    if (this.#count('SELECT COUNT(*) AS n FROM slot') > 0)
      await this.ctx.storage.setAlarm(now + SYNC_LIMITS.retentionCheckMs)
  }

  // --- Live socket ---------------------------------------------------------

  /**
   * `GET sync/live`, forwarded by the Worker after it verified the token,
   * the switches, and the entitlement: the account in
   * `SYNC_HEADERS.account` (which only the Worker sets) and the device's own
   * slot in `x-ww-slot-id`, so its own puts don't echo back. Says `hello`
   * with the current `seq`; past the cap the oldest sockets close.
   */
  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return failure(fail('upgrade_required'))
    const accountId = request.headers.get(SYNC_HEADERS.account)
    const slotId = request.headers.get(SYNC_HEADERS.slotId)
    if (!accountId || !isSyncSlotId(slotId)) return failure(fail('bad_request'))
    this.#ensure(accountId)

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    const attachment: LiveAttachment = { openedAt: Date.now(), slotId }
    server.serializeAttachment(attachment)
    const others = this.#liveSockets()
      .filter((ws) => ws !== server)
      .sort((a, b) => (attachmentOf(a)?.openedAt ?? 0) - (attachmentOf(b)?.openedAt ?? 0))
    const excess = others.length + 1 - SYNC_LIMITS.liveSockets
    const { code, reason } = SYNC_LIVE_CLOSE.replaced
    for (const ws of others.slice(0, Math.max(0, excess)))
      closeQuietly(ws, code, reason)
    this.#signal(server, { type: 'hello', seq: this.#seq() })
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

  #ready(): boolean {
    if (this.#schemaReady) return true
    const found = this.#sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
      )
      .one().n
    this.#schemaReady = found > 0
    return this.#schemaReady
  }

  /** Creates the tables and the meta row on first use. */
  #ensure(accountId: string): void {
    if (!this.#schemaReady) {
      for (const statement of SCHEMA) this.#sql.exec(statement)
      this.#schemaReady = true
    }
    this.#sql.exec(
      'INSERT OR IGNORE INTO meta (singleton, account_id, seq) VALUES (1, ?, 0)',
      accountId
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

  async #ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null)
      await this.ctx.storage.setAlarm(Date.now() + SYNC_LIMITS.retentionCheckMs)
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
