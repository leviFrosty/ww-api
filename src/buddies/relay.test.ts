import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DAY_MS,
  Owner,
  SigningKey,
  blobOfSize,
  createHarness,
  envelope,
  inviteSecrets,
  randomId,
  unsignedEnvelope,
  type Harness,
} from '../test/buddies'

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

const START = Date.UTC(2026, 8, 23, 12)
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

let h: Harness

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  h = await createHarness()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Creates an invite from `owner`; returns its secrets. */
const createInvite = async (
  owner: Owner,
  expiresAt = Date.now() + 7 * DAY_MS
) => {
  const secrets = await inviteSecrets()
  const response = await owner.send('invite/create', {
    inviteId: secrets.inviteId,
    claimVerifier: secrets.claimVerifier,
    blob: blobOfSize(200),
    expiresAt,
  })
  return { ...secrets, response }
}

const claim = (inviteId: string, claimSecret: string, blob = blobOfSize(180)) =>
  h.post('/invite/claim', unsignedEnvelope({ inviteId, claimSecret, blob }))

const fetchInvite = (inviteId: string) =>
  h.post('/invite/fetch', unsignedEnvelope({ inviteId }))

describe('signed envelopes', () => {
  it('registers idempotently for the same key and conflicts on a different one', async () => {
    const owner = await Owner.create(h)
    expect(
      (await owner.send('inbox/register', { ownerPub: owner.key.publicKey }))
        .body
    ).toEqual({
      ok: true,
    })

    const intruder = await SigningKey.generate()
    const response = await h.send('inbox/register', intruder, {
      inboxId: owner.inboxId,
      ownerPub: intruder.publicKey,
    })
    expect(response).toEqual({ status: 409, body: { error: 'conflict' } })
  })

  it('requires register to be signed by the key it registers', async () => {
    const claimed = await SigningKey.generate()
    const signer = await SigningKey.generate()
    const response = await h.send('inbox/register', signer, {
      inboxId: randomId(),
      ownerPub: claimed.publicKey,
    })
    expect(response).toEqual({ status: 401, body: { error: 'bad_signature' } })
  })

  it('rejects owner ops signed with the wrong key', async () => {
    const owner = await Owner.create(h)
    const stranger = await SigningKey.generate()
    const response = await h.send('inbox/sync', stranger, {
      inboxId: owner.inboxId,
      since: 0,
    })
    expect(response).toEqual({ status: 401, body: { error: 'bad_signature' } })
  })

  it('rejects tampered payload bytes and a missing signature', async () => {
    const owner = await Owner.create(h)
    const signed = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 0, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    const tampered = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 1, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    // Valid payload bytes from one request, signature from another.
    expect(await h.post('/inbox/sync', { p: tampered.p, s: signed.s })).toEqual(
      {
        status: 401,
        body: { error: 'bad_signature' },
      }
    )
    expect(await h.post('/inbox/sync', { p: signed.p })).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    expect((await h.post('/inbox/sync', signed)).status).toBe(200)
  })

  it('binds the signature to the op in the path', async () => {
    const owner = await Owner.create(h)
    const signedForSync = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 0, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    expect(await h.post('/inbox/delete', signedForSync)).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    })
    expect((await owner.sync()).status).toBe(200)
  })

  it('verifies the exact signed bytes, not a re-serialization', async () => {
    const owner = await Owner.create(h)
    const raw = `{ "since" : 0,\n  "nonce":"${randomId()}", "ts":${Date.now()}, "inboxId": "${owner.inboxId}", "attest": null }`
    const response = await h.post(
      '/inbox/sync',
      await envelope('inbox/sync', raw, owner.key)
    )
    expect(response.status).toBe(200)
  })

  it('rejects stale timestamps on either side of the ±5 minute window', async () => {
    const owner = await Owner.create(h)
    for (const skew of [-300_001, 300_001]) {
      const response = await owner.send('inbox/sync', {
        since: 0,
        ts: Date.now() + skew,
      })
      expect(response).toEqual({ status: 401, body: { error: 'stale' } })
    }
    for (const skew of [-300_000, 300_000]) {
      expect(
        (await owner.send('inbox/sync', { since: 0, ts: Date.now() + skew }))
          .status
      ).toBe(200)
    }
  })

  it('rejects a replayed nonce for the same inbox', async () => {
    const owner = await Owner.create(h)
    const request = await envelope(
      'inbox/sync',
      { inboxId: owner.inboxId, since: 0, ts: Date.now(), nonce: randomId() },
      owner.key
    )
    expect((await h.post('/inbox/sync', request)).status).toBe(200)
    advance(4 * MINUTE_MS)
    expect(await h.post('/inbox/sync', request)).toEqual({
      status: 409,
      body: { error: 'replay' },
    })
    // A reused nonce with a new signature is still a replay.
    const nonce = randomId()
    expect((await owner.send('inbox/sync', { since: 0, nonce })).status).toBe(
      200
    )
    expect(
      (await owner.send('roster/put', { blob: blobOfSize(10), nonce })).body
    ).toEqual({
      error: 'replay',
    })
  })

  it('returns not_found for an unknown inbox and bad_request for malformed input', async () => {
    const stranger = await SigningKey.generate()
    expect(
      await h.send('inbox/sync', stranger, { inboxId: randomId(), since: 0 })
    ).toEqual({ status: 404, body: { error: 'not_found' } })

    const owner = await Owner.create(h)
    expect((await owner.send('inbox/sync', { since: -1 })).body).toEqual({
      error: 'bad_request',
    })
    expect((await h.post('/inbox/sync', 'not json')).body).toEqual({
      error: 'bad_request',
    })
    expect((await h.post('/inbox/sync', { p: '***' })).body).toEqual({
      error: 'bad_request',
    })
    expect(
      (await owner.send('inbox/sync', { since: 0, inboxId: 'short' })).status
    ).toBe(400)
  })
})

