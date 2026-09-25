import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { SUMMARY_KEY } from './ratings'

/** The summary changes at most daily (see SWEEP_INTERVAL_MS). */
const EDGE_TTL_SECONDS = 6 * 60 * 60
const CLIENT_TTL_SECONDS = 24 * 60 * 60
const KV_EDGE_TTL_SECONDS = 60 * 60

/**
 * GET /app-store/ratings — paywall social proof. Served from the colo's Cache
 * API on nearly every request; a miss costs one edge-cached KV read. The app
 * persists the body for 7 days on top of this, so each install asks roughly
 * once a week.
 */
export async function handleAppStoreRatingsRequest(ctx: AppContext) {
  // Query strings would fragment the cache without changing the body.
  const cacheKey = new Request(new URL('/app-store/ratings', ctx.req.url))
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  const summary = await ctx.env.NOTES_KV.get(SUMMARY_KEY, {
    cacheTtl: KV_EDGE_TTL_SECONDS,
  })
  if (!summary) {
    // No completed sweep yet (fresh deploy). Clients keep their fallback.
    const response: ErrorResponse = { error: 'Ratings unavailable' }
    return ctx.json(response, HTTP_STATUS.SERVICE_UNAVAILABLE, {
      'Cache-Control': 'no-store',
    })
  }

  const response = new Response(summary, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CLIENT_TTL_SECONDS}, s-maxage=${EDGE_TTL_SECONDS}`,
    },
  })
  ctx.executionCtx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
