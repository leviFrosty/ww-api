import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../crypto'
import type { Environment } from '../types'
import { createHarness, TEST_DEV_BYPASS, type Harness } from '../test/buddies'
import {
  bearer,
  nextTestIp,
  openTestSession,
  type TestSession,
} from '../test/accounts'
import { createNamespace, type FakeNamespace } from '../test/durableObjects'
import { resetAccountStatusCache } from '../accounts/auth'
import { createAccountsRoutes } from '../accounts/route'
import { accountsDb, setAccountStatus } from '../accounts/store'
import { accessTokenKeys, signAccessToken } from '../accounts/tokens'
import { analyticsDistinctId } from '../analytics'
import { app } from '../app'
import { SYNC_IMPORT_DEADLINE_MS, SYNC_SLOT_MAX_AGE_MS } from './cap'
import { getNotesImportConfig } from './config'
import { NotesImportIndex } from './indexDO'
import { NotesImportRun } from './runDO'
import { ModelDeadlineError, importOwnerKey } from './route'

/**
 * Notes Import on account sessions (witness-work ADR 0027): bearer requests
 * meter by the token's account and reach only that account's runs; legacy
 * requests are unchanged while the legacy switch is on and 426 once it's
 * off. Real run and index Durable Objects; the model, the page reader, and
 * PostHog are stubbed, and RevenueCat answers through `fetch`.
 */

const mocks = vi.hoisted(() => ({
  runModel: vi.fn(),
  transcribe: vi.fn(),
  capture: vi.fn(async () => undefined),
  /** Stands in for App Attest v1 verification when a test sets it. */
  appAttest: null as { verifyAssertion: () => Promise<void> } | null,
}))

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
vi.mock('./llm', () => ({ runNotesImportModel: mocks.runModel }))
vi.mock('../appAttest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../appAttest')>()
  return {
    ...original,
    appAttestLifecycle: (env: Environment) =>
      mocks.appAttest ?? original.appAttestLifecycle(env),
  }
})
vi.mock('./transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transcribe')>()),
  transcribeNotesPage: mocks.transcribe,
}))
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  captureAnalyticsEvent: mocks.capture,
}))

const START = Date.UTC(2026, 9, 15, 12)
const accountsApp = createAccountsRoutes() as never

const CONTEXT = {
  now: '2026-10-15T08:00:00-04:00',
  timeZone: 'America/New_York',
  existingContacts: [],
  existingCategories: [],
}
const RESULT = {
  contacts: [],
  visits: [],
  timeEntries: [
    { date: '2026-10-14', hours: 1, minutes: 0, categoryId: null, credit: false },
  ],
  categories: [],
  publisher: null,
  warnings: [],
  summary: 'One hour',
  assistantMessage: '',
}
/** The first bytes of a JPEG (FF D8 FF E0 00 10). */
const JPEG = '/9j/4AAQ'
const RC_ID = 'B1C2D3E4-0000-4000-8000-000000000001'
const LIFETIME = {
  subscriber: { entitlements: { 'Lifetime Supporter': { expires_date: null } } },
}

let h: Harness
let runs: FakeNamespace<NotesImportRun>
let indexes: FakeNamespace<NotesImportIndex>
let pending: Promise<unknown>[]
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  h = await createHarness()
  resetAccountStatusCache()
  await h.kv.put('notes-import:provider-health', 'up')
  const env = h.env as Environment & Record<string, unknown>
  env.RATE_LIMITER = { limit: async () => ({ success: true }) }
  env.OPENROUTER_API_KEY = 'openrouter-test'
  env.REVENUECAT_API_KEY = 'revenuecat-test'
  env.POSTHOG_PROJECT_TOKEN = 'phc_test'
  runs = createNamespace((state) => new NotesImportRun(state as never, env as never))
  indexes = createNamespace(
    (state) => new NotesImportIndex(state as never, env as never)
  )
  env.NOTES_IMPORT_RUN = runs.namespace as Environment['NOTES_IMPORT_RUN']
  env.NOTES_IMPORT_INDEX = indexes.namespace as Environment['NOTES_IMPORT_INDEX']
  pending = []
  // RevenueCat: nobody is a Supporter unless a test says otherwise.
  fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  mocks.runModel.mockReset()
  mocks.runModel.mockResolvedValue({
    result: RESULT,
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 },
    resolvedProvider: 'azure',
  })
  mocks.transcribe.mockReset()
  mocks.capture.mockClear()
  mocks.appAttest = null
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise)
  },
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext

