import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The accounts database (D1 `ACCOUNTS_DB`). It knows each account by a random
 * id and the public half of its signing key, and which Buddies inboxes it owns
 * (Option A in witness-work ADR 0024). No name, email, or phone number, and no
 * private key: the account key never leaves the User's devices.
 */

export const ACCOUNT_STATUSES = ['active', 'suspended'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/** Why a status changed. A short code, never free text about the User. */
export const ACCOUNT_STATUS_REASONS = [
  'report',
  'automated',
  'appeal',
  'admin',
] as const
export type AccountStatusReason = (typeof ACCOUNT_STATUS_REASONS)[number]

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())

export const accounts = sqliteTable('accounts', {
  /** b64u of 16 random bytes, minted here. An identifier, not a secret. */
  id: text('id').primaryKey(),
  /** The account signing key's Ed25519 public key (b64u, 32 bytes). */
  accountPub: text('account_pub').notNull().unique(),
  status: text('status', { enum: ACCOUNT_STATUSES })
    .notNull()
    .default('active'),
  createdAt: createdAt(),
})

/** Every status change, for appeals and auditing. */
export const accountStatusEvents = sqliteTable(
  'account_status_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull(),
    reason: text('reason', { enum: ACCOUNT_STATUS_REASONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('account_status_events_account_idx').on(t.accountId)]
)

/**
 * Which account owns each Buddies inbox. Written only after the inbox accepted
 * a registration signed by its owner key that also carried the account key's
 * signature over the same inbox, so neither key alone can link an inbox.
 */
export const accountInboxes = sqliteTable(
  'account_inboxes',
  {
    inboxId: text('inbox_id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('account_inboxes_account_idx').on(t.accountId)]
)
