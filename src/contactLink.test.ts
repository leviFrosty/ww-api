import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Environment } from './types'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import worker from './index'

const ORIGIN = 'https://ww-proxy.leviwilkerson.com'
const CANONICAL_URL = `${ORIGIN}/c`
// gzip + base64url contact JSON, exactly as the app encodes it.
const PAYLOAD =
  'H4sIAAAAAAAAE42MMQvCMBQG_0r4VpPyUohgNsHJ2ckttA8MYl5IglVK_7tEcBduvLsVTy41SoKHHQga7Z0ZHktsiWtdpNzNJKmFqUGDX1lK4_nY4DHSuDd0MGQvRP7LQERXaPwKvyLO8JgsNFJ49PM5JFYn4a4VDn_c8k1SL3dWOecUWSJs2wdjV8GKuwAAAA'
const ENV = { APPLE_TEAM_ID: 'TEAM123456' } as Environment

async function request(
  path: string,
  { env = ENV, headers }: { env?: Environment; headers?: HeadersInit } = {}
) {
  const pending: Promise<unknown>[] = []
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  }
  const response = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { headers }) as never,
    env,
    context as never
  )
  await Promise.all(pending)
  return response
}

const html = async (path: string) => {
  const response = await request(path)
  expect(response.status).toBe(200)
  return response.text()
}

const ogUrl = (page: string) =>
  page.match(/<meta property="og:url" content="([^"]*)">/)?.[1]

/** Runs the page's inline script against a stub DOM, as a browser at `/c<hash>` would. */
function openAppLinkAt(page: string, hash: string) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  expect(script).toBeDefined()
  const link = { href: '', hidden: true }
  const document = {
    getElementById: (id: string) => (id === 'open-app' ? link : null),
  }
  new Function('location', 'document', script!)({ hash }, document)
  return link
}

describe('apple-app-site-association', () => {
  it('matches fragment links and legacy path links for every app variant', async () => {
    const response = await request('/.well-known/apple-app-site-association')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: [
              'TEAM123456.com.leviwilkerson.jwtime',
              'TEAM123456.com.leviwilkerson.jwtimebeta',
              'TEAM123456.com.leviwilkerson.jwtimedev',
            ],
            components: [
              { '/': '/c', '#': '?*' },
              { '/': '/c/*' },
              { '/': '/b', '#': '1?*' },
            ],
          },
        ],
      },
    })
  })
})

describe('GET /c', () => {
  it('never puts a payload in the response', async () => {
    // Whatever request data reaches the worker, nothing is reflected.
    for (const path of ['/c', `/c?${PAYLOAD}`]) {
      const page = await html(path)
      expect(page).not.toContain(PAYLOAD)
      expect(ogUrl(page)).toBe(CANONICAL_URL)
      expect(page).toContain('<a class="secondary" id="open-app" hidden>')
    }
  })

  it('builds the Open app link from a base64url fragment', async () => {
    expect(openAppLinkAt(await html('/c'), `#${PAYLOAD}`)).toEqual({
      href: `witnesswork://import-contact/${PAYLOAD}`,
      hidden: false,
    })
  })

  it('keeps the Open app link hidden without a base64url fragment', async () => {
    const page = await html('/c')
    for (const hash of [
      '',
      '#',
      `#${PAYLOAD}=`,
      `#${PAYLOAD}/x`,
      '#%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
      '#javascript:alert(1)',
    ]) {
      expect(openAppLinkAt(page, hash)).toEqual({ href: '', hidden: true })
    }
  })
})

describe('GET /c/:payload (legacy)', () => {
  it('keeps the deep link but leaves the payload out of og:url and every meta tag', async () => {
    const page = await html(`/c/${PAYLOAD}`)

    expect(ogUrl(page)).toBe(CANONICAL_URL)
    expect(page.slice(0, page.indexOf('</head>'))).not.toContain(PAYLOAD)
    expect(page).toContain(`href="witnesswork://import-contact/${PAYLOAD}"`)
  })

  it('renders no deep link for a payload that is not base64url', async () => {
    const page = await html('/c/%22%3E%3Cb%3Ehi')

    expect(page).not.toContain('witnesswork://import-contact/')
    expect(page).not.toContain('<b>hi')
  })
})

describe('Sentry reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names legacy link transactions by route and never sends the payload', async () => {
    const envelopes: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = init?.body
        envelopes.push(
          typeof body === 'string'
            ? body
            : new TextDecoder().decode(body as Uint8Array)
        )
        return new Response('{}', { status: 200 })
      })
    )

    await request(`/c/${PAYLOAD}`, {
      env: {
        ...ENV,
        APP_ATTEST_ENVIRONMENT: 'development',
        SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
      },
      headers: { referer: `${ORIGIN}/c/${PAYLOAD}` },
    })

    const sent = envelopes.join('\n')
    expect(sent).toContain('"type":"transaction"')
    expect(sent).toContain('"transaction":"GET /c/:payload"')
    expect(sent).toContain('"transaction_info":{"source":"route"}')
    expect(sent).toContain(`${ORIGIN}/c/[redacted]`)
    expect(sent).not.toContain(PAYLOAD)
  })
})
