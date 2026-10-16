import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DAY_MS,
  Owner,
  SigningKey,
  Writer,
  b64u,
  blobOfSize,
  createHarness,
  envelope,
  inviteSecrets,
  liveHeaders,
  photoBlob,
  randomId,
  relayError,
  unsignedEnvelope,
  type ApiResponse,
  type Harness,
  type HarnessOptions,
  type PhotoBlob,
} from '../test/buddies'
import { bearer, openTestSession, type TestSession } from '../test/accounts'
import { inboxLinkMessage } from '../accounts/contracts'
import { createAccountsRoutes } from '../accounts/route'
import { createAccountsAdminRoutes } from '../accounts/admin'
import { resetAccountStatusCache } from '../accounts/auth'
import {
  BUDDIES_LIVE_ACCOUNT_HEADER,
  BUDDIES_OPS,
  type BuddiesSignedOp,
} from './contracts'

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

/**
 * The Buddies relay on account sessions (witness-work ADR 0027,
 * "Authentication (sessions)" in docs/buddies-protocol.md): bearer requests
 * for every op class, the legacy switch, and per-account limits. The legacy
 * (signed) behavior is covered by the other Buddies tests, which run with the
 * switch on.
 */

const START = Date.UTC(2026, 9, 16, 12)
const ADMIN_TOKEN = 'admin-secret-for-tests'
const IP = '203.0.113.7'
const encoder = new TextEncoder()
const accountsApp = createAccountsRoutes() as never
const adminApp = createAccountsAdminRoutes() as never

let h: Harness

const setUp = async (options: HarnessOptions = {}) => {
  h = await createHarness(options)
  h.env.ADMIN_API_TOKEN = ADMIN_TOKEN
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  resetAccountStatusCache()
  await setUp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const session = () => openTestSession(accountsApp, h.env)
const legacyOff = () => h.kv.put('auth:legacy', 'off')
const encodeFields = (fields: Record<string, unknown>) =>
  b64u(encoder.encode(JSON.stringify(fields)))

const setStatus = async (accountId: string, status: string) => {
  const response = await adminApp.request(
    '/status',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ww-admin-token': ADMIN_TOKEN,
      },
      body: JSON.stringify({ accountId, status, reason: 'report' }),
    },
    h.env
  )
  expect(response.status).toBe(200)
  resetAccountStatusCache()
}

/** One person on a session: an account key, its token, and an inbox. */
class BearerOwner {
  readonly inboxId = randomId()

  private constructor(
    readonly session: TestSession,
    readonly key: SigningKey
  ) {}

  /** Opens a session and (unless `register` is false) registers a linked inbox. */
  static async create(register = true): Promise<BearerOwner> {
    const owner = new BearerOwner(await session(), await SigningKey.generate())
    if (register) {
      const response = await owner.register()
      if (response.status !== 200)
        throw new Error(`register failed: ${response.status}`)
    }
    return owner
  }

  get auth(): Record<string, string> {
    return bearer(this.session.accessToken)
  }

  /** The `account` proof linking this inbox to `account` (this one's by default). */
  async proof(account: TestSession = this.session) {
    const message = inboxLinkMessage(
      account.accountId,
      this.inboxId,
      this.key.publicKey
    )
    return {
      accountId: account.accountId,
      signature: b64u(await account.key.sign(message)),
    }
  }

  /** A bearer `inbox/register`: the token plus the self-signed envelope. */
  async register(
    fields: Record<string, unknown> = {},
    headers = this.auth
  ): Promise<ApiResponse> {
    const payload = {
      inboxId: this.inboxId,
      ownerPub: this.key.publicKey,
      account: await this.proof(),
      ts: Date.now(),
      nonce: randomId(),
      ...fields,
    }
    return h.post(
      '/inbox/register',
      await envelope('inbox/register', payload, this.key),
      headers
    )
  }

  /** A bearer owner op: plain JSON fields with this inbox's id. */
  op(
    op: BuddiesSignedOp,
    fields: Record<string, unknown> = {},
    headers = this.auth
  ): Promise<ApiResponse> {
    return h.post(`/${op}`, { inboxId: this.inboxId, ...fields }, headers)
  }

  sync(headers = this.auth): Promise<ApiResponse> {
    return this.op('inbox/sync', { since: 0 }, headers)
  }

