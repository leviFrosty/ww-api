import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  randomBytes,
  randomId,
  sha256B64u,
  TEST_WEB_ORIGIN,
  type Harness,
} from '../test/buddies'
import {
  accountEnvelope,
  bearer,
  openTestSession,
  postJson,
  requestJson,
  type TestSession,
} from '../test/accounts'
import type { FakeWebSocket } from '../test/durableObjects'
import { RevenueCatError } from '../revenuecat'
import { createAccountsRoutes } from './route'
import { resetSyncEntitlementCache } from './sync'
import { SYNC_LIMITS } from './syncContracts'
import { syncEntitlement } from './syncSwitch'
import { AccountSync } from './syncDO'
import { accountSupporterStatus } from './supporter'

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

vi.mock('./supporter', async (original) => ({
  ...(await original<typeof import('./supporter')>()),
  accountSupporterStatus: vi.fn(),
}))

/**
 * Cloud Sync (witness-work ADR 0030): per-device encrypted slots in R2, an
 * `AccountSync` index per account, a live socket, switches, and retention.
 */

const START = Date.UTC(2026, 9, 19, 12)
const SECOND = 1_000
const DAY = 24 * 60 * 60 * SECOND
const MIB = 1_024 * 1_024
const app = createAccountsRoutes()
const supporterStatus = vi.mocked(accountSupporterStatus)

let h: Harness

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  h = await createHarness()
  resetSyncEntitlementCache()
  supporterStatus.mockReset()
  supporterStatus.mockResolvedValue({
    supporter: true,
    expiresAt: null,
    customers: 1,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)
const session = () => openTestSession(app as never, h.env)
const slot = () => randomId().slice(0, 16)

const request = (path: string, init: RequestInit) =>
  (app as { request: typeof fetch }).request(
    path,
    { duplex: 'half', ...init } as RequestInit,
    h.env as never
  )

const put = async (
  s: TestSession,
  slotId: string,
  bytes: Uint8Array = randomBytes(1_000),
  headers: Record<string, string> = {}
) => {
  const response = await request('/sync/put', {
    method: 'POST',
    headers: {
      ...bearer(s.accessToken),
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-ww-slot-id': slotId,
      'x-ww-sha256': await sha256B64u(bytes),
      ...headers,
    },
    body: bytes,
  })
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  }
}

const list = (s: TestSession) =>
  postJson(app as never, h.env, '/sync/list', {}, bearer(s.accessToken))

const del = (s: TestSession, body: Record<string, unknown> = {}) =>
  postJson(app as never, h.env, '/sync/delete', body, bearer(s.accessToken))

