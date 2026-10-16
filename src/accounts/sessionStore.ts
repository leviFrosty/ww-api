import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { bytesToBase64Url, sha256Bytes, timingSafeEqual } from '../crypto'
import { ACCOUNT_LIMITS, type RefreshToken } from './contracts'
import { accountSessions, type SessionPlatform } from './schema'
import type { AccountsDb } from './store'

/**
 * Session rows in the accounts database (`account_sessions`). A session is
 * live until it's revoked or reaches `expiresAt`, 90 days after it opened.
 *
 * Refresh tokens are `<sessionId>.<secret>` (opaque to the app), so a token
 * names its session even after it was replaced. Only the SHA-256 of a whole
 * token is stored: the current one, and the one it replaced, which still
 * works for a minute after the rotation so a lost response doesn't end the
 * session. Presenting it later, or any older token of a live session, ends
 * the session.
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

/** A refresh token for the session: a random secret. */
const newRefreshToken = (sessionId: string) =>
  withHash(`${sessionId}.${bytesToBase64Url(randomBytes(32))}`)

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
 * `sessionsPerAccount`, in one batch.
 */
export const createSession = async (
  db: AccountsDb,
  input: {
    accountId: string
    platform: SessionPlatform
    device: string | null
  },
  now: number = Date.now()
): Promise<IssuedSession> => {
  const id = bytesToBase64Url(randomBytes(16))
  const refresh = await newRefreshToken(id)
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

const revoke = (db: AccountsDb, sessionId: string, now: number) =>
  db
    .update(accountSessions)
    .set({ revokedAt: new Date(now) })
    .where(
      and(eq(accountSessions.id, sessionId), isNull(accountSessions.revokedAt))
    )

const findSession = async (
  db: AccountsDb,
  sessionId: string
): Promise<SessionRow | undefined> =>
  (await db
    .select(sessionColumns)
    .from(accountSessions)
    .where(eq(accountSessions.id, sessionId))
    .get()) as SessionRow | undefined

/**
 * Replaces the session's refresh token. Null means 401 `unauthorized`: an
 * unknown session, an ended or expired one, or a token the session replaced
 * that isn't the one just replaced within its minute, which also ends the
 * session.
 *
 * Within that minute the replaced token gets another new token, and the one
 * issued in between stops working; the minute still counts from the first
 * rotation, so retries can't stretch it.
 */
export const refreshSession = async (
  db: AccountsDb,
  presented: RefreshToken,
  now: number = Date.now()
): Promise<IssuedSession | null> => {
  const hash = await refreshHash(presented.token)
  let row = await findSession(db, presented.sessionId)
  if (!row || !isLive(row, now)) return null

  if (timingSafeEqual(hash, row.refreshHash)) {
    const next = await newRefreshToken(row.id)
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
    if (changes(rotated) === 1)
      return { session: record(row), refreshToken: next.token }
    // A concurrent refresh with the same token won; this one is now the
    // replaced token, answered below.
    row = await findSession(db, presented.sessionId)
    if (!row || !isLive(row, now)) return null
  }

  const replaced =
    row.previousRefreshHash != null &&
    timingSafeEqual(hash, row.previousRefreshHash)
  const inGrace =
    row.rotatedAt != null && now - row.rotatedAt.getTime() <= refreshGraceMs
  if (!replaced || !inGrace) {
    // Replaced over a minute ago, or older still: someone kept a copy.
    await revoke(db, row.id, now)
    return null
  }
  const next = await newRefreshToken(row.id)
  const reissued = await db
    .update(accountSessions)
    .set({ refreshHash: next.hash })
    .where(
      and(
        eq(accountSessions.id, row.id),
        eq(accountSessions.previousRefreshHash, hash),
        isNull(accountSessions.revokedAt)
      )
    )
  return changes(reissued) === 1
    ? { session: record(row), refreshToken: next.token }
    : null
}

/** Ends the account's session; ending an ended one is a no-op. */
export const closeSession = async (
  db: AccountsDb,
  accountId: string,
  sessionId: string,
  now: number = Date.now()
): Promise<void> => {
  await db
    .update(accountSessions)
    .set({ revokedAt: new Date(now) })
    .where(
      and(
        eq(accountSessions.id, sessionId),
        eq(accountSessions.accountId, accountId),
        isNull(accountSessions.revokedAt)
      )
    )
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
