import { z } from 'zod'
import { ROUTE_PLANNING_LIMITS } from './config'

const coordinate = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict()

export type Coordinate = z.infer<typeof coordinate>

/**
 * `POST /route-planning/optimize`. Coordinates only: `strict()` rejects any
 * other field, so names, notes, or topics can never ride along.
 */
export const routeOptimizeRequestSchema = z
  .object({
    /** The app's account id (RevenueCat app user id), for the Supporter check. */
    accountId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    start: coordinate,
    stops: z.array(coordinate).min(1).max(ROUTE_PLANNING_LIMITS.maxStops),
  })
  .strict()

export type RouteOptimizeRequest = z.infer<typeof routeOptimizeRequestSchema>

export interface RouteOptimizeResponse {
  /** Indices into the request's `stops`, in visiting order. */
  order: number[]
  /** Driving distance from the start through the last stop, in metres. */
  distanceMeters: number
  /** Driving time for the same, in seconds, with traffic at request time. */
  durationSeconds: number
  /** Optimizations this account has left in the rolling 24 hours. */
  remainingToday: number
}

export type RouteOptimizeErrorCode =
  | 'bad_request'
  | 'payload_too_large'
  | 'unavailable'
  | 'supporter_required'
  | 'supporter_check_failed'
  | 'daily_limit'
  | 'rate_limited'
  | 'no_route'
  | 'upstream_error'

export interface RouteOptimizeErrorResponse {
  error: string
  code: RouteOptimizeErrorCode
  /** Set on `daily_limit` and `rate_limited`; mirrors `Retry-After`. */
  retryAfterSeconds?: number
}