interface Reply {
  status: number
  headers: Headers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  text: string
}

const call = async (
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Reply> => {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': nextTestIp(),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    h.env,
    executionCtx
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // The SSE stream.
  }
  return { status: response.status, headers: response.headers, body, text }
}

const flush = async () => {
  while (pending.length) await Promise.all(pending.splice(0))
}

/** A dev session (the harness opens sessions with the dev bypass). */
const devSession = () => openTestSession(accountsApp, h.env)

/** A token for the same account and session, as an iOS session would carry. */
const iosToken = async (session: TestSession) => {
  const keys = await accessTokenKeys(h.env)
  return (
    await signAccessToken(keys!, {
      accountId: session.accountId,
      sessionId: session.sessionId,
      platform: 'ios',
    })
  ).accessToken
}

const kickoff = (token: string, fields: Record<string, unknown> = {}) =>
  call('POST', '/notes-import/kickoff', {
    headers: bearer(token),
    body: { notesText: 'Field service 1 hour', context: CONTEXT, ...fields },
  })

/** Kicks off and runs the import to `done`; returns its id. */
const importNotes = async (token: string, fields: Record<string, unknown> = {}) => {
  const started = await kickoff(token, fields)
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  await runs.fireAlarm(started.body.importId)
  await flush()
  return started.body.importId as string
}

const run = (importId: string, op: string, token: string) =>
  call(op === 'events' || op === 'result' ? 'GET' : 'POST', `/notes-import/${importId}/${op}`, {
    headers: bearer(token),
  })

const legacyBody = (fields: Record<string, unknown> = {}) => ({
  uuid: 'C3D4E5F6-0000-4000-8000-000000000002',
  notesText: 'Field service 1 hour',
  context: CONTEXT,
  ...fields,
})
const legacyHeaders = { 'x-ww-dev-bypass': TEST_DEV_BYPASS }

const revenueCatIds = () =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('https://api.revenuecat.com/'))
    .map((url) => decodeURIComponent(url.split('/').pop()!))

describe('bearer kickoff', () => {
  it('meters by the token’s account, with no attestation fields', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const started = await kickoff(token, {
      // Legacy identity fields are not read on a bearer request.
      uuid: 'D4E5F6A7-0000-4000-8000-000000000003',
      accountId: 'legacy-shared-account-id',
    })

    expect(started.status).toBe(200)
    expect(Object.keys(started.body).sort()).toEqual([
      'credits',
      'importId',
      'refinement',
    ])
    expect(started.body.importId).toMatch(/^imp_[a-f0-9]{40}$/)
    expect(started.body.credits).toMatchObject({ limit: 3, isSupporter: false })

    await runs.fireAlarm(started.body.importId)
    await flush()
    const hash = await sha256Hex('Field service 1 hour')
    expect(
      indexes.storage(session.accountId).query('SELECT hash, charged FROM hash_record')
    ).toEqual([{ hash, charged: 1 }])
    const result = await run(started.body.importId, 'result', token)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: 'done',
      payload: { result: RESULT, contentHash: hash, credits: { remaining: 2 } },
    })
    // No Supporter id named, so RevenueCat was never asked.
    expect(revenueCatIds()).toEqual([])
  })

  it('is idempotent per account and content, and distinct across accounts', async () => {
    const a = await devSession()
    const b = await devSession()
    const first = await kickoff(a.accessToken)
    const again = await kickoff(a.accessToken)
    const other = await kickoff(b.accessToken)
    expect(again.body.importId).toBe(first.body.importId)
    expect(other.body.importId).not.toBe(first.body.importId)
  })

  it('never lands on a legacy run with the same meter and content', async () => {
    const session = await devSession()
    const legacy = await call('POST', '/notes-import/kickoff', {
      headers: legacyHeaders,
      body: legacyBody({ uuid: `account:${session.accountId}` }),
    })
    expect(legacy.status).toBe(200)
    const bearerStart = await kickoff(session.accessToken)
    expect(bearerStart.body.importId).not.toBe(legacy.body.importId)
  })

  it('serves the synchronous POST /notes-import the same way', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const response = await call('POST', '/notes-import', {
      headers: bearer(token),
      body: { notesText: 'Field service 1 hour', context: CONTEXT },
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      result: RESULT,
      credits: { remaining: 2, limit: 3 },
    })
    expect(
      indexes.storage(session.accountId).query('SELECT charged FROM hash_record')
    ).toEqual([{ charged: 1 }])
  })

  it('refuses a bad token with 401, never falling back to attestation', async () => {
    const response = await call('POST', '/notes-import/kickoff', {
      headers: { ...legacyHeaders, authorization: 'Bearer forged.token.value' },
      body: legacyBody(),
    })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: 'The access token is missing, expired, or invalid',
      code: 'unauthorized',
    })
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"'
    )
    expect(mocks.runModel).not.toHaveBeenCalled()
  })

  it('refuses a suspended account, which can still read and delete its runs', async () => {
    const session = await devSession()
    const importId = await importNotes(session.accessToken)
    await setAccountStatus(
      accountsDb(h.env.ACCOUNTS_DB!),
      session.accountId,
      'suspended',
      'report'
    )
    vi.setSystemTime(START + 30_000)
    const refused = await kickoff(session.accessToken, { notesText: 'Other notes' })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ ok: false, code: 'suspended' })
    expect((await run(importId, 'result', session.accessToken)).status).toBe(200)
    expect((await run(importId, 'destroy', session.accessToken)).status).toBe(200)
  })

  it('validates the body without legacy fields', async () => {
    const session = await devSession()
    const missing = await call('POST', '/notes-import/kickoff', {
      headers: bearer(session.accessToken),
      body: { context: CONTEXT },
    })
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({
      ok: false,
      error: 'Missing notesText or context',
      code: 'bad_request',
    })
    const badId = await kickoff(session.accessToken, {
      revenueCatAppUserId: 'not a valid id!',
    })
    expect(badId.status).toBe(400)
    expect(badId.body.error).toBe('Invalid revenueCatAppUserId')
  })
})