const get = async (s: TestSession, slotId: string) => {
  const response = await request('/sync/get', {
    method: 'POST',
    headers: { ...bearer(s.accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({ slotId }),
  })
  return {
    status: response.status,
    headers: response.headers,
    bytes:
      response.status === 200
        ? new Uint8Array(await response.arrayBuffer())
        : null,
    body: response.status === 200 ? null : await response.json(),
  }
}

const live = async (
  s: TestSession,
  slotId: string,
  headers: Record<string, string> = {}
) => {
  const response = (await request('/sync/live', {
    method: 'GET',
    headers: {
      ...bearer(s.accessToken),
      upgrade: 'websocket',
      'x-ww-slot-id': slotId,
      ...headers,
    },
  })) as Response & { webSocket?: FakeWebSocket | null }
  return {
    status: response.status,
    socket: response.status === 101 ? response.webSocket! : null,
  }
}

const code = (body: unknown) => (body as { code?: string }).code

describe('put, list, get, delete', () => {
  it('stores ciphertext per slot and lists ETags with the account seq', async () => {
    const s = await session()
    const phone = slot()
    const bytes = randomBytes(5_000)
    const etag = await sha256B64u(bytes)

    const stored = await put(s, phone, bytes)
    expect(stored.status).toBe(200)
    expect(stored.body).toEqual({
      ok: true,
      etag,
      size: 5_000,
      updatedAt: START,
      seq: 1,
    })
    expect(stored.headers.get('etag')).toBe(`"${etag}"`)
    expect(h.syncBlobs.objects.get(`v1/${s.accountId}/${phone}`)?.bytes).toEqual(
      bytes
    )

    expect((await list(s)).body).toEqual({
      ok: true,
      seq: 1,
      slots: [
        { slotId: phone, etag, size: 5_000, updatedAt: START, platform: 'dev', live: true },
      ],
    })

    const got = await get(s, phone)
    expect(got.status).toBe(200)
    expect(got.bytes).toEqual(bytes)
    expect(got.headers.get('etag')).toBe(`"${etag}"`)
    expect(got.headers.get('x-ww-updated-at')).toBe(String(START))
    expect(got.headers.get('cache-control')).toBe('no-store')

    expect((await get(s, slot())).status).toBe(404)

    expect((await del(s, { slotId: phone })).body).toEqual({ ok: true, seq: 2 })
    expect(h.syncBlobs.objects.size).toBe(0)
    expect((await list(s)).body).toEqual({ ok: true, seq: 2, slots: [] })
    // Idempotent.
    expect((await del(s, { slotId: phone })).body).toEqual({ ok: true, seq: 2 })
  })

  it('keeps accounts apart', async () => {
    const a = await session()
    const b = await session()
    const shared = slot()
    await put(a, shared)
    expect((await list(b)).body).toEqual({ ok: true, seq: 0, slots: [] })
    expect((await get(b, shared)).status).toBe(404)
    await del(b, { slotId: shared })
    expect((await list(a)).body).toMatchObject({ slots: [{ slotId: shared }] })
  })

  it('deletes every slot, and leftovers in R2, without slotId', async () => {
    const s = await session()
    await put(s, slot())
    await put(s, slot())
    h.syncBlobs.objects.set(`v1/${s.accountId}/orphaned-slot`, {
      bytes: randomBytes(4),
      uploaded: Date.now(),
    })
    expect((await del(s)).body).toEqual({ ok: true, seq: 3 })
    expect(h.syncBlobs.objects.size).toBe(0)
  })

  it('needs a live session to delete every slot, not one', async () => {
    const s = await session()
    const mine = slot()
    await put(s, mine)
    await requestJson(app as never, h.env, 'DELETE', '/sessions/current', undefined, bearer(s.accessToken))
    expect((await del(s)).status).toBe(401)
    expect((await del(s, { slotId: mine })).status).toBe(200)
  })

  it('refuses malformed requests', async () => {
    const s = await session()
    const bytes = randomBytes(100)
    expect((await put(s, 'short')).status).toBe(400)
    expect(
      (await put(s, slot(), bytes, { 'x-ww-sha256': await sha256B64u(randomBytes(100)) }))
        .body
    ).toMatchObject({ code: 'bad_request' })
    expect((await put(s, slot(), bytes, { 'if-match': 'nope' })).status).toBe(400)
    expect((await get(s, 'bad slot id!')).status).toBe(400)
    expect((await del(s, { slotId: 7 })).status).toBe(400)
    expect(h.syncBlobs.objects.size).toBe(0)
  })

  it('refuses a request without a token', async () => {
    const response = await postJson(app as never, h.env, '/sync/list', {})
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })
})

describe('If-Match', () => {
  it('puts only while the slot holds that ETag, or exists for *', async () => {
    const s = await session()
    const phone = slot()
    expect((await put(s, phone, randomBytes(10), { 'if-match': '*' })).body).toMatchObject({
      code: 'precondition_failed',
    })
    const first = await put(s, phone)
    advance(2 * SECOND)
    const stale = `"${await sha256B64u(randomBytes(10))}"`
    const refused = await put(s, phone, randomBytes(10), { 'if-match': stale })
    expect(refused.status).toBe(412)
    expect(
      (await put(s, phone, randomBytes(10), { 'if-match': `"${first.body.etag}"` }))
        .status
    ).toBe(200)
    advance(2 * SECOND)
    expect((await put(s, phone, randomBytes(10), { 'if-match': '*' })).status).toBe(200)
  })
})

describe('limits', () => {
  it('refuses a declared size over 20 MiB before reading the body', async () => {
    const s = await session()
    const response = await request('/sync/put', {
      method: 'POST',
      headers: {
        ...bearer(s.accessToken),
        'content-length': String(SYNC_LIMITS.blobBytes + 1),
        'x-ww-slot-id': slot(),
        'x-ww-sha256': await sha256B64u(randomBytes(1)),
      },
      body: randomBytes(1),
    })
    expect(response.status).toBe(413)
    expect(code(await response.json())).toBe('too_large')
  })

  it('caps new slots at 20 an account', async () => {
    const s = await session()
    for (let i = 0; i < SYNC_LIMITS.slots; i++)
      expect((await put(s, slot(), randomBytes(8))).status).toBe(200)
    const over = await put(s, slot(), randomBytes(8))
    expect(over.status).toBe(429)
    expect(over.body).toMatchObject({ code: 'limit' })
  })

  it('takes one put a slot every 2 seconds', async () => {
    const s = await session()
    const phone = slot()
    await put(s, phone)
    advance(1_500)
    const early = await put(s, phone)
    expect(early.status).toBe(429)
    expect(early.body).toMatchObject({ code: 'rate_limited', retryAfter: 1 })
    expect(early.headers.get('retry-after')).toBe('1')
    // Another device isn't held up.
    expect((await put(s, slot())).status).toBe(200)
    advance(500)
    expect((await put(s, phone)).status).toBe(200)
  })

  it('holds a slot while a put is uploading, and frees it after a failed write', async () => {
    const s = await session()
    const index = h.syncIndexes.object(s.accountId)
    const phone = slot()
    const begun = await index.beginPut({
      accountId: s.accountId,
      slotId: phone,
      size: 10,
      ifMatch: null,
    })
    expect(begun.ok).toBe(true)
    expect((await put(s, phone)).body).toMatchObject({ code: 'rate_limited' })
    advance(SYNC_LIMITS.putReservationMs + 1)
    h.syncBlobs.failNext('put')
    expect((await put(s, phone)).status).toBe(500)
    expect((await put(s, phone)).status).toBe(200)
  })

  it('caps puts and bytes an account a rolling day', async () => {
    const s = await session()
    const index = h.syncIndexes.object(s.accountId)
    const args = { accountId: s.accountId, slotId: slot(), size: 1, ifMatch: null }
    for (let i = 0; i < SYNC_LIMITS.accountPutsPerDay; i++) {
      const begun = await index.beginPut(args)
      expect(begun.ok).toBe(true)
      if (begun.ok)
        await index.abortPut({ slotId: args.slotId, reservation: begun.value.reservation })
    }
    const over = await put(s, slot())
    expect(over.status).toBe(429)
    expect(over.body).toMatchObject({ code: 'rate_limited', retryAfter: 24 * 60 * 60 })
    advance(DAY + 1)
    // The token expired meanwhile; the same account signs in again.
    const again = await openTestSession(app as never, h.env, s.key)
    expect((await put(again, slot())).status).toBe(200)

    const other = await session()
    const big = h.syncIndexes.object(other.accountId)
    const half = { accountId: other.accountId, slotId: slot(), size: SYNC_LIMITS.accountBytesPerDay / 2, ifMatch: null }
    const first = await big.beginPut(half)
    if (first.ok) await big.abortPut({ slotId: half.slotId, reservation: first.value.reservation })
    expect((await big.beginPut(half)).ok).toBe(true)
    expect(await big.beginPut({ ...half, slotId: slot(), size: 1 })).toMatchObject({
      ok: false,
      error: 'rate_limited',
    })
  })
})

describe('switches and entitlement', () => {
  it('is free for everyone by default', async () => {
    const s = await session()
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 0 })
    expect((await put(s, slot())).status).toBe(200)
    expect(
      (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body
    ).toMatchObject({ entitled: true, entitlement: 'everyone', supporter: false })
  })

  it('resolves who gets it from KV, then the var, else everyone', async () => {
    const kv = (value?: string) => ({
      get: async () => value ?? null,
    })
    expect(await syncEntitlement({ NOTES_KV: kv() })).toBe('everyone')
    expect(await syncEntitlement({ NOTES_KV: kv(), SYNC_ENTITLEMENT: 'supporter' })).toBe('supporter')
    expect(await syncEntitlement({ NOTES_KV: kv('supporter'), SYNC_ENTITLEMENT: 'everyone' })).toBe('supporter')
    expect(await syncEntitlement({ NOTES_KV: kv('everyone'), SYNC_ENTITLEMENT: 'supporter' })).toBe('everyone')
    expect(await syncEntitlement({ NOTES_KV: kv(' supporter\n') })).toBe('supporter')
    expect(await syncEntitlement({ NOTES_KV: kv('Supporter') })).toBe('supporter')
    // Anything else is the default.
    expect(await syncEntitlement({ NOTES_KV: kv('nope') })).toBe('everyone')
    // An unreadable KV falls back to the var.
    const broken = { get: async () => { throw new Error('kv down') } }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await syncEntitlement({ NOTES_KV: broken, SYNC_ENTITLEMENT: 'supporter' })).toBe('supporter')
    expect(await syncEntitlement({ NOTES_KV: broken })).toBe('everyone')
  })

  it('is a Supporter benefit again with sync:entitlement supporter', async () => {
    const s = await session()
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 0 })
    await h.kv.put('sync:entitlement', 'supporter')
    const refused = await put(s, slot())
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ code: 'supporter_required' })
    for (const path of ['/sync/list', '/sync/get'])
      expect(
        (await postJson(app as never, h.env, path, { slotId: slot() }, bearer(s.accessToken))).status,
        path
      ).toBe(403)
    expect((await live(s, slot())).status).toBe(403)
    // Taking data off the server always works.
    expect((await del(s, { slotId: slot() })).status).toBe(200)
    expect(
      (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body
    ).toEqual({
      ok: true,
      enabled: true,
      entitled: false,
      entitlement: 'supporter',
      supporter: false,
      requestedAt: null,
    })
    supporterStatus.mockResolvedValue({ supporter: true, expiresAt: null, customers: 1 })
    resetSyncEntitlementCache()
    expect((await put(s, slot())).status).toBe(200)
  })

  it('caches the Supporter answer for a minute per account', async () => {
    await h.kv.put('sync:entitlement', 'supporter')
    const s = await session()
    await put(s, slot())
    await list(s)
    expect(supporterStatus).toHaveBeenCalledTimes(1)
    advance(60 * SECOND)
    await list(s)
    expect(supporterStatus).toHaveBeenCalledTimes(2)
  })

  it('says unavailable, not "not a Supporter", when RevenueCat is down', async () => {
    await h.kv.put('sync:entitlement', 'supporter')
    const s = await session()
    supporterStatus.mockRejectedValue(new RevenueCatError('RevenueCat 500'))
    const refused = await put(s, slot())
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ code: 'unavailable' })
    expect(refused.headers.get('retry-after')).toBe('30')
    expect(
      (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body
    ).toMatchObject({ supporter: false, supporterCheckFailed: true, entitled: false })
  })

  it('turns off with sync:enabled, except delete and the status', async () => {
    const s = await session()
    const phone = slot()
    await put(s, phone)
    await h.kv.put('sync:enabled', 'false')
    advance(2 * SECOND)
    const refused = await put(s, phone)
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ code: 'disabled' })
    expect(refused.headers.get('retry-after')).toBe('60')
    expect((await list(s)).status).toBe(503)
    expect((await live(s, phone)).status).toBe(503)
    expect(
      (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body
    ).toMatchObject({ enabled: false, entitled: false })
    expect((await del(s, { slotId: phone })).status).toBe(200)
    await h.kv.put('sync:enabled', 'on')
    expect((await list(s)).status).toBe(200)
  })

  it('is off without the bucket', async () => {
    h = await createHarness({ syncBucket: false })
    const s = await session()
    expect((await put(s, slot())).body).toMatchObject({ code: 'disabled' })
    expect((await del(s)).body).toMatchObject({ code: 'disabled' })
  })

  it('keeps a suspended account syncing', async () => {
    const s = await session()
    await h.accountsDb!.prepare("UPDATE accounts SET status = 'suspended'").run()
    expect((await put(s, slot())).status).toBe(200)
    expect((await list(s)).status).toBe(200)
  })
})