describe('inbox/sync', () => {
  it('returns items after `since`, the full slot list, and a null roster when unchanged', async () => {
    const owner = await Owner.create(h)
    expect((await owner.sync()).body).toEqual({
      ok: true,
      seq: 0,
      slots: [],
      cards: [],
      events: [],
      roster: null,
    })

    const alice = await owner.addWriter()
    advance(1_000)
    const bob = await owner.addWriter()
    const roster = blobOfSize(300)
    expect((await owner.send('roster/put', { blob: roster })).body).toEqual({
      ok: true,
      seq: 1,
    })
    const card = blobOfSize(500)
    expect((await alice.putCard(card)).body).toEqual({ ok: true, seq: 2 })
    const eventId = randomId()
    const eventBlob = blobOfSize(80)
    expect(
      (await bob.putEvent({ eventId, kind: 'pair.confirmed', blob: eventBlob }))
        .body
    ).toEqual({ ok: true, seq: 3 })

    const full = (await owner.sync(0)).body
    expect(full).toEqual({
      ok: true,
      seq: 3,
      slots: [
        { slotId: alice.slotId, createdAt: START },
        { slotId: bob.slotId, createdAt: START + 1_000 },
      ],
      cards: [
        { slotId: alice.slotId, blob: card, seq: 2, updatedAt: START + 1_000 },
      ],
      events: [
        {
          eventId,
          slotId: bob.slotId,
          kind: 'pair.confirmed',
          blob: eventBlob,
          seq: 3,
          createdAt: START + 1_000,
        },
      ],
      roster: { blob: roster, seq: 1 },
    })

    const partial = (await owner.sync(1)).body
    expect(partial.roster).toBeNull()
    expect(partial.cards.map((c: { seq: number }) => c.seq)).toEqual([2])
    expect(partial.events.map((e: { seq: number }) => e.seq)).toEqual([3])

    const caughtUp = (await owner.sync(3)).body
    expect(caughtUp).toMatchObject({
      seq: 3,
      cards: [],
      events: [],
      roster: null,
    })
    expect(caughtUp.slots).toHaveLength(2)
  })

  it('replaces a slot card and gives it the next seq', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    await buddy.putCard(blobOfSize(40))
    const latest = blobOfSize(41)
    expect((await buddy.putCard(latest)).body).toEqual({ ok: true, seq: 2 })

    const { cards } = (await owner.sync()).body
    expect(cards).toEqual([
      expect.objectContaining({ slotId: buddy.slotId, blob: latest, seq: 2 }),
    ])
  })

  it('stops at a size budget and returns the cursor it reached', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const storage = h.inboxes.storage(owner.inboxId)
    // 450 max-size (8 KiB) events: more than one 4 MiB sync budget holds.
    const blob = 'A'.repeat(Math.ceil((8 * 1024 * 4) / 3))
    for (let seq = 1; seq <= 450; seq++) {
      storage.query(
        `INSERT INTO event (event_id, slot_id, kind, blob, seq, created_at)
         VALUES (?, ?, 'plan.joined', ?, ?, ?)`,
        `event-${seq}`,
        buddy.slotId,
        blob,
        seq,
        Date.now()
      )
    }
    storage.query('UPDATE meta SET seq = 450')
    expect((await buddy.putCard()).body).toEqual({ ok: true, seq: 451 })

    const first = (await owner.sync()).body
    expect(first.events.length).toBeGreaterThan(300)
    expect(first.events.length).toBeLessThan(450)
    expect(first.seq).toBe(first.events.at(-1).seq)
    expect(first.cards).toEqual([])

    const rest = (await owner.sync(first.seq)).body
    expect(rest.seq).toBe(451)
    expect(first.events.length + rest.events.length).toBe(450)
    expect(rest.events[0].seq).toBe(first.seq + 1)
    expect(rest.cards).toHaveLength(1)
  })
})