describe('empty notes', () => {
  it('refuses empty or whitespace-only notesText before any credit or model work, bearer and legacy', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const metered = vi.spyOn(indexes.namespace, 'idFromName')
    const requests = (notesText: string) => [
      ['/notes-import/kickoff', bearer(token), { notesText, context: CONTEXT, revenueCatAppUserId: RC_ID }],
      ['/notes-import', bearer(token), { notesText, context: CONTEXT, revenueCatAppUserId: RC_ID }],
      ['/notes-import/kickoff', legacyHeaders, legacyBody({ notesText })],
      ['/notes-import', legacyHeaders, legacyBody({ notesText })],
    ] as const

    for (const notesText of ['', ' ', '\n\t \r\n', '  ﻿']) {
      for (const [path, headers, body] of requests(notesText)) {
        const response = await call('POST', path, { headers, body })
        expect(response.status, `${path} ${JSON.stringify(notesText)}`).toBe(400)
        expect(response.body).toEqual({
          ok: false,
          error: 'notesText is empty',
          code: 'bad_request',
        })
      }
    }
    expect(metered).not.toHaveBeenCalled()
    expect(revenueCatIds()).toEqual([])
    expect(mocks.runModel).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()

    // Text around the whitespace is still an import.
    expect((await kickoff(token, { notesText: '  1 hour  ' })).status).toBe(200)
  })
})

