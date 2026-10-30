import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm'
import type { Environment } from '../types'
import {
  REVENUECAT_API_ORIGIN,
  countsWebSandboxSubscriptions,
  fetchSupporterStatus,
  type SupporterStatus,
} from '../revenuecat'
import {
  accountRevenueCatCustomers,
  revenueCatCustomers,
  revenueCatWebhookEvents,
} from './schema'
import { accountsDb, type AccountsDb } from './store'

/**
 * Supporter status on the server account (witness-work ADR 0029). The app
 * links the RevenueCat customer it's logged in as to its account
 * (`linkCustomer`), RevenueCat's webhook keeps each linked customer's record
 * current (`refreshCustomer`), and every account-scoped Supporter check asks
 * `isAccountSupporter`, which answers from those records.
 *
 * Nothing is ever stored from a client's say-so: a record is always what
 * RevenueCat's REST API answered. Who counts is ADR 0014's rule
 * (`fetchSupporterStatus`).
 *
 * Privacy: app user ids are RevenueCat capabilities and account ids are
 * account ids; nothing here logs or reports either.
 */

export const SUPPORTER_LINK_LIMITS = {
  /** Customers one account links (several phones, a moved account). */
  customersPerAccount: 5,
  /** Accounts one customer is linked to (devices before a handoff joins them). */
  accountsPerCustomer: 5,
  /**
   * A record read from RevenueCat this recently is the answer; older ones are
   * read again first. Catches a webhook RevenueCat gave up on within a day.
   */
  freshMs: 24 * 60 * 60_000,
  /** How long handled webhook event ids are kept for deduplication. */
  webhookEventRetentionMs: 30 * 24 * 60 * 60_000,
} as const

/** What `POST /accounts/v1/revenuecat-customers` accepts as `appUserId`. */
export const REVENUECAT_APP_USER_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Captured at module evaluation, before Sentry's fetch integration wraps
 * `globalThis.fetch`, so the app user id in RevenueCat's URL stays out of
 * trace spans.
 */
const uninstrumentedFetch: typeof fetch = globalThis.fetch.bind(globalThis)

export interface SupporterDependencies {
  fetch: typeof fetch
  now: () => number
}

export const defaultSupporterDependencies: SupporterDependencies = {
  fetch: uninstrumentedFetch,
  now: () => Date.now(),
}

const deps = (
  overrides: Partial<SupporterDependencies> = {}
): SupporterDependencies => ({ ...defaultSupporterDependencies, ...overrides })

/** The account's status over every customer it links. */
export interface AccountSupporterStatus {
  supporter: boolean
  /** Epoch ms; null for no end, or when not a Supporter. */
  expiresAt: number | null
  /** How many customers the account links. */
  customers: number
}

interface CustomerRecord {
  appUserId: string
  supporter: boolean
  supporterExpiresAt: Date | null
  checkedAt: Date
}

const isActive = (record: CustomerRecord, now: number) =>
  record.supporter &&
  (record.supporterExpiresAt == null ||
    record.supporterExpiresAt.getTime() > now)

const combine = (
  records: CustomerRecord[],
  now: number
): AccountSupporterStatus => {
  const active = records.filter((record) => isActive(record, now))
  if (!active.length)
    return { supporter: false, expiresAt: null, customers: records.length }
  const ends = active.map((record) => record.supporterExpiresAt?.getTime())
  return {
    supporter: true,
    expiresAt: ends.some((end) => end == null)
      ? null
      : Math.max(...(ends as number[])),
    customers: records.length,
  }
}

/**
 * Upserts a customer's record from a RevenueCat read that started at
 * `startedAt`, unless a read that started later already wrote. An unknown
 * customer only updates an existing row (to not a Supporter); it's never
 * inserted.
 */
const storeRead = async (
  db: AccountsDb,
  appUserId: string,
  status: SupporterStatus,
  startedAt: number
): Promise<void> => {
  const values = {
    supporter: status.supporter,
    supporterExpiresAt:
      status.expiresAt == null ? null : new Date(status.expiresAt),
    checkedAt: new Date(startedAt),
  }
  if (!status.known) {
    await db
      .update(revenueCatCustomers)
      .set(values)
      .where(
        and(
          eq(revenueCatCustomers.appUserId, appUserId),
          lt(revenueCatCustomers.checkedAt, values.checkedAt)
        )
      )
    return
  }
  await db
    .insert(revenueCatCustomers)
    .values({ appUserId, ...values })
    .onConflictDoUpdate({
      target: revenueCatCustomers.appUserId,
      set: values,
      setWhere: sql`${revenueCatCustomers.checkedAt} <= ${startedAt}`,
    })
}

/**
 * Reads one customer from RevenueCat and stores the answer. Throws
 * `RevenueCatError` when RevenueCat can't be read; nothing changes then.
 */