describe('events and pushes', () => {
  it('dedupes on eventId: a repeat returns the original seq and never pushes', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const buddy = await owner.addWriter()
    const eventId = randomId()

    const first = await buddy.putEvent({
      eventId,
      kind: 'pair.confirmed',
      push: true,
    })
    advance(2 * MINUTE_MS)
    const repeat = await buddy.putEvent({
      eventId,
      kind: 'pair.confirmed',
      push: true,
    })
    await h.flush()

    expect(first.body).toEqual({ ok: true, seq: 1 })
    expect(repeat.body).toEqual({ ok: true, seq: 1 })
    expect(h.pushes).toHaveLength(1)
    expect((await owner.sync()).body.events).toHaveLength(1)
  })

  it('pushes each device its own template and skips devices without one', async () => {
    const owner = await Owner.create(h)
    const withTemplate = randomId()
    await owner.registerDevice(withTemplate, {
      'plan.joined': { title: 'Plans', body: 'Mom plans to come' },
    })
    await owner.registerDevice(randomId(), {
      'invite.claimed': { title: 'x', body: 'y' },
    })
    const buddy = await owner.addWriter()

    await buddy.putEvent({ kind: 'plan.joined', push: true })
    await h.flush()

    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].body).toEqual({
      aps: {
        alert: { title: 'Plans', body: 'Mom plans to come' },
        sound: 'default',
        'thread-id': 'buddies',
      },
      ww: { kind: 'plan.joined' },
    })
  })

  it('stores but does not push events with push: false', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const buddy = await owner.addWriter()
    await buddy.putEvent({ push: false })
    await h.flush()
    expect(h.pushes).toHaveLength(0)
    expect((await owner.sync()).body.events).toHaveLength(1)
  })
})

