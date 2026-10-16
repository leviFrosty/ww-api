import type { Environment } from '../types'
import { isSupporter } from '../revenuecat'

/**
 * Supporter status for an account (witness-work ADR 0027 §4). The one seam
 * every account-scoped Supporter check goes through: Notes Import asks it at
 * kickoff and again when a run settles.
 *
 * Until the RevenueCat identity is linked to the account, the app names its
 * RevenueCat app user id on each request (`revenueCatAppUserId`), and that id
 * is checked with RevenueCat exactly as the pre-session routes check theirs;
 * without one the account is not a Supporter. The linking change replaces
 * this body with the account's own linked id (or the status RevenueCat
 * webhooks keep on it) and drops the request field.
 *
 * Rejects as `isSupporter` does (`RevenueCatError` included), so callers keep
 * their own fail-closed handling.
 */
export interface AccountSupporterLookup {
  /** The session's account. Unused until the RevenueCat link exists. */
  accountId: string
  /** The RevenueCat app user id the request named, or null. */
  revenueCatAppUserId: string | null
}

export const isAccountSupporter = async (
  env: Pick<Environment, 'REVENUECAT_API_KEY'>,
  account: AccountSupporterLookup,
  checkSupporter: typeof isSupporter = isSupporter
): Promise<boolean> => {
  if (!account.revenueCatAppUserId) return false
  return checkSupporter({
    apiKey: env.REVENUECAT_API_KEY,
    appUserId: account.revenueCatAppUserId,
  })
}