type SupporterEnv = Pick<Environment, 'REVENUECAT_API_KEY'> &
  Partial<
    Pick<
      Environment,
      | 'APP_ATTEST_ENVIRONMENT'
      | 'REVENUECAT_API_URL'
      | 'REVENUECAT_COUNT_WEB_SANDBOX'
    >
  >

/**
 * RevenueCat's origin: `REVENUECAT_API_URL` on a development worker (the
 * verify loop's fake), else the real one. Production ignores the override.
 */
const revenueCatOrigin = (env: SupporterEnv): string =>
  env.APP_ATTEST_ENVIRONMENT === 'development' && env.REVENUECAT_API_URL
    ? env.REVENUECAT_API_URL.replace(/\/$/, '')
    : REVENUECAT_API_ORIGIN

export const refreshCustomer = async (
  env: SupporterEnv,
  db: AccountsDb,
  appUserId: string,
  overrides: Partial<SupporterDependencies> = {}
): Promise<SupporterStatus> =>
  (await readCustomer(env, db, appUserId, overrides)).status

/** `refreshCustomer`, also answering when its read started. */
const readCustomer = async (
  env: SupporterEnv,
  db: AccountsDb,
  appUserId: string,
  overrides: Partial<SupporterDependencies> = {}
): Promise<{ status: SupporterStatus; startedAt: number }> => {
  const { fetch, now } = deps(overrides)
  const startedAt = now()
  const status = await fetchSupporterStatus({
    apiKey: env.REVENUECAT_API_KEY,
    appUserId,
    fetchImpl: fetch,
    nowMs: startedAt,
    apiOrigin: revenueCatOrigin(env),
    countWebSandbox: countsWebSandboxSubscriptions(env),
  })
  await storeRead(db, appUserId, status, startedAt)
  return { status, startedAt }
}

/** The account's linked customers' records. */
const linkedRecords = (db: AccountsDb, accountId: string) =>
  db
    .select({
      appUserId: revenueCatCustomers.appUserId,
      supporter: revenueCatCustomers.supporter,
      supporterExpiresAt: revenueCatCustomers.supporterExpiresAt,
      checkedAt: revenueCatCustomers.checkedAt,
    })
    .from(accountRevenueCatCustomers)
    .innerJoin(
      revenueCatCustomers,
      eq(revenueCatCustomers.appUserId, accountRevenueCatCustomers.appUserId)
    )
    .where(eq(accountRevenueCatCustomers.accountId, accountId))

/**
 * Links the customer to the account after reading it from RevenueCat, and
 * answers the account's status afterwards. A customer RevenueCat has never
 * seen isn't linked. Repeating a link moves its `linkedAt`; a link past
 * either cap replaces the least recently linked. Throws `RevenueCatError`
 * when RevenueCat can't be read; nothing changes then.
 */
export const linkCustomer = async (
  env: SupporterEnv,
  db: AccountsDb,
  accountId: string,
  appUserId: string,
  overrides: Partial<SupporterDependencies> = {}
): Promise<AccountSupporterStatus> => {
  const resolved = deps(overrides)
  const { status, startedAt } = await readCustomer(
    env,
    db,
    appUserId,
    resolved
  )
  const now = resolved.now()
  if (status.known) {
    const links = accountRevenueCatCustomers
    const keepNewest = (column: 'accountId' | 'appUserId', value: string) => {
      const other = column === 'accountId' ? links.appUserId : links.accountId
      const limit =
        column === 'accountId'
          ? SUPPORTER_LINK_LIMITS.customersPerAccount
          : SUPPORTER_LINK_LIMITS.accountsPerCustomer
      return db
        .delete(links)
        .where(
          and(
            eq(links[column], value),
            notInArray(
              other,
              db
                .select({ id: other })
                .from(links)
                .where(eq(links[column], value))
                .orderBy(desc(links.linkedAt), other)
                .limit(limit)
            )
          )
        )
    }
    await db.batch([
      // The read above stored the customer; the hourly prune can delete it
      // again before this batch (nothing linked it yet), so put it back.
      db
        .insert(revenueCatCustomers)
        .values({
          appUserId,
          supporter: status.supporter,
          supporterExpiresAt:
            status.expiresAt == null ? null : new Date(status.expiresAt),
          checkedAt: new Date(startedAt),
        })
        .onConflictDoNothing(),
      db
        .insert(links)
        .values({ accountId, appUserId, linkedAt: new Date(now) })
        .onConflictDoUpdate({
          target: [links.accountId, links.appUserId],
          set: { linkedAt: new Date(now) },
        }),
      keepNewest('accountId', accountId),
      keepNewest('appUserId', appUserId),
    ])
  }
  return combine(await linkedRecords(db, accountId), now)
}

/**
 * Whether a record has to be read from RevenueCat again before it's an
 * answer: it's over `freshMs` old, or it was a Supporter whose end has passed
 * since it was read. A subscription renews at its end, and the webhook saying
 * so can come late or not at all; one read then tells a renewal from a lapse
 * (and is itself read after the end, so it's fresh until the next one).
 */