describe('ending a connection', () => {
  it('slot/leave removes the slot, card, and events; later writes are gone', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const other = await owner.addWriter()
    await buddy.putCard()
    await buddy.putEvent()
    await other.putCard()

    expect((await buddy.send('slot/leave')).body).toEqual({ ok: true })
    expect((await buddy.send('slot/leave')).body).toEqual({ ok: true })

    expect(await buddy.putCard()).toEqual({
      status: 410,
      body: { error: 'gone' },
    })
    expect(await buddy.putEvent()).toEqual({
      status: 410,
      body: { error: 'gone' },
    })
    const sync = (await owner.sync()).body
    expect(sync.slots.map((s: { slotId: string }) => s.slotId)).toEqual([
      other.slotId,
    ])
    expect(sync.cards.map((c: { slotId: string }) => c.slotId)).toEqual([
      other.slotId,
    ])
    expect(sync.events).toEqual([])
  })

  it('slot/remove by the owner makes the buddy see gone', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    await buddy.putCard()
    expect(
      (await owner.send('slot/remove', { slotId: buddy.slotId })).body
    ).toEqual({ ok: true })
    expect(
      (await owner.send('slot/remove', { slotId: buddy.slotId })).body
    ).toEqual({ ok: true })
    expect(await buddy.putCard()).toEqual({
      status: 410,
      body: { error: 'gone' },
    })
    expect((await owner.sync()).body).toMatchObject({ slots: [], cards: [] })
  })

  it('slot/leave into a deleted inbox is a no-op success', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    await owner.send('inbox/delete')
    expect((await buddy.send('slot/leave')).body).toEqual({ ok: true })
  })

  it('rejects slot/leave signed by anyone but the slot writer', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const impostor = await SigningKey.generate()
    const response = await h.send('slot/leave', impostor, {
      inboxId: owner.inboxId,
      slotId: buddy.slotId,
    })
    expect(response).toEqual({ status: 401, body: { error: 'bad_signature' } })
    expect((await owner.sync()).body.slots).toHaveLength(1)
  })

  it('slot/add is idempotent for the same key and conflicts on a different one', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    expect(
      (
        await owner.send('slot/add', {
          slotId: buddy.slotId,
          writerPub: buddy.key.publicKey,
        })
      ).body
    ).toEqual({ ok: true })
    const other = await SigningKey.generate()
    expect(
      (
        await owner.send('slot/add', {
          slotId: buddy.slotId,
          writerPub: other.publicKey,
        })
      ).body
    ).toEqual({ error: 'conflict' })
  })
})