  /** A bearer `inbox/live` upgrade: the fields in `x-buddies-payload`. */
  connect(headers = this.auth, fields: Record<string, unknown> = {}) {
    return h.live({
      upgrade: 'websocket',
      'x-buddies-payload': encodeFields({ inboxId: this.inboxId, ...fields }),
      ...headers,
    })
  }

  /** A bearer `blob/put`: the fields in `x-buddies-payload`, the bytes raw. */
  async putBlob(
    blob: PhotoBlob,
    headers = this.auth,
    fields: Record<string, unknown> = {}
  ): Promise<ApiResponse> {
    const response = await h.request('/blob/put', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': IP,
        'content-type': 'application/octet-stream',
        'content-length': String(blob.bytes.byteLength),
        'x-buddies-payload': encodeFields({
          inboxId: this.inboxId,
          blobId: blob.blobId,
          bytes: blob.bytes.byteLength,
          expiresAt: Date.now() + 30 * DAY_MS,
          readTokenHash: blob.readTokenHash,
          ...fields,
        }),
        ...headers,
      },
      body: blob.bytes,
      ...({ duplex: 'half' } as object),
    })
    return { status: response.status, body: await response.json() }
  }

  /** Adds a slot for a buddy's writer key, by bearer request. */
  async addWriter(): Promise<Writer> {
    const key = await SigningKey.generate()
    const slotId = randomId()
    const response = await this.op('slot/add', {
      slotId,
      writerPub: key.publicKey,
    })
    expect(response.status).toBe(200)
    return new Writer(h, this.inboxId, slotId, key)
  }
}

/** A writer op: the writer-signed envelope, plus `headers` (a token). */
const writerSend = async (
  writer: Writer,
  op: BuddiesSignedOp,
  fields: Record<string, unknown>,
  headers: Record<string, string>,
  key = writer.key
) =>
  h.post(
    `/${op}`,
    await envelope(
      op,
      {
        inboxId: writer.inboxId,
        slotId: writer.slotId,
        ts: Date.now(),
        nonce: randomId(),
        ...fields,
      },
      key
    ),
    headers
  )

const getBlob = async (
  inboxId: string,
  blob: PhotoBlob,
  headers: Record<string, string>
) => {
  const response = await h.request('/blob/get', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': IP,
      ...headers,
    },
    body: JSON.stringify(
      unsignedEnvelope({ inboxId, blobId: blob.blobId, token: blob.token })
    ),
  })
  return response.status === 200
    ? { status: 200, bytes: new Uint8Array(await response.arrayBuffer()) }
    : { status: response.status, body: await response.json() }
}

const nonceRows = (inboxId: string) =>
  h.inboxes.storage(inboxId).query('SELECT COUNT(*) AS n FROM nonce')[0].n