describe('synchronous imports and the concurrency cap', () => {
  const MODEL_OUTPUT = {
    result: RESULT,
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 },
    resolvedProvider: 'azure',
  }

  /** Holds every model run until `release()`. */
  const holdModel = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    mocks.runModel.mockImplementation(async () => {
      await gate
      return MODEL_OUTPUT
    })
    return release
  }

  const slots = (meter: string) =>
    indexes.storage(meter).query('SELECT importId FROM active') as {
      importId: string
    }[]

  /**
   * Sends `count` identical synchronous imports at once with the model held:
   * `cap` of them run, each in a slot of its own, and the rest are refused
   * while they do. Then they finish and charge once.
   */
  const burst = async (
    meter: string,
    cap: number,
    send: () => Promise<Reply>
  ) => {
    const release = holdModel()
    const settled: Reply[] = []
    const replies = Array.from({ length: cap + 2 }, () =>
      send().then((reply) => (settled.push(reply), reply))
    )
    await vi.waitFor(() => {
      expect(mocks.runModel).toHaveBeenCalledTimes(cap)
      expect(settled).toHaveLength(2)
    })
    for (const refused of settled) {
      expect(refused.status).toBe(429)
      expect(refused.body).toMatchObject({ code: 'active_cap' })
      expect(refused.headers.get('retry-after')).toBe('15')
    }
    const held = slots(meter).map(({ importId }) => importId)
    expect(held).toHaveLength(cap)
    expect(new Set(held).size).toBe(cap)
    for (const slot of held) expect(slot).toMatch(/^legacy:[0-9a-f-]{36}$/)

    release()
    const done = (await Promise.all(replies)).filter(
      (reply) => reply.status === 200
    )
    expect(done).toHaveLength(cap)
    expect(mocks.runModel).toHaveBeenCalledTimes(cap)
    expect(slots(meter)).toEqual([])
    return done
  }

  /** The meter's content records and import window. */
  const usage = (meter: string) => ({
    records: indexes
      .storage(meter)
      .query('SELECT hash, charged, refinements FROM hash_record'),
    window: indexes
      .storage(meter)
      .query("SELECT v FROM credit_meta WHERE k = 'count'"),
  })

  it('gives every identical bearer request its own slot, and charges once', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const done = await burst(
      session.accountId,
      getNotesImportConfig(h.env).activeImportCap,
      () =>
        call('POST', '/notes-import', {
          headers: bearer(token),
          body: { notesText: 'Field service 1 hour', context: CONTEXT },
        })
    )
    // One charge for the content, however many runs it took.
    expect(usage(session.accountId)).toEqual({
      records: [
        {
          hash: await sha256Hex('Field service 1 hour'),
          charged: 1,
          refinements: 0,
        },
      ],
      window: [{ v: 1 }],
    })
    for (const reply of done)
      expect(reply.body.credits).toMatchObject({ remaining: 2, limit: 3 })
  })

  it('gives every identical legacy request its own slot, and charges once', async () => {
    // App Attest v1, the legacy synchronous route's only attestation.
    mocks.appAttest = { verifyAssertion: vi.fn(async () => undefined) }
    const body = legacyBody({
      keyId: 'key-id',
      challenge: 'challenge',
      assertion: 'assertion',
    })
    const done = await burst(
      body.uuid,
      getNotesImportConfig(h.env).activeImportCap,
      () => call('POST', '/notes-import', { body })
    )
    expect(mocks.appAttest.verifyAssertion).toHaveBeenCalledTimes(
      getNotesImportConfig(h.env).activeImportCap + 2
    )
    expect(usage(body.uuid)).toEqual({
      records: [
        {
          hash: await sha256Hex('Field service 1 hour'),
          charged: 1,
          refinements: 0,
        },
      ],
      window: [{ v: 1 }],
    })
    for (const reply of done)
      expect(reply.body.credits).toMatchObject({ remaining: 2, limit: 3 })
  })

  it('gives every identical dev-bypass request its own slot, under the Supporter cap', async () => {
    await burst(
      legacyBody().uuid,
      getNotesImportConfig(h.env).activeImportCapSupporter,
      () =>
        call('POST', '/notes-import', {
          headers: legacyHeaders,
          body: legacyBody(),
        })
    )
    // Unlimited, so nothing counts against a window.
    expect(usage(legacyBody().uuid)).toEqual({
      records: [
        {
          hash: await sha256Hex('Field service 1 hour'),
          charged: 0,
          refinements: 0,
        },
      ],
      window: [],
    })
  })

  it('counts each identical refinement that ran, as before', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const send = (fields: Record<string, unknown> = {}) =>
      call('POST', '/notes-import', {
        headers: bearer(token),
        body: { notesText: 'Field service 1 hour', context: CONTEXT, ...fields },
      })
    expect((await send()).status).toBe(200)
    mocks.runModel.mockClear()
    const refinement = {
      instruction: 'Make it two hours',
      previousResult: RESULT,
    }
    const cap = getNotesImportConfig(h.env).activeImportCap
    await burst(session.accountId, cap, () => send({ refinement }))
    // Refinements count per run, so the cap now bounds how many count at once.
    expect(usage(session.accountId)).toEqual({
      records: [
        {
          hash: await sha256Hex('Field service 1 hour'),
          charged: 1,
          refinements: cap,
        },
      ],
      window: [{ v: 1 }],
    })
  })

  it('never shares a slot with a streaming run of the same content', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const started = await kickoff(token)
    expect(started.status).toBe(200)
    const release = holdModel()
    const sync = call('POST', '/notes-import', {
      headers: bearer(token),
      body: { notesText: 'Field service 1 hour', context: CONTEXT },
    })
    await vi.waitFor(() => expect(slots(session.accountId)).toHaveLength(2))
    // With the cap (2) full, a third import of the same notes waits.
    const third = await call('POST', '/notes-import', {
      headers: bearer(token),
      body: { notesText: 'Field service 1 hour', context: CONTEXT },
    })
    expect(third.status).toBe(429)
    release()
    expect((await sync).status).toBe(200)
    expect(slots(session.accountId)).toEqual([
      { importId: started.body.importId },
    ])
  })

  it('drops a synchronous slot nobody released after 15 minutes, never a run’s', async () => {
    const session = await devSession()
    const send = async () =>
      call('POST', '/notes-import', {
        headers: bearer(await iosToken(session)),
        body: { notesText: 'Field service 1 hour', context: CONTEXT },
      })
    // A streaming run holds a slot until it settles (its alarm never fires
    // here).
    const started = await kickoff(await iosToken(session), {
      notesText: 'Other notes',
    })
    expect(started.status).toBe(200)
    // A request whose client went away: its model run never returns, so its
    // `finally` never releases its slot.
    mocks.runModel.mockImplementation(() => new Promise(() => undefined))
    void send()
    await vi.waitFor(() => expect(slots(session.accountId)).toHaveLength(2))
    const [{ startedAt }] = indexes
      .storage(session.accountId)
      .query(
        "SELECT startedAt FROM active WHERE importId LIKE 'legacy:%'"
      ) as { startedAt: number }[]

    mocks.runModel.mockResolvedValue(MODEL_OUTPUT)
    vi.setSystemTime(startedAt + SYNC_SLOT_MAX_AGE_MS - 1)
    expect((await send()).status).toBe(429)
    vi.setSystemTime(startedAt + SYNC_SLOT_MAX_AGE_MS)
    expect((await send()).status).toBe(200)
    expect(slots(session.accountId)).toEqual([
      { importId: started.body.importId },
    ])
  })

  it('ends a model call at its deadline with model_error, freeing its slot before it could age out', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(START)
    const session = await devSession()
    const token = await iosToken(session)
    const send = () =>
      call('POST', '/notes-import', {
        headers: bearer(token),
        body: { notesText: 'Field service 1 hour', context: CONTEXT },
      })
    // A model that never answers and ignores its abort signal, in every
    // slot of the cap. (Not `vi.waitFor`, which advances fake timers.)
    const cap = getNotesImportConfig(h.env).activeImportCap
    let allStarted!: () => void
    const started = new Promise<void>((resolve) => (allStarted = resolve))
    mocks.runModel.mockImplementation(() => {
      if (mocks.runModel.mock.calls.length === cap) allStarted()
      return new Promise(() => undefined)
    })
    const settled: Reply[] = []
    const hung = Array.from({ length: cap }, () =>
      send().then((reply) => (settled.push(reply), reply))
    )
    await started
    expect(Date.now()).toBe(START)
    const signals = mocks.runModel.mock.calls.map(
      ([args]) => (args as { abortSignal: AbortSignal }).abortSignal
    )

    // Up to the deadline the calls run and hold the cap.
    await vi.advanceTimersByTimeAsync(SYNC_IMPORT_DEADLINE_MS - 1)
    expect(settled).toEqual([])
    expect(slots(session.accountId)).toHaveLength(cap)
    for (const signal of signals) expect(signal.aborted).toBe(false)
    expect((await send()).status).toBe(429)

    await vi.advanceTimersByTimeAsync(1)
    for (const reply of await Promise.all(hung)) {
      expect(reply.status).toBe(502)
      expect(reply.body).toMatchObject({
        error: 'The import model could not process these notes',
        code: 'model_error',
      })
    }
    // The upstream request is aborted, and each slot released by its own
    // request (an age-out would take SYNC_SLOT_MAX_AGE_MS and another
    // acquire).
    for (const signal of signals) {
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBeInstanceOf(ModelDeadlineError)
    }
    expect(Date.now() - START).toBeLessThan(SYNC_SLOT_MAX_AGE_MS)
    expect(slots(session.accountId)).toEqual([])
    // Charged nothing, like any other model error.
    expect(
      indexes.storage(session.accountId).query('SELECT hash FROM hash_record')
    ).toEqual([])
    await flush()
    const finished = mocks.capture.mock.calls
      .map(
        (args) =>
          (args as unknown[])[1] as {
            event: string
            properties: Record<string, unknown>
          }
      )
      .filter((event) => event.event === 'api_notes_import_finished')
    expect(finished.map((event) => event.properties.outcome)).toEqual(
      Array(cap).fill('model_error')
    )

    mocks.runModel.mockResolvedValue(MODEL_OUTPUT)
    expect((await send()).status).toBe(200)
  })
})

