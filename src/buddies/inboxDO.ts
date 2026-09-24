import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import type { ApnsEnvironment } from '../apns'
import {
  BUDDIES_LIMITS as LIMITS,
  INVITE_CLAIMED_KIND,
  RELAY_SLOT_ID,
  fail,
  isPlainObject,
  ok,
  type BuddiesErrorCode,
  type BuddiesResult,
  type BuddiesSignedOp,
  type CardPutPayload,
  type DeviceRegisterPayload,
  type DeviceUnregisterPayload,
  type EventPutPayload,
  type InboxFields,
  type InviteCreatePayload,
  type InviteDeletePayload,
  type PushJob,
  type PushTarget,
  type RegisterPayload,
  type RosterPutPayload,
  type Signed,
  type SignedFields,
  type SlotAddPayload,
  type SlotPayload,
  type SyncCard,
  type SyncEvent,
  type SyncPayload,
  type SyncResponse,
  type SyncSlot,
} from './contracts'
import { verifyBuddiesSignature } from './envelope'

type Empty = Record<string, never>

/** How the inbox answers the invite DO when a claim lands. */
export type ClaimDelivery =
  | { status: 'delivered'; push: PushJob | null }
  | { status: 'claimed_elsewhere' }
  | { status: 'gone' }

export interface StaleDevice {
  deviceId: string
  apnsToken: string
}

type PendingInviteDelete = {
  inviteId: string
  creatorInboxId: string
  expiresAt: number
}

type MetaRow = {
  inboxId: string
  ownerPub: string
  seq: number
  lastActiveAt: number
}
type DeviceRow = {
  deviceId: string
  apnsToken: string
  apnsEnvironment: string
  templates: string
}

type KeyRef = 'owner' | 'writer'
type KeyedCall = InboxFields & { slotId?: string }

const INVITE_DELETE_RETRY_MS = 60_000

/**
 * Every table is created on first registration, never for a probe: an
 * unregistered or wiped inbox stores nothing. `meta` is the existence marker.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
     inbox_id       TEXT NOT NULL,
     owner_pub      TEXT NOT NULL,
     seq            INTEGER NOT NULL,
     created_at     INTEGER NOT NULL,
     last_active_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS slot (
     slot_id    TEXT PRIMARY KEY,
     writer_pub TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS card (
     slot_id    TEXT PRIMARY KEY,
     blob       TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS event (
     event_id   TEXT PRIMARY KEY,
     slot_id    TEXT NOT NULL,
     kind       TEXT NOT NULL,
     blob       TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS event_by_seq ON event (seq)',
  'CREATE INDEX IF NOT EXISTS event_by_created ON event (created_at)',
  'CREATE INDEX IF NOT EXISTS event_by_slot ON event (slot_id)',
  `CREATE TABLE IF NOT EXISTS roster (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     blob      TEXT NOT NULL,
     seq       INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS device (
     device_id        TEXT PRIMARY KEY,
     apns_token       TEXT NOT NULL,
     apns_environment TEXT NOT NULL,
     templates        TEXT NOT NULL,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   )`,
  // Open-invite bookkeeping for the caps; rows leave with the invite.
  `CREATE TABLE IF NOT EXISTS invite (
     invite_id  TEXT PRIMARY KEY,
     status     TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  // Rolling 24 h creation log. Random ids so it never holds invite ids.
  `CREATE TABLE IF NOT EXISTS invite_creation (
     id         TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS slot_write (
     slot_id TEXT NOT NULL,
     at      INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS slot_write_by_slot ON slot_write (slot_id, at)',
  `CREATE TABLE IF NOT EXISTS slot_push (
     slot_id TEXT NOT NULL,
     at      INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS slot_push_by_slot ON slot_push (slot_id, at)',
  `CREATE TABLE IF NOT EXISTS nonce (
     nonce   TEXT PRIMARY KEY,
     seen_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS nonce_by_seen ON nonce (seen_at)',
  // Invite deletions that failed during a wipe, retried from the alarm.
  `CREATE TABLE IF NOT EXISTS pending_invite_delete (
     invite_id        TEXT PRIMARY KEY,
     creator_inbox_id TEXT NOT NULL,
     expires_at       INTEGER NOT NULL
   )`,
] as const

/**
 * One SQLite Durable Object per `inboxId`: the owner key, slots (buddies'
 * writer keys), Buddy Cards, events, devices, the encrypted roster, the nonce
 * cache, the per-inbox `seq`, and open-invite bookkeeping. It holds ciphertext,
 * random ids, public keys, and push tokens only.
 *
 * Signed ops verify first (the only await), then run their checks and writes in
 * one synchronous transaction, so caps and `seq` stay exact under concurrency.
 */