describe('caps and rate limits', () => {
  it('limits slots + open invites to 5', async () => {
    const owner = await Owner.create(h)
    for (let i = 0; i < 3; i++) await owner.addWriter()
    expect((await createInvite(owner)).response.body).toEqual({ ok: true })
    expect((await createInvite(owner)).response.body).toEqual({ ok: true })

    expect((await createInvite(owner)).response).toEqual({
      status: 429,
      body: { error: 'limit' },
    })
    const writer = await SigningKey.generate()
    expect(
      (
        await owner.send('slot/add', {
          slotId: randomId(),
          writerPub: writer.publicKey,
        })
      ).body
    ).toEqual({ error: 'limit' })
  })

  it('limits open invites to 3', async () => {
    const owner = await Owner.create(h)
    for (let i = 0; i < 3; i++) {
      expect((await createInvite(owner)).response.status).toBe(200)
    }
    expect((await createInvite(owner)).response.body).toEqual({
      error: 'limit',
    })
  })

  it('limits invite creation to 5 per 24 hours, counting deleted invites', async () => {
    const owner = await Owner.create(h)
    for (let i = 0; i < 5; i++) {
      const invite = await createInvite(owner)
      expect(invite.response.status).toBe(200)
      await owner.send('invite/delete', { inviteId: invite.inviteId })
      advance(HOUR_MS)
    }
    expect((await createInvite(owner)).response).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    advance(20 * HOUR_MS)
    expect((await createInvite(owner)).response.status).toBe(200)
  })

  it('limits writes to 60 per slot per hour, per slot', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const other = await owner.addWriter()
    for (let i = 0; i < 30; i++) {
      expect((await buddy.putCard()).status).toBe(200)
      expect((await buddy.putEvent()).status).toBe(200)
    }
    expect(await buddy.putCard()).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    expect(await buddy.putEvent()).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    expect((await other.putCard()).status).toBe(200)

    advance(HOUR_MS)
    expect((await buddy.putCard()).status).toBe(200)
  })

  it('pushes at most 10 per slot per day, at least 60 s apart, and still stores the rest', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const buddy = await owner.addWriter()
    const other = await owner.addWriter()

    await buddy.putEvent({ push: true })
    advance(59_000)
    await buddy.putEvent({ push: true })
    await other.putEvent({ push: true })
    await h.flush()
    expect(h.pushes).toHaveLength(2)

    for (let i = 0; i < 12; i++) {
      advance(MINUTE_MS)
      await buddy.putEvent({ push: true })
    }
    await h.flush()
    // buddy: 10 pushes in the window; other: 1.
    expect(h.pushes).toHaveLength(11)
    expect((await owner.sync()).body.events).toHaveLength(15)

    advance(DAY_MS)
    await buddy.putEvent({ push: true })
    await h.flush()
    expect(h.pushes).toHaveLength(12)
  })

  it('keeps 10 devices per inbox, evicting the least recently registered', async () => {
    const owner = await Owner.create(h)
    const ids = Array.from({ length: 11 }, () => randomId())
    for (const id of ids) {
      expect((await owner.registerDevice(id)).body).toEqual({ ok: true })
      advance(1_000)
    }
    const devices = h.inboxes
      .storage(owner.inboxId)
      .query('SELECT device_id AS id FROM device ORDER BY updated_at')
      .map((row) => row.id)
    expect(devices).toEqual(ids.slice(1))

    // Re-registering refreshes a device so it's no longer the oldest.
    await owner.registerDevice(ids[1])
    await owner.registerDevice(randomId())
    const after = h.inboxes
      .storage(owner.inboxId)
      .query('SELECT device_id AS id FROM device')
      .map((row) => row.id)
    expect(after).toHaveLength(10)
    expect(after).toContain(ids[1])
    expect(after).not.toContain(ids[2])
  })

  it('keeps one device per APNs token and deletes on device/unregister', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice(randomId(), undefined, 'ab'.repeat(32))
    const reinstalled = randomId()
    await owner.registerDevice(reinstalled, undefined, 'ab'.repeat(32))
    const storage = h.inboxes.storage(owner.inboxId)
    expect(storage.query('SELECT device_id AS id FROM device')).toEqual([
      { id: reinstalled },
    ])

    expect(
      (await owner.send('device/unregister', { deviceId: reinstalled })).body
    ).toEqual({
      ok: true,
    })
    expect(
      (await owner.send('device/unregister', { deviceId: reinstalled })).body
    ).toEqual({
      ok: true,
    })
    expect(storage.query('SELECT device_id FROM device')).toEqual([])
  })

  it('rate-limits unsigned ops by client IP', async () => {
    h = await createHarness({ unsignedLimit: 2 })
    const inviteId = randomId()
    expect((await fetchInvite(inviteId)).status).toBe(404)
    expect((await fetchInvite(inviteId)).status).toBe(404)
    expect(await fetchInvite(inviteId)).toEqual({
      status: 429,
      body: { error: 'rate_limited' },
    })
    expect(
      (
        await h.post('/invite/fetch', unsignedEnvelope({ inviteId }), {
          'cf-connecting-ip': '198.51.100.2',
        })
      ).status
    ).toBe(404)
    expect(new Set(h.rateLimitKeys)).toEqual(
      new Set(['203.0.113.7', '198.51.100.2'])
    )
  })
})

