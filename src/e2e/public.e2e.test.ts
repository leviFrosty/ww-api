import { afterAll, describe, expect, it } from 'vitest'
import {
  LOCAL_LAUNCHER,
  configured,
  http,
  localKv,
  writeTranscript,
} from '../test/e2e'

/**
 * Public, unauthenticated surfaces: health, Notes Import availability, the
 * paywall ratings, universal-link support, and the HERE proxy (opt-in only).
 */

afterAll(() => {
  writeTranscript('public')
})

describe('health and status', () => {
  it('GET /health reports ok with build metadata', async () => {
    const res = await http('GET', '/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok' })
    expect(typeof res.body.timestamp).toBe('string')
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false)
    expect(typeof res.body.versionId).toBe('string')
  })

  it('GET /notes-import/status returns availability, capabilities, no-store', async () => {
    const res = await http('GET', '/notes-import/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(typeof res.body.available).toBe('boolean')
    expect(res.body.capabilities).toEqual({
      appAttest: { protocolVersions: [1, 2] },
    })
    if (res.body.available && res.body.limits) {
      expect(res.body.limits).toMatchObject({
        imports: { free: expect.any(Number) },
        windowDays: expect.any(Number),
      })
    }
  })

  it('unknown routes are a JSON 404', async () => {
    const res = await http('GET', '/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
  })
})

describe('app store ratings', () => {
  const summary = {
    averageRating: 4.87,
    ratingCount: 1234,
    countryCount: 42,
    updatedAt: '2026-10-01T00:00:00.000Z',
  }

  it('serves 503 no-store before a sweep, then the stored summary', async () => {
    const first = await http('GET', '/app-store/ratings')
    if (first.status === 503) {
      expect(first.body).toEqual({ error: 'Ratings unavailable' })
      expect(first.headers.get('cache-control')).toBe('no-store')
      if (!LOCAL_LAUNCHER) return
      // Seed what the hourly cron would publish, then read it back.
      localKv('put', 'app-store-ratings:summary', JSON.stringify(summary))
      const seeded = await http('GET', '/app-store/ratings')
      expect(seeded.status).toBe(200)
      expect(seeded.body).toEqual(summary)
      expect(seeded.headers.get('cache-control')).toContain('s-maxage=21600')
    } else {
      // Already seeded by an earlier run against the same persisted state.
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({
        averageRating: expect.any(Number),
        ratingCount: expect.any(Number),
        countryCount: expect.any(Number),
        updatedAt: expect.any(String),
      })
    }
  })
})

describe('universal links', () => {
  it('serves the AASA as JSON with /c, /c/*, and /b#1 components', async () => {
    const res = await http('GET', '/.well-known/apple-app-site-association')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const [detail] = res.body.applinks.details
    expect(detail.appIDs).toHaveLength(3)
    for (const appId of detail.appIDs) {
      expect(appId).toMatch(/^[A-Z0-9]{10}\.com\.leviwilkerson\.jwtime(beta|dev)?$/)
    }
    expect(detail.components).toEqual([
      { '/': '/c', '#': '?*' },
      { '/': '/c/*' },
      { '/': '/b', '#': '1?*' },
    ])
  })

  it('GET /c renders the localized contact fallback page', async () => {
    const english = await http('GET', '/c')
    expect(english.status).toBe(200)
    expect(english.headers.get('content-type')).toContain('text/html')
    expect(english.text).toContain('id="open-app"')
    expect(english.text).toContain('witnesswork://import-contact/')

    const spanish = await http('GET', '/c?lang=es')
    expect(spanish.status).toBe(200)
    expect(spanish.headers.get('content-language')).toMatch(/^es/)
    expect(spanish.text).toContain('<html lang="es')
  })

  it('GET /c/:payload links legacy payloads into the app, never into meta tags', async () => {
    const payload = 'abc_DEF-123'
    const res = await http('GET', `/c/${payload}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain(`href="witnesswork://import-contact/${payload}"`)
    expect(res.text).not.toMatch(new RegExp(`<meta[^>]+${payload}`))

    const hostile = await http('GET', `/c/${encodeURIComponent('"><script>x</script>')}`)
    expect(hostile.status).toBe(200)
    expect(hostile.text).not.toContain('<script>x</script>')
  })

  it('GET /b serves the buddy invite page with a locked-down CSP', async () => {
    const res = await http('GET', '/b')
    expect(res.status).toBe(200)
    expect(res.text).toContain('WitnessWork buddy invite')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('HERE proxy', () => {
  // Each call hits the HERE API; one request total, only with a real key.
  const enabled = configured('HERE_API_KEY') && !process.env.WW_API_E2E_SKIP_HERE
  it.skipIf(!enabled)('GET /geocode proxies one lookup', async () => {
    const res = await http('GET', '/geocode?q=Times+Square+New+York&limit=1')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })
  it.skipIf(!enabled)('GET /autocomplete proxies one lookup', async () => {
    const res = await http('GET', '/autocomplete?q=Times+Squ&limit=1')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })
})
