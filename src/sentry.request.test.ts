import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  createTransport,
  wrapRequestHandler,
  type CloudflareOptions,
} from '@sentry/cloudflare'
import { Sentry, createSentryConfig } from './sentry'
import type { Environment } from './types'

/**
 * A legacy Notes Import run request through the SDK's own request wrapper
 * (as `Sentry.withSentry` runs every request), with the worker's config and a
 * transport that keeps every envelope: the error, the transaction (Notes
 * Import traces at 100%), a child span, and a breadcrumb, all as Sentry
 * would receive them. Its own file, since the SDK's `init` sets global state.
 */

const SECRET = 'legacy-subscribe-token-0123456789abcdef'
const IMPORT_ID = `imp_${'a'.repeat(40)}`
const URL_WITH_TOKEN = `https://ww-proxy.test/notes-import/${IMPORT_ID}/events?token=${SECRET}&lastEventId=3`
const UPSTREAM = `https://upstream.test/echo?token=${SECRET}`
const REDACTED_UPSTREAM = 'https://upstream.test/echo?token=[redacted]'

describe('Sentry on a request with a subscribe token in its URL', () => {
  it('sends the error and the transaction without the token', async () => {
    const envelopes: string[] = []
    const options: CloudflareOptions = {
      ...createSentryConfig({
        SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
        APP_ATTEST_ENVIRONMENT: 'production',
      } as Environment),
      transport: (transportOptions) =>
        createTransport(transportOptions, async ({ body }) => {
          envelopes.push(
            typeof body === 'string' ? body : new TextDecoder().decode(body)
          )
          return {}
        }),
    }
    // What the fetch integration records for an outbound call.
    const app = new Hono().get('/notes-import/:importId/events', async (c) => {
      Sentry.addBreadcrumb({
        type: 'http',
        category: 'fetch',
        data: { method: 'GET', url: UPSTREAM, status_code: 200 },
      })
      await Sentry.startSpan(
        {
          name: `GET ${UPSTREAM}`,
          op: 'http.client',
          attributes: { 'url.full': UPSTREAM },
        },
        async () => undefined
      )
      Sentry.captureException(new Error('stream failed'))
      return c.text('ok')
    })
    const request = new Request(URL_WITH_TOKEN, {
      headers: { referer: URL_WITH_TOKEN, accept: 'text/event-stream' },
    })
    const flushes: Promise<unknown>[] = []

    const response = await wrapRequestHandler(
      {
        options,
        request: request as never,
        context: {
          waitUntil: (promise: Promise<unknown>) => flushes.push(promise),
        } as unknown as ExecutionContext,
      },
      () => app.fetch(request)
    )
    expect(response.status).toBe(200)
    await Promise.all(flushes)
    await Sentry.flush(2_000)

    // Each envelope is a header line, then an item header and payload per
    // item; only payloads carry an `event_id`.
    const items = envelopes.flatMap((envelope) =>
      envelope
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((item) => 'event_id' in item && 'timestamp' in item)
    )
    const error = items.find(
      (item) =>
        (item.exception as { values?: { value?: string }[] } | undefined)
          ?.values?.[0]?.value === 'stream failed'
    )
    const transaction = items.find((item) => item.type === 'transaction')
    expect(error).toBeDefined()
    expect(transaction).toBeDefined()

    const sent = envelopes.join('\n')
    expect(sent).not.toContain(SECRET)
    // The rest of the URL survives, so the trace is still useful.
    const redacted = `https://ww-proxy.test/notes-import/${IMPORT_ID}/events?token=[redacted]&lastEventId=3`
    expect(error!.request).toMatchObject({
      url: redacted,
      query_string: 'token=[redacted]&lastEventId=3',
      headers: { referer: redacted },
    })
    expect(transaction!.transaction).toBe(
      `GET /notes-import/${IMPORT_ID}/events`
    )
    expect(
      (transaction!.contexts as { trace: { data: Record<string, unknown> } })
        .trace.data['url.full']
    ).toBe(redacted)
    expect(error!.breadcrumbs).toEqual([
      expect.objectContaining({
        data: { method: 'GET', url: REDACTED_UPSTREAM, status_code: 200 },
      }),
    ])
    expect(transaction!.spans).toEqual([
      expect.objectContaining({
        description: `GET ${REDACTED_UPSTREAM}`,
        data: expect.objectContaining({ 'url.full': REDACTED_UPSTREAM }),
      }),
    ])
  })
})