describe('live socket', () => {
  it('says hello with the seq, and changed to the account’s other slots', async () => {
    const s = await session()
    const phone = slot()
    const tablet = slot()
    await put(s, phone)

    const phoneLive = await live(s, phone)
    const tabletLive = await live(s, tablet)
    expect(phoneLive.status).toBe(101)
    expect(phoneLive.socket!.messages()).toEqual([{ type: 'hello', seq: 1 }])

    advance(2 * SECOND)
    await put(s, phone)
    expect(phoneLive.socket!.messages()).toEqual([{ type: 'hello', seq: 1 }])
    expect(tabletLive.socket!.messages()).toEqual([
      { type: 'hello', seq: 1 },
      { type: 'changed', seq: 2 },
    ])

    await del(s, { slotId: tablet })
    // Nothing was there: no change.
    await del(s, { slotId: phone })
    expect(phoneLive.socket!.messages().at(-1)).toEqual({ type: 'changed', seq: 3 })
    expect(tabletLive.socket!.messages().at(-1)).toEqual({ type: 'changed', seq: 3 })
  })

  it('answers ping with pong and ignores anything else', async () => {
    const s = await session()
    const { socket } = await live(s, slot())
    socket!.send('ping')
    socket!.send('hello?')
    expect(socket!.received.slice(1)).toEqual(['pong'])
  })

  it('closes the oldest past 20 sockets an account', async () => {
    const s = await session()
    const sockets: FakeWebSocket[] = []
    for (let i = 0; i <= SYNC_LIMITS.liveSockets; i++) {
      sockets.push((await live(s, slot())).socket!)
      advance(1)
    }
    expect(sockets[0].closedBy).toEqual({ code: 4000, reason: 'replaced' })
    expect(sockets.slice(1).every((socket) => socket.closedBy == null)).toBe(true)
  })

  it('needs an upgrade and a slot id, and never trusts a client’s account header', async () => {
    const s = await session()
    const other = await session()
    const plain = await request('/sync/live', {
      method: 'GET',
      headers: { ...bearer(s.accessToken), 'x-ww-slot-id': slot() },
    })
    expect(plain.status).toBe(426)
    expect((await live(s, 'x')).status).toBe(400)
    const spoofed = await live(s, slot(), { 'x-ww-sync-account': other.accountId })
    expect(spoofed.status).toBe(101)
    advance(2 * SECOND)
    await put(other, slot())
    expect(spoofed.socket!.messages()).toEqual([{ type: 'hello', seq: 0 }])
  })
})

