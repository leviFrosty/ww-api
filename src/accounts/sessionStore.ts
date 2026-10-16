import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { bytesToBase64Url, sha256Bytes, timingSafeEqual } from '../crypto'
import { ACCOUNT_LIMITS, type RefreshToken } from './contracts'
import {
  accountActivity,
  accountSessions,
  type SessionPlatform,
} from './schema'
import { activityInsert, sessionIsLive } from './activity'
import type { AccountsDb } from './store'
import type { RefreshKeys } from './tokens'

/**
 * Session rows in the accounts database (`account_sessions`). A session is
 * live until it's revoked or reaches `expiresAt`, 90 days after it opened.
 *
 * Refresh tokens are `<sessionId>.<secret>.<mac>` (opaque to the app), so a
 * token names its session even after it was replaced. Only the SHA-256 of a
 * whole token is stored: the current one, and the one it replaced, which
 * still works for a minute after the rotation so a lost response doesn't end
 * the session. Presenting it later, or any older token of a live session,
 * ends the session.
 *
 * The MAC (HMAC-SHA256 over `<sessionId>.<secret>` under `macKey`, from
 * `ACCOUNT_TOKEN_SECRET` in src/accounts/tokens.ts) proves this worker
 * issued the token. The session id is no secret (every access token carries
 * it), so without the MAC anyone could end a session by sending its id with
 * a made-up secret. A token whose MAC doesn't verify under the current or
 * previous secret is refused before the database is read, and never ends a
 * session.
 *
 * The token that replaces another is derived from it (HMAC under
 * `rotationKey`, another key from the secret), so every refresh presenting
 * the same token gets the same next one: a retry after a lost response, or
 * two refreshes at once from one device, never leave the device holding a
 * token the session no longer knows.
 *
 * Every way a live session ends, and every one that opens, is logged to the
 * account's activity in the same batch (ADR 0028); expiring isn't, and a
 * token that fails its MAC never reaches the log.
 */

const {
  sessionMs,
  refreshGraceMs,
  sessionsPerAccount,
  endedSessionRetentionMs,
} = ACCOUNT_LIMITS

export interface SessionRecord {
  id: string
  accountId: string
  platform: SessionPlatform
  /** Epoch milliseconds. */
  expiresAt: number
}

/** A live session and the refresh token that now refreshes it. */
export interface IssuedSession {
  session: SessionRecord
  refreshToken: string
}

const randomBytes = (size: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(size))

const encoder = new TextEncoder()

/** b64u SHA-256 of the whole token's UTF-8. */
const refreshHash = async (token: string): Promise<string> =>
  bytesToBase64Url(await sha256Bytes(encoder.encode(token)))

const withHash = async (token: string) => ({
  token,
  hash: await refreshHash(token),
})

/** `body` (`<sessionId>.<secret>`) with its MAC under `keys`, and its hash. */
const issueRefreshToken = async (keys: RefreshKeys, body: string) => {
  const mac = await crypto.subtle.sign(
    'HMAC',
    keys.macKey,
    encoder.encode(body)
  )
  return withHash(`${body}.${bytesToBase64Url(new Uint8Array(mac))}`)
}

/**
 * Whether `presented` carries a MAC from one of `keys`. `subtle.verify`
 * compares in constant time.
 */
const isIssued = async (
  keys: readonly RefreshKeys[],
  presented: RefreshToken
): Promise<boolean> => {
  const body = encoder.encode(presented.body)
  for (const { macKey } of keys) {
    if (await crypto.subtle.verify('HMAC', macKey, presented.mac, body))
      return true
  }
  return false
}

/** A session's first refresh token: a random secret. */
const firstRefreshToken = (keys: RefreshKeys, sessionId: string) =>
  issueRefreshToken(keys, `${sessionId}.${bytesToBase64Url(randomBytes(32))}`)

