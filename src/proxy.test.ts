import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Environment } from './types'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import worker from './index'

const ENV = {
  HERE_API_KEY: 'test-key',
  RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Environment

async function geocode() {
  const context = { waitUntil: () => {}, passThroughOnException: () => {} }
  return worker.fetch!(
    new Request('https://ww-proxy.leviwilkerson.com/geocode?q=Main') as never,
    ENV,
    context as never
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('HERE API proxy', () => {
  it('passes JSON responses through with the upstream status', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [] }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await geocode()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]))
    expect(url.searchParams.get('apiKey')).toBe('test-key')
  })

  it('returns 502 when HERE returns a plain-text Cloudflare error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error code: 520\n', { status: 520 })))

    const response = await geocode()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Upstream error' })
  })
})