describe('retention', () => {
  it('deletes a slot 30 days after its last put once its session ended', async () => {
    const s = await session()
    const kept = await session()
    const phone = slot()
    await put(s, phone)
    await put(kept, slot())
    expect(h.syncIndexes.storage(s.accountId).alarm()).toBe(START + DAY)

    await requestJson(app as never, h.env, 'DELETE', '/sessions/current', undefined, bearer(s.accessToken))
    advance(29 * DAY)
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(h.syncIndexes.storage(s.accountId).query('SELECT slot_id FROM slot')).toHaveLength(1)

    advance(2 * DAY)
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(h.syncIndexes.storage(s.accountId).query('SELECT slot_id FROM slot')).toEqual([])
    expect(h.syncBlobs.objects.has(`v1/${s.accountId}/${phone}`)).toBe(false)
    // Nothing left: no more alarms.
    expect(h.syncIndexes.storage(s.accountId).alarm()).toBeNull()

    // A live session's slot stays...
    await h.syncIndexes.fireAlarm(kept.accountId)
    expect(h.syncIndexes.storage(kept.accountId).query('SELECT slot_id FROM slot')).toHaveLength(1)
    // ...until 400 days without a put.
    advance(370 * DAY)
    await h.syncIndexes.fireAlarm(kept.accountId)
    expect(h.syncIndexes.storage(kept.accountId).query('SELECT slot_id FROM slot')).toEqual([])
  })

  it('sweeps objects no slot names', async () => {
    const s = await session()
    await put(s, slot())
    const orphan = `v1/${s.accountId}/never-committed`
    h.syncBlobs.objects.set(orphan, { bytes: randomBytes(4), uploaded: Date.now() })
    await h.syncIndexes.fireAlarm(s.accountId)
    // Too young: a put could still be committing it.
    expect(h.syncBlobs.objects.has(orphan)).toBe(true)
    advance(DAY)
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(h.syncBlobs.objects.has(orphan)).toBe(false)
    expect(h.syncBlobs.objects.size).toBe(1)
  })
})

describe('sync/list sessions', () => {
  it('says each slot’s writing platform and whether that session is live', async () => {
    const s = await session()
    const other = await openTestSession(app as never, h.env, s.key)
    const phone = slot()
    const tablet = slot()
    await put(s, phone)
    await put(other, tablet)
    await requestJson(app as never, h.env, 'DELETE', '/sessions/current', undefined, bearer(other.accessToken))
    expect((await list(s)).body.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slotId: phone, platform: 'dev', live: true }),
        expect.objectContaining({ slotId: tablet, platform: 'dev', live: false }),
      ])
    )
  })

  it('reads the platform of a slot put before it was kept, and says unknown once its session is gone', async () => {
    const s = await session()
    const other = await openTestSession(app as never, h.env, s.key)
    const phone = slot()
    const tablet = slot()
    await put(s, phone)
    await put(other, tablet)
    h.syncIndexes.storage(s.accountId).query('UPDATE slot SET platform = NULL')
    await h.accountsDb!.prepare('DELETE FROM account_sessions WHERE id = ?').bind(other.sessionId).run()
    expect((await list(s)).body.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slotId: phone, platform: 'dev', live: true }),
        expect.objectContaining({ slotId: tablet, platform: null, live: false }),
      ])
    )
  })

  it('adds the column to an index from before it', async () => {
    const s = await session()
    const phone = slot()
    await put(s, phone)
    const storage = h.syncIndexes.storage(s.accountId)
    storage.query('ALTER TABLE slot DROP COLUMN platform')
    h.syncIndexes.restart(s.accountId)
    expect((await list(s)).body.slots).toEqual([
      expect.objectContaining({ slotId: phone, platform: 'dev', live: true }),
    ])
    advance(2 * SECOND)
    expect((await put(s, phone)).status).toBe(200)
    expect(storage.query('SELECT platform FROM slot')).toEqual([{ platform: 'dev' }])
  })

  it('says live when the sessions can’t be read', async () => {
    const s = await session()
    const other = await openTestSession(app as never, h.env, s.key)
    await put(other, slot())
    await requestJson(app as never, h.env, 'DELETE', '/sessions/current', undefined, bearer(other.accessToken))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sessions = await import('./sessionStore')
    vi.spyOn(sessions, 'sessionStates').mockRejectedValueOnce(new Error('d1 down'))
    expect((await list(s)).body.slots).toEqual([
      expect.objectContaining({ platform: 'dev', live: true }),
    ])
    expect((await list(s)).body.slots).toEqual([
      expect.objectContaining({ platform: 'dev', live: false }),
    ])
  })
})