describe('invites', () => {
  it('runs create → fetch → claim → confirm-delete, with the first claim winning', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const invite = await createInvite(owner)
    expect(invite.response.body).toEqual({ ok: true })

    const fetched = await fetchInvite(invite.inviteId)
    expect(fetched.body).toEqual({
      ok: true,
      blob: expect.any(String),
      expiresAt: START + 7 * DAY_MS,
      status: 'open',
    })

    const claimBlob = blobOfSize(150)
    expect(await claim(invite.inviteId, invite.claimSecret, claimBlob)).toEqual(
      {
        status: 200,
        body: { ok: true },
      }
    )
    await h.flush()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].body).toMatchObject({ ww: { kind: 'invite.claimed' } })

    expect((await fetchInvite(invite.inviteId)).body.status).toBe('claimed')
    expect(await claim(invite.inviteId, invite.claimSecret)).toEqual({
      status: 409,
      body: { error: 'conflict' },
    })

    const { events, seq } = (await owner.sync()).body
    expect(events).toEqual([
      {
        eventId: invite.inviteId,
        slotId: '',
        kind: 'invite.claimed',
        blob: claimBlob,
        seq: 1,
        createdAt: START,
      },
    ])
    expect(seq).toBe(1)

    expect(
      (await owner.send('invite/delete', { inviteId: invite.inviteId })).body
    ).toEqual({
      ok: true,
    })
    expect(await fetchInvite(invite.inviteId)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
    expect(h.invites.storage(invite.inviteId).tables()).toEqual([])
    expect(
      (await owner.send('invite/delete', { inviteId: invite.inviteId })).body
    ).toEqual({
      ok: true,
    })
  })

  it('burns the invite after 5 wrong claim secrets', async () => {
    const owner = await Owner.create(h)
    const invite = await createInvite(owner)
    const wrong = (await inviteSecrets()).claimSecret
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await claim(invite.inviteId, wrong)).toEqual({
        status: 401,
        body: { error: 'bad_signature' },
      })
    }
    expect((await fetchInvite(invite.inviteId)).status).toBe(404)
    expect((await claim(invite.inviteId, invite.claimSecret)).body).toEqual({
      error: 'not_found',
    })
    // The burned invite no longer holds one of the creator's spots.
    expect(
      h.inboxes.storage(owner.inboxId).query('SELECT invite_id FROM invite')
    ).toEqual([])
  })

  it('stops counting a claimed invite as open, so its confirm can add the 5th slot', async () => {
    const owner = await Owner.create(h)
    for (let i = 0; i < 4; i++) await owner.addWriter()
    const invite = await createInvite(owner)
    expect(invite.response.status).toBe(200)
    expect((await claim(invite.inviteId, invite.claimSecret)).status).toBe(200)
    await owner.addWriter()
    expect((await owner.sync()).body.slots).toHaveLength(5)
  })

  it('expires invites at expiresAt and deletes them after a short grace', async () => {
    const owner = await Owner.create(h)
    const invite = await createInvite(owner, Date.now() + HOUR_MS)
    const storage = h.invites.storage(invite.inviteId)
    expect(storage.alarm()).toBe(START + HOUR_MS + 10 * MINUTE_MS)

    advance(HOUR_MS)
    expect((await fetchInvite(invite.inviteId)).body).toEqual({
      error: 'not_found',
    })
    expect((await claim(invite.inviteId, invite.claimSecret)).body).toEqual({
      error: 'not_found',
    })

    advance(10 * MINUTE_MS)
    await h.invites.fireAlarm(invite.inviteId)
    expect(storage.tables()).toEqual([])

    // The creator's bookkeeping drops it too, freeing the spot.
    await h.inboxes.fireAlarm(owner.inboxId)
    expect(
      h.inboxes.storage(owner.inboxId).query('SELECT invite_id FROM invite')
    ).toEqual([])
  })

  it('validates expiresAt against the 7 day + 5 minute ceiling', async () => {
    const owner = await Owner.create(h)
    const ceiling = Date.now() + 7 * DAY_MS + 5 * MINUTE_MS
    expect((await createInvite(owner, ceiling)).response.status).toBe(200)
    expect((await createInvite(owner, ceiling + 1)).response.body).toEqual({
      error: 'bad_request',
    })
    expect((await createInvite(owner, Date.now())).response.body).toEqual({
      error: 'bad_request',
    })
  })

  it('conflicts on an existing inviteId, and only the creator may delete', async () => {
    const owner = await Owner.create(h)
    const other = await Owner.create(h)
    const invite = await createInvite(owner)

    const duplicate = await other.send('invite/create', {
      inviteId: invite.inviteId,
      claimVerifier: invite.claimVerifier,
      blob: blobOfSize(10),
      expiresAt: Date.now() + DAY_MS,
    })
    expect(duplicate).toEqual({ status: 409, body: { error: 'conflict' } })
    // The failed create doesn't hold one of the other inbox's spots.
    expect(
      h.inboxes.storage(other.inboxId).query('SELECT * FROM invite')
    ).toEqual([])

    expect(
      (await other.send('invite/delete', { inviteId: invite.inviteId })).body
    ).toEqual({
      ok: true,
    })
    expect((await fetchInvite(invite.inviteId)).body.status).toBe('open')
  })

  it('treats a claim on a cancelled invite as not_found', async () => {
    const owner = await Owner.create(h)
    const invite = await createInvite(owner)
    // Simulate a lost invite DO delete: the inbox forgot it, the DO didn't.
    await h.inboxes.object(owner.inboxId).forgetInvite(invite.inviteId)
    expect((await claim(invite.inviteId, invite.claimSecret)).body).toEqual({
      error: 'not_found',
    })
    expect(h.invites.storage(invite.inviteId).tables()).toEqual([])
  })

  it('reopens an invite whose claim delivery failed and dedupes the retry', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const invite = await createInvite(owner)
    const blob = blobOfSize(120)

    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.inboxes.failNextReply(owner.inboxId)
    expect(await claim(invite.inviteId, invite.claimSecret, blob)).toEqual({
      status: 500,
      body: { error: 'internal' },
    })
    expect((await fetchInvite(invite.inviteId)).body.status).toBe('open')

    // The retry lands on the already-stored event and pushes once.
    expect(
      (await claim(invite.inviteId, invite.claimSecret, blob)).body
    ).toEqual({ ok: true })
    await h.flush()
    expect(h.pushes).toHaveLength(1)
    const { events } = (await owner.sync()).body
    expect(events).toHaveLength(1)
    // A different claimer can't slip in behind the first claim.
    expect((await claim(invite.inviteId, invite.claimSecret)).body).toEqual({
      error: 'conflict',
    })
  })
})

