import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import { ACCOUNT_LIMITS } from './contracts'
import { accountSessions, type SessionPlatform } from './schema'
import type { AccountsDb } from './store'

/**
 * Session rows in the accounts database (`account_sessions`). A session is
 * live until it's revoked or reaches `expiresAt`, 90 days after it opened.
 * Only the SHA-256 of a refresh token is stored: the current one, and the one
 * it replaced, which still works for a minute after the rotation so a lost
 * response doesn't end the session. Presenting it later, or any other
 * replaced token, ends the session.
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

const refreshHash = async (token: Uint8Array): Promise<string> =>
  bytesToBase64Url(await sha256Bytes(token))

const newRefreshToken = async () => {
  const bytes = randomBytes(32)
  return { token: bytesToBase64Url(bytes), hash: await refreshHash(bytes) }
}

/** Rows a D1 write changed (Drizzle hands back D1's result for writes). */
const changes = (result: unknown): number =>
  (result as { meta?: { changes?: number } }).meta?.changes ?? 0

const sessionColumns = {
  id: accountSessions.id,
  accountId: accountSessions.accountId,
  platform: accountSessions.platform,
  expiresAt: accountSessions.expiresAt,
  revokedAt: accountSessions.revokedAt,
  rotatedAt: accountSessions.rotatedAt,
}

type SessionRow = {
  id: string
  accountId: string
  platform: SessionPlatform
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
  const refresh = await newRefreshToken()
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

/**
 * Replaces the session's refresh token. Null means 401 `unauthorized`: an
 * unknown token, an ended or expired session, or a replaced token presented
 * more than a minute after it was replaced, which also ends the session.
 *
 * Within that minute the replaced token gets another new token, and the one
 * issued in between stops working; the minute still counts from the first
 * rotation, so retries can't stretch it.
 */
export const refreshSession = async (
  db: AccountsDb,
  token: Uint8Array,
  now: number = Date.now()
): Promise<IssuedSession | null> => {
  const hash = await refreshHash(token)

  const current = (await db
    .select(sessionColumns)
    .from(accountSessions)
    .where(eq(accountSessions.refreshHash, hash))
    .get()) as SessionRow | undefined
  if (current) {
    if (!isLive(current, now)) return null
    const next = await newRefreshToken()
    const rotated = await db
      .update(accountSessions)
      .set({
        refreshHash: next.hash,
        previousRefreshHash: hash,
        rotatedAt: new Date(now),
      })
      .where(
        and(
          eq(accountSessions.id, current.id),
          eq(accountSessions.refreshHash, hash),
          isNull(accountSessions.revokedAt)
        )
      )
    if (changes(rotated) === 1)
      return { session: record(current), refreshToken: next.token }
    // A concurrent refresh with the same token won; this one is now the
    // replaced token, answered below.
  }

  const replaced = (await db
    .select(sessionColumns)
    .from(accountSessions)
    .where(eq(accountSessions.previousRefreshHash, hash))
    .get()) as SessionRow | undefined
  if (!replaced) return null
  const inGrace =
    replaced.rotatedAt != null &&
    now - replaced.rotatedAt.getTime() <= refreshGraceMs
  if (!isLive(replaced, now) || !inGrace) {
    await revoke(db, replaced.id, now)
    return null
  }
  const next = await newRefreshToken()
  const reissued = await db
    .update(accountSessions)
    .set({ refreshHash: next.hash })
    .where(
      and(
        eq(accountSessions.id, replaced.id),
        eq(accountSessions.previousRefreshHash, hash),
        isNull(accountSessions.revokedAt)
      )
    )
  return changes(reissued) === 1
    ? { session: record(replaced), refreshToken: next.token }
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