describe('the Cloud Sync request', () => {
  /** `{ requested: true }` with the account's envelope, unless the body says otherwise. */
  const ask = async (s: TestSession, body: Record<string, unknown> | unknown[], signer = s.key) =>
    postJson(
      app as never,
      h.env,
      '/sync/request',
      !Array.isArray(body) && body.requested === true && !('payload' in body)
        ? { ...body, ...(await accountEnvelope('sync/request', signer)) }
        : body,
      bearer(s.accessToken)
    )
  const status = async (s: TestSession) =>
    (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body

  it('sets, keeps its time when asked again, and is withdrawn', async () => {
    const s = await session()
    expect(await status(s)).toMatchObject({ requestedAt: null })
    expect((await ask(s, { requested: true })).body).toEqual({ ok: true, requestedAt: START })
    advance(10 * SECOND)
    expect((await ask(s, { requested: true })).body).toEqual({ ok: true, requestedAt: START })
    expect(await status(s)).toMatchObject({ requestedAt: START })
    // Any session of the account sees it; withdrawing is bearer only.
    const web = await openTestSession(app as never, h.env, s.key)
    expect(await status(web)).toMatchObject({ requestedAt: START })
    expect((await ask(web, { requested: false })).body).toEqual({ ok: true, requestedAt: null })
    expect((await ask(web, { requested: false })).body).toEqual({ ok: true, requestedAt: null })
    expect(await status(s)).toMatchObject({ requestedAt: null })
    // Asked again after that: a new time.
    advance(SECOND)
    expect((await ask(s, { requested: true })).body).toEqual({
      ok: true,
      requestedAt: START + 11 * SECOND,
    })
  })

  it('needs the token’s own account’s signature to set', async () => {
    const s = await session()
    const other = await session()
    const forged = await ask(s, { requested: true }, other.key)
    expect(forged.status).toBe(403)
    expect(forged.body).toMatchObject({ code: 'forbidden' })
    const bare = await ask(s, { requested: true, payload: undefined })
    expect(bare.body).toMatchObject({ code: 'bad_request' })
    const envelope = await accountEnvelope('sync/request', s.key)
    const tampered = await ask(s, { requested: true, ...envelope, signature: (await accountEnvelope('sync/request', s.key)).signature })
    expect(tampered.body).toMatchObject({ code: 'bad_signature' })
    const otherOp = await accountEnvelope('backup/delete', s.key)
    expect((await ask(s, { requested: true, ...otherOp })).body).toMatchObject({ code: 'bad_signature' })
    const stale = await accountEnvelope('sync/request', s.key)
    advance(10 * 60 * SECOND)
    const later = await openTestSession(app as never, h.env, s.key)
    expect((await ask(later, { requested: true, ...stale })).body).toMatchObject({ code: 'stale' })
    expect(await status(later)).toMatchObject({ requestedAt: null })
  })

  it('takes an envelope once, so a captured one can’t undo a withdrawal', async () => {
    const s = await session()
    const envelope = await accountEnvelope('sync/request', s.key)
    expect((await ask(s, { requested: true, ...envelope })).body).toEqual({ ok: true, requestedAt: START })
    expect((await ask(s, { requested: false })).body).toEqual({ ok: true, requestedAt: null })
    const replayed = await ask(s, { requested: true, ...envelope })
    expect(replayed.status).toBe(409)
    expect(replayed.body).toMatchObject({ code: 'replay' })
    expect(await status(s)).toMatchObject({ requestedAt: null })
    // Past its window it's stale, so forgetting the nonce then is safe.
    advance(10 * 60 * SECOND)
    const later = await openTestSession(app as never, h.env, s.key)
    expect((await ask(later, { requested: true, ...envelope })).body).toMatchObject({ code: 'stale' })
    expect((await ask(later, { requested: true })).status).toBe(200)
  })

  it('keeps accounts apart', async () => {
    const a = await session()
    const b = await session()
    await ask(a, { requested: true })
    expect(await status(b)).toMatchObject({ requestedAt: null })
    await ask(b, { requested: false })
    expect(await status(a)).toMatchObject({ requestedAt: START })
  })

  it('lapses 30 days after it was last asked for', async () => {
    let s = await session()
    await ask(s, { requested: true })
    advance(20 * DAY)
    s = await openTestSession(app as never, h.env, s.key)
    expect((await ask(s, { requested: true })).body).toEqual({ ok: true, requestedAt: START })
    advance(30 * DAY - 1)
    // The token expired meanwhile; the same account signs in again.
    s = await openTestSession(app as never, h.env, s.key)
    expect(await status(s)).toMatchObject({ requestedAt: START })
    advance(1)
    expect(await status(s)).toMatchObject({ requestedAt: null })
    // A lapsed request isn't "standing": asking again starts a new one.
    expect((await ask(s, { requested: true })).body).toEqual({
      ok: true,
      requestedAt: START + 50 * DAY,
    })
  })

  it('clears itself once every live phone session has written a slot since', async () => {
    const web = await session()
    const phone = await openTestSession(app as never, h.env, web.key)
    const tablet = await openTestSession(app as never, h.env, web.key)
    const gone = await openTestSession(app as never, h.env, web.key)
    // A slot written before the request doesn't count.
    await put(tablet, 'tablet-slot')
    advance(SECOND)
    await ask(web, { requested: true })
    advance(SECOND)
    await put(phone, 'phone-slot')
    // The web's own session is a phone session here too (dev); it writes a slot.
    await put(web, 'web-slot')
    expect(await status(web)).toMatchObject({ requestedAt: START + SECOND })
    // An ended session doesn't hold it up.
    await requestJson(app as never, h.env, 'DELETE', '/sessions/current', undefined, bearer(gone.accessToken))
    expect(await status(web)).toMatchObject({ requestedAt: START + SECOND })
    advance(2 * SECOND)
    await put(tablet, 'tablet-slot')
    expect(await status(web)).toMatchObject({ requestedAt: null })
  })

  it('keeps standing when the sessions can’t be read', async () => {
    const s = await session()
    await ask(s, { requested: true })
    advance(SECOND)
    await put(s, slot())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sessions = await import('./sessionStore')
    vi.spyOn(sessions, 'listLiveSessions').mockRejectedValueOnce(new Error('d1 down'))
    expect(await status(s)).toMatchObject({ requestedAt: START })
    expect(await status(s)).toMatchObject({ requestedAt: null })
  })

  it('needs Cloud Sync on and an entitled account to set, never to withdraw', async () => {
    const s = await session()
    await ask(s, { requested: true })
    await h.kv.put('sync:enabled', 'false')
    const off = await ask(s, { requested: true })
    expect(off.status).toBe(503)
    expect(off.body).toMatchObject({ code: 'disabled' })
    expect(off.headers.get('retry-after')).toBe('60')
    // The status still says what stands.
    expect(await status(s)).toMatchObject({ enabled: false, requestedAt: START })
    expect((await ask(s, { requested: false })).body).toEqual({ ok: true, requestedAt: null })

    await h.kv.put('sync:enabled', 'on')
    await h.kv.put('sync:entitlement', 'supporter')
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 0 })
    resetSyncEntitlementCache()
    const unentitled = await ask(s, { requested: true })
    expect(unentitled.status).toBe(403)
    expect(unentitled.body).toMatchObject({ code: 'supporter_required' })
    expect((await ask(s, { requested: false })).status).toBe(200)
    expect(await status(s)).toMatchObject({ requestedAt: null })
  })

  it('works on an account whose index predates it', async () => {
    const s = await session()
    await put(s, slot())
    h.syncIndexes.storage(s.accountId).query('DROP TABLE sync_request')
    h.syncIndexes.restart(s.accountId)
    expect(await status(s)).toMatchObject({ requestedAt: null })
    expect((await ask(s, { requested: true })).body).toEqual({ ok: true, requestedAt: START })
  })

  it('still answers the status when the request can’t be read', async () => {
    const s = await session()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(AccountSync.prototype, 'requestedAt').mockRejectedValueOnce(new Error('do down'))
    expect(await status(s)).toMatchObject({ ok: true, entitled: true, requestedAt: null })
  })

  it('refuses malformed bodies and requests without a token', async () => {
    const s = await session()
    for (const body of [{}, { requested: 'yes' }, { requested: 1 }, { requested: null }, []])
      expect((await ask(s, body)).body, JSON.stringify(body)).toMatchObject({ code: 'bad_request' })
    const anonymous = await postJson(app as never, h.env, '/sync/request', {
      requested: true,
      ...(await accountEnvelope('sync/request', s.key)),
    })
    expect(anonymous.status).toBe(401)
    expect(await status(s)).toMatchObject({ requestedAt: null })
  })

  it('counts in the read edge tier', async () => {
    const s = await session()
    vi.spyOn(h.env.BUDDIES_READ_LIMITER, 'limit').mockResolvedValueOnce({ success: false })
    const limited = await ask(s, { requested: true })
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ code: 'rate_limited' })
  })
})