describe('NotesImportIndex synchronous slots', () => {
  it('ages out the content-keyed slots from before, too', async () => {
    const index = indexes.object('meter')
    // How the synchronous path keyed its slot before each request got its own.
    index.acquire(`legacy:imp_${'a'.repeat(40)}`, 2)
    expect(index.acquireSync(1)).toEqual({ ok: false, active: 1 })
    vi.setSystemTime(START + SYNC_SLOT_MAX_AGE_MS)
    const taken = index.acquireSync(1)
    expect(taken).toEqual({
      ok: true,
      active: 1,
      slot: expect.stringMatching(/^legacy:[0-9a-f-]{36}$/),
    })
    index.release((taken as { slot: string }).slot)
    expect(index.list()).toEqual([])
  })
})

describe('Supporter status through revenueCatAppUserId', () => {
  it('checks the named RevenueCat id at kickoff and again at settlement', async () => {
    fetchMock.mockImplementation(async () => Response.json(LIFETIME))
    const session = await devSession()
    const token = await iosToken(session)
    const started = await kickoff(token, { revenueCatAppUserId: RC_ID })
    expect(started.status).toBe(200)
    expect(started.body.credits).toMatchObject({ isSupporter: true, limit: null })
    expect(revenueCatIds()).toEqual([RC_ID])

    await runs.fireAlarm(started.body.importId)
    await flush()
    expect(revenueCatIds()).toEqual([RC_ID, RC_ID])
    const result = await run(started.body.importId, 'result', token)
    expect(result.body.payload.credits).toMatchObject({ isSupporter: true })
  })

  it('treats a missing id, or one RevenueCat doesn’t know, as free', async () => {
    const session = await devSession()
    const token = await iosToken(session)
    const started = await kickoff(token, { revenueCatAppUserId: RC_ID })
    expect(started.body.credits).toMatchObject({ isSupporter: false, limit: 3 })
    expect(revenueCatIds()).toEqual([RC_ID])
  })

  it('never asks RevenueCat about the account id', async () => {
    fetchMock.mockImplementation(async () => Response.json(LIFETIME))
    const session = await devSession()
    const started = await kickoff(await iosToken(session))
    expect(started.body.credits.isSupporter).toBe(false)
    expect(revenueCatIds()).toEqual([])
  })
})