describe('bearer owner ops', () => {
  it('registers with a proof for the token’s account, then runs every owner op as plain JSON', async () => {
    const owner = await BearerOwner.create(false)
    expect(await owner.register()).toEqual({
      status: 200,
      body: { ok: true, accountId: owner.session.accountId },
    })

    const synced = await owner.sync()
    expect(synced).toEqual({
      status: 200,
      body: {
        ok: true,
        seq: 0,
        slots: [],
        cards: [],
        events: [],
        roster: null,
        capabilities: { photos: true },
      },
    })

    const deviceId = randomId()
    expect(
      (
        await owner.op('device/register', {
          deviceId,
          apnsToken: 'ab'.repeat(32),
          apnsEnvironment: 'sandbox',
          templates: { 'plan.joined': { title: 'Plans', body: 'Joined' } },
        })
      ).body
    ).toEqual({ ok: true })
    expect(await owner.op('roster/put', { blob: blobOfSize(64) })).toEqual({
      status: 200,
      body: { ok: true, seq: 1 },
    })
    const slotId = randomId()
    const writer = await SigningKey.generate()
    expect(
      (await owner.op('slot/add', { slotId, writerPub: writer.publicKey }))
        .body
    ).toEqual({ ok: true })
    const invite = await inviteSecrets()
    expect(
      (
        await owner.op('invite/create', {
          inviteId: invite.inviteId,
          claimVerifier: invite.claimVerifier,
          blob: blobOfSize(100),
          expiresAt: Date.now() + DAY_MS,
        })
      ).status
    ).toBe(200)
    for (const [op, fields] of [
      ['invite/delete', { inviteId: invite.inviteId }],
      ['blob/delete', { blobIds: [b64u(new Uint8Array(32))] }],
      ['device/unregister', { deviceId }],
      ['slot/remove', { slotId }],
    ] as const) {
      expect(await owner.op(op, fields)).toEqual({
        status: 200,
        body: { ok: true },
      })
    }
    const after = await owner.sync()
    expect(after.body).toMatchObject({ seq: 1, slots: [] })

    expect((await owner.op('inbox/delete')).status).toBe(200)
    expect(await owner.sync()).toEqual({
      status: 404,
      body: relayError('not_found'),
    })
  })

  it('requires the proof on a bearer register, and for the token’s own account', async () => {
    const owner = await BearerOwner.create(false)
    const other = await session()
    const quotas = vi.spyOn(h.env.BUDDY_REGISTRATION_QUOTA, 'idFromName')

    expect(await owner.register({ account: undefined })).toEqual({
      status: 400,
      body: relayError('bad_request'),
    })
    expect(await owner.register({ account: await owner.proof(other) })).toEqual(
      { status: 403, body: relayError('forbidden') }
    )
    // Refused before the quota counts them.
    expect(quotas).not.toHaveBeenCalled()
    // The other account's own token with its own proof would be fine.
    expect(
      (
        await owner.register(
          { account: await owner.proof(other) },
          bearer(other.accessToken)
        )
      ).body
    ).toEqual({ ok: true, accountId: other.accountId })
  })

  it('refuses another account’s inbox with forbidden', async () => {
    const owner = await BearerOwner.create()
    const stranger = await session()
    const as = bearer(stranger.accessToken)

    expect(await owner.sync(as)).toEqual({
      status: 403,
      body: relayError('forbidden'),
    })
    expect(
      await owner.op('slot/add', { slotId: randomId(), writerPub: owner.key.publicKey }, as)
    ).toEqual({ status: 403, body: relayError('forbidden') })
    expect((await owner.op('inbox/delete', {}, as)).status).toBe(403)
    expect((await owner.op('slot/remove', { slotId: randomId() }, as)).status).toBe(403)
    expect((await owner.connect(as)).status).toBe(403)
    const blob = await photoBlob()
    await owner.addWriter()
    expect(await owner.putBlob(blob, as)).toEqual({
      status: 403,
      body: relayError('forbidden'),
    })
    // The owner is untouched.
    expect((await owner.sync()).status).toBe(200)
  })

  it('answers not_linked for an inbox registered before accounts, until it links', async () => {
    const legacy = await Owner.create(h)
    const owner = await BearerOwner.create(false)
    // Same inbox and owner key as the legacy registration.
    Object.assign(owner, { inboxId: legacy.inboxId, key: legacy.key })

    expect(await owner.sync()).toEqual({
      status: 409,
      body: relayError('not_linked'),
    })
    expect((await owner.connect()).status).toBe(409)
    expect(await owner.register()).toEqual({
      status: 200,
      body: { ok: true, accountId: owner.session.accountId },
    })
    expect((await owner.sync()).status).toBe(200)
    // The legacy envelope keeps working while the switch is on.
    expect((await legacy.sync()).status).toBe(200)
  })

  it('answers not_found for an unknown inbox', async () => {
    const owner = await BearerOwner.create(false)
    expect(await owner.sync()).toEqual({
      status: 404,
      body: relayError('not_found'),
    })
  })

  it('refuses a bad token without trying the envelope', async () => {
    const owner = await Owner.create(h)
    const signed = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 0, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    for (const token of ['expired.or.forged', '']) {
      const response = await h.request('/inbox/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': IP },
        body: JSON.stringify(signed),
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer error="invalid_token"'
      )
      expect(await response.json()).toEqual(relayError('unauthorized'))
    }
  })

  it('refuses an envelope as a bearer owner body', async () => {
    const owner = await BearerOwner.create()
    const signed = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 0, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    expect(await h.post('/inbox/sync', signed, owner.auth)).toEqual({
      status: 400,
      body: relayError('bad_request'),
    })
    expect(
      await h.post('/inbox/sync', { ...signed, inboxId: owner.inboxId, since: 0 }, owner.auth)
    ).toEqual({ status: 400, body: relayError('bad_request') })
    expect(await h.post('/inbox/sync', '{not json', owner.auth)).toEqual({
      status: 400,
      body: relayError('bad_request'),
    })
  })

  it('takes no ts or nonce: repeats are no replay, and no nonce is stored', async () => {
    const owner = await BearerOwner.create()
    const before = nonceRows(owner.inboxId)
    const blob = blobOfSize(64)
    const fields = { blob, ts: Date.now() - DAY_MS, nonce: randomId() }
    expect(await owner.op('roster/put', fields)).toEqual({
      status: 200,
      body: { ok: true, seq: 1 },
    })
    expect(await owner.op('roster/put', fields)).toEqual({
      status: 200,
      body: { ok: true, seq: 2 },
    })
    expect(nonceRows(owner.inboxId)).toBe(before)
  })

  it('refuses a suspended account’s owner ops, but lets it leave', async () => {
    const owner = await BearerOwner.create()
    const slotId = randomId()
    expect(
      (await owner.op('slot/add', { slotId, writerPub: owner.key.publicKey }))
        .status
    ).toBe(200)
    await setStatus(owner.session.accountId, 'suspended')

    expect(await owner.sync()).toEqual({
      status: 403,
      body: relayError('suspended'),
    })
    expect((await owner.connect()).status).toBe(403)
    expect((await owner.op('slot/remove', { slotId })).status).toBe(200)
    expect((await owner.op('inbox/delete')).status).toBe(200)
  })

  it('keeps the kill switch: only leaving works while Buddies is off', async () => {
    const owner = await BearerOwner.create()
    await h.kv.put('buddies:enabled', 'false')
    expect(await owner.sync()).toEqual({
      status: 503,
      body: relayError('disabled'),
    })
    expect((await owner.connect()).status).toBe(503)
    expect((await owner.op('slot/remove', { slotId: randomId() })).status).toBe(
      200
    )
    expect((await owner.op('inbox/delete')).status).toBe(200)
  })

  it('answers disabled on a worker without sessions', async () => {
    const owner = await BearerOwner.create()
    delete h.env.ACCOUNT_TOKEN_SECRET
    expect(await owner.sync()).toEqual({
      status: 503,
      body: relayError('disabled'),
    })
  })
})