describe('inbox/delete', () => {
  it('wipes the inbox and every invite it created', async () => {
    const owner = await Owner.create(h)
    await owner.registerDevice()
    const buddy = await owner.addWriter()
    await buddy.putCard()
    await buddy.putEvent()
    await owner.send('roster/put', { blob: blobOfSize(100) })
    const open = await createInvite(owner)
    const claimed = await createInvite(owner)
    await claim(claimed.inviteId, claimed.claimSecret)

    expect((await owner.send('inbox/delete')).body).toEqual({ ok: true })

    expect(h.inboxes.storage(owner.inboxId).tables()).toEqual([])
    expect(h.inboxes.storage(owner.inboxId).alarm()).toBeNull()
    for (const invite of [open, claimed]) {
      expect((await fetchInvite(invite.inviteId)).status).toBe(404)
      expect(h.invites.storage(invite.inviteId).tables()).toEqual([])
    }
    expect((await owner.sync()).body).toEqual({ error: 'not_found' })
    expect(await buddy.putCard()).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })

    // The same identity can start over from an empty inbox.
    expect(
      (await owner.send('inbox/register', { ownerPub: owner.key.publicKey }))
        .status
    ).toBe(200)
    expect((await owner.sync()).body).toMatchObject({ seq: 0, slots: [] })
  })

  it('retries invite deletions that fail during the wipe', async () => {
    const owner = await Owner.create(h)
    const invite = await createInvite(owner)
    h.invites.failNextReply(invite.inviteId)
    expect((await owner.send('inbox/delete')).body).toEqual({ ok: true })
    // The delete ran even though its reply was lost; the retry is idempotent.
    const storage = h.inboxes.storage(owner.inboxId)
    expect(
      storage.query('SELECT invite_id AS id FROM pending_invite_delete')
    ).toEqual([{ id: invite.inviteId }])
    expect(storage.alarm()).toBe(START + MINUTE_MS)

    advance(MINUTE_MS)
    await h.inboxes.fireAlarm(owner.inboxId)
    expect(storage.tables()).toEqual([])
  })
})