describe('dev sessions', () => {
  it('get the dev bypass’s allowances on the dev worker, never Supporter status', async () => {
    fetchMock.mockImplementation(async () => Response.json(LIFETIME))
    const session = await devSession()
    const started = await kickoff(session.accessToken, {
      revenueCatAppUserId: RC_ID,
    })
    expect(started.body.credits).toMatchObject({
      isSupporter: false,
      limit: null,
      remaining: null,
    })
    expect(revenueCatIds()).toEqual([])
  })

  it('get ordinary allowances without the bypass token configured', async () => {
    const session = await devSession()
    delete (h.env as Partial<Environment>).NOTES_IMPORT_DEV_BYPASS_TOKEN
    const started = await kickoff(session.accessToken)
    expect(started.body.credits).toMatchObject({ limit: 3 })
  })

  it('ignore the bypass header on an iOS session', async () => {
    const session = await devSession()
    const started = await call('POST', '/notes-import/kickoff', {
      headers: { ...bearer(await iosToken(session)), ...legacyHeaders },
      body: { notesText: 'Field service 1 hour', context: CONTEXT },
    })
    expect(started.body.credits).toMatchObject({ limit: 3 })
  })
})

describe('run routes on a bearer import', () => {
  it('streams, reads, and deletes the account’s own import', async () => {
    const session = await devSession()
    const importId = await importNotes(session.accessToken)

    const events = await run(importId, 'events', session.accessToken)
    expect(events.status).toBe(200)
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    expect(events.text).toContain('event: done')

    const result = await run(importId, 'result', session.accessToken)
    expect(result.body.status).toBe('done')
    const cancelled = await run(importId, 'cancel', session.accessToken)
    expect(cancelled.body.status).toBe('done')

    const destroyed = await run(importId, 'destroy', session.accessToken)
    expect(destroyed.status).toBe(200)
    expect(destroyed.body).toEqual({ ok: true })
    const gone = await run(importId, 'result', session.accessToken)
    expect(gone.status).toBe(404)
  })

  it('can run the same notes again after deleting them', async () => {
    const session = await devSession()
    const importId = await importNotes(session.accessToken)
    await run(importId, 'destroy', session.accessToken)
    // The same Durable Object instance, its tables dropped by deleteAll().
    expect(await importNotes(session.accessToken)).toBe(importId)
    const result = await run(importId, 'result', session.accessToken)
    expect(result.body.status).toBe('done')
  })

  it('answers another account the same 404 as an unknown import', async () => {
    const owner = await devSession()
    const stranger = await devSession()
    const importId = await importNotes(owner.accessToken)
    const unknown = `imp_${'0'.repeat(40)}`

    for (const op of ['events', 'result', 'cancel', 'destroy']) {
      const foreign = await run(importId, op, stranger.accessToken)
      const missing = await run(unknown, op, stranger.accessToken)
      expect(foreign.status, op).toBe(404)
      expect(foreign.body, op).toEqual({
        ok: false,
        error: 'Import not found',
        code: 'not_found',
      })
      expect(missing.body, op).toEqual(foreign.body)
    }
    // The stranger's destroy touched nothing.
    const still = await run(importId, 'result', owner.accessToken)
    expect(still.body.status).toBe('done')
    // Asking about an unknown import stored nothing.
    expect(runs.storage(unknown).tables()).toEqual([])
  })

  it('refuses a malformed id without waking a run', async () => {
    const session = await devSession()
    const response = await run('not-an-import', 'result', session.accessToken)
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('not_found')
  })

  it('keeps legacy runs out of reach of bearer tokens, and the reverse', async () => {
    const session = await devSession()
    const legacy = await call('POST', '/notes-import/kickoff', {
      headers: legacyHeaders,
      body: legacyBody(),
    })
    const { importId, subscribeToken } = legacy.body
    expect((await run(importId, 'result', session.accessToken)).status).toBe(404)
    const viaToken = await call(
      'GET',
      `/notes-import/${importId}/result?token=${subscribeToken}`
    )
    expect(viaToken.status).toBe(200)

    // A bearer request never reads `?token=`.
    const mine = await importNotes(session.accessToken)
    const withToken = await call(
      'GET',
      `/notes-import/${mine}/result?token=${subscribeToken}`,
      { headers: bearer('forged.token.value') }
    )
    expect(withToken.status).toBe(401)
  })

  it('stores the owner as a hash, never the account id', async () => {
    const session = await devSession()
    const importId = await importNotes(session.accessToken)
    const meta = runs.storage(importId).query('SELECT k, v FROM meta')
    expect(meta).toContainEqual({
      k: 'owner',
      v: await importOwnerKey(session.accountId),
    })
    expect(JSON.stringify(meta)).not.toContain(session.accountId)
  })
})

