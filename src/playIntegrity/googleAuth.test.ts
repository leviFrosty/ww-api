import { beforeEach, describe, expect, it, vi } from 'vitest'
import { base64ToBytes } from '../crypto'
import { createTestServiceAccount } from '../test/googleServiceAccount'
import {
  GoogleAuthError,
  PLAY_INTEGRITY_SCOPE,
  getPlayIntegrityAccessToken,
  resetGoogleAuthState,
} from './googleAuth'

const NOW = 1_800_000_000_000

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64ToBytes(segment)))

const tokenFetch = (body: unknown = { access_token: 'ya29.test', expires_in: 3599 }) =>
  vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 })
  )

describe('getPlayIntegrityAccessToken', () => {
  beforeEach(() => resetGoogleAuthState())

  it('exchanges a signed RS256 assertion at Google, ignoring the key file token_uri', async () => {
    const account = await createTestServiceAccount()
    const fetch = tokenFetch()

    await expect(
      getPlayIntegrityAccessToken(account.json, { fetch, now: () => NOW })
    ).resolves.toBe('ya29.test')

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )
    const [header, claims, signature] = form.get('assertion')!.split('.')
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decodeSegment(claims)).toEqual({
      iss: 'play-integrity@example.iam.gserviceaccount.com',
      scope: PLAY_INTEGRITY_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    })
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        account.publicKey,
        base64ToBytes(signature),
        new TextEncoder().encode(`${header}.${claims}`)
      )
    ).resolves.toBe(true)
  })

  it('reuses the token until five minutes before it expires', async () => {
    const account = await createTestServiceAccount()
    const fetch = tokenFetch({ access_token: 'ya29.cached', expires_in: 3600 })
    let now = NOW

    await getPlayIntegrityAccessToken(account.json, { fetch, now: () => now })
    now = NOW + 54 * 60_000
    await getPlayIntegrityAccessToken(account.json, { fetch, now: () => now })
    expect(fetch).toHaveBeenCalledTimes(1)

    now = NOW + 56 * 60_000
    await getPlayIntegrityAccessToken(account.json, { fetch, now: () => now })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a token minted for a different key', async () => {
    const first = await createTestServiceAccount()
    const second = await createTestServiceAccount()
    const fetch = tokenFetch()

    await getPlayIntegrityAccessToken(first.json, { fetch, now: () => NOW })
    await getPlayIntegrityAccessToken(second.json, { fetch, now: () => NOW })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['a key without a private key', JSON.stringify({ client_email: 'a@b' })],
    [
      'an unusable private key',
      JSON.stringify({ client_email: 'a@b', private_key: 'not-a-key' }),
    ],
  ])('fails closed on %s without calling Google', async (_name, json) => {
    const fetch = tokenFetch()
    await expect(
      getPlayIntegrityAccessToken(json, { fetch, now: () => NOW })
    ).rejects.toBeInstanceOf(GoogleAuthError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails on a rejected or empty token exchange', async () => {
    const account = await createTestServiceAccount()
    await expect(
      getPlayIntegrityAccessToken(account.json, {
        fetch: vi.fn(async () => new Response('{}', { status: 401 })),
        now: () => NOW,
      })
    ).rejects.toThrow('HTTP 401')
    await expect(
      getPlayIntegrityAccessToken(account.json, {
        fetch: tokenFetch({}),
        now: () => NOW,
      })
    ).rejects.toThrow('returned no token')
  })
})
