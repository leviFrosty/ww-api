import { afterAll, describe, expect, it } from 'vitest'
import {
  DEV_BYPASS_TOKEN,
  bearerHeaders,
  configured,
  http,
  openSession,
  writeTranscript,
} from '../test/e2e'

/**
 * The web map's routes (witness-work ADR 0037 §8): MapKit JS tokens and
 * point-of-interest search. With `MAPKIT_JS_*` passed to the launcher
 * (`up --secrets-from`, a throwaway P-256 key is enough) the token path mints;
 * without them it must answer `maps_unconfigured`. The HERE call is opt-in
 * like the proxy's.
 */

afterAll(() => {
  writeTranscript('maps')
})

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

const mapKitConfigured =
  configured('MAPKIT_JS_PRIVATE_KEY') && configured('MAPKIT_JS_KEY_ID')

describe('POST /maps/v1/mapkit-tokens', () => {
  it('needs a bearer token', async () => {
    const res = await http('POST', '/maps/v1/mapkit-tokens')
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(res.headers.get('www-authenticate')).toContain('invalid_token')
    const forged = await http('POST', '/maps/v1/mapkit-tokens', {
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' },
    })
    expect(forged.status).toBe(401)
  })

  it.skipIf(!DEV_BYPASS_TOKEN || mapKitConfigured)(
    'answers maps_unconfigured without the MapKit JS key',
    async () => {
      const session = await openSession()
      const res = await http('POST', '/maps/v1/mapkit-tokens', {
        headers: bearerHeaders(session),
      })
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ ok: false, code: 'maps_unconfigured' })
      expect(res.headers.get('retry-after')).toBe('60')
    }
  )

  it.skipIf(!DEV_BYPASS_TOKEN || !mapKitConfigured)(
    'mints an ES256 token for the frame origin',
    async () => {
      const session = await openSession()
      const res = await http('POST', '/maps/v1/mapkit-tokens', {
        headers: bearerHeaders(session),
        body: {},
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const [header, claims, signature] = String(res.body.token).split('.')
      expect(decode(header!)).toMatchObject({ alg: 'ES256', typ: 'JWT' })
      const payload = decode(claims!)
      expect(payload).toMatchObject({
        origin: res.body.origin,
        scope: 'mapkit_js',
      })
      expect(payload.exp - payload.iat).toBe(1800)
      expect(res.body.expiresAt).toBe(payload.exp * 1000)
      expect(Buffer.from(signature!, 'base64url')).toHaveLength(64)

      const other = await http('POST', '/maps/v1/mapkit-tokens', {
        headers: bearerHeaders(session),
        body: { origin: 'https://evil.example' },
      })
      expect(other.status).toBe(400)
      expect(other.body.code).toBe('origin_not_allowed')
    }
  )
})

describe('GET /places/v1/search', () => {
  it('refuses a missing query or location before HERE', async () => {
    const noQuery = await http('GET', '/places/v1/search?at=39.1,-84.5')
    expect(noQuery.status).toBe(400)
    expect(noQuery.body).toMatchObject({ code: 'bad_request', field: 'q' })
    const noAt = await http('GET', '/places/v1/search?q=coffee')
    expect(noAt.status).toBe(400)
    expect(noAt.body).toMatchObject({ code: 'bad_request', field: 'at' })
  })

  // One HERE Discover transaction, only with a real key.
  const enabled =
    configured('HERE_API_KEY') && !process.env.WW_API_E2E_SKIP_HERE
  it.skipIf(!enabled)('finds points of interest near a coordinate', async () => {
    const res = await http(
      'GET',
      '/places/v1/search?q=coffee&at=39.1031,-84.5120&limit=3'
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.items.length).toBeGreaterThan(0)
    for (const item of res.body.items) {
      expect(typeof item.id).toBe('string')
      expect(typeof item.address.label).toBe('string')
      expect(typeof item.latitude).toBe('number')
      expect(typeof item.longitude).toBe('number')
    }
    expect(res.body.items.some((item: { name?: string }) => item.name)).toBe(
      true
    )
  })
})
