import { APP_STORE_STOREFRONTS } from './storefronts'

/**
 * Complete App Store ratings snapshots for the paywall.
 *
 * App Store Connect's API exposes written reviews only; star-only ratings (the
 * bulk of them) are published per storefront by Apple's public iTunes lookup
 * API. Totals therefore mean summing ~175 storefront lookups. That exceeds the
 * free-plan subrequest budget of a single invocation, so an hourly cron sweeps
 * `BATCH_SIZE` storefronts per run into KV and publishes the summary once a
 * full sweep finishes. Once complete, it rests until `SWEEP_INTERVAL_MS` has
 * passed, so Apple sees about one full sweep per day.
 */

export const APP_STORE_APP_ID = '6469723047'

export const STATE_KEY = 'app-store-ratings:state:v2'
export const SUMMARY_KEY = 'app-store-ratings:summary:v2'

export const BATCH_SIZE = 40
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOOKUP_TIMEOUT_MS = 5_000

export type RatingsKv = Pick<KVNamespace, 'get' | 'put'>

export interface StorefrontRating {
  count: number
  average: number
}

interface SweepState {
  pending: string[]
  /** When the last full sweep finished; null before the first one. */
  completedAt: number | null
  storefronts: Record<string, StorefrontRating>
}

export interface AppStoreRatingsSummary {
  complete: true
  /** Rating-count-weighted mean across storefronts, rounded to 2 decimals. */
  averageRating: number
  ratingCount: number
  /** Storefronts with at least one rating. */
  countryCount: number
  updatedAt: string
}

const emptyState = (): SweepState => ({
  pending: [...APP_STORE_STOREFRONTS],
  completedAt: null,
  storefronts: {},
})

/**
 * One storefront's lookup. `null` means Apple reported no ratings there;
 * `undefined` means the lookup failed and the previous value should stand.
 */
export async function fetchStorefrontRating(
  country: string,
  fetchFn: typeof fetch = fetch,
): Promise<StorefrontRating | null | undefined> {
  try {
    const url = `https://itunes.apple.com/lookup?id=${APP_STORE_APP_ID}&country=${country}`
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      resultCount?: unknown
      results?: Array<{
        userRatingCount?: unknown
        averageUserRating?: unknown
      }>
    }
    if (
      body.resultCount === 0 &&
      Array.isArray(body.results) &&
      body.results.length === 0
    ) {
      return null
    }
    if (
      body.resultCount !== 1 ||
      !Array.isArray(body.results) ||
      body.results.length !== 1
    ) {
      return undefined
    }
    const app = body.results?.[0]
    const count = app?.userRatingCount
    const average = app?.averageUserRating
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      typeof average !== 'number' ||
      !Number.isFinite(average) ||
      average < 0 ||
      average > 5
    ) {
      return undefined
    }
    if (count === 0) return null
    return { count, average }
  } catch {
    return undefined
  }
}

export function summarize(
  storefronts: Record<string, StorefrontRating>,
  now: number,
): AppStoreRatingsSummary {
  let ratingCount = 0
  let weighted = 0
  for (const { count, average } of Object.values(storefronts)) {
    ratingCount += count
    weighted += count * average
  }
  return {
    complete: true,
    averageRating: ratingCount
      ? Math.round((weighted / ratingCount) * 100) / 100
      : 0,
    ratingCount,
    countryCount: Object.keys(storefronts).length,
    updatedAt: new Date(now).toISOString(),
  }
}

async function readState(kv: RatingsKv): Promise<SweepState> {
  const raw = await kv.get(STATE_KEY)
  if (!raw) return emptyState()
  try {
    const state = JSON.parse(raw) as SweepState
    return Array.isArray(state.pending) && state.storefronts
      ? state
      : emptyState()
  } catch {
    return emptyState()
  }
}

/** Advances the sweep by one batch. Called from the cron trigger. */
export async function runRatingsSweepStep({
  kv,
  now = Date.now(),
  fetchFn = fetch,
}: {
  kv: RatingsKv
  now?: number
  fetchFn?: typeof fetch
}): Promise<'idle' | 'progress' | 'completed'> {
  const state = await readState(kv)
  if (
    state.pending.length === 0 &&
    state.completedAt !== null &&
    now - state.completedAt < SWEEP_INTERVAL_MS
  ) {
    return 'idle'
  }

  if (state.pending.length === 0) state.pending = [...APP_STORE_STOREFRONTS]
  const batch = state.pending.splice(0, BATCH_SIZE)
  for (const country of batch) {
    const result = await fetchStorefrontRating(country, fetchFn)
    if (result === undefined) {
      state.pending.push(country)
      continue
    }
    if (result === null) delete state.storefronts[country]
    else state.storefronts[country] = result
  }

  const completed = state.pending.length === 0
  if (completed) {
    state.completedAt = now
    await kv.put(SUMMARY_KEY, JSON.stringify(summarize(state.storefronts, now)))
  }
  await kv.put(STATE_KEY, JSON.stringify(state))
  return completed ? 'completed' : 'progress'
}
