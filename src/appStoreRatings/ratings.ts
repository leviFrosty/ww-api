import { APP_STORE_STOREFRONTS } from './storefronts'

/**
 * App Store social proof for the paywall ("4.89 average from 728 ratings,
 * publishers in 38+ countries").
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

export const STATE_KEY = 'app-store-ratings:state'
export const SUMMARY_KEY = 'app-store-ratings:summary'

export const BATCH_SIZE = 40
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOOKUP_TIMEOUT_MS = 5_000

export type RatingsKv = Pick<KVNamespace, 'get' | 'put'>

export interface StorefrontRating {
  count: number
  average: number
}

interface SweepState {
  /** Index into APP_STORE_STOREFRONTS where the next run resumes. */
  cursor: number
  /** When the last full sweep finished; null before the first one. */
  completedAt: number | null
  storefronts: Record<string, StorefrontRating>
}

export interface AppStoreRatingsSummary {
  /** Rating-count-weighted mean across storefronts, rounded to 2 decimals. */
  averageRating: number
  ratingCount: number
  /** Storefronts with at least one rating. */
  countryCount: number
  updatedAt: string
}

const EMPTY_STATE: SweepState = { cursor: 0, completedAt: null, storefronts: {} }

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
      results?: Array<{ userRatingCount?: unknown; averageUserRating?: unknown }>
    }
    const app = body.results?.[0]
    const count = app?.userRatingCount
    const average = app?.averageUserRating
    if (typeof count !== 'number' || typeof average !== 'number' || count <= 0) {
      return null
    }
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
    averageRating: ratingCount ? Math.round((weighted / ratingCount) * 100) / 100 : 0,
    ratingCount,
    countryCount: Object.keys(storefronts).length,
    updatedAt: new Date(now).toISOString(),
  }
}

async function readState(kv: RatingsKv): Promise<SweepState> {
  const raw = await kv.get(STATE_KEY)
  if (!raw) return { ...EMPTY_STATE }
  try {
    const state = JSON.parse(raw) as SweepState
    return typeof state.cursor === 'number' && state.storefronts
      ? state
      : { ...EMPTY_STATE }
  } catch {
    return { ...EMPTY_STATE }
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
    state.cursor === 0 &&
    state.completedAt !== null &&
    now - state.completedAt < SWEEP_INTERVAL_MS
  ) {
    return 'idle'
  }

  const batch = APP_STORE_STOREFRONTS.slice(state.cursor, state.cursor + BATCH_SIZE)
  const results = await Promise.all(
    batch.map((country) => fetchStorefrontRating(country, fetchFn)),
  )
  batch.forEach((country, index) => {
    const result = results[index]
    if (result === undefined) return
    if (result === null) delete state.storefronts[country]
    else state.storefronts[country] = result
  })

  state.cursor += batch.length
  const completed = state.cursor >= APP_STORE_STOREFRONTS.length
  if (completed) {
    state.cursor = 0
    state.completedAt = now
    await kv.put(SUMMARY_KEY, JSON.stringify(summarize(state.storefronts, now)))
  }
  await kv.put(STATE_KEY, JSON.stringify(state))
  return completed ? 'completed' : 'progress'
}
