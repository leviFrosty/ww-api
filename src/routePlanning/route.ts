import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppContext, Environment } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { isSupporter, RevenueCatError } from '../revenuecat'
import {
  ROUTE_PLANNING_LIMITS as LIMITS,
  isRouteDevBypass,
  isRoutePlanningEnabled,
} from './config'
import {
  routeOptimizeRequestSchema,
  type RouteOptimizeErrorCode,
  type RouteOptimizeErrorResponse,
  type RouteOptimizeResponse,
} from './contracts'
import { fetchWaypointsSequence } from './here'

/**
 * `POST /route-planning/optimize` — Supporter-only shortest driving order for
 * today's stops. Fails closed: a non-Supporter, an unknown account, or a failed
 * RevenueCat check never reaches HERE.
 *
 * Privacy: the body holds an account id and bare coordinates. Nothing here
 * logs or reports either; HERE receives only the coordinates.
 */

/**
 * Captured at module evaluation, before Sentry's fetch integration wraps
 * `globalThis.fetch`, so the account id in RevenueCat's URL and the HERE key
 * stay out of trace spans.
 */
const uninstrumentedFetch: typeof fetch = globalThis.fetch.bind(globalThis)

export interface RoutePlanningDependencies {
  fetch: typeof fetch
  checkSupporter: typeof isSupporter
  now: () => number
}

const defaultDependencies: RoutePlanningDependencies = {
  fetch: uninstrumentedFetch,
  checkSupporter: isSupporter,
  now: () => Date.now(),
}

const fail = (
  ctx: AppContext,
  status: ContentfulStatusCode,
  code: RouteOptimizeErrorCode,
  error: string,
  retryAfterSeconds?: number
) => {
  const body: RouteOptimizeErrorResponse = { error, code }
  if (retryAfterSeconds != null) {
    body.retryAfterSeconds = retryAfterSeconds
    return ctx.json(body, status, { 'Retry-After': String(retryAfterSeconds) })
  }
  return ctx.json(body, status)
}

const quota = (env: Environment, accountId: string) =>
  env.ROUTE_PLANNING_QUOTA.get(env.ROUTE_PLANNING_QUOTA.idFromName(accountId))

export const createRoutePlanningRoutes = (
  overrides: Partial<RoutePlanningDependencies> = {}
) => {
  const deps = { ...defaultDependencies, ...overrides }
  const routes = new Hono<{ Bindings: Environment }>()

  routes.post('/optimize', async (ctx) => {
    if (!(await isRoutePlanningEnabled(ctx.env))) {
      return fail(
        ctx,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        'unavailable',
        'Route planning is unavailable'
      )
    }

    const declaredLength = Number(ctx.req.header('content-length') ?? 0)
    if (declaredLength > LIMITS.maxBodyBytes) {
      return fail(
        ctx,
        HTTP_STATUS.PAYLOAD_TOO_LARGE,
        'payload_too_large',
        'Request too large'
      )
    }
    const text = await ctx.req.text()
    if (text.length > LIMITS.maxBodyBytes) {
      return fail(
        ctx,
        HTTP_STATUS.PAYLOAD_TOO_LARGE,
        'payload_too_large',
        'Request too large'
      )
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail(ctx, HTTP_STATUS.BAD_REQUEST, 'bad_request', 'Invalid JSON')
    }
    const parsed = routeOptimizeRequestSchema.safeParse(json)
    if (!parsed.success) {
      return fail(ctx, HTTP_STATUS.BAD_REQUEST, 'bad_request', 'Invalid request')
    }
    const { accountId, start, stops } = parsed.data

    if (!isRouteDevBypass(ctx.env, ctx.req.header('x-ww-dev-bypass'))) {
      let supporter: boolean
      try {
        supporter = await deps.checkSupporter({
          apiKey: ctx.env.REVENUECAT_API_KEY,
          appUserId: accountId,
          fetchImpl: deps.fetch,
        })
      } catch (error) {
        if (!(error instanceof RevenueCatError)) Sentry.captureException(error)
        return fail(
          ctx,
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          'supporter_check_failed',
          'Could not confirm Supporter status'
        )
      }
      if (!supporter) {
        return fail(
          ctx,
          HTTP_STATUS.FORBIDDEN,
          'supporter_required',
          'Route planning is a Supporter feature'
        )
      }
    }

    const decision = await quota(ctx.env, accountId).consume({
      nowMs: deps.now(),
      dailyLimit: LIMITS.dailyLimit,
      minuteLimit: LIMITS.minuteLimit,
    })
    if (!decision.allowed) {
      return fail(
        ctx,
        HTTP_STATUS.TOO_MANY_REQUESTS,
        decision.reason === 'daily' ? 'daily_limit' : 'rate_limited',
        decision.reason === 'daily'
          ? 'Daily route limit reached'
          : 'Too many route requests',
        decision.retryAfterSeconds
      )
    }

    const result = await fetchWaypointsSequence(
      { start, stops },
      ctx.env.HERE_API_KEY,
      deps.fetch,
      LIMITS.hereTimeoutMs
    )
    if (result.kind === 'no_route') {
      return fail(
        ctx,
        HTTP_STATUS.UNPROCESSABLE_ENTITY,
        'no_route',
        'No driving route connects these stops'
      )
    }
    if (result.kind === 'upstream_error') {
      Sentry.captureMessage('HERE Waypoints Sequence request failed', {
        level: 'warning',
        fingerprint: ['here-waypoints-sequence-failed'],
        tags: { 'here_api.status': result.status ?? 'network' },
      })
      return fail(
        ctx,
        HTTP_STATUS.BAD_GATEWAY,
        'upstream_error',
        'Routing service unavailable'
      )
    }

    const response: RouteOptimizeResponse = {
      order: result.order,
      distanceMeters: Math.round(result.distanceMeters),
      durationSeconds: Math.round(result.durationSeconds),
      remainingToday: decision.remainingToday,
    }
    return ctx.json(response)
  })

  return routes
}
