import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFeatureFlagCache, isFeatureEnabled } from './posthog'

const env = { POSTHOG_PROJECT_TOKEN: 'phc_test' }

const flagsResponse = (body: unknown, status = 200) =>
  vi.fn(async () => Response.json(body, { status }))

const ask = (fetchFn: typeof fetch, overrides = {}) =>
  isFeatureEnabled({
    env,
    flag: 'my-flag',
    distinctId: 'user-1',
    fetchFn,
    ...overrides,
  })

beforeEach(() => {
  clearFeatureFlagCache()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('isFeatureEnabled', () => {
  it('posts one flag evaluation to the US host', async () => {
    const fetchFn = flagsResponse({ flags: { 'my-flag': { enabled: true } } })
    await expect(
      ask(fetchFn as unknown as typeof fetch, {
        personProperties: { ww_api_environment: 'production' },
      })
    ).resolves.toBe(true)

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://us.i.posthog.com/flags?v=2')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      api_key: 'phc_test',
      distinct_id: 'user-1',
      person_properties: { ww_api_environment: 'production' },
      flag_keys_to_evaluate: ['my-flag'],
      geoip_disable: true,
    })
  })

  it('honors a custom host', async () => {
    const fetchFn = flagsResponse({ flags: {} })
    await isFeatureEnabled({
      env: { ...env, POSTHOG_HOST: 'https://eu.i.posthog.com/' },
      flag: 'my-flag',
      distinctId: 'user-1',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const [url] = fetchFn.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://eu.i.posthog.com/flags?v=2')
  })

  it('reads a disabled or absent flag as off', async () => {
    const off = flagsResponse({ flags: { 'my-flag': { enabled: false } } })
    await expect(ask(off as unknown as typeof fetch)).resolves.toBe(false)
    clearFeatureFlagCache()
    const absent = flagsResponse({ flags: {} })
    await expect(ask(absent as unknown as typeof fetch)).resolves.toBe(false)
  })

  it('returns null when the flag cannot be decided', async () => {
    const cases = [
      flagsResponse({}, 500),
      flagsResponse({ flags: {}, quotaLimited: ['feature_flags'] }),
      flagsResponse({ flags: {}, errorsWhileComputingFlags: true }),
      vi.fn(async () => {
        throw new Error('network down')
      }),
    ]
    for (const fetchFn of cases) {
      await expect(ask(fetchFn as unknown as typeof fetch)).resolves.toBeNull()
    }
  })

  it('returns null without calling PostHog when no token is set', async () => {
    const fetchFn = vi.fn()
    await expect(
      isFeatureEnabled({
        env: {},
        flag: 'my-flag',
        distinctId: 'user-1',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).resolves.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('caches decided results per distinct id, not failures', async () => {
    const fetchFn = flagsResponse({ flags: { 'my-flag': { enabled: true } } })
    await ask(fetchFn as unknown as typeof fetch)
    await ask(fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await ask(fetchFn as unknown as typeof fetch, { distinctId: 'user-2' })
    expect(fetchFn).toHaveBeenCalledTimes(2)

    clearFeatureFlagCache()
    const failing = flagsResponse({}, 503)
    await ask(failing as unknown as typeof fetch)
    await ask(failing as unknown as typeof fetch)
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
