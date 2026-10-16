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

export const SESSION_PLATFORMS = ['ios', 'android', 'dev'] as const
export type SessionPlatform = (typeof SESSION_PLATFORMS)[number]

/**
 * Attested sessions (witness-work ADR 0027): one row per session opened
 * (`POST /accounts/v1/sessions`). Only the account, the platform, the sealed
 * device label, the SHA-256 of the current and previous refresh token, and
 * times. Never the install, its App Attest key, `accountPub`, or an IP.
 */
export const accountSessions = sqliteTable(
  'account_sessions',
  {
    /** b64u of 16 random bytes; the access token's `sid`. */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** What attested the session; `dev` is the development bypass. */
    platform: text('platform', { enum: SESSION_PLATFORMS }).notNull(),
    /** The device label, sealed under a key only the account's devices hold. */
    device: text('device'),
    /** b64u SHA-256 of the current refresh token's bytes. */
    refreshHash: text('refresh_hash').notNull().unique(),
    /** The one it replaced, accepted for a minute after `rotatedAt`. */
    previousRefreshHash: text('previous_refresh_hash'),
    rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    /** 90 days after it opened; refreshing never moves it. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('account_sessions_account_idx').on(t.accountId),
    index('account_sessions_previous_refresh_idx').on(t.previousRefreshHash),
  ]
)

/**
 * The account's security history (witness-work ADR 0028), newest by `id`.
 * Written only by the server, in the same batch as the action where it can
 * be (`src/accounts/activity.ts`). Never an IP, location, user agent, or
 * content; device names stay in their sealed labels. Kept 400 days.
 */
export const ACTIVITY_KINDS = [
  'account.created',
  'session.opened',
  'session.signed_out',
  'session.revoked',
  'session.replaced',
  'session.refresh_reused',
  'handoff.sent',
  'backup.deleted',
  'backup.downloaded',
  'account.suspended',
  'account.reinstated',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const accountActivity = sqliteTable(
  'account_activity',
  {
    /** Increasing; the list's cursor. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    /** The session the entry is about, or that did it. */
    sessionId: text('session_id'),
    sessionPlatform: text('session_platform', { enum: SESSION_PLATFORMS }),
    /** That session's sealed device label, copied so it outlives the row. */
    sessionDevice: text('session_device'),
    /** The session that ended `sessionId` (`session.revoked`, `.replaced`). */
    actorSessionId: text('actor_session_id'),
    actorPlatform: text('actor_platform', { enum: SESSION_PLATFORMS }),
    actorDevice: text('actor_device'),
    /** The backup slot (`backup.*`); null for "every slot". */
    slotId: text('slot_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('account_activity_account_idx').on(t.accountId, t.id),
    index('account_activity_created_idx').on(t.createdAt),
  ]
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
