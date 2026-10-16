import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SigningKey,
  TEST_DEV_BYPASS,
  createHarness,
  randomBytes,
  b64u,
  type Harness,
} from '../test/buddies'
import { Hono } from 'hono'
import {
  accountEnvelope,
  bearer,
  openTestSession,
  postJson,
  requestJson,
} from '../test/accounts'
import { createNamespace } from '../test/durableObjects'
import { createTestServiceAccount } from '../test/googleServiceAccount'
import { randomToken } from '../crypto'
import { AppAttestIdentity } from '../appAttest/identityDO'
import { AppAttestError, appAttestLifecycle } from '../appAttest'
import { PlayIntegrityChallenges } from '../playIntegrity/challengeDO'
import { computePlayIntegrityRequestBinding } from '../playIntegrity/protocol'
import { resetGoogleAuthState } from '../googleAuth'
import type { AppEnv, Environment } from '../types'
import { handleAttestationChallengeRequest } from '../attestation/route'
import { sessionAttestationHash } from './contracts'
import { accountsDb } from './store'
import { pruneEndedSessions } from './sessionStore'
import { resetAccountStatusCache } from './auth'
import { createAccountsRoutes } from './route'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: unknown
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const START = Date.UTC(2026, 9, 15, 12)
const SECOND = 1_000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE
// The accounts routes at the root, plus the shared challenge route sessions
// attest through.
const app = new Hono<AppEnv>()
  .post('/attestation/v1/challenge', handleAttestationChallengeRequest)
  .route('/', createAccountsRoutes()) as never

let h: Harness

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  h = await createHarness()
  resetAccountStatusCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const post = (path: string, body: unknown, headers?: Record<string, string>) =>
  postJson(app, h.env, path, body, headers)
const open = (key?: SigningKey, fields?: Record<string, unknown>) =>
  openTestSession(app, h.env, key, fields)
const refresh = (refreshToken: unknown) =>
  post('/sessions/refresh', { refreshToken })
const close = (headers?: Record<string, string>) =>
  requestJson(app, h.env, 'DELETE', '/sessions/current', undefined, headers)
const info = (accessToken: string) =>
  requestJson(app, h.env, 'GET', '/account', undefined, bearer(accessToken))
const requestChallenge = (body: unknown) =>
  post('/attestation/v1/challenge', body)
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

const sessionRows = () =>
  h.accountsDb!.db.prepare('SELECT * FROM account_sessions').all() as Record<
    string,
    unknown
  >[]