/** The token that replaces `presented`, under one secret's `keys`. */
const nextRefreshToken = async (keys: RefreshKeys, presented: RefreshToken) => {
  const secret = await crypto.subtle.sign(
    'HMAC',
    keys.rotationKey,
    encoder.encode(`ww-account/v1/refresh-next\n${presented.token}`)
  )
  return issueRefreshToken(
    keys,
    `${presented.sessionId}.${bytesToBase64Url(new Uint8Array(secret))}`
  )
}

/** Rows a D1 write changed (Drizzle hands back D1's result for writes). */
const changes = (result: unknown): number =>
  (result as { meta?: { changes?: number } }).meta?.changes ?? 0

const sessionColumns = {
  id: accountSessions.id,
  accountId: accountSessions.accountId,
  platform: accountSessions.platform,
  refreshHash: accountSessions.refreshHash,
  previousRefreshHash: accountSessions.previousRefreshHash,
  expiresAt: accountSessions.expiresAt,
  revokedAt: accountSessions.revokedAt,
  rotatedAt: accountSessions.rotatedAt,
}

type SessionRow = {
  id: string
  accountId: string
  platform: SessionPlatform
  refreshHash: string
  previousRefreshHash: string | null
  expiresAt: Date
  revokedAt: Date | null
  rotatedAt: Date | null
}

const isLive = (row: SessionRow, now: number): boolean =>
  row.revokedAt == null && row.expiresAt.getTime() > now

const record = (row: SessionRow): SessionRecord => ({
  id: row.id,
  accountId: row.accountId,
  platform: row.platform,
  expiresAt: row.expiresAt.getTime(),
})

/**
 * Opens a session, then ends the account's oldest live sessions past
 * `sessionsPerAccount`, in one batch. `keys` are the current secret's.
 */
export const createSession = async (
  db: AccountsDb,
  keys: RefreshKeys,
  input: {
    accountId: string
    platform: SessionPlatform
    device: string | null
  },
  now: number = Date.now()
): Promise<IssuedSession> => {
  const id = bytesToBase64Url(randomBytes(16))
  const refresh = await firstRefreshToken(keys, id)
  const expiresAt = now + sessionMs
  // Every live session but the newest `sessionsPerAccount` (this one among
  // them). `LIMIT -1` is SQLite's "no limit", which Drizzle can't spell.
  const overflow = sql`SELECT ${accountSessions.id} FROM ${accountSessions}
    WHERE ${accountSessions.accountId} = ${input.accountId}
      AND ${accountSessions.revokedAt} IS NULL
      AND ${accountSessions.expiresAt} > ${now}
    ORDER BY ${accountSessions.createdAt} DESC, ${accountSessions.id} DESC
    LIMIT -1 OFFSET ${sessionsPerAccount}`
  await db.batch([
    db.insert(accountSessions).values({
      id,
      accountId: input.accountId,
      platform: input.platform,
      device: input.device,
      refreshHash: refresh.hash,
      createdAt: new Date(now),
      expiresAt: new Date(expiresAt),
    }),
    activityInsert(
      db,
      { accountId: input.accountId, kind: 'session.opened', sessionId: id },
      { now }
    ),
    // `session.replaced` for each session the cap is about to end, before
    // the update ends them. (Columns in the table's order; see
    // `activityInsert`.)
    db.insert(accountActivity).select(
      sql`SELECT NULL, account_id, 'session.replaced',
          id, platform, device, ${id}, ${input.platform}, ${input.device},
          NULL, ${now}
        FROM account_sessions WHERE id IN (${overflow})`
    ),
    db
      .update(accountSessions)
      .set({ revokedAt: new Date(now) })
      .where(sql`${accountSessions.id} IN (${overflow})`),
  ])
  return {
    session: {
      id,
      accountId: input.accountId,
      platform: input.platform,
      expiresAt,
    },
    refreshToken: refresh.token,
  }
}

/**
 * Ends a live session and logs why, in one batch. Nothing is logged for a
 * session that had already ended or expired.
 */
