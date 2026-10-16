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
 *
 * The token that replaces another is derived from it (HMAC under a key from
 * `ACCOUNT_TOKEN_SECRET`, `rotationKey` in src/accounts/tokens.ts), so every
 * refresh presenting the same token gets the same next one: a retry after a
 * lost response, or two refreshes at once from one device, never leave the
 * device holding a token the session no longer knows.
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

/** A session's first refresh token: a random secret. */
const firstRefreshToken = (sessionId: string) =>
  withHash(`${sessionId}.${bytesToBase64Url(randomBytes(32))}`)

/** The token that replaces `presented`, under `rotationKey`. */
const nextRefreshToken = async (
  rotationKey: CryptoKey,
  presented: RefreshToken
) => {
  const secret = await crypto.subtle.sign(
    'HMAC',
    rotationKey,
    encoder.encode(`ww-account/v1/refresh-next\n${presented.token}`)
  )
  return withHash(
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
  const refresh = await firstRefreshToken(id)
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

/** What a refresh comes to, for one read of the session's row. */
type RefreshStep =
  | { done: IssuedSession | null }
  /** The row changed under this refresh: read it again. */
  | { changed: true }

/**
 * One refresh against the row as read: the current token rotates (a
 * compare-and-swap on the hash read, so only one refresh can rotate it),
 * the replaced one within its minute gets the token it was replaced by
 * again (no write), and any other token ends the session unless `raced`
 * (this refresh saw its token current a moment ago).
 */
const refreshStep = async (
  db: AccountsDb,
  rotationKeys: readonly CryptoKey[],
  presented: RefreshToken,
  hash: string,
  row: SessionRow | undefined,
  now: number,
  raced: boolean
): Promise<RefreshStep> => {
  if (!row || !isLive(row, now)) return { done: null }

  if (timingSafeEqual(hash, row.refreshHash)) {
    const next = await nextRefreshToken(rotationKeys[0], presented)
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
    // The current token is this one's replacement, derived under the key
    // that rotated it: the current one, or the previous one just after the
    // secret rotated.
    for (const key of rotationKeys) {
      const next = await nextRefreshToken(key, presented)
      if (timingSafeEqual(next.hash, row.refreshHash))
        return { done: { session: record(row), refreshToken: next.token } }
    }
    return { done: null }
  }

  // Replaced over a minute ago, or older still: someone kept a copy.
  if (!raced) await revoke(db, row.id, now)
  return { done: null }
}

/**
 * Replaces the session's refresh token. Null means 401 `unauthorized`: an
 * unknown session, an ended or expired one, or a token the session replaced
 * that isn't the one just replaced within its minute, which also ends the
 * session.
 *
 * Within that minute the replaced token gets the same new token it was
 * replaced by; the minute counts from the rotation, so retries can't stretch
 * it. A refresh whose rotation lost a race to another with the same token
 * reads the row once more and finds its token just replaced, so both answer
 * with the same token; if the session moved on again in between, it's 401
 * and the session lives, since that token was current a moment ago.
 * `rotationKeys` are the current key first, then the previous one if set.
 */
export const refreshSession = async (
  db: AccountsDb,
  rotationKeys: readonly CryptoKey[],
  presented: RefreshToken,
  now: number = Date.now()
): Promise<IssuedSession | null> => {
  const hash = await refreshHash(presented.token)
  for (const raced of [false, true]) {
    const row = await findSession(db, presented.sessionId)
    const step = await refreshStep(
      db,
      rotationKeys,
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
