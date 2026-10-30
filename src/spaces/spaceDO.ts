import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import { timingSafeEqual } from '../crypto'
import { retryAfterSeconds } from '../errors'
import { captureOperationFailure } from '../sentry'
import { decodedLength, ok } from '../buddies/contracts'
import { isWebSocketUpgrade } from '../buddies/envelope'
import { rollingWindowWaitMs, type WindowBucket } from '../buddies/limits'
import {
  SEQ_PAGE_CHUNK,
  deleteAllThen,
  readSeqPage,
} from '../durableObjectStorage'
import {
  SPACES_HEADERS,
  SPACES_LIMITS as LIMITS,
  SPACES_LIVE_CLOSE,
  decodeLiveMember,
  fail,
  logSpacesLimitHit,
  mayPutRecord,
  rekeyLinkId,
  spacesErrorResponse,
  type PutRecord,
  type RekeyLink,
  type RekeyWrap,
  type SpacesErrorCode,
  type SpacesFailure,
  type SpacesLiveMessage,
  type SpacesResult,
} from './contracts'

/**
 * One SQLite Durable Object per shared space (witness-work ADR 0037;
 * `docs/shared-cars-protocol.md` there), `idFromName(spaceId)`. It holds the
 * space's sealed records (the current version of each, with the `seq` it was
 * stored at), its members (a token hash, the X25519 public key their id
 * commits to, and the current epoch's wrap each, never an account), its
 * invites (a verifier and the inviter, never the secret), the change `seq`,
 * the record and byte counts, the put limits, and the live sockets. The
 * server is blind: it never learns what the space is or who is on it.
 *
 * Every change advances `seq`: each stored record takes the next one, and
 * joins, leaves, removals, invite changes, and rekeys take one each, so a
 * socket's `hello` or `changed` past a device's cursor always means `sync`
 * has something new.
 *
 * An invite lives only as long as its inviter is on the space and the key
 * epoch it was made at: `leave` closes the open invites the member made,
 * and `member/remove` and `rekey` close them all. So a member who's gone
 * can't come back through an open invite before the key changes, and nobody
 * joins with an old key. A closed invite's id is kept until it expires, so
 * no retried `invite/create` opens it again.
 *
 * Deleting the space (the owner's `delete`, the last member's `leave`, or
 * 400 days without a `sync` or `put`) drops every table and writes a
 * tombstone in the same transaction as the decision, so later requests are
 * `gone` and the id can't be created again; `#purge` then frees the storage.
 *
 * Privacy: nothing here logs or reports ids, token hashes, keys, wraps, or
 * blobs.
 */

type Empty = Record<string, never>

/** A member op's credentials, with the token already hashed by the Worker. */
export interface MemberAuth {
  spaceId: string
  memberId: string
  /** Canonical b64u of SHA-256(token). */
  tokenHash: string
}

/** `memberId` is checked against `dhPub` by the Worker (`spacesMemberId`). */
export interface CreateSpaceArgs {
  spaceId: string
  memberId: string
  dhPub: string
  tokenHash: string
  wrap: string
}

export interface SyncSpaceArgs extends MemberAuth {
  since: number
  limit: number
}

export interface PutRecordArgs extends PutRecord {
  /** Lowercase hex SHA-256 of the decoded blob: the last tie-break. */
  blobHash: string
}

export interface PutSpaceArgs extends MemberAuth {
  records: PutRecordArgs[]
}

export interface CreateSpaceInviteArgs extends MemberAuth {
  inviteId: string
  joinVerifier: string
  expiresAt: number
  /** The epoch of the key the invitation carries; must be current. */
  epoch: number
  /** Members plus open invites the space may hold (KV `spaces:maxMembers`). */
  maxMembers: number
}

export interface DeleteSpaceInviteArgs extends MemberAuth {
  inviteId: string
}

/** `memberId` is checked against `dhPub` by the Worker (`spacesMemberId`). */
export interface JoinSpaceArgs {
  spaceId: string
  inviteId: string
  /** Canonical b64u of SHA-256(joinSecret), computed by the Worker. */
  joinHash: string
  /** The invitation's epoch: a fresh join's must be current. */
  epoch: number
  memberId: string
  dhPub: string
  tokenHash: string
  wrap: string
  maxMembers: number
}

export interface RemoveSpaceMemberArgs extends MemberAuth {
  removeId: string
}

export interface RekeyLinkArgs extends RekeyLink {
  /** Lowercase hex SHA-256 of the decoded blob, as a put record's. */
  blobHash: string
}

export interface RekeySpaceArgs extends MemberAuth {
  epoch: number
  wraps: RekeyWrap[]
  /** The record `k.<epoch>`, sealed under the new epoch's key. */
  link: RekeyLinkArgs
}

/** `create`'s answer. */
export interface SpaceCreated {
  seq: number
  joinedAt: number
}

/** `join`'s answer. */
export interface SpaceJoined {
  seq: number
  epoch: number
  joinedAt: number
}

export interface SpaceRecordView {
  recordId: string
  epoch: number
  stamp: number
  deleted: boolean
  blob: string
  seq: number
}

export type SpaceMemberView = {
  memberId: string
  dhPub: string
  joinedAt: number
}

export interface SpaceSyncView {
  /** The head, or the last record's `seq` when `more`. */
  seq: number
  epoch: number
  /** The caller's own wrap of the current epoch's key. */
  wrap: string
  ownerId: string
  members: SpaceMemberView[]
  invites: { inviteId: string; invitedBy: string; expiresAt: number }[]
  rekeyNeeded: boolean
  records: SpaceRecordView[]
  more: boolean
}

export interface PutResult {
  recordId: string
  stored: boolean
}

type SpaceRow = {
  spaceId: string
  ownerId: string
  epoch: number
  rekeyNeeded: number
  seq: number
  recordCount: number
  /** Decoded blob bytes of every record held, deletions included. */
  blobBytes: number
  lastActiveAt: number
}

type MemberRow = {
  memberId: string
  dhPub: string
  tokenHash: string
  wrap: string
  joinedAt: number
}

type InviteRow = {
  inviteId: string
  invitedBy: string
  joinVerifier: string
  expiresAt: number
  badJoins: number
  /** Set once the invite is used; kept until it expires, for a retried join. */
  joinedMemberId: string | null
  joinedTokenHash: string | null
}

