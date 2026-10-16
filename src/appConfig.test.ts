import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Environment } from './types'
import { makeMemoryKv } from './test/memoryKv'
import { resolveAppMinVersion } from './appConfig'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import { app } from './app'

const env = async (kv?: string, APP_MIN_VERSION?: string) => {
  const NOTES_KV = makeMemoryKv()
  if (kv != null) await NOTES_KV.put('app:min-version', kv)
  return {
    NOTES_KV,
    APP_MIN_VERSION,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Environment
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /app/v1/config', () => {
  it('serves the minimum version uncached, without authentication', async () => {
    const response = await app.fetch(
      new Request('https://ww-proxy.leviwilkerson.com/app/v1/config'),
      await env('{"minVersion":"1.42.0"}')
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, minAppVersion: '1.42.0' })
  })

  it('leaves minAppVersion out without a floor', async () => {
    const response = await app.fetch(
      new Request('https://ww-proxy.leviwilkerson.com/app/v1/config'),
      await env()
    )
    expect(await response.json()).toEqual({ ok: true })
  })

  it('counts against its own per-IP bucket', async () => {
    const limiter = { keys: [] as string[] }
    const environment = {
      ...(await env()),
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          limiter.keys.push(key)
          return { success: false }
        },
      },
    } as unknown as Environment
    const response = await app.fetch(
      new Request('https://ww-proxy.leviwilkerson.com/app/v1/config', {
        headers: { 'cf-connecting-ip': '198.51.100.9' },
      }),
      environment
    )
    expect(response.status).toBe(429)
    expect(limiter.keys).toEqual(['app:198.51.100.9'])
  })
})

describe('resolveAppMinVersion', () => {
  it('reads KV, then APP_MIN_VERSION, ignoring invalid values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await resolveAppMinVersion(await env('{"minVersion":"2.0.1"}', '1.0.0'))).toBe('2.0.1')
    expect(await resolveAppMinVersion(await env(undefined, ' 1.5.0 '))).toBe('1.5.0')
    expect(await resolveAppMinVersion(await env('{"minVersion":"v2"}', '1.5.0'))).toBe('1.5.0')
    expect(await resolveAppMinVersion(await env('', '1.5.0'))).toBe('1.5.0')
    expect(await resolveAppMinVersion(await env(undefined, 'latest'))).toBeNull()
    expect(await resolveAppMinVersion(await env())).toBeNull()
    expect(warn).toHaveBeenCalledWith('app: min-version KV value is invalid')
    expect(warn).toHaveBeenCalledWith('APP_MIN_VERSION is invalid')
  })

  it('falls back to the var when KV fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = {
      NOTES_KV: {
        get: async () => {
          throw new Error('kv down')
        },
      },
      APP_MIN_VERSION: '1.2.3',
    }
    expect(await resolveAppMinVersion(failing)).toBe('1.2.3')
  })
})