describe('kill switch', () => {
  it('returns disabled for everything except inbox/delete, slot/remove, and slot/leave', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const leaver = await owner.addWriter()
    const invite = await createInvite(owner)

    await h.kv.put('buddies:enabled', 'false')
    const disabled = { status: 503, body: { error: 'disabled' } }
    expect(await owner.sync()).toEqual(disabled)
    expect(await owner.registerDevice()).toEqual(disabled)
    expect(await buddy.putCard()).toEqual(disabled)
    expect(await buddy.putEvent()).toEqual(disabled)
    expect(await createInvite(owner).then((i) => i.response)).toEqual(disabled)
    expect(await fetchInvite(invite.inviteId)).toEqual(disabled)
    expect(await claim(invite.inviteId, invite.claimSecret)).toEqual(disabled)
    expect(await h.post('/inbox/register', { p: 'x' })).toEqual(disabled)

    expect((await leaver.send('slot/leave')).body).toEqual({ ok: true })
    expect(
      (await owner.send('slot/remove', { slotId: buddy.slotId })).body
    ).toEqual({ ok: true })
    expect((await owner.send('inbox/delete')).body).toEqual({ ok: true })
    expect((await fetchInvite(invite.inviteId)).status).toBe(503)
    expect(h.invites.storage(invite.inviteId).tables()).toEqual([])
  })

  it('reads KV first and falls back to BUDDIES_ENABLED when the key is absent', async () => {
    const probe = async (harness: Harness) =>
      (
        await harness.post(
          '/invite/fetch',
          unsignedEnvelope({ inviteId: randomId() })
        )
      ).status

    expect(await probe(await createHarness({ enabled: 'false' }))).toBe(503)
    expect(await probe(await createHarness({ enabled: 'true' }))).toBe(404)
    expect(
      await probe(await createHarness({ enabled: 'false', kvEnabled: 'true' }))
    ).toBe(404)
    expect(
      await probe(await createHarness({ enabled: 'true', kvEnabled: 'false' }))
    ).toBe(503)
    expect(
      await probe(await createHarness({ enabled: 'true', kvEnabled: 'yes' }))
    ).toBe(503)
  })
})

describe('retention', () => {
  it('deletes events 30 days after creation via the alarm', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    await buddy.putEvent()
    advance(DAY_MS)
    await buddy.putEvent()
    const storage = h.inboxes.storage(owner.inboxId)
    expect(storage.alarm()).toBe(START + 30 * DAY_MS)

    advance(29 * DAY_MS)
    await owner.sync()
    await h.inboxes.fireAlarm(owner.inboxId)
    expect(storage.query('SELECT COUNT(*) AS n FROM event')).toEqual([{ n: 1 }])
    expect(storage.alarm()).toBe(START + 31 * DAY_MS)

    advance(DAY_MS)
    await h.inboxes.fireAlarm(owner.inboxId)
    expect(storage.query('SELECT COUNT(*) AS n FROM event')).toEqual([{ n: 0 }])
  })

  it('wipes an inbox 180 days after the last owner op, ignoring buddy writes', async () => {
    const owner = await Owner.create(h)
    const buddy = await owner.addWriter()
    const storage = h.inboxes.storage(owner.inboxId)
    expect(storage.alarm()).toBe(START + 180 * DAY_MS)

    advance(100 * DAY_MS)
    await owner.sync()
    advance(80 * DAY_MS)
    await buddy.putCard()
    await h.inboxes.fireAlarm(owner.inboxId)
    // Still active: the sync 80 days ago reset the clock.
    expect(storage.tables()).toContain('meta')
    expect(storage.alarm()).toBe(START + 280 * DAY_MS)

    advance(100 * DAY_MS)
    await h.inboxes.fireAlarm(owner.inboxId)
    expect(storage.tables()).toEqual([])
    expect((await owner.sync()).body).toEqual({ error: 'not_found' })
  })

  it('stores nothing for requests to an inbox that was never registered', async () => {
    const stranger = await SigningKey.generate()
    const inboxId = randomId()
    await h.send('inbox/sync', stranger, { inboxId, since: 0 })
    await h.send('card/put', stranger, {
      inboxId,
      slotId: randomId(),
      blob: blobOfSize(10),
    })
    await h.send('inbox/register', stranger, {
      inboxId,
      ownerPub: stranger.publicKey,
      ts: Date.now() - DAY_MS,
    })
    expect(h.inboxes.storage(inboxId).tables()).toEqual([])
  })
})