describe('bearer writer and capability ops', () => {
  it('takes the token plus the writer envelope, never comparing the token’s account', async () => {
    const owner = await BearerOwner.create()
    const buddy = await session()
    const writer = await owner.addWriter()

    const put = await writerSend(
      writer,
      'event/put',
      { eventId: randomId(), kind: 'plan.joined', blob: blobOfSize(48), push: false },
      bearer(buddy.accessToken)
    )
    expect(put).toEqual({ status: 200, body: { ok: true, seq: 1 } })
    // Any valid session works: the writer signature is the capability.
    expect(
      (await writerSend(writer, 'card/put', { blob: blobOfSize(64) }, owner.auth))
        .body
    ).toEqual({ ok: true, seq: 2 })
    const stranger = await SigningKey.generate()
    expect(
      await writerSend(
        writer,
        'card/put',
        { blob: blobOfSize(64) },
        bearer(buddy.accessToken),
        stranger
      )
    ).toEqual({ status: 401, body: relayError('bad_signature') })
    expect(
      await writerSend(writer, 'card/put', { blob: blobOfSize(64) }, bearer('forged'))
    ).toEqual({ status: 401, body: relayError('unauthorized') })

    const synced = await owner.sync()
    expect(synced.body.events).toHaveLength(1)
    expect(synced.body.cards).toHaveLength(1)
    // The inbox knows only its owner's account, never a writer's.
    const accounts = h.inboxes
      .storage(owner.inboxId)
      .query('SELECT account_id AS accountId FROM owner_account')
    expect(accounts).toEqual([{ accountId: owner.session.accountId }])

    expect(
      (await writerSend(writer, 'slot/leave', {}, bearer(buddy.accessToken)))
        .body
    ).toEqual({ ok: true })
    expect((await owner.sync()).body.slots).toEqual([])
  })

  it('fetches and claims invites with the token and today’s body', async () => {
    const owner = await BearerOwner.create()
    const buddy = await session()
    const as = bearer(buddy.accessToken)
    const invite = await inviteSecrets()
    await owner.op('invite/create', {
      inviteId: invite.inviteId,
      claimVerifier: invite.claimVerifier,
      blob: blobOfSize(100),
      expiresAt: Date.now() + DAY_MS,
    })

    const fetched = await h.post(
      '/invite/fetch',
      unsignedEnvelope({ inviteId: invite.inviteId }),
      as
    )
    expect(fetched.body).toMatchObject({ ok: true, status: 'open' })
    const claimed = await h.post(
      '/invite/claim',
      unsignedEnvelope({
        inviteId: invite.inviteId,
        claimSecret: invite.claimSecret,
        blob: blobOfSize(80),
      }),
      as
    )
    expect(claimed).toEqual({ status: 200, body: { ok: true } })
    expect((await owner.sync()).body.events).toMatchObject([
      { kind: 'invite.claimed', eventId: invite.inviteId },
    ])
  })

  it('puts photo blobs by token and reads them with the read token', async () => {
    const owner = await BearerOwner.create()
    const blob = await photoBlob()
    expect(await owner.putBlob(blob)).toEqual({
      status: 403,
      body: relayError('no_buddies'),
    })
    await owner.addWriter()
    const put = await owner.putBlob(blob)
    expect(put).toEqual({
      status: 200,
      body: { ok: true, expiresAt: expect.any(Number) },
    })
    // A repeat is idempotent, not a replay.
    expect((await owner.putBlob(blob)).status).toBe(200)

    const buddy = await session()
    const read = await getBlob(owner.inboxId, blob, bearer(buddy.accessToken))
    expect(read).toEqual({ status: 200, bytes: blob.bytes })
    expect(
      await getBlob(owner.inboxId, { ...blob, token: b64u(new Uint8Array(32)) }, bearer(buddy.accessToken))
    ).toMatchObject({ status: 404, body: relayError('not_found') })

    expect(
      (await owner.op('blob/delete', { blobIds: [blob.blobId] })).status
    ).toBe(200)
    expect((await getBlob(owner.inboxId, blob, owner.auth)).status).toBe(404)
  })

  it('refuses a signature header, a short payload header, and a wrong body on a bearer blob/put', async () => {
    const owner = await BearerOwner.create()
    await owner.addWriter()
    const blob = await photoBlob()
    expect(
      await owner.putBlob(blob, { ...owner.auth, 'x-buddies-signature': 'x' })
    ).toEqual({ status: 400, body: relayError('bad_request') })
    expect(
      await owner.putBlob(blob, { ...owner.auth, 'x-buddies-s': 'x' })
    ).toEqual({ status: 400, body: relayError('bad_request') })
    expect(
      await owner.putBlob(blob, {
        ...owner.auth,
        'x-buddies-payload': '',
        'x-buddies-p': encodeFields({ inboxId: owner.inboxId }),
      })
    ).toEqual({ status: 400, body: relayError('bad_request') })
    const other = await photoBlob()
    expect(
      await owner.putBlob(blob, owner.auth, { blobId: other.blobId })
    ).toEqual({ status: 400, body: relayError('bad_request') })
  })
})