describe('POST /sessions with the dev bypass', () => {
  it('creates the account and opens a session', async () => {
    const session = await open()
    expect(session).toEqual({
      key: session.key,
      ok: true,
      accountId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      status: 'active',
      sessionId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      accessToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
      accessExpiresAt: START + 15 * MINUTE,
      refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionExpiresAt: START + 90 * DAY,
    })

    // Only the account, platform, label, token hashes, and times.
    const [row] = sessionRows()
    expect(Object.keys(row).sort()).toEqual(
      [
        'account_id',
        'created_at',
        'device',
        'expires_at',
        'id',
        'platform',
        'previous_refresh_hash',
        'refresh_hash',
        'revoked_at',
        'rotated_at',
      ].sort()
    )
    expect(row).toMatchObject({
      id: session.sessionId,
      account_id: session.accountId,
      platform: 'dev',
      device: null,
      previous_refresh_hash: null,
      created_at: START,
      expires_at: START + 90 * DAY,
      revoked_at: null,
    })
    expect(row.refresh_hash).not.toBe(session.refreshToken)
    expect(JSON.stringify(row)).not.toContain(session.key.publicKey)
  })

  it('opens sessions for the account the key already has', async () => {
    const key = await SigningKey.generate()
    const registered = await post(
      '/account/register',
      await accountEnvelope('account/register', key)
    )
    const first = await open(key)
    const second = await open(key)
    expect(first.accountId).toBe(registered.body.accountId)
    expect(second.accountId).toBe(registered.body.accountId)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('reads the token’s account back with GET /account', async () => {
    const session = await open()
    const read = await info(session.accessToken)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({
      ok: true,
      accountId: session.accountId,
      accountPub: session.key.publicKey,
      status: 'active',
      createdAt: START,
      inboxIds: [],
      statusChanges: [],
    })
  })

  it('stores the sealed device label opaque, up to 512 characters', async () => {
    const label = 'A'.repeat(512)
    await open(undefined, { device: label })
    expect(sessionRows()[0].device).toBe(label)

    const key = await SigningKey.generate()
    const over = await post(
      '/sessions',
      await accountEnvelope('session/open', key, { device: 'A'.repeat(513) }),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(over.status).toBe(413)
    expect(over.body.code).toBe('too_large')
    const notB64u = await post(
      '/sessions',
      await accountEnvelope('session/open', key, { device: 'not base64url!' }),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(notB64u.status).toBe(400)
  })

  it('checks the envelope like account/register', async () => {
    const key = await SigningKey.generate()
    const other = await SigningKey.generate()
    const forged = await post(
      '/sessions',
      await accountEnvelope('session/open', key, {}, other),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(forged.status).toBe(401)
    expect(forged.body.code).toBe('bad_signature')
    const wrongOp = await post(
      '/sessions',
      await accountEnvelope('account/register', key),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(wrongOp.status).toBe(401)
    const stale = await post(
      '/sessions',
      await accountEnvelope('session/open', key, { ts: Date.now() - 6 * MINUTE }),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(stale.status).toBe(401)
    expect(stale.body.code).toBe('stale')
  })

  it('never takes the bypass on production, or a wrong bypass token', async () => {
    const key = await SigningKey.generate()
    const envelope = await accountEnvelope('session/open', key)
    const wrong = await post('/sessions', envelope, {
      'x-ww-dev-bypass': 'not-the-token',
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body).toMatchObject({ code: 'bad_request', reason: 'invalid_request' })

    // Production never has the token, so the header is ignored there; with
    // the token set, the worker fails loudly instead (src/devBypass.ts).
    h.env.APP_ATTEST_ENVIRONMENT = 'production'
    const misconfigured = await post(
      '/sessions',
      await accountEnvelope('session/open', key),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(misconfigured.status).toBe(500)
    delete h.env.NOTES_IMPORT_DEV_BYPASS_TOKEN
    const prod = await post(
      '/sessions',
      await accountEnvelope('session/open', key),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(prod.status).toBe(400)
    expect(prod.body.code).toBe('bad_request')
    expect(sessionRows()).toEqual([])
  })

  it('counts 20 opens per account key a rolling day', async () => {
    const key = await SigningKey.generate()
    for (let i = 0; i < 20; i++) await open(key)
    const refused = await post(
      '/sessions',
      await accountEnvelope('session/open', key),
      { 'x-ww-dev-bypass': TEST_DEV_BYPASS }
    )
    expect(refused.status).toBe(429)
    expect(refused.body.code).toBe('rate_limited')
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another account isn't affected.
    await open()
  })

  it('ends the oldest session when an eleventh opens', async () => {
    const key = await SigningKey.generate()
    const sessions = []
    for (let i = 0; i < 11; i++) {
      sessions.push(await open(key))
      advance(SECOND)
    }
    const live = sessionRows().filter((row) => row.revoked_at == null)
    expect(live).toHaveLength(10)
    expect((await refresh(sessions[0].refreshToken)).status).toBe(401)
    expect((await refresh(sessions[1].refreshToken)).status).toBe(200)
    expect((await refresh(sessions[10].refreshToken)).status).toBe(200)
  })
})

describe('POST /sessions/refresh', () => {
  it('replaces both tokens every time', async () => {
    const session = await open()
    advance(MINUTE)
    const first = await refresh(session.refreshToken)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      ok: true,
      accessToken: expect.any(String),
      accessExpiresAt: Date.now() + 15 * MINUTE,
      refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionExpiresAt: session.sessionExpiresAt,
    })
    expect(first.body.refreshToken).not.toBe(session.refreshToken)
    expect(first.body.accessToken).not.toBe(session.accessToken)
    expect((await info(first.body.accessToken)).status).toBe(200)

    advance(5 * MINUTE)
    const second = await refresh(first.body.refreshToken)
    expect(second.status).toBe(200)
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken)
  })

  it('accepts the replaced token for 60 seconds after a lost response', async () => {
    const session = await open()
    const rotated = await refresh(session.refreshToken)
    advance(59 * SECOND)
    const retried = await refresh(session.refreshToken)
    expect(retried.status).toBe(200)
    // The pair issued in between is gone; the retried one works.
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401)
    const next = await refresh(retried.body.refreshToken)
    expect(next.status).toBe(200)
    expect((await refresh(next.body.refreshToken)).status).toBe(200)
  })

  it('counts the grace from the first rotation, so retries can’t stretch it', async () => {
    const session = await open()
    await refresh(session.refreshToken)
    advance(40 * SECOND)
    expect((await refresh(session.refreshToken)).status).toBe(200)
    advance(40 * SECOND)
    expect((await refresh(session.refreshToken)).status).toBe(401)
  })

  it('ends the session when a replaced token comes back after 60 seconds', async () => {
    const session = await open()
    const rotated = await refresh(session.refreshToken)
    advance(61 * SECOND)
    const reused = await refresh(session.refreshToken)
    expect(reused.status).toBe(401)
    expect(reused.body.code).toBe('unauthorized')
    // The current token died with the session.
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401)
    expect(sessionRows()[0].revoked_at).toBe(Date.now())
  })

  it('refuses unknown and malformed tokens', async () => {
    const unknown = await refresh(b64u(randomBytes(32)))
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({
      ok: false,
      error: 'unauthorized',
      code: 'unauthorized',
    })
    expect(unknown.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"'
    )
    expect((await refresh('too-short')).status).toBe(401)
    expect((await refresh(42)).status).toBe(400)
    expect((await post('/sessions/refresh', 'not json')).status).toBe(400)
  })

  it('lasts 90 days from open, however often it refreshes', async () => {
    const session = await open()
    let token = session.refreshToken
    for (let day = 0; day < 89; day += 10) {
      advance(10 * DAY)
      const next = await refresh(token)
      if (Date.now() >= session.sessionExpiresAt) {
        expect(next.status).toBe(401)
        return
      }
      expect(next.status).toBe(200)
      expect(next.body.sessionExpiresAt).toBe(START + 90 * DAY)
      expect(next.body.accessExpiresAt).toBeLessThanOrEqual(START + 90 * DAY)
      token = next.body.refreshToken
    }
    vi.setSystemTime(START + 90 * DAY - 5 * MINUTE)
    const last = await refresh(token)
    expect(last.status).toBe(200)
    // The access token stops with the session.
    expect(last.body.accessExpiresAt).toBe(START + 90 * DAY)
    vi.setSystemTime(START + 90 * DAY)
    expect((await refresh(last.body.refreshToken)).status).toBe(401)
  })
})

describe('DELETE /sessions/current', () => {
  it('ends the session; repeating it is ok', async () => {
    const session = await open()
    const closed = await close(bearer(session.accessToken))
    expect(closed.status).toBe(200)
    expect(closed.body).toEqual({ ok: true })
    expect((await refresh(session.refreshToken)).status).toBe(401)
    const again = await close(bearer(session.accessToken))
    expect(again.status).toBe(200)
  })

  it('needs a valid bearer token', async () => {
    const missing = await close()
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"'
    )
    expect(
      (await close(bearer('nope'))).status
    ).toBe(401)
    const session = await open()
    advance(15 * MINUTE)
    expect(
      (await close(bearer(session.accessToken))).status
    ).toBe(401)
  })

  it('only ends the token’s own session', async () => {
    const key = await SigningKey.generate()
    const mine = await open(key)
    const other = await open(key)
    await close(bearer(mine.accessToken))
    expect((await refresh(other.refreshToken)).status).toBe(200)
  })
})

describe('without sessions configured', () => {
  it('answers disabled without a token secret or the accounts database', async () => {
    for (const options of [{ sessions: false }, { accountsDb: false }]) {
      h = await createHarness(options)
      const key = await SigningKey.generate()
      const responses = [
        await post('/sessions', await accountEnvelope('session/open', key), {
          'x-ww-dev-bypass': TEST_DEV_BYPASS,
        }),
        await refresh(b64u(randomBytes(32))),
        await close(bearer('x.y.z')),
      ]
      for (const response of responses) {
        expect(response.status).toBe(503)
        expect(response.body.code).toBe('disabled')
      }
    }
  })

  it('never lets a bearer token through without a secret', async () => {
    const session = await open()
    delete h.env.ACCOUNT_TOKEN_SECRET
    const read = await info(session.accessToken)
    expect(read.status).toBe(503)
    expect(read.body.code).toBe('disabled')
  })
})

describe('pruning ended sessions', () => {
  it('deletes sessions a week after they were revoked or expired', async () => {
    const key = await SigningKey.generate()
    const closed = await open(key)
    await open(key)
    await close(bearer(closed.accessToken))
    const db = accountsDb(h.env.ACCOUNTS_DB!)

    vi.setSystemTime(START + 7 * DAY - 1)
    expect(await pruneEndedSessions(db)).toBe(0)
    vi.setSystemTime(START + 7 * DAY)
    expect(await pruneEndedSessions(db)).toBe(1)
    expect(sessionRows()).toHaveLength(1)

    vi.setSystemTime(START + 97 * DAY)
    expect(await pruneEndedSessions(db)).toBe(1)
    expect(sessionRows()).toEqual([])
  })
})

// --- Attestation ---------------------------------------------------------------

const UUID = 'install-uuid-0001'
const KEY_ID = Buffer.from(randomBytes(32)).toString('base64')
const RECOVERY_TOKEN = b64u(randomBytes(32))

/** The real AppAttestIdentity with fake cryptography: `count:N` asserts. */
const withAppAttest = async () => {
  const clientData: string[] = []
  const identities = createNamespace(
    (state) =>
      new AppAttestIdentity(state as never, h.env, {
        now: () => Date.now(),
        randomChallenge: () => randomToken(32),
        verifyAttestation: async (args) => ({
          spki: `spki:${args.keyId}`,
          environment: 'development',
          bundleId: args.bundleIds[0],
        }),
        verifyAssertion: async (args) => {
          clientData.push(args.clientData)
          const match = /^count:(\d+)$/.exec(args.assertion)
          if (!match) throw new AppAttestError('synthetic assertion invalid')
          return { signCount: Number(match[1]) }
        },
      })
  )
  h.env.APP_ATTEST_IDENTITY =
    identities.namespace as unknown as Environment['APP_ATTEST_IDENTITY']
  const lifecycle = appAttestLifecycle(h.env)
  const bind = {
    protocolVersion: 2 as const,
    operation: 'bind' as const,
    operationId: 'bind-operation-1',
    uuid: UUID,
    keyId: KEY_ID,
  }
  const { challenge } = (await lifecycle.issueChallenge(bind)) as {
    challenge: string
  }
  await lifecycle.register({
    ...bind,
    challenge,
    attestation: 'attestation',
    recoveryToken: RECOVERY_TOKEN,
  })
  return { clientData }
}

const appAttestFields = (hash: string, operationId = 'session-operation-1') => ({
  protocolVersion: 2,
  operation: 'assert',
  operationId,
  uuid: UUID,
  keyId: KEY_ID,
  purpose: 'account-session',
  contentHash: hash,
  requestHash: hash,
})

const openWith = async (key: SigningKey, attestation: unknown) =>
  post('/sessions', await accountEnvelope('session/open', key, { attestation }))

describe('session attestation (App Attest)', () => {
  it('binds the assertion to the envelope’s account key', async () => {
    const { clientData } = await withAppAttest()
    const key = await SigningKey.generate()
    const hash = await sessionAttestationHash(key.publicKey)
    const fields = appAttestFields(hash)

    const issued = await requestChallenge(fields)
    expect(issued.status).toBe(200)
    expect(issued.body).toEqual({
      protocolVersion: 2,
      operation: 'assert',
      operationId: fields.operationId,
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: Date.now() + 5 * MINUTE,
    })
    const { challenge } = issued.body
    const opened = await openWith(key, {
      ...fields,
      challenge,
      assertion: 'count:1',
    })
    expect(opened.status).toBe(201)
    expect(opened.body.status).toBe('active')
    expect(sessionRows()[0].platform).toBe('ios')
    expect(clientData).toEqual([
      [
        'witnesswork.app-attest',
        '2',
        'assert',
        'account-session',
        fields.operationId,
        challenge,
        UUID,
        '',
        hash,
        hash,
      ].join('|'),
    ])

    // The challenge is spent: a replay of the same request is refused.
    const replayed = await openWith(key, {
      ...fields,
      challenge,
      assertion: 'count:1',
    })
    expect(replayed.status).toBe(403)
    expect(replayed.body).toMatchObject({
      code: 'attestation_failed',
      reason: 'challenge_not_found',
    })
    expect(sessionRows()).toHaveLength(1)
  })

  it('refuses an attestation for another key', async () => {
    await withAppAttest()
    const key = await SigningKey.generate()
    const thief = await SigningKey.generate()
    const hash = await sessionAttestationHash(key.publicKey)
    const fields = appAttestFields(hash)
    const { challenge } = (await requestChallenge(fields)).body
    const attestation = { ...fields, challenge, assertion: 'count:1' }

    // Moved as is: the hashes name another key.
    const moved = await openWith(thief, attestation)
    expect(moved.status).toBe(400)
    expect(moved.body).toMatchObject({ code: 'bad_request', reason: 'invalid_request' })

    // Relabeled for the thief's key: the challenge was issued for the other.
    const thiefHash = await sessionAttestationHash(thief.publicKey)
    const relabeled = await openWith(thief, {
      ...attestation,
      contentHash: thiefHash,
      requestHash: thiefHash,
    })
    expect(relabeled.status).toBe(403)
    expect(relabeled.body).toMatchObject({
      code: 'attestation_failed',
      reason: 'operation_conflict',
    })
    expect(sessionRows()).toEqual([])

    // The rightful key still opens with it.
    expect((await openWith(key, attestation)).status).toBe(201)
  })

  it('refuses a bad assertion with a stable reason', async () => {
    await withAppAttest()
    const key = await SigningKey.generate()
    const fields = appAttestFields(await sessionAttestationHash(key.publicKey))
    const { challenge } = (await requestChallenge(fields)).body
    const refused = await openWith(key, {
      ...fields,
      challenge,
      assertion: 'not-an-assertion',
    })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({
      ok: false,
      code: 'attestation_failed',
      reason: 'assertion_invalid',
    })
  })

  it('needs the install’s key bound first', async () => {
    await withAppAttest()
    const key = await SigningKey.generate()
    const fields = {
      ...appAttestFields(await sessionAttestationHash(key.publicKey)),
      uuid: 'another-install-0002',
    }
    const { challenge } = (await requestChallenge(fields)).body
    const refused = await openWith(key, { ...fields, challenge, assertion: 'count:1' })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({
      code: 'attestation_failed',
      reason: 'identity_not_bound',
      action: 'bind',
    })
  })

  it('issues account-session challenges through /attestation/v1/challenge', async () => {
    await withAppAttest()
    const fields = appAttestFields(
      await sessionAttestationHash((await SigningKey.generate()).publicKey)
    )
    const issued = await requestChallenge(fields)
    expect(issued.status).toBe(200)
    expect(issued.body.operationId).toBe(fields.operationId)
  })

  it('refuses an attestation for another purpose or with mismatched hashes', async () => {
    await withAppAttest()
    const key = await SigningKey.generate()
    const hash = await sessionAttestationHash(key.publicKey)
    for (const [index, change] of [
      { purpose: 'notes-import-kickoff' },
      { requestHash: 'b'.repeat(64) },
      { contentHash: 'b'.repeat(64) },
    ].entries()) {
      const fields = {
        ...appAttestFields(hash, `session-operation-${index + 10}`),
        ...change,
      }
      const issued = await requestChallenge(fields)
      expect(issued.status, JSON.stringify(change)).toBe(200)
      const refused = await openWith(key, {
        ...fields,
        challenge: issued.body.challenge,
        assertion: 'count:1',
      })
      expect(refused.status, JSON.stringify(change)).toBe(400)
      expect(refused.body).toMatchObject({
        code: 'bad_request',
        reason: 'invalid_request',
      })
    }
    for (const attestation of [[], 'nope']) {
      const refused = await openWith(key, attestation)
      expect(refused.status).toBe(400)
      expect(refused.body.code).toBe('bad_request')
    }
    // App Attest v1 never opens a session.
    const v1 = await openWith(key, {
      ...appAttestFields(hash),
      protocolVersion: 1,
      challenge: 'C'.repeat(43),
      assertion: 'count:1',
    })
    expect(v1.status).toBe(400)
    expect(v1.body).toMatchObject({
      code: 'bad_request',
      reason: 'unsupported_protocol',
    })
    expect(sessionRows()).toEqual([])
  })
})

describe('session attestation (Play Integrity)', () => {
  const PACKAGE = 'com.leviwilkerson.jwtime'

  const withPlayIntegrity = async (device = ['MEETS_DEVICE_INTEGRITY']) => {
    resetGoogleAuthState()
    const account = await createTestServiceAccount()
    const challenges = createNamespace(
      (state) => new PlayIntegrityChallenges(state, {} as Environment)
    )
    Object.assign(h.env, {
      ANDROID_PACKAGE_NAME: PACKAGE,
      PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: '123456789012',
      PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: account.json,
      PLAY_INTEGRITY_CHALLENGES: challenges.namespace,
    })
    const binding = { value: '' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === 'https://oauth2.googleapis.com/token')
          return Response.json({ access_token: 'ya29.test', expires_in: 3600 })
        if (url.endsWith(':decodeIntegrityToken'))
          return Response.json({
            tokenPayloadExternal: {
              requestDetails: {
                requestPackageName: PACKAGE,
                requestHash: binding.value,
                timestampMillis: String(Date.now()),
              },
              appIntegrity: {
                appRecognitionVerdict: 'PLAY_RECOGNIZED',
                packageName: PACKAGE,
              },
              deviceIntegrity: { deviceRecognitionVerdict: device },
            },
          })
        throw new Error(`unexpected fetch ${url}`)
      })
    )
    return binding
  }

  const attest = async (binding: { value: string }, key: SigningKey) => {
    const hash = await sessionAttestationHash(key.publicKey)
    const fields = {
      attestationProvider: 'play-integrity',
      protocolVersion: 1,
      operation: 'assert',
      operationId: 'play-session-operation-1',
      uuid: UUID,
      purpose: 'account-session',
      contentHash: hash,
      requestHash: hash,
    }
    const issued = await requestChallenge(fields)
    expect(issued.status).toBe(200)
    expect(issued.body).toMatchObject({
      attestationProvider: 'play-integrity',
      challenge: expect.any(String),
    })
    const { challenge } = issued.body
    binding.value = await computePlayIntegrityRequestBinding({
      ...(fields as never),
      challenge,
    })
    return { ...fields, challenge, integrityToken: 'token.abc' }
  }

  it('opens an Android session for a bound integrity token', async () => {
    const binding = await withPlayIntegrity()
    const key = await SigningKey.generate()
    const opened = await openWith(key, await attest(binding, key))
    expect(opened.status).toBe(201)
    expect(sessionRows()[0].platform).toBe('android')
    expect((await info(opened.body.accessToken)).status).toBe(200)
  })

  it('refuses a device that fails integrity, with its reason', async () => {
    const binding = await withPlayIntegrity(['MEETS_BASIC_INTEGRITY'])
    const key = await SigningKey.generate()
    const refused = await openWith(key, await attest(binding, key))
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({
      code: 'attestation_failed',
      reason: 'device_integrity_failed',
    })
    expect(sessionRows()).toEqual([])
  })

  it('refuses a token bound to another key', async () => {
    const binding = await withPlayIntegrity()
    const key = await SigningKey.generate()
    const attestation = await attest(binding, key)
    const moved = await openWith(await SigningKey.generate(), attestation)
    expect(moved.status).toBe(400)
    expect(moved.body.reason).toBe('invalid_request')
  })
})
