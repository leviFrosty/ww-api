import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppContext, Environment } from '../types'
import { makeMemoryKv } from '../test/memoryKv'
import { APP_STORE_STOREFRONTS } from './storefronts'
import {
  BATCH_SIZE,
  STATE_KEY,
  SUMMARY_KEY,
  SWEEP_INTERVAL_MS,
  fetchStorefrontRating,
  runRatingsSweepStep,
  summarize,
} from './ratings'
import { handleAppStoreRatingsRequest } from './route'

const lookup = (count: number, average: number) =>
  Response.json({ resultCount: 1, results: [{ userRatingCount: count, averageUserRating: average }] })

/** US 100 × 5.0, BR 50 × 4.0, every other storefront unrated. */
const appleFetch = vi.fn(async (input: RequestInfo | URL) => {
  const country = new URL(String(input)).searchParams.get('country')
  if (country === 'us') return lookup(100, 5)
  if (country === 'br') return lookup(50, 4)
  return Response.json({ resultCount: 0, results: [] })
}) as unknown as typeof fetch

const runs = Math.ceil(APP_STORE_STOREFRONTS.length / BATCH_SIZE)

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchStorefrontRating', () => {
  it('distinguishes unrated storefronts from failed lookups', async () => {
    expect(await fetchStorefrontRating('us', appleFetch)).toEqual({ count: 100, average: 5 })
    expect(await fetchStorefrontRating('fr', appleFetch)).toBeNull()
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    expect(await fetchStorefrontRating('us', failing)).toBeUndefined()
    const throwing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchStorefrontRating('us', throwing)).toBeUndefined()
  })
})

describe('summarize', () => {
  it('weights the average by rating count', () => {
    expect(
      summarize({ us: { count: 100, average: 5 }, br: { count: 50, average: 4 } }, 0),
    ).toEqual({
      averageRating: 4.67,
      ratingCount: 150,
      countryCount: 2,
      updatedAt: new Date(0).toISOString(),
    })
  })
})

describe('runRatingsSweepStep', () => {
  it('publishes a summary only after every storefront is swept, then rests a day', async () => {
    const kv = makeMemoryKv()
    for (let run = 1; run < runs; run++) {
      expect(await runRatingsSweepStep({ kv, now: 0, fetchFn: appleFetch })).toBe('progress')
      expect(kv.store.has(SUMMARY_KEY)).toBe(false)
    }
    expect(await runRatingsSweepStep({ kv, now: 0, fetchFn: appleFetch })).toBe('completed')
    expect(appleFetch).toHaveBeenCalledTimes(APP_STORE_STOREFRONTS.length)
    expect(JSON.parse(kv.store.get(SUMMARY_KEY)!)).toMatchObject({
      averageRating: 4.67,
      ratingCount: 150,
      countryCount: 2,
    })

    expect(
      await runRatingsSweepStep({ kv, now: SWEEP_INTERVAL_MS - 1, fetchFn: appleFetch }),
    ).toBe('idle')
    expect(appleFetch).toHaveBeenCalledTimes(APP_STORE_STOREFRONTS.length)
    expect(
      await runRatingsSweepStep({ kv, now: SWEEP_INTERVAL_MS, fetchFn: appleFetch }),
    ).toBe('progress')
  })

  it('keeps the last known value when a lookup fails', async () => {
    const kv = makeMemoryKv()
    kv.store.set(
      STATE_KEY,
      JSON.stringify({ cursor: 0, completedAt: null, storefronts: { af: { count: 7, average: 3 } } }),
    )
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await runRatingsSweepStep({ kv, now: 0, fetchFn: failing })
    expect(JSON.parse(kv.store.get(STATE_KEY)!)).toMatchObject({
      cursor: BATCH_SIZE,
      storefronts: { af: { count: 7, average: 3 } },
    })
  })
})

describe('GET /app-store/ratings', () => {
  function fixture() {
    const kv = makeMemoryKv()
    const cached = new Map<string, Response>()
    const cache = {
      match: vi.fn(async (request: Request) => cached.get(request.url)?.clone()),
      put: vi.fn(async (request: Request, response: Response) => {
        cached.set(request.url, response)
      }),
    }
    vi.stubGlobal('caches', { default: cache })
    const pending: Promise<unknown>[] = []
    const request = (url = 'https://ww-proxy.leviwilkerson.com/app-store/ratings') =>
      handleAppStoreRatingsRequest({
        req: { url },
        env: { NOTES_KV: kv } as unknown as Environment,
        executionCtx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
        json: (body: unknown, status: number, headers: HeadersInit) =>
          Response.json(body, { status, headers }),
      } as unknown as AppContext).then(async (response) => {
        await Promise.all(pending)
        return response
      })
    return { kv, cache, request }
  }

  it('is unavailable and uncached before the first sweep completes', async () => {
    const { cache, request } = fixture()
    const response = await request()
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('serves repeat requests, including query variants, from the edge cache', async () => {
    const { kv, cache, request } = fixture()
    const summary = summarize({ us: { count: 728, average: 4.89 } }, 0)
    kv.store.set(SUMMARY_KEY, JSON.stringify(summary))
    const get = vi.spyOn(kv, 'get')

    const first = await request()
    expect(first.status).toBe(200)
    expect(first.headers.get('Cache-Control')).toContain('s-maxage=')
    expect(await first.json()).toEqual(summary)

    const second = await request('https://ww-proxy.leviwilkerson.com/app-store/ratings?v=2')
    expect(await second.json()).toEqual(summary)
    expect(get).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })
})