type StoredRecord = {
  stamp: number
  deleted: number
  blobHash: string
  /** The decoded blob's size. */
  bytes: number
}

type RecordRow = {
  recordId: string
  epoch: number
  stamp: number
  deleted: number
  blob: string
  seq: number
}

/**
 * Every table is created by `create`, never for a probe: an unknown space
 * stores nothing, and a deleted one keeps only `tombstone`. A space made
 * before a table was added gets it when its object next starts.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS space (
     singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
     space_id       TEXT NOT NULL,
     owner_id       TEXT NOT NULL,
     epoch          INTEGER NOT NULL,
     rekey_needed   INTEGER NOT NULL,
     seq            INTEGER NOT NULL,
     record_count   INTEGER NOT NULL,
     blob_bytes     INTEGER NOT NULL,
     created_at     INTEGER NOT NULL,
     last_active_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS member (
     member_id  TEXT PRIMARY KEY,
     dh_pub     TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     wrap       TEXT NOT NULL,
     joined_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS invite (
     invite_id         TEXT PRIMARY KEY,
     invited_by        TEXT NOT NULL,
     join_verifier     TEXT NOT NULL,
     expires_at        INTEGER NOT NULL,
     created_at        INTEGER NOT NULL,
     bad_joins         INTEGER NOT NULL,
     joined_member_id  TEXT,
     joined_token_hash TEXT
   )`,
  // Invites closed before they were used (deleted, burned, or closed by a
  // leave, removal, or rekey): only the id, until it would have expired, so
  // it can't be opened again.
  `CREATE TABLE IF NOT EXISTS closed_invite (
     invite_id  TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS record (
     record_id  TEXT PRIMARY KEY,
     epoch      INTEGER NOT NULL,
     stamp      INTEGER NOT NULL,
     deleted    INTEGER NOT NULL,
     blob       TEXT NOT NULL,
     blob_hash  TEXT NOT NULL,
     blob_bytes INTEGER NOT NULL,
     seq        INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS record_seq ON record (seq)',
  // Records put per hour over the last day: counts, not a list of puts.
  `CREATE TABLE IF NOT EXISTS put_hour (
     hour    INTEGER PRIMARY KEY,
     records INTEGER NOT NULL
   )`,
  // Each member's puts over the last minute, counted per millisecond, so
  // the budget holds across eviction: counts, not a list of puts.
  `CREATE TABLE IF NOT EXISTS member_put (
     member_id TEXT NOT NULL,
     at        INTEGER NOT NULL,
     puts      INTEGER NOT NULL,
     PRIMARY KEY (member_id, at)
   )`,
]

const SPACE_TABLES = [
  'record',
  'invite',
  'closed_invite',
  'member',
  'put_hour',
  'member_put',
  'space',
]

const TOMBSTONE_SCHEMA = `CREATE TABLE IF NOT EXISTS tombstone (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  deleted_at INTEGER NOT NULL
)`

const HOUR_MS = 60 * 60_000
/** How soon the alarm tries `#purge` again after it failed. */
const PURGE_RETRY_MS = 10 * 60_000

/** `WebSocket.READY_STATE_OPEN`. */
const SOCKET_OPEN = 1

/** Stored on each live socket; survives hibernation. */
type LiveAttachment = { openedAt: number; memberId: string }

const attachmentOf = (ws: WebSocket): LiveAttachment | null =>
  (ws.deserializeAttachment() as LiveAttachment | null) ?? null

const closeQuietly = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // Already closing or gone.
  }
}

const failure = (result: SpacesFailure): Response =>
  spacesErrorResponse(result.error, {
    retryAfterSeconds: result.retryAfterSeconds,
  })

/** When a space whose activity was last recorded at `lastActiveAt` goes. */
const retentionDeadline = (lastActiveAt: number): number =>
  lastActiveAt + LIMITS.retentionMs + LIMITS.activityGranularityMs

/**
 * What a write did: its answer, whether the space changed (the sockets hear
 * `changed`), whose sockets close because they're no longer members, and
 * whether the space is gone (every socket closes, the storage is purged).
 */
type Change<T> = {
  result: SpacesResult<T>
  changed?: boolean
  dropped?: string[]
  wiped?: boolean
}

const refusal = (error: SpacesErrorCode, retryAfter?: number): Change<never> => ({
  result: fail(error, retryAfter),
})

/** The open invites a close takes: one, those a member made, or all. */
type OpenInvites = { inviteId: string } | { invitedBy: string } | 'all'

/**
 * Which of `others` (oldest first) a new socket of `opener` replaces when
 * the space is `excess` past its socket cap, chosen one at a time: the
 * opener's own oldest while they hold `liveSocketsPerMember` or more, else
 * the oldest socket of whichever member holds the most (on a tie, the
 * oldest of theirs). So a member who keeps opening sockets replaces only
 * their own, and an excess bigger than one member's share (after KV
 * lowered the cap) spills over the biggest holders until the space is at
 * the cap.
 */
const replacedSockets = (
  others: readonly WebSocket[],
  opener: string,
  excess: number
): WebSocket[] => {
  const pool = others.map((ws) => ({ ws, memberId: attachmentOf(ws)?.memberId }))
  const replaced: WebSocket[] = []
  while (replaced.length < excess && pool.length > 0) {
    const held = new Map<string | undefined, number>()
    for (const { memberId } of pool) held.set(memberId, (held.get(memberId) ?? 0) + 1)
    const own = (held.get(opener) ?? 0) >= LIMITS.liveSocketsPerMember
    const most = Math.max(...held.values())
    const index = pool.findIndex(({ memberId }) =>
      own ? memberId === opener : held.get(memberId) === most
    )
    replaced.push(pool.splice(index, 1)[0].ws)
  }
  return replaced
}

type Verdict = 'newer' | 'older' | 'same'

/**
 * Which version of a record the space keeps: the newer `stamp`; on a tie a
 * deletion, then the lower SHA-256 of the blob. `same` is the version
 * already held (a retried put).
 */
const compareVersions = (incoming: PutRecordArgs, held: StoredRecord): Verdict => {
  if (incoming.stamp !== held.stamp)
    return incoming.stamp > held.stamp ? 'newer' : 'older'
  const deleted = held.deleted === 1
  if (incoming.deleted !== deleted) return incoming.deleted ? 'newer' : 'older'
  if (incoming.blobHash === held.blobHash) return 'same'
  return incoming.blobHash < held.blobHash ? 'newer' : 'older'
}