describe('bearer live socket', () => {
  it('says hello, signals changes, and closes with 4003 on suspension', async () => {
    const owner = await BearerOwner.create()
    const live = await owner.connect()
    expect(live.status).toBe(101)
    expect(live.socket!.messages()).toEqual([{ type: 'hello', seq: 0 }])
    await owner.op('roster/put', { blob: blobOfSize(32) })
    expect(live.socket!.messages()).toEqual([
      { type: 'hello', seq: 0 },
      { type: 'changed', seq: 1 },
    ])
    await setStatus(owner.session.accountId, 'suspended')
    expect(live.socket!.closedBy).toEqual({ code: 4003, reason: 'suspended' })
  })

  it('refuses a signature header, and ignores an account header from the client', async () => {
    const owner = await BearerOwner.create()
    expect(
      (await owner.connect({ ...owner.auth, 'x-buddies-signature': 'x' }))
        .status
    ).toBe(400)

    // A legacy upgrade can't claim an account through the internal header.
    const legacy = await Owner.create(h)
    const forged = await liveHeaders(
      { inboxId: owner.inboxId, ts: Date.now(), nonce: randomId() },
      legacy.key
    )
    const refused = await h.live({
      ...forged,
      [BUDDIES_LIVE_ACCOUNT_HEADER]: owner.session.accountId,
    })
    expect(refused).toMatchObject({
      status: 401,
      body: relayError('bad_signature'),
    })
    const unsigned = await h.live({
      upgrade: 'websocket',
      'x-buddies-payload': encodeFields({ inboxId: owner.inboxId }),
      [BUDDIES_LIVE_ACCOUNT_HEADER]: owner.session.accountId,
    })
    expect(unsigned.status).toBe(400)
    expect(unsigned.socket).toBeNull()
  })

  it('takes the bearer upgrade only as a WebSocket', async () => {
    const owner = await BearerOwner.create()
    const response = await h.live(
      {
        'x-buddies-payload': encodeFields({ inboxId: owner.inboxId }),
        ...owner.auth,
      },
      'GET'
    )
    expect(response).toMatchObject({
      status: 426,
      body: relayError('upgrade_required'),
    })
  })
})

