import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessTokenKeys, signAccessToken } from '../accounts/tokens'
import {
  ACCOUNT_TOKEN_SECRET,
  DEV_BYPASS_TOKEN,
  REVENUECAT_API_URL,
  REVENUECAT_WEBHOOK_TOKEN,
  bearerHeaders,
  http,
  openSession,
  writeTranscript,
  type E2ESession,
} from '../test/e2e'

/**
 * Supporter status on the server account (witness-work ADR 0029) over real
 * HTTP and the local D1. A fake RevenueCat answers the worker's REST reads
 * (`REVENUECAT_API_URL`, development workers only): a device links its
 * customer, route planning answers from the account, and the webhook ends it.
 *
 * Start the worker with the fake's URL:
 * `REVENUECAT_API_URL=http://127.0.0.1:18790 node scripts/verify/dev.mjs up`.
 */

afterAll(() => {
  writeTranscript('supporter')
})

const RC_ID = `e2e-${crypto.randomUUID()}`
const lifetime = {
  subscriber: { entitlements: { 'Lifetime Supporter': { expires_date: null } } },
}
const free = { subscriber: { entitlements: {}, subscriptions: {} } }

/** What the fake answers per app user id; absent is 404. */
const customers = new Map<string, unknown>()
const reads: string[] = []
let fake: Server | null = null

beforeAll(async () => {
  if (!REVENUECAT_API_URL) return
  const { hostname, port } = new URL(REVENUECAT_API_URL)
  fake = createServer((request, response) => {
    const id = decodeURIComponent((request.url ?? '').split('/').pop() ?? '')
    reads.push(id)
    const body = customers.get(id)
    const authorized = (request.headers.authorization ?? '').startsWith('Bearer ')
    response.writeHead(!authorized ? 401 : body ? 200 : 404, {
      'content-type': 'application/json',
    })
    response.end(body ? JSON.stringify(body) : '{}')
  })
  await new Promise<void>((resolve) => fake!.listen(Number(port), hostname, resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()))
})

/** The session's account as an iOS session would carry it (dev sessions skip Supporter checks). */
const iosHeaders = async (session: E2ESession) => {
  const keys = await accessTokenKeys({
    ACCOUNT_TOKEN_SECRET: ACCOUNT_TOKEN_SECRET!,
    APP_ATTEST_ENVIRONMENT: 'development',
  })
  const { accessToken } = await signAccessToken(keys!, {
    accountId: session.accountId,
    sessionId: session.sessionId,
    platform: 'ios',
  })
  return { authorization: `Bearer ${accessToken}` }
}

const route = {
  start: { lat: 39.1, lng: -84.5 },
  stops: [{ lat: 39.11, lng: -84.51 }],
}

const webhook = (event: Record<string, unknown>, token = REVENUECAT_WEBHOOK_TOKEN) =>
  http('POST', '/revenuecat/v1/webhook', {
    headers: { authorization: `Bearer ${token}` },
    body: { api_version: '1.0', event },
  })

describe.skipIf(!DEV_BYPASS_TOKEN || !REVENUECAT_WEBHOOK_TOKEN)('RevenueCat webhook', () => {
  it('refuses a wrong Authorization header', async () => {
    const wrong = await webhook({ id: 'e2e-wrong' }, 'not-the-secret')
    expect(wrong.status).toBe(401)
    expect(wrong.body.code).toBe('unauthorized')
  })

  it('ignores customers nobody linked and handles each event once', async () => {
    const event = { id: `e2e-${crypto.randomUUID()}`, type: 'TEST', app_user_id: 'never-linked-000000' }
    const first = await webhook(event)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true, customers: 0 })
    const again = await webhook(event)
    expect(again.body).toEqual({ ok: true, customers: 0, duplicate: true })
  })
})

describe.skipIf(!DEV_BYPASS_TOKEN)('Supporter status without a link', () => {
  it('starts with no Supporter and refuses a malformed id', async () => {
    const session = await openSession()
    const status = await http('GET', '/accounts/v1/supporter', { headers: bearerHeaders(session) })
    expect(status.status).toBe(200)
    expect(status.body).toEqual({ ok: true, supporter: false, expiresAt: null, customers: 0 })
    const bad = await http('POST', '/accounts/v1/revenuecat-customers', {
      headers: bearerHeaders(session),
      body: { appUserId: '$RCAnonymousID:abc' },
    })
    expect(bad.status).toBe(400)
  })
})

describe.skipIf(
  !DEV_BYPASS_TOKEN || !REVENUECAT_API_URL || !REVENUECAT_WEBHOOK_TOKEN || !ACCOUNT_TOKEN_SECRET
)('Supporter status through the fake RevenueCat', () => {
  it('links, answers from the account, and ends by webhook', async () => {
    customers.set(RC_ID, lifetime)
    const session = await openSession()

    const linked = await http('POST', '/accounts/v1/revenuecat-customers', {
      headers: bearerHeaders(session),
      body: { appUserId: RC_ID },
    })
    expect(linked.status).toBe(200)
    expect(linked.body).toEqual({ ok: true, supporter: true, expiresAt: null })
    expect(reads).toEqual([RC_ID])

    const status = await http('GET', '/accounts/v1/supporter', { headers: bearerHeaders(session) })
    expect(status.body).toEqual({ ok: true, supporter: true, expiresAt: null, customers: 1 })

    // Route planning passes the Supporter check from the stored record. With
    // no HERE key locally, HERE then fails (502), which is past the gate.
    const ios = await iosHeaders(session)
    const planned = await http('POST', '/route-planning/optimize', { headers: ios, body: route })
    expect([200, 502]).toContain(planned.status)
    expect(reads).toEqual([RC_ID])

    // The subscription ends; RevenueCat says so, and the webhook names it.
    customers.set(RC_ID, free)
    const event = { id: `e2e-${crypto.randomUUID()}`, type: 'EXPIRATION', app_user_id: RC_ID }
    const handled = await webhook(event)
    expect(handled.body).toEqual({ ok: true, customers: 1 })
    expect(reads).toEqual([RC_ID, RC_ID])

    const after = await http('GET', '/accounts/v1/supporter', { headers: bearerHeaders(session) })
    expect(after.body).toMatchObject({ supporter: false, customers: 1 })
    const refused = await http('POST', '/route-planning/optimize', {
      headers: await iosHeaders(session),
      body: route,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('supporter_required')
  })

  it('answers unavailable while RevenueCat is unreachable', async () => {
    const session = await openSession()
    // Stop the fake for the call: RevenueCat is down.
    await new Promise<void>((resolve) => fake!.close(() => resolve()))
    try {
      const response = await http('POST', '/accounts/v1/revenuecat-customers', {
        headers: bearerHeaders(session),
        body: { appUserId: RC_ID },
      })
      expect(response.status).toBe(503)
      expect(response.body.code).toBe('unavailable')
      expect(response.headers.get('retry-after')).toBe('30')
    } finally {
      const { hostname, port } = new URL(REVENUECAT_API_URL!)
      await new Promise<void>((resolve) => fake!.listen(Number(port), hostname, resolve))
    }
  })
})
