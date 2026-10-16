import type { MiddlewareHandler } from 'hono'
import type { AppContext, AppEnv, Environment } from '../types'
import { captureFailure } from '../sentry'
import { readEnvelopeText } from '../buddies/envelope'
import {
  buddiesErrorResponse,
  buddiesInternalError,
} from '../buddies/errorResponse'
import type { AccountStatus, SessionPlatform } from './schema'
import { accountsDb, findAccount } from './store'
import { accessTokenKeys, verifyAccessToken } from './tokens'
import { refuseLegacyAuth } from './legacySwitch'

/**
 * Bearer authentication for every user-scoped route (witness-work ADR 0027):
 * the caller is the account in an attested session's access token.
 *
 * - `requireAccount()`: Hono middleware for bearer-only routes.
 * - `authenticateAccount(c)`: the same check as a call, for routes that order
 *   their own gates (Notes Import's kill switch, Buddies' tiers).
 * - `bearerOrLegacy(c, …)`: for routes that still accept the pre-session way
 *   while the legacy switch is on.
 *
 * Each sets `c.var.account` on success (read it with `accountOf(c)`), and a
 * refusal is a ready `Response` plus its code, for routes with their own
 * error format: 401 `unauthorized` (with `WWW-Authenticate`), 403
 * `suspended`, 503 `disabled` (no token secret, or `requireActive` without
 * the accounts database), or 500 `internal`.
 *
 * Privacy: nothing here logs or reports a token, an account id, or a session
 * id.
 */

/** Who's calling, from a verified access token. */
export interface AccountAuth {
  accountId: string
  sessionId: string
  platform: SessionPlatform
}

export type AccountAuthError =
  | 'unauthorized'
  | 'suspended'
  | 'disabled'
  | 'internal'

export type AccountAuthResult =
  | { ok: true; account: AccountAuth }
  | { ok: false; error: AccountAuthError; response: Response }

export interface RequireAccountOptions {
  /**
   * Also refuse a suspended account (403 `suspended`). Costs a D1 read of the
   * account's status, cached per isolate for 30 seconds, so a suspension or
   * reinstatement takes up to that long to apply. Leave it off for routes a
   * suspended account may still use (handoff, backup).
   */
  requireActive?: boolean
}

const STATUS_CACHE_MS = 30_000
const STATUS_CACHE_ENTRIES = 1_000
const statusCache = new Map<string, { status: AccountStatus; at: number }>()

/** Clears the per-isolate status cache (tests). */
export const resetAccountStatusCache = (): void => statusCache.clear()

/** The account's status, or null when it no longer exists. */
const accountStatus = async (
  env: Environment,
  accountId: string,
  now: number
): Promise<AccountStatus | null> => {
  const cached = statusCache.get(accountId)
  if (cached && now - cached.at < STATUS_CACHE_MS) return cached.status
  const account = await findAccount(accountsDb(env.ACCOUNTS_DB!), accountId)
  statusCache.delete(accountId)
  if (!account) return null
  if (statusCache.size >= STATUS_CACHE_ENTRIES)
    statusCache.delete(statusCache.keys().next().value!)
  statusCache.set(accountId, { status: account.status, at: now })
  return account.status
}

const refuse = (error: AccountAuthError): AccountAuthResult => ({
  ok: false,
  error,
  response:
    error === 'internal'
      ? buddiesInternalError()
      : buddiesErrorResponse(error),
})

/** True when the request has an `Authorization` header: a bearer request. */
export const hasAuthorization = (c: AppContext): boolean =>
  c.req.header('authorization') != null

/** The token in `Authorization: Bearer <token>`, or null. */
export const bearerToken = (header: string | undefined): string | null =>
  /^Bearer +([A-Za-z0-9._~+/-]+=*) *$/i.exec(header ?? '')?.[1] ?? null

/**
 * Verifies the request's bearer token and, with `requireActive`, the
 * account's status; on success sets `c.var.account`.
 */
export const authenticateAccount = async (
  c: AppContext,
  options: RequireAccountOptions = {}
): Promise<AccountAuthResult> => {
  const keys = await accessTokenKeys(c.env)
  if (!keys) return refuse('disabled')
  const token = bearerToken(c.req.header('authorization'))
  const claims = token ? await verifyAccessToken(keys, token) : null
  if (!claims) return refuse('unauthorized')
  const account: AccountAuth = {
    accountId: claims.accountId,
    sessionId: claims.sessionId,
    platform: claims.platform,
  }
  if (options.requireActive) {
    if (!c.env.ACCOUNTS_DB) return refuse('disabled')
    let status: AccountStatus | null
    try {
      status = await accountStatus(c.env, account.accountId, Date.now())
    } catch (error) {
      console.error('accounts: status read failed')
      captureFailure(error, 'account status')
      return refuse('internal')
    }
    if (status == null) return refuse('unauthorized')
    if (status === 'suspended') return refuse('suspended')
  }
  c.set('account', account)
  return { ok: true, account }
}

/**
 * Middleware for a bearer-only route: refuses the request unless it carries a
 * valid access token (and, with `requireActive`, an active account).
 */
export const requireAccount =
  (options: RequireAccountOptions = {}): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const result = await authenticateAccount(c, options)
    if (!result.ok) return result.response
    await next()
  }

/** The caller `requireAccount` or `bearerOrLegacy` verified. */
export const accountOf = (c: AppContext): AccountAuth => {
  const account = c.get('account')
  if (!account) throw new Error('accounts: route ran without requireAccount')
  return account
}

/**
 * Runs a route converted to bearer tokens. A request with an `Authorization`
 * header is a bearer request, always: its token must verify, and it never
 * falls back to the envelope. A request without one is a legacy request,
 * served by `legacy` while the legacy switch is on and refused with 426
 * `upgrade_required` once it's off.
 */
export const bearerOrLegacy = async (
  c: AppContext,
  handlers: {
    bearer: (account: AccountAuth) => Promise<Response>
    legacy: () => Promise<Response>
  },
  options: RequireAccountOptions = {}
): Promise<Response> => {
  if (hasAuthorization(c)) {
    const result = await authenticateAccount(c, options)
    return result.ok ? handlers.bearer(result.account) : result.response
  }
  return (await refuseLegacyAuth(c.env)) ?? handlers.legacy()
}

/**
 * A plain JSON request body (a bearer request's fields), read under the
 * envelope's size limit. Null for a missing, oversized, or unparsable body;
 * never surfaces the parser's message, which quotes the input.
 */
export const readPlainJson = async (c: AppContext): Promise<unknown> => {
  const text = await readEnvelopeText(c.req.raw)
  return parseJsonOrNull(text)
}

export const parseJsonOrNull = (text: string | null): unknown => {
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
