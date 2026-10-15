import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  accountInboxes,
  accountStatusEvents,
  accounts,
  type AccountStatus,
  type AccountStatusReason,
} from './schema'

export const accountsDb = (d1: D1Database) => drizzle(d1)
export type AccountsDb = ReturnType<typeof accountsDb>

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

const findAccountByPub = async (
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
  await db
    .insert(accounts)
    .values({ id: newId(), accountPub })
    .onConflictDoNothing({ target: accounts.accountPub })
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
 * when another account linked it first.
 */
export const linkInbox = async (
  db: AccountsDb,
  inboxId: string,
  accountId: string
): Promise<string> => {
  await db
    .insert(accountInboxes)
    .values({ inboxId, accountId })
    .onConflictDoNothing({ target: accountInboxes.inboxId })
  const row = await db
    .select({ accountId: accountInboxes.accountId })
    .from(accountInboxes)
    .where(eq(accountInboxes.inboxId, inboxId))
    .get()
  return row?.accountId ?? accountId
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

/** Sets the status and records why, in one batch. */
export const setAccountStatus = async (
  db: AccountsDb,
  accountId: string,
  status: AccountStatus,
  reason: AccountStatusReason
): Promise<void> => {
  await db.batch([
    db.update(accounts).set({ status }).where(eq(accounts.id, accountId)),
    db.insert(accountStatusEvents).values({ accountId, status, reason }),
  ])
}

/**
 * What `account/info` shows the account's own devices: its row, the inboxes
 * it owns, and when its status changed. Status reasons stay with moderation.
 */
export interface AccountInfo extends AccountRecord {
  createdAt: number
  inboxIds: string[]
  statusChanges: { status: AccountStatus; createdAt: number }[]
}

export const findAccountInfo = async (
  db: AccountsDb,
  accountPub: string
): Promise<AccountInfo | null> => {
  const account = await db
    .select({ ...accountColumns, createdAt: accounts.createdAt })
    .from(accounts)
    .where(eq(accounts.accountPub, accountPub))
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
