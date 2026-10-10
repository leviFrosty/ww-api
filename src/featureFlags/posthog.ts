import type { Environment } from '../types'

/**
 * Server-side PostHog feature flags via the `/flags?v=2` endpoint.
 *
 * Returns null (never throws) when the flag can't be decided: no project token
 * configured, network error, timeout, quota limit, or a flag PostHog couldn't
 * compute. Callers treat null as their flag-off path.
 *
 * Results are cached per isolate for {@link CACHE_TTL_MS}, so a burst of
 * requests makes one call and a PostHog toggle takes effect within that window.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com'
const TIMEOUT_MS = 1_500
const CACHE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 500

interface FlagsResponse {
  flags?: Record<string, { enabled?: unknown }>
  errorsWhileComputingFlags?: boolean
  quotaLimited?: string[]
}

const cache = new Map<string, { value: boolean | null; expiresAt: number }>()

/** Test hook. */
export const clearFeatureFlagCache = (): void => cache.clear()

export interface FeatureFlagRequest {
  env: Pick<Environment, 'POSTHOG_PROJECT_TOKEN' | 'POSTHOG_HOST'>
  flag: string
  /**
   * Who the flag is evaluated for. Percentage rollouts hash this, so pass an
   * opaque, stable id; never a raw account id or anything identifying.
   */
  distinctId: string
  /** Evaluation-only person properties (not stored), for targeting rules. */
  personProperties?: Record<string, string>
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

const evaluate = async ({
  env,
  flag,
  distinctId,
  personProperties,
  fetchFn = fetch,
}: FeatureFlagRequest & { env: { POSTHOG_PROJECT_TOKEN: string } }): Promise<
  boolean | null
> => {
  const host = (env.POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(`${host}/flags?v=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: env.POSTHOG_PROJECT_TOKEN,
        distinct_id: distinctId,
        ...(personProperties ? { person_properties: personProperties } : {}),
        flag_keys_to_evaluate: [flag],
        geoip_disable: true,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(`feature flag ${flag}: PostHog returned ${res.status}`)
      return null
    }
    const body = (await res.json()) as FlagsResponse
    if (body.quotaLimited?.includes('feature_flags')) {
      console.warn(`feature flag ${flag}: PostHog quota limited`)
      return null
    }
    const entry = body.flags?.[flag]
    if (!entry || typeof entry.enabled !== 'boolean') {
      // An absent flag is "off" unless PostHog says it failed to compute it.
      return body.errorsWhileComputingFlags ? null : false
    }
    return entry.enabled
  } catch (error) {
    console.warn(`feature flag ${flag}: PostHog request failed`, String(error))
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export const isFeatureEnabled = async (
  request: FeatureFlagRequest
): Promise<boolean | null> => {
  const token = request.env.POSTHOG_PROJECT_TOKEN?.trim()
  if (!token) return null

  const key = `${request.flag}\u0000${request.distinctId}\u0000${JSON.stringify(
    request.personProperties ?? {}
  )}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now < hit.expiresAt) return hit.value

  const value = await evaluate({
    ...request,
    env: { ...request.env, POSTHOG_PROJECT_TOKEN: token },
  })
  // Unknown results are not cached, so a PostHog blip retries next request.
  if (value != null) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
  }
  return value
}
