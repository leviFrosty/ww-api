import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { bytesToBase64Url } from '../crypto'
import {
  accountInboxes,
  accountStatusEvents,
  accounts,
  type AccountStatus,
  type AccountStatusReason,
} from './schema'
import { activityInsert } from './activity'

export const accountsDb = (d1: D1Database) => drizzle(d1)
export type AccountsDb = ReturnType<typeof accountsDb>

/** A fresh account id: b64u of 16 random bytes. */
export const newAccountId = (): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))

export interface AccountRecord {
  id: string
  accountPub: string
  status: AccountStatus
}

const accountColumns = {
  id: accounts.id,
  accountPub: accounts.accountPub,
  status: accounts.status,
}

export const findAccount = async (
  db: AccountsDb,
  accountId: string
): Promise<AccountRecord | null> =>
  (await db
    .select(accountColumns)
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()) ?? null

export const findAccountByPub = async (
  db: AccountsDb,
  accountPub: string
): Promise<AccountRecord | null> =>
  (await db
    .select(accountColumns)
    .from(accounts)
    .where(eq(accounts.accountPub, accountPub))
    .get()) ?? null

/**
 * The account for this public key, created with `newId` if there is none.
 * Idempotent: the same key always gets the same account, including when two
 * devices register it at once.
 */
export const registerAccount = async (
  db: AccountsDb,
  accountPub: string,
  newId: () => string
): Promise<AccountRecord> => {
  const existing = await findAccountByPub(db, accountPub)
  if (existing) return existing
  // `account.created` only when this insert made the row: a racing device
  // that won leaves no row under this id.
  const id = newId()
  await db.batch([
    db
      .insert(accounts)
      .values({ id, accountPub })
      .onConflictDoNothing({ target: accounts.accountPub }),
    activityInsert(
      db,
      { accountId: id, kind: 'account.created' },
      { onlyIf: sql`EXISTS (SELECT 1 FROM accounts WHERE id = ${id})` }
    ),
  ])
  const account = await findAccountByPub(db, accountPub)
  if (!account) throw new Error('accounts: registered account is missing')
  return account
}

/** The account that owns this inbox, or null when none has claimed it. */
export const findInboxAccount = async (
  db: AccountsDb,
  inboxId: string
): Promise<AccountRecord | null> =>
  (await db
    .select(accountColumns)
    .from(accountInboxes)
    .innerJoin(accounts, eq(accounts.id, accountInboxes.accountId))
    .where(eq(accountInboxes.inboxId, inboxId))
    .get()) ?? null

/**
 * Links the inbox to the account unless it's already linked. Returns the
 * account the inbox belongs to afterwards, which differs from `accountId` only
 * when another account linked it first, with its status as read after the
 * link was written.
 *
 * A new link goes in the account's activity (`buddies.inbox_linked`, naming
 * `sessionId` when a bearer session linked it) in the same batch; the batch
 * is atomic, so an account that loses a race logs nothing.
 */
export const linkInbox = async (
  db: AccountsDb,
  inboxId: string,
  accountId: string,
  sessionId: string | null = null
): Promise<AccountRecord> => {
  await db.batch([
    activityInsert(
      db,
      { accountId, kind: 'buddies.inbox_linked', sessionId },
      {
        onlyIf: sql`NOT EXISTS (SELECT 1 FROM ${accountInboxes}
          WHERE ${accountInboxes.inboxId} = ${inboxId})`,
      }
    ),
    db
      .insert(accountInboxes)
      .values({ inboxId, accountId })
      .onConflictDoNothing({ target: accountInboxes.inboxId }),
  ])
  const owner = await findInboxAccount(db, inboxId)
  if (!owner) throw new Error('accounts: linked inbox is missing')
  return owner
}

export const accountInboxIds = async (
  db: AccountsDb,
  accountId: string
): Promise<string[]> =>
  (
    await db
      .select({ inboxId: accountInboxes.inboxId })
      .from(accountInboxes)
      .where(eq(accountInboxes.accountId, accountId))
      .all()
  ).map((row) => row.inboxId)

/**
 * Sets the status and records why, in one batch. A change also goes in the
 * account's activity (`account.suspended`/`.reinstated`), without the reason.
 */
export const setAccountStatus = async (
  db: AccountsDb,
  accountId: string,
  status: AccountStatus,
  reason: AccountStatusReason
): Promise<void> => {
  await db.batch([
    activityInsert(
      db,
      {
        accountId,
        kind: status === 'suspended' ? 'account.suspended' : 'account.reinstated',
      },
      {
        onlyIf: sql`EXISTS (SELECT 1 FROM accounts
          WHERE id = ${accountId} AND status != ${status})`,
      }
    ),
    db.update(accounts).set({ status }).where(eq(accounts.id, accountId)),
    db.insert(accountStatusEvents).values({ accountId, status, reason }),
  ])
}

/**
 * What `GET /account` (and the legacy `account/info`) shows the account's own
 * devices: its row, the inboxes it owns, and when its status changed. Status
 * reasons stay with moderation.
 */
export interface AccountInfo extends AccountRecord {
  createdAt: number
  inboxIds: string[]
  statusChanges: { status: AccountStatus; createdAt: number }[]
}

export const findAccountInfo = async (
  db: AccountsDb,
  by: { accountPub: string } | { accountId: string }
): Promise<AccountInfo | null> => {
  const account = await db
    .select({ ...accountColumns, createdAt: accounts.createdAt })
    .from(accounts)
    .where(
      'accountId' in by
        ? eq(accounts.id, by.accountId)
        : eq(accounts.accountPub, by.accountPub)
    )
    .get()
  if (!account) return null
  const [inboxIds, statusChanges] = await Promise.all([
    accountInboxIds(db, account.id),
    db
      .select({
        status: accountStatusEvents.status,
        createdAt: accountStatusEvents.createdAt,
      })
      .from(accountStatusEvents)
      .where(eq(accountStatusEvents.accountId, account.id))
      .orderBy(asc(accountStatusEvents.id))
      .all(),
  ])
  return {
    ...account,
    createdAt: account.createdAt.getTime(),
    inboxIds,
    statusChanges: statusChanges.map((change) => ({
      status: change.status,
      createdAt: change.createdAt.getTime(),
    })),
  }
}