describe('bearer transcribe', () => {
  it('reads a page metered by the account, with no hashes or attestation', async () => {
    mocks.transcribe.mockResolvedValue({
      text: 'Ana Silva | 12 Oak St',
      usage: { inputTokens: 900, outputTokens: 20 },
      finishReason: 'stop',
    })
    const session = await devSession()
    const response = await call('POST', '/notes-import/transcribe', {
      headers: bearer(await iosToken(session)),
      body: { image: JPEG, mimeType: 'image/jpeg' },
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      text: 'Ana Silva | 12 Oak St',
      truncated: false,
      pagesRemaining: 39,
    })
    expect(
      indexes.storage(session.accountId).query('SELECT ts FROM transcribed_page')
    ).toHaveLength(1)
  })

  it('uses the Supporter page limit for a named Supporter id', async () => {
    fetchMock.mockImplementation(async () => Response.json(LIFETIME))
    mocks.transcribe.mockResolvedValue({
      text: 'x',
      usage: {},
      finishReason: 'stop',
    })
    const session = await devSession()
    const response = await call('POST', '/notes-import/transcribe', {
      headers: bearer(await iosToken(session)),
      body: { image: JPEG, mimeType: 'image/jpeg', revenueCatAppUserId: RC_ID },
    })
    expect(response.body.pagesRemaining).toBe(199)
    expect(revenueCatIds()).toEqual([RC_ID])
  })

  it('needs only image and mimeType', async () => {
    const session = await devSession()
    const response = await call('POST', '/notes-import/transcribe', {
      headers: bearer(session.accessToken),
      body: { image: JPEG },
    })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Missing image or a supported mimeType')
  })
})

