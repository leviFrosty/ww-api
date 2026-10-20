import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  randomBytes,
  randomId,
  sha256B64u,
  type Harness,
} from '../test/buddies'
import {
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
      slots: [{ slotId: phone, etag, size: 5_000, updatedAt: START }],
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
  it('is a Supporter benefit by default', async () => {
    const s = await session()
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 0 })
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
    })
  })

  it('is free for everyone with sync:entitlement everyone', async () => {
    const s = await session()
    supporterStatus.mockResolvedValue({ supporter: false, expiresAt: null, customers: 0 })
    await h.kv.put('sync:entitlement', 'everyone')
    expect((await put(s, slot())).status).toBe(200)
    expect(
      (await requestJson(app as never, h.env, 'GET', '/sync', undefined, bearer(s.accessToken))).body
    ).toMatchObject({ entitled: true, entitlement: 'everyone', supporter: false })
  })

  it('caches the Supporter answer for a minute per account', async () => {
    const s = await session()
    await put(s, slot())
    await list(s)
    expect(supporterStatus).toHaveBeenCalledTimes(1)
    advance(60 * SECOND)
    await list(s)
    expect(supporterStatus).toHaveBeenCalledTimes(2)
  })

  it('says unavailable, not "not a Supporter", when RevenueCat is down', async () => {
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
    const text = JSON.stringify(logs)
    for (const secret of [phone, s.accountId, s.accessToken])
      expect(text).not.toContain(secret)
  })
})