const endSession = async (
  db: AccountsDb,
  ended: {
    accountId: string
    sessionId: string
    kind: 'session.signed_out' | 'session.revoked' | 'session.refresh_reused'
    actorSessionId?: string
  },
  now: number
): Promise<void> => {
  await db.batch([
    activityInsert(db, ended, {
      now,
      onlyIf: sessionIsLive(ended.accountId, ended.sessionId, now),
    }),
    db
      .update(accountSessions)
      .set({ revokedAt: new Date(now) })
      .where(
        and(
          eq(accountSessions.id, ended.sessionId),
          eq(accountSessions.accountId, ended.accountId),
          isNull(accountSessions.revokedAt)
        )
      ),
  ])
}

const findSession = async (
  db: AccountsDb,
  sessionId: string
): Promise<SessionRow | undefined> =>
  (await db
    .select(sessionColumns)
    .from(accountSessions)
    .where(eq(accountSessions.id, sessionId))
    .get()) as SessionRow | undefined

/** What a refresh comes to, for one read of the session's row. */
type RefreshStep =
  | { done: IssuedSession | null }
  /** The row changed under this refresh: read it again. */
  | { changed: true }

/**
 * One refresh of a token this worker issued, against the row as read: the
 * current token rotates (a compare-and-swap on the hash read, so only one
 * refresh can rotate it), the replaced one within its minute gets the token
 * it was replaced by again (no write), and any other token ends the session
 * unless `raced` (this refresh saw its token current a moment ago).
 */
const refreshStep = async (
  db: AccountsDb,
  keys: readonly RefreshKeys[],
  presented: RefreshToken,
  hash: string,
  row: SessionRow | undefined,
  now: number,
  raced: boolean
): Promise<RefreshStep> => {
  if (!row || !isLive(row, now)) return { done: null }

  if (timingSafeEqual(hash, row.refreshHash)) {
    const next = await nextRefreshToken(keys[0], presented)
    const rotated = await db
      .update(accountSessions)
      .set({
        refreshHash: next.hash,
        previousRefreshHash: hash,
        rotatedAt: new Date(now),
      })
      .where(
        and(
          eq(accountSessions.id, row.id),
          eq(accountSessions.refreshHash, hash),
          isNull(accountSessions.revokedAt)
        )
      )
    return changes(rotated) === 1
      ? { done: { session: record(row), refreshToken: next.token } }
      : { changed: true }
  }

  const replaced =
    row.previousRefreshHash != null &&
    timingSafeEqual(hash, row.previousRefreshHash)
  const inGrace =
    row.rotatedAt != null && now - row.rotatedAt.getTime() <= refreshGraceMs
  if (replaced && inGrace) {
    // The current token is this one's replacement, derived and signed under
    // the secret that rotated it: the current one, or the previous one just
    // after the secret rotated.
    for (const secretKeys of keys) {
      const next = await nextRefreshToken(secretKeys, presented)
      if (timingSafeEqual(next.hash, row.refreshHash))
        return { done: { session: record(row), refreshToken: next.token } }
    }
    return { done: null }
  }

  // Issued by this worker, but replaced over a minute ago, or older still:
  // someone kept a copy. Logged as suspicious (`session.refresh_reused`).
  if (!raced)
    await endSession(
      db,
      {
        accountId: row.accountId,
        sessionId: row.id,
        kind: 'session.refresh_reused',
      },
      now
    )
  return { done: null }
}

/**
 * Replaces the session's refresh token. Null means 401 `unauthorized`: a
 * token whose MAC doesn't verify (refused before any read, so it never ends
 * a session), an unknown session, an ended or expired one, or a token the
 * session replaced that isn't the one just replaced within its minute, which
 * also ends the session.
 *
 * Within that minute the replaced token gets the same new token it was
 * replaced by; the minute counts from the rotation, so retries can't stretch
 * it. A refresh whose rotation lost a race to another with the same token
 * reads the row once more and finds its token just replaced, so both answer
 * with the same token; if the session moved on again in between, it's 401
 * and the session lives, since that token was current a moment ago.
 * `keys` are the current secret's first, then the previous one's if set.
 */