describe('privacy', () => {
  it('never logs slot ids, account ids, or tokens', async () => {
    const logs: unknown[] = []
    for (const level of ['log', 'warn', 'error', 'info'] as const)
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args))
    const s = await session()
    const phone = slot()
    await put(s, phone)
    advance(1_000)
    await put(s, phone)
    await list(s)
    await get(s, phone)
    await del(s, { slotId: phone })
    await postJson(app as never, h.env, '/sync/request', { requested: true, ...(await accountEnvelope('sync/request', s.key)) }, bearer(s.accessToken))
    await postJson(app as never, h.env, '/sync/request', { requested: false }, bearer(s.accessToken))
    const text = JSON.stringify(logs)
    for (const secret of [phone, s.accountId, s.accessToken])
      expect(text).not.toContain(secret)
  })
})

/**
 * The browser's live socket (witness-work ADR 0038 §10): browsers can't set
 * headers on a WebSocket, so the token and slot ride in the
 * `Sec-WebSocket-Protocol` offer, next to `ww.v1`, from an allowed origin.
 */
describe('browser live socket', () => {
  const MINUTE = 60 * SECOND

  const offer = (s: TestSession, slotId: string) => [
    'ww.v1',
    `bearer.${s.accessToken}`,
    `slot.${slotId}`,
  ]

  const browserLive = async (
    protocols: string[] | string | null,
    headers: Record<string, string> = {}
  ) => {
    const response = (await request('/sync/live', {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        origin: TEST_WEB_ORIGIN,
        ...(protocols == null
          ? {}
          : {
              'sec-websocket-protocol': Array.isArray(protocols)
                ? protocols.join(', ')
                : protocols,
            }),
        ...headers,
      },
    })) as Response & { webSocket?: FakeWebSocket | null }
    const upgraded = response.status === 101
    return {
      status: response.status,
      protocol: response.headers.get('sec-websocket-protocol'),
      authenticate: response.headers.get('www-authenticate'),
      code: upgraded ? null : code(await response.json()),
      socket: upgraded ? response.webSocket! : null,
    }
  }

  /** The requests `AccountSync` got through `fetch`. */
  const forwarded = () => {
    const seen: Request[] = []
    const original = AccountSync.prototype.fetch
    vi.spyOn(AccountSync.prototype, 'fetch').mockImplementation(function (
      this: AccountSync,
      request: Request
    ) {
      seen.push(request)
      return original.call(this, request)
    })
    return seen
  }

  it('opens with ww.v1 echoed, says hello, and honors the slot', async () => {
    const s = await session()
    const phone = slot()
    const tablet = slot()
    const live = await browserLive(offer(s, phone))
    expect(live.status).toBe(101)
    expect(live.protocol).toBe('ww.v1')
    expect(live.socket!.messages()).toEqual([{ type: 'hello', seq: 0 }])

    await put(s, phone)
    // Its own slot's put doesn't echo back.
    expect(live.socket!.messages()).toEqual([{ type: 'hello', seq: 0 }])
    await put(s, tablet)
    expect(live.socket!.messages().at(-1)).toEqual({ type: 'changed', seq: 2 })
    live.socket!.send('ping')
    expect(live.socket!.received.at(-1)).toBe('pong')
  })

  it('takes the entries in any order, with or without spaces', async () => {
    const s = await session()
    const live = await browserLive(
      `slot.${slot()},bearer.${s.accessToken} ,  ww.v1`
    )
    expect(live.status).toBe(101)
    expect(live.protocol).toBe('ww.v1')
  })

  it('never forwards the token or the offer to the DO', async () => {
    const seen = forwarded()
    const s = await session()
    const phone = slot()
    expect((await browserLive(offer(s, phone))).status).toBe(101)
    expect(seen).toHaveLength(1)
    const headers = Object.fromEntries(seen[0].headers.entries())
    expect(headers['sec-websocket-protocol']).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(JSON.stringify(headers)).not.toContain(s.accessToken)
    expect(headers['x-ww-sync-account']).toBe(s.accountId)
    expect(headers['x-ww-slot-id']).toBe(phone)
    expect(headers['x-ww-sync-expires-at']).toBe(String(s.accessExpiresAt))
    expect(seen[0].url).not.toContain(phone)
  })

  it('needs ww.v1 in the offer', async () => {
    const s = await session()
    const live = await browserLive([`bearer.${s.accessToken}`, `slot.${slot()}`])
    expect(live).toMatchObject({ status: 400, code: 'bad_request', protocol: null })
  })

  it('refuses a bad, expired, or missing token like the header path', async () => {
    const s = await session()
    for (const token of ['nope', `${s.accessToken}x`]) {
      const live = await browserLive(['ww.v1', `bearer.${token}`, `slot.${slot()}`])
      expect(live).toMatchObject({ status: 401, code: 'unauthorized' })
      expect(live.authenticate).toContain('Bearer')
    }
    expect(await browserLive(['ww.v1', `slot.${slot()}`])).toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
    advance(16 * MINUTE)
    expect(await browserLive(offer(s, slot()))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('needs an allowed Origin, before the token or the DO', async () => {
    const seen = forwarded()
    const s = await session()
    for (const origin of ['https://evil.example', 'null', `${TEST_WEB_ORIGIN}/`]) {
      expect(
        await browserLive(offer(s, slot()), { origin })
      ).toMatchObject({ status: 403, code: 'forbidden' })
      // A bad token from a bad origin is still the origin's refusal.
      expect(
        await browserLive(['ww.v1', 'bearer.nope', `slot.${slot()}`], { origin })
      ).toMatchObject({ status: 403, code: 'forbidden' })
      // So is a malformed offer: a foreign page learns nothing of its shape.
      expect(
        await browserLive(['bearer.nope', 'bad entry'], { origin })
      ).toMatchObject({ status: 403, code: 'forbidden' })
    }
    const response = (await request('/sync/live', {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        'sec-websocket-protocol': offer(s, slot()).join(', '),
      },
    })) as Response
    expect(response.status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('refuses malformed offers with bad_request', async () => {
    const s = await session()
    const token = `bearer.${s.accessToken}`
    const phone = `slot.${slot()}`
    for (const protocols of [
      ['ww.v1', 'ww.v1', token, phone],
      ['ww.v1', token, token, phone],
      ['ww.v1', token, phone, `slot.${slot()}`],
      ['ww.v1', '', token, phone],
      ['ww.v1', token, phone, 'chat'],
      ['ww.v1', token, phone, 'ww.v2'],
      ['ww.v1', 'bearer.', phone],
      ['ww.v1', token, 'slot.'],
      ['ww.v1', token, 'slot.bad slot'],
      ['ww.v1', token, 'slot.a/b'],
      ['ww.v1', token, 'slot.x'],
      ['ww.v1', token, phone, `payload.${'A'.repeat(16)}`],
      ['ww.v1', token, phone, `x${'A'.repeat(5_000)}`],
      ['ww.v1', token],
    ]) {
      const live = await browserLive(protocols)
      expect(live, protocols.join(', ').slice(0, 80)).toMatchObject({
        status: 400,
        code: 'bad_request',
      })
    }
    expect(
      await browserLive(offer(s, slot()), { authorization: `Bearer ${s.accessToken}` })
    ).toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('runs the switch and entitlement checks the header path runs', async () => {
    const s = await session()
    await h.kv.put('sync:enabled', 'false')
    expect(await browserLive(offer(s, slot()))).toMatchObject({
      status: 503,
      code: 'disabled',
    })
    await h.kv.delete('sync:enabled')
    await h.kv.put('sync:entitlement', 'supporter')
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 1 })
    resetSyncEntitlementCache()
    expect(await browserLive(offer(s, slot()))).toMatchObject({
      status: 403,
      code: 'supporter_required',
    })
    const plain = await request('/sync/live', {
      method: 'GET',
      headers: {
        origin: TEST_WEB_ORIGIN,
        'sec-websocket-protocol': offer(s, slot()).join(', '),
      },
    })
    expect(plain.status).toBe(403)
  })

  it('needs an upgrade like the header path', async () => {
    const s = await session()
    const plain = await request('/sync/live', {
      method: 'GET',
      headers: {
        origin: TEST_WEB_ORIGIN,
        'sec-websocket-protocol': offer(s, slot()).join(', '),
      },
    })
    expect(plain.status).toBe(426)
  })

  it('leaves header-path sockets as they were: no subprotocol, no expiry', async () => {
    const seen = forwarded()
    const s = await session()
    const response = (await request('/sync/live', {
      method: 'GET',
      headers: {
        ...bearer(s.accessToken),
        upgrade: 'websocket',
        'x-ww-slot-id': slot(),
        // A client can't set the expiry the Worker hands the DO.
        'x-ww-sync-expires-at': String(Date.now() + MINUTE),
      },
    })) as Response & { webSocket?: FakeWebSocket | null }
    expect(response.status).toBe(101)
    expect(response.headers.get('sec-websocket-protocol')).toBeNull()
    expect(seen[0].headers.get('x-ww-sync-expires-at')).toBeNull()
    advance(20 * MINUTE)
    expect(h.syncIndexes.storage(s.accountId).alarm()).toBeNull()
    expect(response.webSocket!.closedBy).toBeNull()
  })

  it('closes with 4004 expired once the token expires; header sockets stay', async () => {
    const s = await session()
    const browser = await browserLive(offer(s, slot()))
    const native = await live(s, slot())
    const storage = h.syncIndexes.storage(s.accountId)
    expect(storage.alarm()).toBe(s.accessExpiresAt)

    advance(s.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(browser.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
    expect(native.socket!.closedBy).toBeNull()
    expect(storage.alarm()).toBeNull()
  })

  it('schedules the earliest expiry, and the next one after it', async () => {
    const first = await session()
    const firstSocket = await browserLive(offer(first, slot()))
    advance(5 * MINUTE)
    // A second session of the same account: refresh-style, a later token.
    const later = await openTestSession(app as never, h.env, first.key)
    expect(later.accountId).toBe(first.accountId)
    const laterSocket = await browserLive(offer(later, slot()))
    const storage = h.syncIndexes.storage(first.accountId)
    expect(storage.alarm()).toBe(first.accessExpiresAt)

    advance(first.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(first.accountId)
    expect(firstSocket.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
    expect(laterSocket.socket!.closedBy).toBeNull()
    expect(storage.alarm()).toBe(later.accessExpiresAt)

    advance(later.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(first.accountId)
    expect(laterSocket.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
  })

  it('keeps the daily retention alarm: an expiry runs no retention early', async () => {
    const s = await session()
    await put(s, slot())
    const storage = h.syncIndexes.storage(s.accountId)
    expect(storage.alarm()).toBe(START + DAY)
    const listed = vi.spyOn(h.syncBlobs, 'list')

    const browser = await browserLive(offer(s, slot()))
    expect(storage.alarm()).toBe(s.accessExpiresAt)
    advance(s.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(browser.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
    expect(listed).not.toHaveBeenCalled()
    // Back to retention, at the time it had.
    expect(storage.alarm()).toBe(START + DAY)

    advance(START + DAY - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(listed).toHaveBeenCalled()
    expect(storage.alarm()).toBe(START + 2 * DAY)
  })

  it('runs retention when it comes first, then closes at the expiry', async () => {
    const s = await session()
    await put(s, slot())
    const storage = h.syncIndexes.storage(s.accountId)
    advance(DAY - 5 * MINUTE)
    const later = await openTestSession(app as never, h.env, s.key)
    const browser = await browserLive(offer(later, slot()))
    // Retention (START + DAY) is sooner than the token's expiry.
    expect(storage.alarm()).toBe(START + DAY)
    const listed = vi.spyOn(h.syncBlobs, 'list')

    advance(5 * MINUTE)
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(listed).toHaveBeenCalledTimes(1)
    expect(browser.socket!.closedBy).toBeNull()
    expect(storage.alarm()).toBe(later.accessExpiresAt)

    advance(later.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(browser.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
    expect(listed).toHaveBeenCalledTimes(1)
    expect(storage.alarm()).toBe(START + 2 * DAY)
  })

  it('treats an alarm from before expiries as retention', async () => {
    const s = await session()
    await put(s, slot())
    const storage = h.syncIndexes.storage(s.accountId)
    // As an object from before this change: an alarm, no schedule row.
    storage.query('DROP TABLE IF EXISTS alarm_schedule')
    h.syncIndexes.restart(s.accountId)
    const listed = vi.spyOn(h.syncBlobs, 'list')
    const later = await openTestSession(app as never, h.env, s.key)
    const browser = await browserLive(offer(later, slot()))
    expect(storage.alarm()).toBe(later.accessExpiresAt)

    advance(later.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(browser.socket!.closedBy).toEqual({ code: 4004, reason: 'expired' })
    // The old alarm was retention's, kept for its time.
    expect(listed).not.toHaveBeenCalled()
    expect(storage.alarm()).toBe(START + DAY)
    advance(START + DAY - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    expect(listed).toHaveBeenCalled()
  })

  it('counts browser sockets in the 20-socket cap', async () => {
    const s = await session()
    const sockets: FakeWebSocket[] = []
    for (let i = 0; i < SYNC_LIMITS.liveSockets; i++) {
      sockets.push((await live(s, slot())).socket!)
      advance(1)
    }
    const browser = await browserLive(offer(s, slot()))
    expect(browser.status).toBe(101)
    expect(sockets[0].closedBy).toEqual({ code: 4000, reason: 'replaced' })
    advance(1)
    // The 19 native sockets older than it go first, then it.
    for (let i = 0; i < SYNC_LIMITS.liveSockets - 1; i++) {
      await live(s, slot())
      advance(1)
    }
    expect(browser.socket!.closedBy).toBeNull()
    await live(s, slot())
    expect(browser.socket!.closedBy).toEqual({ code: 4000, reason: 'replaced' })
  })

  it('never logs the token or the slot', async () => {
    const logs: unknown[] = []
    for (const level of ['log', 'warn', 'error', 'info'] as const)
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args))
    const s = await session()
    const phone = slot()
    await browserLive(offer(s, phone))
    await browserLive(offer(s, phone), { origin: 'https://evil.example' })
    advance(s.accessExpiresAt - Date.now())
    await h.syncIndexes.fireAlarm(s.accountId)
    const text = JSON.stringify(logs)
    for (const secret of [phone, s.accountId, s.accessToken])
      expect(text).not.toContain(secret)
  })
})