export class BuddyInbox extends DurableObject<Environment> {
  #schemaReady = false

  // --- Owner ops ----------------------------------------------------------

  async register(call: Signed<RegisterPayload>): Promise<BuddiesResult<Empty>> {
    const valid = await verifyBuddiesSignature(
      call.ownerPub,
      'inbox/register',
      call.payloadBytes,
      call.signature
    )
    if (!valid) return fail('bad_signature')

    const now = Date.now()
    const result = this.ctx.storage.transactionSync(
      (): BuddiesResult<Empty> => {
        if (this.#isStale(call, now)) return fail('stale')
        const meta = this.#meta()
        if (meta && meta.ownerPub !== call.ownerPub) return fail('conflict')
        this.#ensureSchema()
        if (!this.#claimNonce(call, now)) return fail('replay')
        if (meta) {
          this.#touch(now)
        } else {
          this.#sql.exec(
            `INSERT INTO meta (singleton, inbox_id, owner_pub, seq, created_at, last_active_at)
           VALUES (1, ?, ?, 0, ?, ?)`,
            call.inboxId,
            call.ownerPub,
            now,
            now
          )
        }
        return ok({})
      }
    )
    if (result.ok) await this.#ensureAlarm(now)
    return result
  }

  async sync(call: Signed<SyncPayload>): Promise<BuddiesResult<SyncResponse>> {
    const auth = await this.#authenticate('inbox/sync', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, (now) =>
      ok(this.#snapshot(call.since, now))
    )
  }

  async deleteInbox(call: Signed<InboxFields>): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('inbox/delete', call, 'owner')
    if (!auth.ok) return auth
    const admitted = this.#commit(call, 'owner', auth.value, () => ok({}))
    if (!admitted.ok) return admitted
    await this.#wipe(Date.now())
    return ok({})
  }