export const refreshSession = async (
  db: AccountsDb,
  keys: readonly RefreshKeys[],
  presented: RefreshToken,
  now: number = Date.now()
): Promise<IssuedSession | null> => {
  if (!(await isIssued(keys, presented))) return null
  const hash = await refreshHash(presented.token)
  for (const raced of [false, true]) {
    const row = await findSession(db, presented.sessionId)
    const step = await refreshStep(
      db,
      keys,
      presented,
      hash,
      row,
      now,
      raced
    )
    if ('done' in step) return step.done
  }
  return null
}

/** Ends the account's session; ending an ended one is a no-op. */
export const closeSession = (
  db: AccountsDb,
  accountId: string,
  sessionId: string,
  now: number = Date.now()
): Promise<void> =>
  endSession(db, { accountId, sessionId, kind: 'session.signed_out' }, now)

/**
 * Ends another of the account's sessions from the calling one
 * (`session.revoked`), or the caller's own (`session.signed_out`). False
 * when the account has no such session; an ended one is `true` (idempotent).
 */
export const revokeSession = async (
  db: AccountsDb,
  input: { accountId: string; sessionId: string; bySessionId: string },
  now: number = Date.now()
): Promise<boolean> => {
  if (input.sessionId === input.bySessionId) {
    await closeSession(db, input.accountId, input.sessionId, now)
    return true
  }
  const found = await db
    .select({ id: accountSessions.id })
    .from(accountSessions)
    .where(
      and(
        eq(accountSessions.id, input.sessionId),
        eq(accountSessions.accountId, input.accountId)
      )
    )
    .get()
  if (!found) return false
  await endSession(
    db,
    {
      accountId: input.accountId,
      sessionId: input.sessionId,
      kind: 'session.revoked',
      actorSessionId: input.bySessionId,
    },
    now
  )
  return true
}

/** A live session, as `GET /accounts/v1/sessions` lists it. */
export interface LiveSession {
  sessionId: string
  platform: SessionPlatform
  /** The sealed device label, as the session sent it. */
  device?: string
  createdAt: number
  /** Its last refresh, or when it opened. */
  lastActiveAt: number
  expiresAt: number
}

/** The account's live sessions, newest first. */
export const listLiveSessions = async (
  db: AccountsDb,
  accountId: string,
  now: number = Date.now()
): Promise<LiveSession[]> => {
  const rows = await db
    .select({
      id: accountSessions.id,
      platform: accountSessions.platform,
      device: accountSessions.device,
      createdAt: accountSessions.createdAt,
      rotatedAt: accountSessions.rotatedAt,
      expiresAt: accountSessions.expiresAt,
    })
    .from(accountSessions)
    .where(
      and(
        eq(accountSessions.accountId, accountId),
        isNull(accountSessions.revokedAt),
        gt(accountSessions.expiresAt, new Date(now))
      )
    )
    .orderBy(desc(accountSessions.createdAt), desc(accountSessions.id))
    .all()
  return rows.map((row) => ({
    sessionId: row.id,
    platform: row.platform,
    ...(row.device != null ? { device: row.device } : {}),
    createdAt: row.createdAt.getTime(),
    lastActiveAt: (row.rotatedAt ?? row.createdAt).getTime(),
    expiresAt: row.expiresAt.getTime(),
  }))
}

/**
 * Deletes sessions that ended (revoked or expired) more than
 * `endedSessionRetentionMs` ago. Run hourly by the cron.
 */
export const pruneEndedSessions = async (
  db: AccountsDb,
  now: number = Date.now()
): Promise<number> => {
  const cutoff = new Date(now - endedSessionRetentionMs)
  return changes(
    await db
      .delete(accountSessions)
      .where(
        or(
          lte(accountSessions.expiresAt, cutoff),
          lte(accountSessions.revokedAt, cutoff)
        )
      )
  )
}
