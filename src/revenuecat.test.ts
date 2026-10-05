import { describe, expect, it } from 'vitest'
import {
  isSupporter,
  LIFETIME_SUPPORTER_ENTITLEMENT,
  RevenueCatError,
} from './revenuecat'

const NOW = Date.parse('2026-06-18T00:00:00Z')
const FUTURE = '2027-01-01T00:00:00Z'
const PAST = '2025-01-01T00:00:00Z'
// RevenueCat stamps lifetime promotional grants ~200 years out, not null.
const PROMO_LIFETIME = '2226-05-19T12:00:00Z'

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch

const call = (status: number, body: unknown) =>
  isSupporter({
    apiKey: 'sk_test',
    appUserId: 'uuid-123',
    entitlementId: 'Supporter',
    fetchImpl: fakeFetch(status, body),
    nowMs: NOW,
  })

const subscriber = (subscriber: {
  entitlements?: Record<string, unknown>
  subscriptions?: Record<string, unknown>
  non_subscriptions?: Record<string, unknown>
}) => call(200, { subscriber })

// Entitlement and product names below match the production RevenueCat project.
const monthly = {
  entitlements: {
    'Monthly Donator': {
      expires_date: FUTURE,
      product_identifier: 'jwtime_399_1mo',
    },
  },
  subscriptions: {
    jwtime_399_1mo: { expires_date: FUTURE, store: 'app_store' },
  },
}

const tip = {
  entitlements: {
    'One Time Donator': {
      expires_date: null,
      product_identifier: 'witnesswork_tip_299',
    },
  },
  non_subscriptions: {
    witnesswork_tip_299: [{ id: 'abc', store: 'play_store' }],
  },
}

describe('isSupporter', () => {
  it('is true for an active monthly subscription', async () => {
    expect(await subscriber(monthly)).toBe(true)
  })

  it('is true for an active annual subscription', async () => {
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: FUTURE,
            product_identifier: 'jwtime_4799_1yr',
          },
        },
        subscriptions: {
          jwtime_4799_1yr: { expires_date: FUTURE, store: 'app_store' },
        },
      })
    ).toBe(true)
  })

  it('is true for a Google Play subscription with a base plan', async () => {
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: FUTURE,
            product_identifier: 'witnesswork_supporter',
            product_plan_identifier: 'annual-2899',
          },
        },
        subscriptions: {
          witnesswork_supporter: {
            expires_date: FUTURE,
            product_plan_identifier: 'annual-2899',
            store: 'play_store',
          },
        },
      })
    ).toBe(true)
  })

  it('is false for an expired subscription', async () => {
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: PAST,
            product_identifier: 'jwtime_399_1mo',
          },
        },
        subscriptions: {
          jwtime_399_1mo: { expires_date: PAST, store: 'app_store' },
        },
      })
    ).toBe(false)
  })

  it('is false when the backing subscription has expired', async () => {
    expect(
      await subscriber({
        ...monthly,
        subscriptions: {
          jwtime_399_1mo: { expires_date: PAST, store: 'app_store' },
        },
      })
    ).toBe(false)
  })

  it('is true for a Lifetime Supporter grant', async () => {
    const productId = `rc_promo_${LIFETIME_SUPPORTER_ENTITLEMENT}_lifetime`
    expect(
      await subscriber({
        entitlements: {
          [LIFETIME_SUPPORTER_ENTITLEMENT]: {
            expires_date: PROMO_LIFETIME,
            product_identifier: productId,
          },
        },
        subscriptions: {
          [productId]: { expires_date: PROMO_LIFETIME, store: 'promotional' },
        },
      })
    ).toBe(true)
  })

  it('is true for a Lifetime Supporter grant with no backing product', async () => {
    expect(
      await subscriber({
        entitlements: {
          [LIFETIME_SUPPORTER_ENTITLEMENT]: {
            expires_date: null,
            product_identifier: 'rc_promo_lifetime_supporter_lifetime',
          },
        },
      })
    ).toBe(true)
  })

  it('is false for a revoked Lifetime Supporter grant', async () => {
    expect(
      await subscriber({
        entitlements: {
          [LIFETIME_SUPPORTER_ENTITLEMENT]: {
            expires_date: PAST,
            product_identifier: 'rc_promo_lifetime_supporter_lifetime',
          },
        },
      })
    ).toBe(false)
  })

  it('is true for an active promotional grant of a subscription entitlement', async () => {
    const productId = 'rc_promo_Monthly Donator_monthly'
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: FUTURE,
            product_identifier: productId,
          },
        },
        subscriptions: {
          [productId]: { expires_date: FUTURE, store: 'promotional' },
        },
      })
    ).toBe(true)
  })

  it('is false for a one-time tip', async () => {
    expect(await subscriber(tip)).toBe(false)
  })

  it('is false for a tip product that unlocks a subscription entitlement', async () => {
    // A non-subscription product reports a non-expiring entitlement; it still
    // isn't backed by a subscription, so it must not grant Supporter status.
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: null,
            product_identifier: 'witnesswork_tip_299',
          },
        },
        non_subscriptions: tip.non_subscriptions,
      })
    ).toBe(false)
  })

  it('is true for a tip plus an active subscription', async () => {
    expect(
      await subscriber({
        entitlements: { ...tip.entitlements, ...monthly.entitlements },
        subscriptions: monthly.subscriptions,
        non_subscriptions: tip.non_subscriptions,
      })
    ).toBe(true)
  })

  it('is false for a tip plus an expired subscription', async () => {
    expect(
      await subscriber({
        entitlements: {
          ...tip.entitlements,
          'Monthly Donator': {
            expires_date: PAST,
            product_identifier: 'jwtime_399_1mo',
          },
        },
        subscriptions: {
          jwtime_399_1mo: { expires_date: PAST, store: 'app_store' },
        },
        non_subscriptions: tip.non_subscriptions,
      })
    ).toBe(false)
  })

  it('ignores a product id that only exists on the object prototype', async () => {
    expect(
      await subscriber({
        entitlements: {
          'Monthly Donator': {
            expires_date: FUTURE,
            product_identifier: 'constructor',
          },
        },
        subscriptions: {},
      })
    ).toBe(false)
  })

  it('is false when there are no entitlements', async () => {
    expect(await subscriber({})).toBe(false)
  })

  it('is false for an unknown subscriber (404)', async () => {
    expect(await call(404, { error: 'not found' })).toBe(false)
  })

  it('throws RevenueCatError on an unexpected status', async () => {
    await expect(call(500, { error: 'boom' })).rejects.toBeInstanceOf(
      RevenueCatError
    )
  })
})