export class SharedSpace extends DurableObject<Environment> {
  #schemaReady = false

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env)
    // Keepalives get their answer from the runtime without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    )
    // Before any request: a space made before a table was added gets it,
    // and a deleted space that lost its tombstone gets it back. An unknown
    // space stays as it is.
    void ctx.blockConcurrencyWhile(async () => {
      if (this.#hasTable('space')) {
        this.#ensureSchema()
        this.#schemaReady = true
        return
      }
      if (this.#hasTable('tombstone')) return
      // Only an object that once held a space has an alarm, so one with
      // neither a space nor a tombstone lost its tombstone after
      // `deleteAll()` (`#purge`), and its id must stay `gone`.
      if ((await ctx.storage.getAlarm()) != null)
        ctx.storage.transactionSync(() => this.#writeTombstone(Date.now()))
    })
  }

  // --- Creating and joining --------------------------------------------------

  /**
   * Makes the space at epoch 1 with the caller as its only member and owner.
   * An identical retry on a space nothing has changed since gets the same
   * answer again (`#existingCreate`).
   */
  async create(args: CreateSpaceArgs): Promise<SpacesResult<SpaceCreated>> {
    let created = false
    const { result } = this.#commit((now): Change<SpaceCreated> => {
      const existing = this.#existingCreate(args)
      if (existing) return { result: existing }
      this.#ensureSchema()
      this.#sql.exec(
        `INSERT INTO space (singleton, space_id, owner_id, epoch, rekey_needed,
                            seq, record_count, blob_bytes, created_at, last_active_at)
         VALUES (1, ?, ?, 1, 0, 1, 0, 0, ?, ?)`,
        args.spaceId,
        args.memberId,
        now,
        now
      )
      this.#insertMember(args, now)
      created = true
      return { result: ok({ seq: 1, joinedAt: now }) }
    })
    if (created) {
      // Only once it committed: a create that rolled back left no tables.
      this.#schemaReady = true
      await this.ctx.storage.setAlarm(retentionDeadline(Date.now()))
    }
    return result
  }

  /**
   * What `create` answers for an id that exists or existed, without
   * changing anything: an identical retry's answer, `conflict`, or `gone`.
   * Null when `create` would make the space. The Worker asks first, so a
   * retry (a lost answer) doesn't count against the account's daily
   * creates again.
   */
  async existingCreate(
    args: CreateSpaceArgs
  ): Promise<SpacesResult<SpaceCreated> | null> {
    return this.#existingCreate(args)
  }

  /**
   * Uses an invite: the caller becomes a member with its own token hash,
   * public key, and wrap. Five wrong secrets burn the invite. An invite
   * whose inviter is no longer on the space is closed (`not_found`). A fresh
   * join's `epoch` (the invitation's) must be current (`stale_key`), so
   * nobody joins with a key for another epoch.
   *
   * A retry of a join that went through (same secret, `memberId`, `dhPub`,
   * and `tokenHash`, the member still there, whatever its `epoch`) answers
   * with the space's head and current epoch now, and the member's original
   * `joinedAt`. Any other join by a current member is `conflict`.
   */
  async join(args: JoinSpaceArgs): Promise<SpacesResult<SpaceJoined>> {
    return this.#commit((now): Change<SpaceJoined> => {
      if (this.#deleted()) return refusal('gone')
      const space = this.#space()
      if (!space || space.spaceId !== args.spaceId) return refusal('not_found')
      this.#prune(now)
      const invite = this.#invite(args.inviteId)
      if (!invite) return refusal('not_found')
      const secretMatches = timingSafeEqual(args.joinHash, invite.joinVerifier)
      const member = this.#member(args.memberId)
      if (invite.joinedMemberId != null) {
        // A used invite counts no wrong secrets (it can't be burned) and
        // answers only the people already on the space.
        if (!secretMatches || !member) return refusal('not_found')
        const retry =
          invite.joinedMemberId === args.memberId &&
          member.dhPub === args.dhPub &&
          timingSafeEqual(args.tokenHash, invite.joinedTokenHash ?? '') &&
          timingSafeEqual(args.tokenHash, member.tokenHash)
        return retry
          ? {
              result: ok({
                seq: space.seq,
                epoch: space.epoch,
                joinedAt: member.joinedAt,
              }),
            }
          : refusal('conflict')
      }
      // `leave` and `member/remove` close their member's invites; this holds
      // even for one that slipped past them.
      if (!this.#member(invite.invitedBy)) return refusal('not_found')
      if (!secretMatches) {
        if (invite.badJoins + 1 >= LIMITS.badJoins) {
          this.#closeInvites({ inviteId: args.inviteId })
          this.#advance()
          return { result: fail('forbidden'), changed: true }
        }
        this.#sql.exec(
          'UPDATE invite SET bad_joins = bad_joins + 1 WHERE invite_id = ?',
          args.inviteId
        )
        return refusal('forbidden')
      }
      if (member) return refusal('conflict')
      // An open invite was made at the current epoch (a rekey closes them
      // all), so another epoch means the invitation carries another key.
      if (args.epoch !== space.epoch) return refusal('stale_key')
      // The invite already holds a place; a lowered cap still applies.
      if (this.#memberCount() + this.#openInviteCount(now) > args.maxMembers) {
        logSpacesLimitHit('spaces/join', 'maxMembers')
        return refusal('limit')
      }
      this.#insertMember(args, now)
      this.#sql.exec(
        `UPDATE invite SET joined_member_id = ?, joined_token_hash = ?
         WHERE invite_id = ?`,
        args.memberId,
        args.tokenHash,
        args.inviteId
      )
      const seq = this.#advance()
      return {
        result: ok({ seq, epoch: space.epoch, joinedAt: now }),
        changed: true,
      }
    }).result
  }

  // --- Records ---------------------------------------------------------------

  /**
   * Records with `seq > since` in `seq` order, up to `limit` (and the page's
   * size budget), plus the complete members and open invites. Records the
   * space's activity when it was last recorded more than
   * `activityGranularityMs` ago, so most syncs write nothing.
   */
  async sync(args: SyncSpaceArgs): Promise<SpacesResult<SpaceSyncView>> {
    return this.#commit((now): Change<SpaceSyncView> => {
      const auth = this.#authenticate(args)
      if (!auth.ok) return { result: auth }
      this.#prune(now)
      if (now - auth.value.lastActiveAt > LIMITS.activityGranularityMs)
        this.#touch(now)
      return {
        result: ok(
          this.#snapshot(auth.value, args.memberId, args.since, args.limit, now)
        ),
      }
    }).result
  }

  /**
   * Stores each record unless the space holds a newer version of it
   * (`compareVersions`); each stored record takes the next `seq`. A record
   * id reserved to someone else (`m.<memberId>` but the caller's own, or
   * `k.<x>` from anyone but the owner: `mayPutRecord`) is `forbidden`, and
   * every record must be sealed under the current epoch (`stale_key`);
   * either way nothing is stored, and the member's put budget isn't spent.
   * Refused whole past the record or byte cap (`limit`), the member's puts a
   * rolling minute, or the space's records a rolling day (`rate_limited`).
   * Touches `lastActiveAt`.
   */
  async put(
    args: PutSpaceArgs
  ): Promise<SpacesResult<{ seq: number; results: PutResult[] }>> {
    return this.#commit((now): Change<{ seq: number; results: PutResult[] }> => {
      const auth = this.#authenticate(args)
      if (!auth.ok) return { result: auth }
      const space = auth.value
      // Both refused before anything is written, so neither costs a put.
      if (
        args.records.some(
          (record) => !mayPutRecord(record.recordId, args.memberId, space.ownerId)
        )
      )
        return refusal('forbidden')
      if (args.records.some((record) => record.epoch !== space.epoch))
        return refusal('stale_key')
      const wait = this.#memberPutWaitMs(args.memberId, now)
      if (wait != null) {
        logSpacesLimitHit('spaces/put', 'memberPuts')
        return refusal('rate_limited', retryAfterSeconds(wait))
      }
      // From here the put counts against the member, refused or not. It's
      // counted in this transaction, so a put that throws costs nothing.
      this.#countPut(args.memberId, now)

      const plan = this.#plan(args.records)
      // Running counts, so a put never scans the table.
      const capped = this.#refuseOverCaps('spaces/put', space, plan)
      if (capped) return { result: capped }
      const budget = this.#refuseOverDailyRecords(args.records.length, now)
      if (budget) return { result: budget }

      let seq = space.seq
      const results: PutResult[] = []
      args.records.forEach((record, index) => {
        const verdict = plan.verdicts[index]
        if (verdict === 'newer') this.#storeRecord(record, ++seq)
        results.push({ recordId: record.recordId, stored: verdict !== 'older' })
      })
      this.#sql.exec(
        `INSERT INTO put_hour (hour, records) VALUES (?, ?)
         ON CONFLICT (hour) DO UPDATE SET records = records + excluded.records`,
        Math.floor(now / HOUR_MS),
        args.records.length
      )
      this.#sql.exec(
        `UPDATE space SET seq = ?, record_count = record_count + ?,
                          blob_bytes = blob_bytes + ?, last_active_at = ?
         WHERE singleton = 1`,
        seq,
        plan.added,
        plan.bytes,
        now
      )
      return { result: ok({ seq, results }), changed: seq !== space.seq }
    }).result
  }

  // --- Invites ---------------------------------------------------------------

  /**
   * Opens an invite for any member at the current epoch (`stale_key`
   * otherwise), keeping who made it. Members plus open invites may not pass
   * `maxMembers` (`limit`). Sending the same invite again (a lost answer) is
   * a no-op while it's open; any other reuse of the id, one closed, used, or
   * burned before it expired included, is `conflict`.
   */
  async createInvite(args: CreateSpaceInviteArgs): Promise<SpacesResult<Empty>> {
    return this.#commit((now): Change<Empty> => {
      const auth = this.#authenticate(args)
      if (!auth.ok) return { result: auth }
      // A rekey closes every open invite, so an open one always matches.
      if (args.epoch !== auth.value.epoch) return refusal('stale_key')
      this.#prune(now)
      const existing = this.#invite(args.inviteId)
      if (existing) {
        const same =
          existing.joinedMemberId == null &&
          existing.invitedBy === args.memberId &&
          existing.expiresAt === args.expiresAt &&
          timingSafeEqual(existing.joinVerifier, args.joinVerifier)
        return same ? { result: ok({}) } : refusal('conflict')
      }
      if (this.#inviteClosed(args.inviteId)) return refusal('conflict')
      if (this.#memberCount() + this.#openInviteCount(now) >= args.maxMembers) {
        logSpacesLimitHit('spaces/invite/create', 'maxMembers')
        return refusal('limit')
      }
      this.#sql.exec(
        `INSERT INTO invite (invite_id, invited_by, join_verifier, expires_at,
                             created_at, bad_joins)
         VALUES (?, ?, ?, ?, ?, 0)`,
        args.inviteId,
        args.memberId,
        args.joinVerifier,
        args.expiresAt,
        now
      )
      this.#advance()
      return { result: ok({}), changed: true }
    }).result
  }

  /**
   * Closes an open invite: its inviter's or the owner's to close
   * (`forbidden` for anyone else). Idempotent: an unknown, closed, used, or
   * expired invite is already closed, so any member gets `ok` and nothing
   * changes.
   */
  async deleteInvite(args: DeleteSpaceInviteArgs): Promise<SpacesResult<Empty>> {
    return this.#commit((now): Change<Empty> => {
      const auth = this.#authenticate(args)
      if (!auth.ok) return { result: auth }
      this.#prune(now)
      const invite = this.#invite(args.inviteId)
      if (!invite || invite.joinedMemberId != null) return { result: ok({}) }
      if (invite.invitedBy !== args.memberId && auth.value.ownerId !== args.memberId)
        return refusal('forbidden')
      this.#closeInvites({ inviteId: args.inviteId })
      this.#advance()
      return { result: ok({}), changed: true }
    }).result
  }

  // --- Leaving, removal, rekeying, deleting ----------------------------------

  /**
   * Deletes the caller's token hash, key, and wrap, and closes the invites
   * they made that nobody used. An owner who leaves passes the space to the
   * member who joined first; the last member to leave deletes it.
   */
  async leave(args: MemberAuth): Promise<SpacesResult<Empty>> {
    return this.#run((now): Change<Empty> => {
      const auth = this.#authenticate(args)
      if (!auth.ok) return { result: auth }
      this.#dropMember(args.memberId)
      if (this.#memberCount() === 0) {
        this.#wipe(now)
        return { result: ok({}), wiped: true }
      }
      if (auth.value.ownerId === args.memberId) {
        const next = this.#sql
          .exec<{ memberId: string }>(
            'SELECT member_id AS memberId FROM member ORDER BY joined_at, member_id LIMIT 1'
          )
          .one().memberId
        this.#sql.exec('UPDATE space SET owner_id = ? WHERE singleton = 1', next)
      }
      this.#advance()
      return { result: ok({}), changed: true, dropped: [args.memberId] }
    })
  }

  /**
   * The owner removes a member (never themselves: they leave or delete), as
   * if they'd left, and closes every open invite, not only theirs: else the
   * removed member could come back through another member's invitation
   * before the rekey. The inviters send theirs again after it. An unknown
   * `removeId` is `ok` and changes nothing.
   */
  async removeMember(args: RemoveSpaceMemberArgs): Promise<SpacesResult<Empty>> {
    return this.#run((): Change<Empty> => {
      const auth = this.#authenticateOwner(args)
      if (!auth.ok) return { result: auth }
      if (args.removeId === args.memberId) return refusal('bad_request')
      if (!this.#member(args.removeId)) return { result: ok({}) }
      this.#dropMember(args.removeId)
      this.#closeInvites('all')
      this.#advance()
      return { result: ok({}), changed: true, dropped: [args.removeId] }
    })
  }

  /**
   * The owner moves the space to the next epoch (`stale_key` for any other)
   * with a wrap for every current member, exactly: missing one or naming
   * someone not on the space is `conflict`, since membership changed under
   * the owner's device (it syncs and tries again). Closes every open invite.
   *
   * In the same transaction it stores `link`, the record `k.<epoch>`, at the
   * new epoch and a `seq` of its own after the rekey's, replacing any version
   * of it the space holds whatever its stamp, so a link planted ahead of
   * time can't block it. It counts against the record and byte caps
   * (`limit`), as a put's records do. The answer's `seq` is the head, the
   * link's.
   */
  async rekey(args: RekeySpaceArgs): Promise<SpacesResult<{ seq: number }>> {
    return this.#run((): Change<{ seq: number }> => {
      const auth = this.#authenticateOwner(args)
      if (!auth.ok) return { result: auth }
      const space = auth.value
      const named = new Set(args.wraps.map((entry) => entry.memberId))
      // The parser refuses these first; malformed either way.
      if (named.size !== args.wraps.length) return refusal('bad_request')
      if (args.epoch !== space.epoch + 1) return refusal('stale_key')
      const members = new Set(
        this.#sql
          .exec<{ memberId: string }>('SELECT member_id AS memberId FROM member')
          .toArray()
          .map((row) => row.memberId)
      )
      if (
        named.size !== members.size ||
        [...named].some((memberId) => !members.has(memberId))
      )
        return refusal('conflict')

      const link: PutRecordArgs = {
        ...args.link,
        recordId: rekeyLinkId(args.epoch),
        epoch: args.epoch,
        deleted: false,
      }
      const held = this.#record(link.recordId)
      const size = decodedLength(link.blob)
      const plan = { added: held ? 0 : 1, bytes: size - (held?.bytes ?? 0) }
      const capped = this.#refuseOverCaps('spaces/rekey', space, plan)
      if (capped) return { result: capped }

      for (const entry of args.wraps)
        this.#sql.exec(
          'UPDATE member SET wrap = ? WHERE member_id = ?',
          entry.wrap,
          entry.memberId
        )
      this.#sql.exec(
        'UPDATE space SET epoch = ?, rekey_needed = 0 WHERE singleton = 1',
        args.epoch
      )
      this.#closeInvites('all')
      const seq = this.#advance() + 1
      this.#storeRecord(link, seq)
      this.#sql.exec(
        `UPDATE space SET seq = ?, record_count = record_count + ?,
                          blob_bytes = blob_bytes + ?
         WHERE singleton = 1`,
        seq,
        plan.added,
        plan.bytes
      )
      return { result: ok({ seq }), changed: true }
    })
  }

  /** The owner wipes the space: records, members, wraps, and invites. */
  async deleteSpace(args: MemberAuth): Promise<SpacesResult<Empty>> {
    return this.#run((now): Change<Empty> => {
      const auth = this.#authenticateOwner(args)
      if (!auth.ok) return { result: auth }
      this.#wipe(now)
      return { result: ok({}), wiped: true }
    })
  }

  // --- Retention -------------------------------------------------------------

  /**
   * Set when the space is made; each time it fires, the space goes if it's
   * had no `sync` or `put` for 400 days (`retentionDeadline`), else the
   * alarm moves to that deadline. On a deleted space it's `#purge`'s retry.
   * Only an object that once held a space has an alarm, so one with neither
   * a space nor a tombstone lost its tombstone after `deleteAll()` (`#purge`):
   * it writes it back (the constructor already does, before any request;
   * this is the backup).
   */
  async alarm(): Promise<void> {
    if (this.#deleted()) {
      await this.#purge()
      return
    }
    const space = this.#space()
    if (!space) {
      if (!this.#ready() && !this.#hasTable('tombstone'))
        this.ctx.storage.transactionSync(() => this.#writeTombstone(Date.now()))
      return
    }
    const deadline = retentionDeadline(space.lastActiveAt)
    if (Date.now() < deadline) {
      await this.ctx.storage.setAlarm(deadline)
      return
    }
    await this.#run((now): Change<Empty> => {
      this.#wipe(now)
      return { result: ok({}), wiped: true }
    })
  }

  // --- Live socket -----------------------------------------------------------

  /**
   * `GET /spaces/v1/live`, forwarded by the Worker after it checked the
   * session and the headers' shape and hashed the token: the member and the
   * member cap in `SPACES_HEADERS.member`, which only the Worker sets. Says
   * `hello` with the current `seq`.
   *
   * Past the cap (4 sockets per member the cap allows), a member who
   * already holds 4 or more replaces their own oldest; anyone else's opens
   * by closing the oldest of whoever holds the most (`replacedSockets`). So
   * no member can keep the others' sockets closed.
   */
  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return failure(fail('upgrade_required'))
    const member = decodeLiveMember(request.headers.get(SPACES_HEADERS.member))
    if (!member) return failure(fail('bad_request'))
    const auth = this.#authenticate(member)
    if (!auth.ok) return failure(auth)

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    const attachment: LiveAttachment = {
      openedAt: Date.now(),
      memberId: member.memberId,
    }
    server.serializeAttachment(attachment)
    const others = this.#liveSockets()
      .filter((ws) => ws !== server)
      .sort(
        (a, b) => (attachmentOf(a)?.openedAt ?? 0) - (attachmentOf(b)?.openedAt ?? 0)
      )
    const excess = others.length + 1 - LIMITS.liveSocketsPerMember * member.maxMembers
    if (excess > 0) {
      const { code, reason } = SPACES_LIVE_CLOSE.replaced
      for (const ws of replacedSockets(others, member.memberId, excess))
        closeQuietly(ws, code, reason)
    }
    this.#signal(server, { type: 'hello', seq: auth.value.seq })
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

  // --- Helpers ---------------------------------------------------------------

  get #sql() {
    return this.ctx.storage.sql
  }

  /**
   * Runs `work` in one transaction, then (once it committed) tells the
   * sockets: `changed` to every open socket, `gone` to members who left or
   * were removed, and to everyone when the space was wiped.
   */
  #commit<T>(work: (now: number) => Change<T>): Change<T> {
    const now = Date.now()
    const change = this.ctx.storage.transactionSync(() => work(now))
    if (change.wiped) {
      this.#closeSockets(null)
    } else {
      if (change.dropped?.length) this.#closeSockets(new Set(change.dropped))
      if (change.changed) this.#broadcast()
    }
    return change
  }

  /** `#commit`, then `#purge` once the space is wiped. */
  async #run<T>(work: (now: number) => Change<T>): Promise<SpacesResult<T>> {
    const change = this.#commit(work)
    if (change.wiped) await this.#purge()
    return change.result
  }

  #hasTable(name: string): boolean {
    return (
      this.#sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
          name
        )
        .one().n > 0
    )
  }

  #ready(): boolean {
    if (!this.#schemaReady) this.#schemaReady = this.#hasTable('space')
    return this.#schemaReady
  }

  /** Creates the space's tables; the caller sets `#schemaReady` once committed. */
  #ensureSchema(): void {
    for (const statement of SCHEMA) this.#sql.exec(statement)
  }

  /** True once the space was deleted (only its tombstone is left). */
  #deleted(): boolean {
    return !this.#ready() && this.#hasTable('tombstone')
  }

  /**
   * Drops every table but the tombstone, inside the caller's transaction,
   * so the space is gone at once for every request after it; the caller
   * then `#purge`s.
   */
  #wipe(now: number): void {
    for (const table of SPACE_TABLES)
      this.#sql.exec(`DROP TABLE IF EXISTS ${table}`)
    this.#schemaReady = false
    this.#writeTombstone(now)
  }

  #writeTombstone(deletedAt: number): void {
    this.#sql.exec(TOMBSTONE_SCHEMA)
    this.#sql.exec(
      'INSERT OR REPLACE INTO tombstone (singleton, deleted_at) VALUES (1, ?)',
      deletedAt
    )
  }

  /**
   * Frees a deleted space's storage. Dropping its tables (`#wipe`) already
   * made it gone, atomically with the check that allowed it, but Cloudflare
   * says dropped tables don't free a SQLite Durable Object's storage, which
   * is billed until `deleteAll()`. So: `deleteAll()` (all or nothing), then
   * the retry alarm set again and the tombstone written back, all inside
   * `blockConcurrencyWhile` (`deleteAllThen`), so no request ever sees the
   * space without its tombstone.
   *
   * If a step fails, workerd resets the object, and the request that wiped
   * the space fails (500) although the space is already gone: a retry gets
   * `gone`. The alarm, set before `deleteAll()` and again after it (from
   * compatibility date 2026-02-24 `deleteAll()` drops it), tries again. A
   * tombstone the failure lost is written back by the next instance's
   * constructor, before any request, and by the alarm otherwise.
   */
  async #purge(): Promise<void> {
    try {
      const deletedAt =
        this.#sql
          .exec<{ at: number }>('SELECT deleted_at AS at FROM tombstone')
          .toArray()[0]?.at ?? Date.now()
      const retryAt = Date.now() + PURGE_RETRY_MS
      await this.ctx.storage.setAlarm(retryAt)
      await deleteAllThen(this.ctx, {
        afterDeleteAll: () => this.ctx.storage.setAlarm(retryAt),
        restore: () => this.#writeTombstone(deletedAt),
      })
      this.#schemaReady = false
      await this.ctx.storage.deleteAlarm()
    } catch (error) {
      // The space is already gone; only its storage waits for the alarm.
      console.warn('spaces: storage purge failed; retrying from the alarm')
      captureOperationFailure(error, 'spaces/purge')
    }
  }

  #space(): SpaceRow | null {
    if (!this.#ready()) return null
    return (
      this.#sql
        .exec<SpaceRow>(
          `SELECT space_id AS spaceId, owner_id AS ownerId, epoch,
                  rekey_needed AS rekeyNeeded, seq, record_count AS recordCount,
                  blob_bytes AS blobBytes, last_active_at AS lastActiveAt
           FROM space WHERE singleton = 1`
        )
        .toArray()[0] ?? null
    )
  }

  /**
   * `create`'s answer for an id that exists or existed: `gone` once deleted;
   * on a space nothing has changed since (`seq` 1), the same answer for an
   * identical retry (same `memberId`, `dhPub`, `tokenHash`, and `wrap`);
   * else `conflict`. Null for an id never used.
   */
  #existingCreate(args: CreateSpaceArgs): SpacesResult<SpaceCreated> | null {
    if (this.#deleted()) return fail('gone')
    const space = this.#space()
    if (!space) return null
    const member = space.seq === 1 ? this.#member(args.memberId) : null
    const retry =
      member != null &&
      space.spaceId === args.spaceId &&
      space.ownerId === args.memberId &&
      member.dhPub === args.dhPub &&
      member.wrap === args.wrap &&
      timingSafeEqual(args.tokenHash, member.tokenHash)
    return retry ? ok({ seq: 1, joinedAt: member.joinedAt }) : fail('conflict')
  }

  /**
   * The space, for a member whose token hash matches: `gone` when the space
   * doesn't exist (deleted, or never made) or the member isn't on it,
   * `forbidden` for a member's wrong token.
   */
  #authenticate(auth: MemberAuth): SpacesResult<SpaceRow> {
    const space = this.#space()
    if (!space || space.spaceId !== auth.spaceId) return fail('gone')
    const member = this.#member(auth.memberId)
    if (!member) return fail('gone')
    if (!timingSafeEqual(auth.tokenHash, member.tokenHash)) return fail('forbidden')
    return ok(space)
  }

  /** `#authenticate`, then only the owner (`forbidden`). */
  #authenticateOwner(auth: MemberAuth): SpacesResult<SpaceRow> {
    const space = this.#authenticate(auth)
    if (space.ok && space.value.ownerId !== auth.memberId) return fail('forbidden')
    return space
  }

  #member(memberId: string): MemberRow | null {
    return (
      this.#sql
        .exec<MemberRow>(
          `SELECT member_id AS memberId, dh_pub AS dhPub, token_hash AS tokenHash,
                  wrap, joined_at AS joinedAt
           FROM member WHERE member_id = ?`,
          memberId
        )
        .toArray()[0] ?? null
    )
  }

  #insertMember(
    member: Pick<MemberRow, 'memberId' | 'dhPub' | 'tokenHash' | 'wrap'>,
    now: number
  ): void {
    this.#sql.exec(
      `INSERT INTO member (member_id, dh_pub, token_hash, wrap, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
      member.memberId,
      member.dhPub,
      member.tokenHash,
      member.wrap,
      now
    )
  }

  /**
   * Takes a member off the space: their token hash, key, and wrap go, and
   * the invites they made that nobody used close, freeing those places. The
   * owner should rekey.
   */
  #dropMember(memberId: string): void {
    this.#sql.exec('DELETE FROM member WHERE member_id = ?', memberId)
    this.#closeInvites({ invitedBy: memberId })
    this.#sql.exec('UPDATE space SET rekey_needed = 1 WHERE singleton = 1')
  }

  /**
   * Closes `which` open invites: each one's id moves to `closed_invite`
   * until it would have expired, so it can't be opened again. Used ones
   * stay until they expire, for a retried join.
   */
  #closeInvites(which: OpenInvites): void {
    const [filter, bindings]: [string, string[]] =
      which === 'all'
        ? ['', []]
        : 'inviteId' in which
          ? [' AND invite_id = ?', [which.inviteId]]
          : [' AND invited_by = ?', [which.invitedBy]]
    this.#sql.exec(
      `INSERT OR REPLACE INTO closed_invite (invite_id, expires_at)
       SELECT invite_id, expires_at FROM invite
       WHERE joined_member_id IS NULL${filter}`,
      ...bindings
    )
    this.#sql.exec(
      `DELETE FROM invite WHERE joined_member_id IS NULL${filter}`,
      ...bindings
    )
  }

  /** Whether `inviteId` was closed before it was used, and hasn't expired. */
  #inviteClosed(inviteId: string): boolean {
    return (
      this.#count(
        'SELECT COUNT(*) AS n FROM closed_invite WHERE invite_id = ?',
        inviteId
      ) > 0
    )
  }

  #invite(inviteId: string): InviteRow | null {
    return (
      this.#sql
        .exec<InviteRow>(
          `SELECT invite_id AS inviteId, invited_by AS invitedBy,
                  join_verifier AS joinVerifier, expires_at AS expiresAt,
                  bad_joins AS badJoins, joined_member_id AS joinedMemberId,
                  joined_token_hash AS joinedTokenHash
           FROM invite WHERE invite_id = ?`,
          inviteId
        )
        .toArray()[0] ?? null
    )
  }

  #record(recordId: string): StoredRecord | null {
    return (
      this.#sql
        .exec<StoredRecord>(
          `SELECT stamp, deleted, blob_hash AS blobHash, blob_bytes AS bytes
           FROM record WHERE record_id = ?`,
          recordId
        )
        .toArray()[0] ?? null
    )
  }

  /** Writes `record` as the version the space holds, at `seq`. */
  #storeRecord(record: PutRecordArgs, seq: number): void {
    this.#sql.exec(
      `INSERT INTO record (record_id, epoch, stamp, deleted, blob, blob_hash,
                           blob_bytes, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (record_id) DO UPDATE SET
         epoch = excluded.epoch, stamp = excluded.stamp,
         deleted = excluded.deleted, blob = excluded.blob,
         blob_hash = excluded.blob_hash, blob_bytes = excluded.blob_bytes,
         seq = excluded.seq`,
      record.recordId,
      record.epoch,
      record.stamp,
      record.deleted ? 1 : 0,
      record.blob,
      record.blobHash,
      decodedLength(record.blob),
      seq
    )
  }

  /**
   * What a put would do, without writing: each record's verdict in order (a
   * record put twice meets its own earlier version), how many records are
   * new to the space, and the change in decoded blob bytes (a replaced
   * version gives its bytes back).
   */
  #plan(records: PutRecordArgs[]): {
    verdicts: Verdict[]
    added: number
    bytes: number
  } {
    const pending = new Map<string, StoredRecord>()
    let added = 0
    let bytes = 0
    const verdicts = records.map((record) => {
      const held = pending.get(record.recordId) ?? this.#record(record.recordId)
      const verdict = held ? compareVersions(record, held) : 'newer'
      if (verdict === 'newer') {
        const size = decodedLength(record.blob)
        if (!held) added++
        bytes += size - (held?.bytes ?? 0)
        pending.set(record.recordId, {
          stamp: record.stamp,
          deleted: record.deleted ? 1 : 0,
          blobHash: record.blobHash,
          bytes: size,
        })
      }
      return verdict
    })
    return { verdicts, added, bytes }
  }

  /**
   * `limit` when `added` more records or `bytes` more decoded bytes would
   * take the space past its record or byte cap (from the running counts, so
   * nothing scans the table); or null.
   */
  #refuseOverCaps(
    op: string,
    space: SpaceRow,
    plan: { added: number; bytes: number }
  ): SpacesFailure | null {
    if (space.recordCount + plan.added > LIMITS.records) {
      logSpacesLimitHit(op, 'records')
      return fail('limit')
    }
    if (space.blobBytes + plan.bytes > LIMITS.spaceBytes) {
      logSpacesLimitHit(op, 'spaceBytes')
      return fail('limit')
    }
    return null
  }

  #count(query: string, ...bindings: (string | number)[]): number {
    return this.#sql.exec<{ n: number }>(query, ...bindings).one().n
  }

  #memberCount(): number {
    return this.#count('SELECT COUNT(*) AS n FROM member')
  }

  #openInviteCount(now: number): number {
    return this.#count(
      'SELECT COUNT(*) AS n FROM invite WHERE joined_member_id IS NULL AND expires_at > ?',
      now
    )
  }

  /**
   * Expired invites go, used and closed ones included: a retried join can't
   * outlive them, and a retried `invite/create` can't name a past expiry.
   */
  #prune(now: number): void {
    this.#sql.exec('DELETE FROM invite WHERE expires_at <= ?', now)
    this.#sql.exec('DELETE FROM closed_invite WHERE expires_at <= ?', now)
  }

  #touch(now: number): void {
    this.#sql.exec('UPDATE space SET last_active_at = ? WHERE singleton = 1', now)
  }

  #advance(): number {
    this.#sql.exec('UPDATE space SET seq = seq + 1 WHERE singleton = 1')
    return this.#space()?.seq ?? 0
  }

  /**
   * How long until `memberId` may put again, past their puts a rolling
   * minute; or null. Drops every member's counts older than the minute.
   */
  #memberPutWaitMs(memberId: string, now: number): number | null {
    this.#sql.exec(
      'DELETE FROM member_put WHERE at <= ?',
      now - LIMITS.memberPutWindowMs
    )
    const buckets = this.#sql
      .exec<WindowBucket>(
        'SELECT at AS start, puts AS count FROM member_put WHERE member_id = ? ORDER BY at',
        memberId
      )
      .toArray()
    return rollingWindowWaitMs(
      buckets,
      1,
      LIMITS.memberPuts,
      LIMITS.memberPutWindowMs,
      now
    )
  }

  #countPut(memberId: string, now: number): void {
    this.#sql.exec(
      `INSERT INTO member_put (member_id, at, puts) VALUES (?, ?, 1)
       ON CONFLICT (member_id, at) DO UPDATE SET puts = puts + 1`,
      memberId,
      now
    )
  }

  /**
   * `rate_limited` when `count` more records would pass the space's records
   * a rolling day, until enough of the oldest hours leave the window; or
   * null.
   */
  #refuseOverDailyRecords(count: number, now: number): SpacesFailure | null {
    const windowHours = Math.round(LIMITS.spaceRecordWindowMs / HOUR_MS)
    this.#sql.exec(
      'DELETE FROM put_hour WHERE hour <= ?',
      Math.floor(now / HOUR_MS) - windowHours
    )
    const buckets = this.#sql
      .exec<{ hour: number; records: number }>(
        'SELECT hour, records FROM put_hour ORDER BY hour'
      )
      .toArray()
      .map((bucket) => ({ start: bucket.hour * HOUR_MS, count: bucket.records }))
    const wait = rollingWindowWaitMs(
      buckets,
      count,
      LIMITS.spaceRecordsPerDay,
      windowHours * HOUR_MS,
      now
    )
    if (wait == null) return null
    logSpacesLimitHit('spaces/put', 'spaceRecordsPerDay')
    return fail('rate_limited', retryAfterSeconds(wait))
  }

  /**
   * `sync`'s answer for `memberId`; see `SpaceSyncView`. Records are read in
   * whole chunks (`readSeqPage`), so a page cut short by `limit` or the
   * size budget leaves no cursor open to block a later `#wipe`.
   */
  #snapshot(
    space: SpaceRow,
    memberId: string,
    since: number,
    limit: number,
    now: number
  ): SpaceSyncView {
    let chars = 0
    const page = readSeqPage(
      (after, count) =>
        this.#sql
          .exec<RecordRow>(
            `SELECT record_id AS recordId, epoch, stamp, deleted, blob, seq
             FROM record WHERE seq > ? ORDER BY seq LIMIT ?`,
            after,
            count
          )
          .toArray(),
      since,
      (row, taken) => {
        if (
          taken.length === limit ||
          (taken.length > 0 && chars + row.blob.length > LIMITS.syncChars)
        )
          return false
        chars += row.blob.length
        return true
      },
      // One past `limit` tells whether there's more.
      Math.min(SEQ_PAGE_CHUNK, limit + 1)
    )
    const records = page.rows.map((row) => ({ ...row, deleted: row.deleted === 1 }))
    return {
      seq: page.more ? records[records.length - 1].seq : space.seq,
      epoch: space.epoch,
      wrap: this.#member(memberId)?.wrap ?? '',
      ownerId: space.ownerId,
      members: this.#sql
        .exec<SpaceMemberView>(
          `SELECT member_id AS memberId, dh_pub AS dhPub, joined_at AS joinedAt
           FROM member ORDER BY joined_at, member_id`
        )
        .toArray(),
      invites: this.#sql
        .exec<{ inviteId: string; invitedBy: string; expiresAt: number }>(
          `SELECT invite_id AS inviteId, invited_by AS invitedBy, expires_at AS expiresAt
           FROM invite WHERE joined_member_id IS NULL AND expires_at > ?
           ORDER BY created_at, invite_id`,
          now
        )
        .toArray(),
      rekeyNeeded: space.rekeyNeeded === 1,
      records,
      more: page.more,
    }
  }

  #liveSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === SOCKET_OPEN)
  }

  #signal(ws: WebSocket, message: SpacesLiveMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // A socket mid-close; its close handler cleans up.
    }
  }

  /** `changed` with the head to every open socket. Never fails the write. */
  #broadcast(): void {
    try {
      const sockets = this.#liveSockets()
      if (!sockets.length) return
      const message: SpacesLiveMessage = {
        type: 'changed',
        seq: this.#space()?.seq ?? 0,
      }
      for (const ws of sockets) this.#signal(ws, message)
    } catch {
      // The write already committed; a socket problem must not surface.
    }
  }

  /** Closes `members`' sockets (everyone's for null) with `4001 "gone"`. */
  #closeSockets(members: ReadonlySet<string> | null): void {
    const { code, reason } = SPACES_LIVE_CLOSE.gone
    for (const ws of this.#liveSockets()) {
      const memberId = attachmentOf(ws)?.memberId
      if (members == null || (memberId != null && members.has(memberId)))
        closeQuietly(ws, code, reason)
    }
  }
}