const needsRead = (record: CustomerRecord, now: number) => {
  const checkedAt = record.checkedAt.getTime()
  if (now - checkedAt >= SUPPORTER_LINK_LIMITS.freshMs) return true
  const end = record.supporterExpiresAt?.getTime()
  return record.supporter && end != null && end <= now && checkedAt < end
}

/**
 * The account's status: from records read within `freshMs`, else read from
 * RevenueCat again first (`needsRead`). An account with an active, fresh
 * record answers at once. The reads run together; one that finds a Supporter
 * is the answer even if another failed. Otherwise throws `RevenueCatError`
 * when any read failed: callers fail closed (route planning refuses, Notes
 * Import counts the User as free).
 */
export const accountSupporterStatus = async (
  env: SupporterEnv,
  db: AccountsDb,
  accountId: string,
  overrides: Partial<SupporterDependencies> = {}
): Promise<AccountSupporterStatus> => {
  const resolved = deps(overrides)
  const records = await linkedRecords(db, accountId)
  const now = resolved.now()
  const settled = records.filter((record) => !needsRead(record, now))
  if (settled.some((record) => isActive(record, now)))
    return { ...combine(settled, now), customers: records.length }
  const stale = records.filter((record) => needsRead(record, now))
  if (!stale.length) return combine(records, now)
  const reads = await Promise.allSettled(
    stale.map(async (record) => {
      const status = await refreshCustomer(env, db, record.appUserId, resolved)
      record.supporter = status.supporter
      record.supporterExpiresAt =
        status.expiresAt == null ? null : new Date(status.expiresAt)
      record.checkedAt = new Date(now)
    })
  )
  // A record whose read failed says nothing: it's left out of the answer.
  const failures = reads.filter(
    (read): read is PromiseRejectedResult => read.status === 'rejected'
  )
  const failed = stale.filter((_, i) => reads[i].status === 'rejected')
  const answer = combine(
    records.filter((record) => !failed.includes(record)),
    resolved.now()
  )
  if (answer.supporter || !failures.length)
    return { ...answer, customers: records.length }
  throw failures[0].reason
}

/**
 * Whether the session's account is a Supporter (ADR 0029): the one seam
 * every account-scoped Supporter check goes through. Notes Import asks it at
 * kickoff and when a run settles, route planning before each optimization.
 * Without the accounts database, no account is a Supporter. Rejects with
 * `RevenueCatError` as `accountSupporterStatus` does.
 */
export const isAccountSupporter = async (
  env: SupporterEnv & Pick<Environment, 'ACCOUNTS_DB'>,
  accountId: string,
  overrides: Partial<SupporterDependencies> = {}
): Promise<boolean> => {
  if (!env.ACCOUNTS_DB) return false
  return (
    await accountSupporterStatus(
      env,
      accountsDb(env.ACCOUNTS_DB),
      accountId,
      overrides
    )
  ).supporter
}

/** Of `appUserIds`, the ones some account links (the only ones worth a read). */
export const linkedCustomerIds = async (
  db: AccountsDb,
  appUserIds: string[]
): Promise<string[]> => {
  if (!appUserIds.length) return []
  const rows = await db
    .selectDistinct({ appUserId: accountRevenueCatCustomers.appUserId })
    .from(accountRevenueCatCustomers)
    .where(inArray(accountRevenueCatCustomers.appUserId, appUserIds))
  return rows.map((row) => row.appUserId)
}

/** True when the webhook already handled `eventId`. */
export const webhookEventSeen = async (
  db: AccountsDb,
  eventId: string
): Promise<boolean> =>
  (
    await db
      .select({ eventId: revenueCatWebhookEvents.eventId })
      .from(revenueCatWebhookEvents)
      .where(eq(revenueCatWebhookEvents.eventId, eventId))
      .limit(1)
  ).length > 0

/** Records `eventId` as handled; a repeat is a no-op. */
export const recordWebhookEvent = async (
  db: AccountsDb,
  eventId: string,
  now: number
): Promise<void> => {
  await db
    .insert(revenueCatWebhookEvents)
    .values({ eventId, receivedAt: new Date(now) })
    .onConflictDoNothing()
}

/**
 * Deletes webhook event ids past their 30 days and customers no account links
 * any more. Run hourly by the cron.
 */
export const pruneSupporterRecords = async (
  db: AccountsDb,
  now: number = Date.now()
): Promise<void> => {
  await db.batch([
    db
      .delete(revenueCatWebhookEvents)
      .where(
        lt(
          revenueCatWebhookEvents.receivedAt,
          new Date(now - SUPPORTER_LINK_LIMITS.webhookEventRetentionMs)
        )
      ),
    db
      .delete(revenueCatCustomers)
      .where(
        notInArray(
          revenueCatCustomers.appUserId,
          db
            .select({ appUserId: accountRevenueCatCustomers.appUserId })
            .from(accountRevenueCatCustomers)
        )
      ),
  ])
}