  async registerDevice(
    call: Signed<DeviceRegisterPayload>
  ): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('device/register', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, (now) => {
      // One row per token, so a reinstall with a new deviceId doesn't double-push.
      this.#sql.exec(
        'DELETE FROM device WHERE apns_token = ? AND device_id <> ?',
        call.apnsToken,
        call.deviceId
      )
      this.#sql.exec(
        `INSERT INTO device (device_id, apns_token, apns_environment, templates, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET
           apns_token = excluded.apns_token,
           apns_environment = excluded.apns_environment,
           templates = excluded.templates,
           updated_at = excluded.updated_at`,
        call.deviceId,
        call.apnsToken,
        call.apnsEnvironment,
        JSON.stringify(call.templates),
        now,
        now
      )
      const excess =
        this.#count('SELECT COUNT(*) AS n FROM device') - LIMITS.devices
      if (excess > 0) {
        // Evict the least recently registered devices.
        this.#sql.exec(
          `DELETE FROM device WHERE device_id IN (
             SELECT device_id FROM device WHERE device_id <> ?
             ORDER BY updated_at, created_at LIMIT ?
           )`,
          call.deviceId,
          excess
        )
      }
      return ok({})
    })
  }

  async unregisterDevice(
    call: Signed<DeviceUnregisterPayload>
  ): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('device/unregister', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, () => {
      this.#sql.exec('DELETE FROM device WHERE device_id = ?', call.deviceId)
      return ok({})
    })
  }

  async addSlot(call: Signed<SlotAddPayload>): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('slot/add', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, (now) => {
      const existing = this.#writerPub(call.slotId)
      if (existing != null)
        return existing === call.writerPub ? ok({}) : fail('conflict')
      if (
        this.#slotCount() + this.#openInvites(now) >=
        LIMITS.slotsPlusOpenInvites
      ) {
        return fail('limit')
      }
      this.#sql.exec(
        'INSERT INTO slot (slot_id, writer_pub, created_at) VALUES (?, ?, ?)',
        call.slotId,
        call.writerPub,
        now
      )
      return ok({})
    })
  }

  async removeSlot(call: Signed<SlotPayload>): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('slot/remove', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, () => {
      this.#deleteSlot(call.slotId)
      return ok({})
    })
  }

  async putRoster(
    call: Signed<RosterPutPayload>
  ): Promise<BuddiesResult<{ seq: number }>> {
    const auth = await this.#authenticate('roster/put', call, 'owner')
    if (!auth.ok) return auth
    return this.#commit(call, 'owner', auth.value, () => {
      const seq = this.#nextSeq()
      this.#sql.exec(
        `INSERT INTO roster (singleton, blob, seq) VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET blob = excluded.blob, seq = excluded.seq`,
        call.blob,
        seq
      )
      return ok({ seq })
    })
  }

  async createInvite(
    call: Signed<InviteCreatePayload>
  ): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('invite/create', call, 'owner')
    if (!auth.ok) return auth

    // Reserve the spot here first, so concurrent creates and slot/adds see it
    // while the invite DO call is in flight.
    const creationId = crypto.randomUUID()
    const reserved = this.#commit(
      call,
      'owner',
      auth.value,
      (now): BuddiesResult<Empty> => {
        if (
          this.#count(
            'SELECT COUNT(*) AS n FROM invite WHERE invite_id = ?',
            call.inviteId
          )
        ) {
          return fail('conflict')
        }
        const open = this.#openInvites(now)
        if (
          open >= LIMITS.openInvites ||
          this.#slotCount() + open >= LIMITS.slotsPlusOpenInvites
        ) {
          return fail('limit')
        }
        this.#sql.exec(
          'DELETE FROM invite_creation WHERE created_at <= ?',
          now - LIMITS.inviteCreationWindowMs
        )
        if (
          this.#count('SELECT COUNT(*) AS n FROM invite_creation') >=
          LIMITS.inviteCreations
        ) {
          return fail('rate_limited')
        }
        this.#sql.exec(
          "INSERT INTO invite (invite_id, status, expires_at) VALUES (?, 'open', ?)",
          call.inviteId,
          call.expiresAt
        )
        this.#sql.exec(
          'INSERT INTO invite_creation (id, created_at) VALUES (?, ?)',
          creationId,
          now
        )
        return ok({})
      }
    )
    if (!reserved.ok) return reserved

    const invite = this.#invite(call.inviteId)
    let created: BuddiesResult<Empty>
    try {
      created = await invite.create({
        inviteId: call.inviteId,
        creatorInboxId: call.inboxId,
        claimVerifier: call.claimVerifier,
        blob: call.blob,
        expiresAt: call.expiresAt,
      })
    } catch (error) {
      this.#releaseInvite(call.inviteId, creationId)
      throw error
    }
    if (!created.ok) {
      this.#releaseInvite(call.inviteId, creationId)
      return created
    }
    if (!this.#meta()) {
      // The inbox was deleted while the invite was being created.
      await invite.deleteByCreator(call.inboxId)
      return fail('not_found')
    }
    await this.#ensureAlarm(Date.now())
    return ok({})
  }

  async deleteInvite(
    call: Signed<InviteDeletePayload>
  ): Promise<BuddiesResult<Empty>> {
    const auth = await this.#authenticate('invite/delete', call, 'owner')
    if (!auth.ok) return auth
    const removed = this.#commit(call, 'owner', auth.value, () => {
      this.#sql.exec('DELETE FROM invite WHERE invite_id = ?', call.inviteId)
      return ok({})
    })
    if (!removed.ok) return removed
    // The invite DO only deletes when this inbox created it.
    await this.#invite(call.inviteId).deleteByCreator(call.inboxId)
    return ok({})
  }

  // --- Writer ops ---------------------------------------------------------

  async putCard(
    call: Signed<CardPutPayload>
  ): Promise<BuddiesResult<{ seq: number }>> {
    const auth = await this.#authenticate('card/put', call, 'writer')
    if (!auth.ok) return auth
    return this.#commit(call, 'writer', auth.value, (now) => {
      if (!this.#recordWrite(call.slotId, now)) return fail('rate_limited')
      const seq = this.#nextSeq()
      this.#sql.exec(
        `INSERT INTO card (slot_id, blob, seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (slot_id) DO UPDATE SET
           blob = excluded.blob, seq = excluded.seq, updated_at = excluded.updated_at`,
        call.slotId,
        call.blob,
        seq,
        now
      )
      return ok({ seq })
    })
  }

  async putEvent(
    call: Signed<EventPutPayload>
  ): Promise<BuddiesResult<{ seq: number; push: PushJob | null }>> {
    const auth = await this.#authenticate('event/put', call, 'writer')
    if (!auth.ok) return auth
    let inserted = false
    const result = this.#commit(call, 'writer', auth.value, (now) => {
      const existing = this.#eventSeq(call.eventId)
      if (existing != null) return ok({ seq: existing, push: null })
      if (!this.#recordWrite(call.slotId, now)) return fail('rate_limited')
      const seq = this.#nextSeq()
      this.#sql.exec(
        `INSERT INTO event (event_id, slot_id, kind, blob, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        call.eventId,
        call.slotId,
        call.kind,
        call.blob,
        seq,
        now
      )
      inserted = true
      const push = call.push
        ? this.#reservePush(call.inboxId, call.slotId, call.kind, now)
        : null
      return ok({ seq, push })
    })
    if (inserted) await this.#ensureAlarm(Date.now())
    return result
  }

  /** Idempotent: a missing inbox or slot means there is nothing left to leave. */
  async leaveSlot(call: Signed<SlotPayload>): Promise<BuddiesResult<Empty>> {
    const key = this.#key(call, 'writer')
    if (!key.ok) return ok({})
    const valid = await verifyBuddiesSignature(
      key.value,
      'slot/leave',
      call.payloadBytes,
      call.signature
    )
    if (!valid) return fail('bad_signature')
    const result = this.#commit(call, 'writer', key.value, () => {
      this.#deleteSlot(call.slotId)
      return ok({})
    })
    if (!result.ok && (result.error === 'gone' || result.error === 'not_found'))
      return ok({})
    return result
  }

  // --- Relay-internal (Worker and invite DO only) ---------------------------

  /**
   * Appends the relay's `invite.claimed` event (eventId = inviteId, slotId "").
   * `gone` when the inbox or its bookkeeping for the invite no longer exists,
   * e.g. the owner cancelled it.
   */
  async recordClaim(args: {
    inboxId: string
    inviteId: string
    blob: string
  }): Promise<ClaimDelivery> {
    const now = Date.now()
    let inserted = false
    const delivery = this.ctx.storage.transactionSync((): ClaimDelivery => {
      const meta = this.#meta()
      if (!meta || meta.inboxId !== args.inboxId) return { status: 'gone' }
      if (
        !this.#count(
          'SELECT COUNT(*) AS n FROM invite WHERE invite_id = ?',
          args.inviteId
        )
      ) {
        return { status: 'gone' }
      }
      this.#sql.exec(
        "UPDATE invite SET status = 'claimed' WHERE invite_id = ?",
        args.inviteId
      )
      const existing = this.#sql
        .exec<{
          blob: string
        }>('SELECT blob FROM event WHERE event_id = ?', args.inviteId)
        .toArray()[0]
      if (existing) {
        if (existing.blob !== args.blob) return { status: 'claimed_elsewhere' }
        // Only reachable after the invite DO reopened a claim whose delivery
        // threw, so the Worker never pushed the first attempt.
        return { status: 'delivered', push: this.#claimPush(meta.inboxId) }
      }
      const seq = this.#nextSeq()
      this.#sql.exec(
        `INSERT INTO event (event_id, slot_id, kind, blob, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        args.inviteId,
        RELAY_SLOT_ID,
        INVITE_CLAIMED_KIND,
        args.blob,
        seq,
        now
      )
      inserted = true
      return { status: 'delivered', push: this.#claimPush(meta.inboxId) }
    })
    if (inserted) await this.#ensureAlarm(now)
    return delivery
  }

  /** Drops bookkeeping for an invite the invite DO burned. */
  forgetInvite(inviteId: string): void {
    if (!this.#ready()) return
    this.#sql.exec('DELETE FROM invite WHERE invite_id = ?', inviteId)
  }

  /** Deletes devices APNs rejected, unless they re-registered a new token since. */
  removeDevices(devices: StaleDevice[]): void {
    if (!this.#ready()) return
    this.ctx.storage.transactionSync(() => {
      for (const device of devices) {
        this.#sql.exec(
          'DELETE FROM device WHERE device_id = ? AND apns_token = ?',
          device.deviceId,
          device.apnsToken
        )
      }
    })
  }

  /** Retention: events at 30 days, invite bookkeeping, and the 180-day wipe. */
  async alarm(): Promise<void> {
    const now = Date.now()
    if (!this.#ready()) return
    const meta = this.#meta()
    if (meta && now - meta.lastActiveAt >= LIMITS.inboxInactivityMs) {
      await this.#wipe(now)
      return
    }
    this.ctx.storage.transactionSync(() => this.#prune(now))
    await this.#retryInviteDeletes(now)
    if (
      !this.#meta() &&
      !this.#count('SELECT COUNT(*) AS n FROM pending_invite_delete')
    ) {
      await this.ctx.storage.deleteAll()
      this.#schemaReady = false
      return
    }
    await this.#ensureAlarm(now)
  }

  // --- Authentication -----------------------------------------------------

  #key(call: KeyedCall, ref: KeyRef): BuddiesResult<string> {
    const meta = this.#meta()
    if (!meta || meta.inboxId !== call.inboxId) return fail('not_found')
    if (ref === 'owner') return ok(meta.ownerPub)
    const writerPub = call.slotId ? this.#writerPub(call.slotId) : null
    return writerPub ? ok(writerPub) : fail('gone')
  }

  async #authenticate(
    op: BuddiesSignedOp,
    call: Signed<KeyedCall>,
    ref: KeyRef
  ): Promise<BuddiesResult<string>> {
    const key = this.#key(call, ref)
    if (!key.ok) return key
    const valid = await verifyBuddiesSignature(
      key.value,
      op,
      call.payloadBytes,
      call.signature
    )
    return valid ? key : fail('bad_signature')
  }

  /**
   * After the signature check: the verifying key must be unchanged, `ts` fresh,
   * and the nonce unseen, then `work` runs in the same transaction. Owner ops
   * also count as owner activity for the 180-day retention.
   */
  #commit<T>(
    call: KeyedCall & SignedFields,
    ref: KeyRef,
    verifiedKey: string,
    work: (now: number) => BuddiesResult<T>
  ): BuddiesResult<T> {
    const now = Date.now()
    return this.ctx.storage.transactionSync((): BuddiesResult<T> => {
      const key = this.#key(call, ref)
      if (!key.ok) return key
      if (key.value !== verifiedKey) return fail('bad_signature')
      const denied = this.#admit(call, now)
      if (denied) return fail(denied)
      if (ref === 'owner') this.#touch(now)
      return work(now)
    })
  }

  #admit(call: SignedFields, now: number): BuddiesErrorCode | null {
    if (this.#isStale(call, now)) return 'stale'
    return this.#claimNonce(call, now) ? null : 'replay'
  }

  #isStale(call: SignedFields, now: number): boolean {
    return Math.abs(now - call.ts) > LIMITS.timestampSkewMs
  }

  /**
   * Records the nonce unless it was seen in the last 10 minutes. With ts
   * limited to ±5 minutes, a request can't outlive its nonce record.
   */
  #claimNonce(call: SignedFields, now: number): boolean {
    this.#sql.exec(
      'DELETE FROM nonce WHERE seen_at < ?',
      now - LIMITS.nonceRetentionMs
    )
    if (
      this.#count('SELECT COUNT(*) AS n FROM nonce WHERE nonce = ?', call.nonce)
    )
      return false
    this.#sql.exec(
      'INSERT INTO nonce (nonce, seen_at) VALUES (?, ?)',
      call.nonce,
      now
    )
    return true
  }

  #touch(now: number): void {
    this.#sql.exec(
      'UPDATE meta SET last_active_at = ? WHERE singleton = 1',
      now
    )
  }

  // --- State helpers --------------------------------------------------------

  get #sql(): SqlStorage {
    return this.ctx.storage.sql
  }

  #ready(): boolean {
    if (this.#schemaReady) return true
    const exists =
      this.#sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        )
        .toArray().length > 0
    // Existing inboxes pick up any tables added since they were created.
    if (exists) this.#ensureSchema()
    return exists
  }

  #ensureSchema(): void {
    for (const statement of SCHEMA) this.#sql.exec(statement)
    this.#schemaReady = true
  }

  #meta(): MetaRow | null {
    if (!this.#ready()) return null
    return (
      this.#sql
        .exec<MetaRow>(
          `SELECT inbox_id AS inboxId, owner_pub AS ownerPub, seq, last_active_at AS lastActiveAt
           FROM meta WHERE singleton = 1`
        )
        .toArray()[0] ?? null
    )
  }

  #count(query: string, ...bindings: (string | number)[]): number {
    return this.#sql.exec<{ n: number }>(query, ...bindings).one().n
  }

  #writerPub(slotId: string): string | null {
    return (
      this.#sql
        .exec<{
          writerPub: string
        }>('SELECT writer_pub AS writerPub FROM slot WHERE slot_id = ?', slotId)
        .toArray()[0]?.writerPub ?? null
    )
  }

  #slotCount(): number {
    return this.#count('SELECT COUNT(*) AS n FROM slot')
  }

  /** Unclaimed, unexpired invites. A claimed invite stops counting: its confirm runs slot/add. */
  #openInvites(now: number): number {
    return this.#count(
      "SELECT COUNT(*) AS n FROM invite WHERE status = 'open' AND expires_at > ?",
      now
    )
  }

  #nextSeq(): number {
    this.#sql.exec('UPDATE meta SET seq = seq + 1 WHERE singleton = 1')
    return this.#sql
      .exec<{ seq: number }>('SELECT seq FROM meta WHERE singleton = 1')
      .one().seq
  }

  #eventSeq(eventId: string): number | null {
    return (
      this.#sql
        .exec<{
          seq: number
        }>('SELECT seq FROM event WHERE event_id = ?', eventId)
        .toArray()[0]?.seq ?? null
    )
  }

  /** Sliding one-hour window of writes per slot. */
  #recordWrite(slotId: string, now: number): boolean {
    this.#sql.exec(
      'DELETE FROM slot_write WHERE slot_id = ? AND at <= ?',
      slotId,
      now - LIMITS.writeWindowMs
    )
    const writes = this.#count(
      'SELECT COUNT(*) AS n FROM slot_write WHERE slot_id = ?',
      slotId
    )
    if (writes >= LIMITS.writesPerSlot) return false
    this.#sql.exec(
      'INSERT INTO slot_write (slot_id, at) VALUES (?, ?)',
      slotId,
      now
    )
    return true
  }

  /**
   * Push budget per slot: 10 per 24 h, at least 60 s apart. Over budget, the
   * event is still stored; it just doesn't alert.
   */
  #reservePush(
    inboxId: string,
    slotId: string,
    kind: string,
    now: number
  ): PushJob | null {
    const targets = this.#pushTargets(kind)
    if (!targets.length) return null
    this.#sql.exec(
      'DELETE FROM slot_push WHERE slot_id = ? AND at <= ?',
      slotId,
      now - LIMITS.pushWindowMs
    )
    const { pushes, last } = this.#sql
      .exec<{
        pushes: number
        last: number | null
      }>(
        'SELECT COUNT(*) AS pushes, MAX(at) AS last FROM slot_push WHERE slot_id = ?',
        slotId
      )
      .one()
    if (pushes >= LIMITS.pushesPerSlot) return null
    if (last != null && now - last < LIMITS.pushSpacingMs) return null
    this.#sql.exec(
      'INSERT INTO slot_push (slot_id, at) VALUES (?, ?)',
      slotId,
      now
    )
    return { inboxId, kind, targets }
  }

  #claimPush(inboxId: string): PushJob | null {
    const targets = this.#pushTargets(INVITE_CLAIMED_KIND)
    return targets.length
      ? { inboxId, kind: INVITE_CLAIMED_KIND, targets }
      : null
  }

  /** Devices that registered a localized template for `kind`. */
  #pushTargets(kind: string): PushTarget[] {
    const rows = this.#sql
      .exec<DeviceRow>(
        `SELECT device_id AS deviceId, apns_token AS apnsToken,
                apns_environment AS apnsEnvironment, templates
         FROM device ORDER BY created_at, device_id`
      )
      .toArray()
    const targets: PushTarget[] = []
    for (const row of rows) {
      let templates: unknown
      try {
        templates = JSON.parse(row.templates)
      } catch {
        continue
      }
      if (!isPlainObject(templates) || !Object.hasOwn(templates, kind)) continue
      const template = templates[kind]
      if (!isPlainObject(template)) continue
      const { title, body } = template
      if (typeof title !== 'string' || typeof body !== 'string') continue
      targets.push({
        deviceId: row.deviceId,
        apnsToken: row.apnsToken,
        apnsEnvironment: row.apnsEnvironment as ApnsEnvironment,
        title,
        body,
      })
    }
    return targets
  }

  #deleteSlot(slotId: string): void {
    this.#sql.exec('DELETE FROM slot WHERE slot_id = ?', slotId)
    this.#sql.exec('DELETE FROM card WHERE slot_id = ?', slotId)
    this.#sql.exec('DELETE FROM event WHERE slot_id = ?', slotId)
    this.#sql.exec('DELETE FROM slot_write WHERE slot_id = ?', slotId)
    this.#sql.exec('DELETE FROM slot_push WHERE slot_id = ?', slotId)
  }

  /**
   * Items with `seq > since`. `slots` is always the full list. Events stop at a
   * size budget, in which case `seq` is the cursor reached rather than the head.
   */
  #snapshot(since: number, now: number): SyncResponse {
    const head = this.#meta()?.seq ?? 0
    const slots = this.#sql
      .exec<SyncSlot>(
        'SELECT slot_id AS slotId, created_at AS createdAt FROM slot ORDER BY created_at, slot_id'
      )
      .toArray()

    const events: SyncEvent[] = []
    let cursor = head
    let chars = 0
    for (const event of this.#sql.exec<SyncEvent>(
      `SELECT event_id AS eventId, slot_id AS slotId, kind, blob, seq, created_at AS createdAt
       FROM event WHERE seq > ? AND created_at > ? ORDER BY seq`,
      since,
      now - LIMITS.eventRetentionMs
    )) {
      if (events.length && chars + event.blob.length > LIMITS.syncEventChars) {
        cursor = events[events.length - 1].seq
        break
      }
      chars += event.blob.length
      events.push(event)
    }

    const cards = this.#sql
      .exec<SyncCard>(
        `SELECT slot_id AS slotId, blob, seq, updated_at AS updatedAt
         FROM card WHERE seq > ? AND seq <= ? ORDER BY seq`,
        since,
        cursor
      )
      .toArray()
    const roster =
      this.#sql
        .exec<{
          blob: string
          seq: number
        }>(
          'SELECT blob, seq FROM roster WHERE singleton = 1 AND seq > ? AND seq <= ?',
          since,
          cursor
        )
        .toArray()[0] ?? null

    return { seq: cursor, slots, cards, events, roster }
  }

  #invite(inviteId: string) {
    return this.env.BUDDY_INVITE.get(this.env.BUDDY_INVITE.idFromName(inviteId))
  }

  #releaseInvite(inviteId: string, creationId: string): void {
    if (!this.#ready()) return
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec('DELETE FROM invite WHERE invite_id = ?', inviteId)
      this.#sql.exec('DELETE FROM invite_creation WHERE id = ?', creationId)
    })
  }

  // --- Retention ------------------------------------------------------------

  #prune(now: number): void {
    this.#sql.exec(
      'DELETE FROM event WHERE created_at <= ?',
      now - LIMITS.eventRetentionMs
    )
    this.#sql.exec(
      'DELETE FROM invite WHERE expires_at <= ?',
      now - LIMITS.inviteGraceMs
    )
    this.#sql.exec(
      'DELETE FROM invite_creation WHERE created_at <= ?',
      now - LIMITS.inviteCreationWindowMs
    )
    this.#sql.exec(
      'DELETE FROM slot_write WHERE at <= ?',
      now - LIMITS.writeWindowMs
    )
    this.#sql.exec(
      'DELETE FROM slot_push WHERE at <= ?',
      now - LIMITS.pushWindowMs
    )
    this.#sql.exec(
      'DELETE FROM nonce WHERE seen_at < ?',
      now - LIMITS.nonceRetentionMs
    )
  }

  #nextDeadline(now: number): number | null {
    if (!this.#ready()) return null
    const deadlines: number[] = []
    const meta = this.#meta()
    if (meta) deadlines.push(meta.lastActiveAt + LIMITS.inboxInactivityMs)
    const { oldestEvent } = this.#sql
      .exec<{
        oldestEvent: number | null
      }>('SELECT MIN(created_at) AS oldestEvent FROM event')
      .one()
    if (oldestEvent != null)
      deadlines.push(oldestEvent + LIMITS.eventRetentionMs)
    const { nextInvite } = this.#sql
      .exec<{
        nextInvite: number | null
      }>('SELECT MIN(expires_at) AS nextInvite FROM invite')
      .one()
    if (nextInvite != null) deadlines.push(nextInvite + LIMITS.inviteGraceMs)
    if (this.#count('SELECT COUNT(*) AS n FROM pending_invite_delete')) {
      deadlines.push(now + INVITE_DELETE_RETRY_MS)
    }
    return deadlines.length ? Math.min(...deadlines) : null
  }

  /** Moves the alarm earlier when a new deadline needs it; a late alarm just reschedules. */
  async #ensureAlarm(now: number): Promise<void> {
    const deadline = this.#nextDeadline(now)
    if (deadline == null) return
    const current = await this.ctx.storage.getAlarm()
    if (current == null || current > deadline)
      await this.ctx.storage.setAlarm(deadline)
  }

  /**
   * Deletes everything (slots, cards, events, devices, roster) and every invite
   * this inbox created. Local state goes first so concurrent ops see a missing
   * inbox; invite deletions that fail are retried from the alarm.
   */
  async #wipe(now: number): Promise<void> {
    const invites: PendingInviteDelete[] = []
    if (this.#ready()) {
      const meta = this.#meta()
      if (meta) {
        for (const row of this.#sql
          .exec<{
            inviteId: string
            expiresAt: number
          }>(
            'SELECT invite_id AS inviteId, expires_at AS expiresAt FROM invite'
          )
          .toArray()) {
          invites.push({ ...row, creatorInboxId: meta.inboxId })
        }
      }
      invites.push(...this.#pendingInviteDeletes())
    }
    await this.ctx.storage.deleteAll()
    // Before compatibility date 2026-02-24, deleteAll() keeps the alarm.
    await this.ctx.storage.deleteAlarm()
    this.#schemaReady = false
    const unique = new Map(invites.map((invite) => [invite.inviteId, invite]))
    await this.#deleteInvites([...unique.values()], now)
  }

  #pendingInviteDeletes(): PendingInviteDelete[] {
    return this.#sql
      .exec<PendingInviteDelete>(
        `SELECT invite_id AS inviteId, creator_inbox_id AS creatorInboxId, expires_at AS expiresAt
         FROM pending_invite_delete`
      )
      .toArray()
  }

  async #retryInviteDeletes(now: number): Promise<void> {
    const pending = this.#pendingInviteDeletes()
    if (pending.length) await this.#deleteInvites(pending, now)
  }

  async #deleteInvites(
    invites: PendingInviteDelete[],
    now: number
  ): Promise<void> {
    if (!invites.length) return
    // Past expiry plus grace, the invite DO's own alarm has deleted it.
    const live = invites.filter(
      (invite) => invite.expiresAt + LIMITS.inviteGraceMs > now
    )
    const results = await Promise.allSettled(
      live.map((invite) =>
        this.#invite(invite.inviteId).deleteByCreator(invite.creatorInboxId)
      )
    )
    const failed = live.filter(
      (_, index) => results[index].status === 'rejected'
    )
    if (!failed.length && !this.#ready()) return

    this.ctx.storage.transactionSync(() => {
      if (failed.length) this.#ensureSchema()
      for (const invite of invites) {
        this.#sql.exec(
          'DELETE FROM pending_invite_delete WHERE invite_id = ?',
          invite.inviteId
        )
      }
      for (const invite of failed) {
        this.#sql.exec(
          `INSERT OR REPLACE INTO pending_invite_delete (invite_id, creator_inbox_id, expires_at)
           VALUES (?, ?, ?)`,
          invite.inviteId,
          invite.creatorInboxId,
          invite.expiresAt
        )
      }
    })
    if (failed.length) {
      console.warn('buddies: invite cleanup failed; retrying from the alarm')
      await this.#ensureAlarm(now)
    }
  }
}
