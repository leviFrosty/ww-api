import { z } from 'zod'
import { describeRoute } from 'hono-openapi'
import {
  apiErrorSchema,
  errorResponse,
  jsonBody,
  jsonResponse,
} from '../openapi/schemas'
import { ROUTE_PLANNING_LIMITS as LIMITS } from './config'
import { routeOptimizeRequestSchema } from './contracts'

const errorSchema = apiErrorSchema
  .extend({
    retryAfterSeconds: z.number().int().positive().optional().meta({
      description: 'The same as `retryAfter`, kept for shipped builds.',
    }),
  })
  .meta({ id: 'RoutePlanningError' })

const error = (description: string, codes: string[]) =>
  errorResponse(description, codes, errorSchema)

export const routeOptimizeDocs = describeRoute({
  tags: ['Route planning'],
  summary: 'Order today’s stops',
  description: `The shortest driving order from \`start\` through every stop, with traffic at request time, from HERE Waypoints Sequence. The route ends at the last stop.

Supporter only: \`accountId\` (the RevenueCat app user id) must hold the Supporter entitlement, and a failed check never reaches HERE. Limits: ${LIMITS.maxStops} stops per request; ${LIMITS.dailyLimit} optimizations per account in any rolling 24 hours and ${LIMITS.minuteLimit} per minute (every call that reaches HERE counts, \`no_route\` included); plus the per-IP limit. The kill switch (KV \`route-planning:enabled\` = \`"false"\`) answers 503 \`unavailable\`.

On the dev worker only, \`x-ww-dev-bypass\` skips the Supporter check.`,
  parameters: [
    {
      name: 'x-ww-dev-bypass',
      in: 'header',
      required: false,
      schema: { type: 'string' },
      description: 'Development worker only: skips the Supporter check.',
    },
  ],
  requestBody: jsonBody(
    routeOptimizeRequestSchema,
    `Coordinates only; any other field is rejected. At most ${LIMITS.maxBodyBytes} bytes.`
  ),
  responses: {
    200: jsonResponse(
      'The visiting order.',
      z.object({
        order: z.array(z.number().int().min(0)).meta({
          description: 'Indices into the request’s `stops`, in visiting order.',
        }),
        distanceMeters: z.number().int().meta({
          description: 'Driving distance from the start through the last stop.',
        }),
        durationSeconds: z
          .number()
          .int()
          .meta({ description: 'Driving time for the same, with traffic.' }),
        remainingToday: z.number().int().meta({
          description: 'Optimizations left in the rolling 24 hours.',
        }),
      })
    ),
    400: error('Invalid JSON or request.', ['bad_request']),
    403: error('The account isn’t a Supporter.', ['supporter_required']),
    413: error('Body too large.', ['payload_too_large']),
    422: error('No driving route connects these stops.', ['no_route']),
    429: error(
      'Per-account daily or per-minute limit, or the per-IP limit. `daily_limit` waits until the oldest optimization ages out.',
      ['daily_limit', 'rate_limited']
    ),
    502: error('HERE was unavailable.', ['upstream_error']),
    503: error(
      'Turned off, or the Supporter check failed (RevenueCat trouble; fails closed).',
      ['unavailable', 'supporter_check_failed']
    ),
  },
})
