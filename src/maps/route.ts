import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext, AppEnv } from '../types'
import { HTTP_STATUS } from '../config'
import { apiError } from '../errors'
import { Sentry } from '../sentry'
import { accountOf, requireAccount } from '../accounts/auth'
import { MAPS_LIMITS } from './config'
import {
  allowsLocalFrame,
  mapKitSigningKey,
  readMapKitConfig,
  signMapKitToken,
} from './mapkitToken'
import { parsePlaceSearchQuery, searchPlaces } from './placeSearch'
import { mapKitTokenDocs, placeSearchDocs } from './openapi'

/**
 * `POST /maps/v1/mapkit-tokens` mints a MapKit JS token for the web app's
 * map frame (witness-work ADR 0037 §8). Bearer only, any active account, so
 * nobody can farm tokens without a session; limited per account in the
 * route-planning quota DO. Answers 503 `maps_unconfigured` until the MapKit
 * JS key, its id, the team id, and a frame origin are all set.
 *
 * `GET /places/v1/search` is HERE Discover for points of interest, public and
 * limited per IP in the `places` bucket like `/autocomplete`.
 *
 * Privacy: neither logs the query, the coordinates, the token, or the account.
 */

/**
 * Captured at module evaluation, before Sentry's fetch integration wraps
 * `globalThis.fetch`, so the HERE key and what the user typed (both in the
 * Discover URL) stay out of trace spans.
 */
const uninstrumentedFetch: typeof fetch = globalThis.fetch.bind(globalThis)

export interface MapsDependencies {
  fetch: typeof fetch
  now: () => number
}

const defaultDependencies: MapsDependencies = {
  fetch: uninstrumentedFetch,
  now: () => Date.now(),
}

/** The last unimportable key reported, so a bad secret reports once. */
let reportedBadKey: string | null = null

/** Secrets are set by hand; a minute is a fair first wait. */
const UNCONFIGURED_RETRY_AFTER_SECONDS = 60
/** HERE didn't say how long to wait. */
const HERE_RETRY_AFTER_SECONDS = 60

export const mapKitTokenRequestSchema = z
  .object({
    origin: z.string().optional().meta({
      description:
        'The map frame’s origin, one the worker allows (`https://maps.witnesswork.app`). Defaults to the first allowed origin.',
    }),
  })
  .strict()

/** The optional JSON body: absent or empty is `{}`; null when invalid. */
const readTokenRequest = async (
  ctx: AppContext
): Promise<z.infer<typeof mapKitTokenRequestSchema> | 'too_large' | null> => {
  const declared = Number(ctx.req.header('content-length') ?? 0)
  if (declared > MAPS_LIMITS.maxTokenBodyBytes) return 'too_large'
  let text: string
  try {
    text = await ctx.req.text()
  } catch {
    // The client went away mid-body; nobody reads the answer.
    return null
  }
  if (text.length > MAPS_LIMITS.maxTokenBodyBytes) return 'too_large'
  if (!text.trim()) return {}
  try {
    const parsed = mapKitTokenRequestSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const createMapsRoutes = (
  overrides: Partial<MapsDependencies> = {}
) => {
  const deps = { ...defaultDependencies, ...overrides }
  const routes = new Hono<AppEnv>()

  routes.post(
    '/mapkit-tokens',
    mapKitTokenDocs,
    requireAccount({ requireActive: true }),
    async (ctx) => {
      const request = await readTokenRequest(ctx)
      if (request === 'too_large')
        return apiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'too_large')
      if (request == null) return apiError(HTTP_STATUS.BAD_REQUEST, 'bad_request')

      const config = readMapKitConfig(
        ctx.env,
        allowsLocalFrame(ctx.env.APP_ATTEST_ENVIRONMENT, ctx.req.url)
      )
      const unconfigured = () =>
        apiError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'maps_unconfigured', {
          retryAfter: UNCONFIGURED_RETRY_AFTER_SECONDS,
        })
      if (!config) return unconfigured()
      try {
        await mapKitSigningKey(config.privateKey)
      } catch {
        // Never the error itself: WebCrypto's message can describe the key.
        // Once per isolate and key value, not per request.
        if (reportedBadKey !== config.privateKey) {
          reportedBadKey = config.privateKey
          console.error('maps: MAPKIT_JS_PRIVATE_KEY is not a P-256 PKCS#8 key')
          Sentry.captureMessage('MapKit JS key import failed', {
            level: 'error',
            fingerprint: ['mapkit-js-key-import-failed'],
          })
        }
        return unconfigured()
      }

      const origin = request.origin ?? config.origins[0]!
      if (!config.origins.includes(origin))
        return apiError(HTTP_STATUS.BAD_REQUEST, 'origin_not_allowed')

      const { accountId } = accountOf(ctx)
      const quota = ctx.env.ROUTE_PLANNING_QUOTA.get(
        ctx.env.ROUTE_PLANNING_QUOTA.idFromName(
          `mapkit-token:account:${accountId}`
        )
      )
      const nowMs = deps.now()
      const decision = await quota.consume({
        nowMs,
        dailyLimit: MAPS_LIMITS.tokenDailyLimit,
        minuteLimit: MAPS_LIMITS.tokenMinuteLimit,
      })
      if (!decision.allowed) {
        return apiError(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          decision.reason === 'daily' ? 'daily_limit' : 'rate_limited',
          { retryAfter: Math.max(1, decision.retryAfterSeconds) }
        )
      }

      const { token, claims } = await signMapKitToken(
        config,
        origin,
        Math.floor(nowMs / 1000),
        MAPS_LIMITS.tokenLifetimeSeconds
      )
      return ctx.json(
        { ok: true, token, origin, expiresAt: claims.exp * 1000 },
        200,
        { 'Cache-Control': 'no-store' }
      )
    }
  )

  return routes
}

export const createPlacesRoutes = (
  overrides: Partial<Pick<MapsDependencies, 'fetch'>> = {}
) => {
  const deps = { ...defaultDependencies, ...overrides }
  const routes = new Hono<AppEnv>()

  routes.get('/search', placeSearchDocs, async (ctx) => {
    const parsed = parsePlaceSearchQuery(new URL(ctx.req.url).searchParams)
    if (!parsed.ok)
      return apiError(HTTP_STATUS.BAD_REQUEST, 'bad_request', {
        extras: { field: parsed.field },
      })

    const result = await searchPlaces(
      parsed.query,
      ctx.env.HERE_API_KEY,
      deps.fetch
    )
    switch (result.kind) {
      case 'ok':
        // The URL carries what the user typed and where they are.
        return ctx.json({ ok: true, items: result.items }, 200, {
          'Cache-Control': 'no-store',
        })
      case 'bad_request':
        return apiError(HTTP_STATUS.BAD_REQUEST, 'bad_request')
      case 'rate_limited':
        return apiError(HTTP_STATUS.TOO_MANY_REQUESTS, 'rate_limited', {
          retryAfter: result.retryAfterSeconds ?? HERE_RETRY_AFTER_SECONDS,
        })
      case 'upstream_error':
        Sentry.captureMessage('HERE Discover request failed', {
          level: 'warning',
          fingerprint: ['here-discover-failed'],
          tags: { 'here_api.status': result.status ?? 'network' },
        })
        return apiError(HTTP_STATUS.BAD_GATEWAY, 'upstream_error')
    }
  })

  return routes
}
