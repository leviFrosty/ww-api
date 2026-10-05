/**
 * Server-side Supporter verification via the RevenueCat REST v1 API. The app's
 * RevenueCat App User ID is its shared account id (witness-work ADR 0011),
 * which defaults to the Keychain install UUID (ADR 0007) — so we look the
 * subscriber up by whichever of those the client sent.
 *
 * Who counts as a Supporter is defined once, in witness-work ADR 0014, and this
 * check must stay in step with the app's `supporterSinceDate`.
 *
 * The secret key never ships in the app — only the proxy holds it.
 */

/**
 * Promotional entitlement granted by hand from the RevenueCat dashboard. Mirrors
 * `LIFETIME_SUPPORTER_ENTITLEMENT` in the app.
 */
export const LIFETIME_SUPPORTER_ENTITLEMENT = 'Lifetime Supporter'

export interface SupporterCheckArgs {
  apiKey: string
  appUserId: string
  /**
   * @deprecated Ignored. Supporter status no longer keys on one entitlement
   * name (witness-work ADR 0014); kept so existing callers still compile.
   */
  entitlementId?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock for tests (epoch ms). Defaults to Date.now(). */
  nowMs?: number
}

interface RcEntitlement {
  expires_date?: string | null
  product_identifier?: string
}

interface RcSubscription {
  expires_date?: string | null
}

interface RcSubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, RcEntitlement>
    /**
     * Recurring purchases keyed by product id, including dashboard grants
     * (`rc_promo_<entitlement>_<duration>`, store `promotional`). One-time
     * Tips live in `non_subscriptions` instead, so they never match here.
     */
    subscriptions?: Record<string, RcSubscription>
  }
}

/**
 * Returns true iff the subscriber is a Supporter (witness-work ADR 0014): an
 * active entitlement backed by an active subscription (monthly, annual, or a
 * promotional grant), or an active `Lifetime Supporter` grant. An entitlement
 * unlocked by a one-time Tip doesn't count, whatever it's called.
 *
 * Fails CLOSED: an unknown subscriber (404) or any error resolves to `false`,
 * so the caller falls back to the free-credit meter rather than granting
 * unlimited access on a fluke. The caller is responsible for reporting
 * unexpected (non-404) failures.
 */
export const isSupporter = async ({
  apiKey,
  appUserId,
  fetchImpl = fetch,
  nowMs = Date.now(),
}: SupporterCheckArgs): Promise<boolean> => {
  const res = await fetchImpl(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    }
  )

  if (!res.ok) {
    // 404 = RevenueCat has never seen this id → definitively not a Supporter.
    // Anything else is unexpected; the caller logs it. Either way: not a
    // Supporter, so the free meter applies.
    if (res.status !== 404) {
      throw new RevenueCatError(`RevenueCat ${res.status}`)
    }
    return false
  }

  const body = (await res.json()) as RcSubscriberResponse
  const entitlements = body.subscriber?.entitlements ?? {}
  const subscriptions = body.subscriber?.subscriptions ?? {}

  // A null expiry never lapses; anything else must be a parseable future date.
  const isActive = (expiresDate: string | null | undefined) => {
    if (expiresDate == null) return true
    const expiresMs = Date.parse(expiresDate)
    return Number.isFinite(expiresMs) && expiresMs > nowMs
  }

  return Object.entries(entitlements).some(([identifier, entitlement]) => {
    if (!isActive(entitlement.expires_date)) return false
    if (identifier === LIFETIME_SUPPORTER_ENTITLEMENT) return true
    // `Object.hasOwn` so a product id like `constructor` can't hit the prototype.
    const productId = entitlement.product_identifier
    if (!productId || !Object.hasOwn(subscriptions, productId)) return false
    return isActive(subscriptions[productId]?.expires_date)
  })
}

/** Distinguishes an unexpected RevenueCat failure (report it) from a 404. */
export class RevenueCatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevenueCatError'
  }
}