describe('the legacy switch', () => {
  it('off: every legacy request is 426, leaving included, while bearer requests work', async () => {
    const owner = await BearerOwner.create()
    const legacy = await Owner.create(h)
    const writer = await owner.addWriter()
    await legacyOff()

    for (const op of BUDDIES_OPS) {
      const response = await h.request(`/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP },
        body: '{}',
      })
      expect(response.status, op).toBe(426)
      expect(response.headers.get('retry-after'), op).toBeNull()
      expect(await response.json()).toEqual(relayError('upgrade_required'))
    }
    expect((await legacy.sync()).status).toBe(426)
    expect((await legacy.send('inbox/delete')).status).toBe(426)
    expect((await legacy.connect()).status).toBe(426)
    expect((await legacy.putBlob(await photoBlob())).status).toBe(426)
    expect((await legacy.getBlob(await photoBlob())).status).toBe(426)
    expect((await writer.putCard()).status).toBe(426)

    expect((await owner.sync()).status).toBe(200)
    expect((await owner.connect()).status).toBe(101)
    expect(
      (await writerSend(writer, 'card/put', { blob: blobOfSize(64) }, owner.auth))
        .status
    ).toBe(200)
    expect((await owner.op('inbox/delete')).status).toBe(200)
  })

  it('off: a legacy register is 426, a bearer one works', async () => {
    await legacyOff()
    const legacy = await Owner.create(h, false)
    expect(
      (await legacy.send('inbox/register', { ownerPub: legacy.key.publicKey }))
        .status
    ).toBe(426)
    expect((await BearerOwner.create(false).then((o) => o.register())).status).toBe(
      200
    )
  })
})

describe('per-account limits', () => {
  it('keys bearer requests on a hash of the account, not the client IP', async () => {
    await setUp({ unsignedLimit: 2 })
    const first = await session()
    const second = await session()
    const fetch = (headers: Record<string, string>, ip = IP) =>
      h.post('/invite/fetch', unsignedEnvelope({ inviteId: randomId() }), {
        'cf-connecting-ip': ip,
        ...headers,
      })

    expect((await fetch(bearer(first.accessToken))).status).toBe(404)
    expect((await fetch(bearer(first.accessToken), '198.51.100.9')).status).toBe(
      404
    )
    // The account's budget is spent, from any address.
    expect(await fetch(bearer(first.accessToken))).toEqual({
      status: 429,
      body: relayError('rate_limited'),
    })
    // Another account behind the same address has its own.
    expect((await fetch(bearer(second.accessToken))).status).toBe(404)
    // So does a legacy request from that address.
    expect((await fetch({})).status).toBe(404)

    const accountKeys = h.rateLimitKeys.filter((key) => key.startsWith('account:'))
    expect(new Set(accountKeys).size).toBe(2)
    for (const key of h.rateLimitKeys) {
      expect(key).not.toContain(first.accountId)
      expect(key).not.toContain(second.accountId)
    }
  })

  it('counts bearer registrations against the account’s daily quota', async () => {
    const owner = await BearerOwner.create(false)
    const names = vi.spyOn(h.env.BUDDY_REGISTRATION_QUOTA, 'idFromName')
    expect(
      (await owner.register({}, { ...owner.auth, 'cf-connecting-ip': '198.51.100.1' }))
        .status
    ).toBe(200)
    expect(
      (await owner.register({}, { ...owner.auth, 'cf-connecting-ip': '198.51.100.2' }))
        .status
    ).toBe(200)
    await Owner.create(h)
    const [bearerA, bearerB, legacy] = names.mock.calls.map(([name]) => name)
    expect(bearerA).toBe(bearerB)
    expect(legacy).not.toBe(bearerA)
    expect(bearerA).not.toContain(owner.session.accountId)
  })
})