describe('admin usage reset', () => {
  it('resets an account’s window by its account id', async () => {
    ;(h.env as Environment & Record<string, unknown>).ADMIN_API_TOKEN =
      'admin-token'
    const session = await devSession()
    const token = await iosToken(session)
    await importNotes(token)
    // Kickoff's `credits` previews the balance after this import succeeds.
    expect((await kickoff(token, { notesText: 'More notes' })).body.credits)
      .toMatchObject({ remaining: 1 })

    const reset = await call('POST', '/admin/notes-import/reset', {
      headers: { 'x-ww-admin-token': 'admin-token' },
      body: { meterId: session.accountId },
    })
    expect(reset.status).toBe(200)
    expect((await kickoff(token, { notesText: 'Even more notes' })).body.credits)
      .toMatchObject({ remaining: 2 })
  })
})

describe('analytics', () => {
  it('identifies a bearer import by its hashed account id', async () => {
    const session = await devSession()
    await importNotes(await iosToken(session))
    const started = mocks.capture.mock.calls
      .map((args) => (args as unknown[])[1] as { event: string; distinctId: string; properties: Record<string, unknown> })
      .find((event) => event.event === 'api_notes_import_started')!
    expect(started.distinctId).toBe(await analyticsDistinctId(session.accountId))
    expect(started.distinctId).not.toContain(session.accountId)
    expect(started.properties).toMatchObject({
      platform: 'ios',
      has_account: true,
      transport: 'stream',
    })
  })

  it('reports a dev session as platform dev', async () => {
    const session = await devSession()
    await importNotes(session.accessToken)
    const events = mocks.capture.mock.calls.map(
      (args) => (args as unknown[])[1] as { properties: Record<string, unknown> }
    )
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) expect(event.properties.platform).toBe('dev')
  })
})

describe('legacy requests', () => {
  it('keep their contract while the legacy switch is on', async () => {
    const response = await call('POST', '/notes-import/kickoff', {
      headers: legacyHeaders,
      body: legacyBody(),
    })
    expect(response.status).toBe(200)
    expect(Object.keys(response.body)).toEqual([
      'importId',
      'subscribeToken',
      'refinement',
      'credits',
    ])
  })

  it('get 426 in Notes Import’s shape once the switch is off', async () => {
    const session = await devSession()
    const legacy = await call('POST', '/notes-import/kickoff', {
      headers: legacyHeaders,
      body: legacyBody(),
    })
    await h.kv.put('auth:legacy', 'off')

    const refused = [
      await call('POST', '/notes-import/kickoff', {
        headers: legacyHeaders,
        body: legacyBody({ notesText: 'Other notes' }),
      }),
      await call('POST', '/notes-import', {
        headers: legacyHeaders,
        body: legacyBody(),
      }),
      await call('POST', '/notes-import/transcribe', {
        headers: legacyHeaders,
        body: { uuid: legacyBody().uuid, image: JPEG, mimeType: 'image/jpeg' },
      }),
      await call(
        'GET',
        `/notes-import/${legacy.body.importId}/result?token=${legacy.body.subscribeToken}`
      ),
      await call(
        'GET',
        `/notes-import/${legacy.body.importId}/events?token=${legacy.body.subscribeToken}`
      ),
    ]
    for (const response of refused) {
      expect(response.status).toBe(426)
      expect(response.body).toEqual({
        ok: false,
        error: 'Update WitnessWork to keep using Notes Import',
        code: 'upgrade_required',
      })
      expect(response.headers.get('retry-after')).toBeNull()
    }
    expect(mocks.runModel).not.toHaveBeenCalled()

    // Bearer requests carry on, and status stays public.
    expect((await kickoff(session.accessToken)).status).toBe(200)
    expect((await call('GET', '/notes-import/status')).status).toBe(200)
  })
})

describe('GET /notes-import/status', () => {
  it('answers a bearer request with the same public body', async () => {
    const session = await devSession()
    const anonymous = await call('GET', '/notes-import/status')
    const withToken = await call('GET', '/notes-import/status', {
      headers: bearer(session.accessToken),
    })
    expect(withToken.status).toBe(200)
    expect(withToken.body).toEqual(anonymous.body)
    expect(JSON.stringify(withToken.body)).not.toContain('credits')
  })
})
