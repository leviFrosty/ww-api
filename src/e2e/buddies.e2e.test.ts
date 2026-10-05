import { afterAll, describe, expect, it } from 'vitest'
import {
  SigningKey,
  b64u,
  blobOfSize,
  envelope,
  randomBytes,
  randomId,
  unsignedEnvelope,
} from '../test/buddiesClient'
import {
  LOCAL_LAUNCHER,
  RelayOwner,
  RelayWriter,
  buddies,
  http,
  localKv,
  sendSigned,
  sendUnsigned,
  writeTranscript,
} from '../test/e2e'

/**
 * Two synthetic identities pair through the live relay following the
 * protocol's pairing sequence (docs/buddies-protocol.md), with read-backs via
 * `inbox/sync` after every write. Blobs are random bytes: the relay is blind.
 */

afterAll(() => {
  writeTranscript('buddies')
})

const DAY_MS = 24 * 60 * 60 * 1000

const inviteSecrets = async () => {
  const claimSecret = randomBytes(32)
  const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', claimSecret))
  return { inviteId: randomId(), claimSecret: b64u(claimSecret), claimVerifier: b64u(verifier) }
}

describe('pairing happy path', () => {
  it('register → invite → claim → confirm → cards → roster → leave → delete', async () => {
    // 1. Two people register inboxes; register is idempotent per key.
    const levi = await RelayOwner.register()
    const maria = await RelayOwner.register()
    expect((await levi.send('inbox/register', { ownerPub: levi.key.publicKey })).body).toEqual({ ok: true })
    const stranger = await SigningKey.generate()
    const hijack = await sendSigned('inbox/register', stranger, {
      inboxId: levi.inboxId,
      ownerPub: stranger.publicKey,
    })
    expect(hijack.status).toBe(409)
    expect(hijack.body).toEqual({ error: 'conflict' })

    const empty = await levi.sync()
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ ok: true, seq: 0, slots: [], cards: [], events: [], roster: null })

    // 2. Levi registers a device (APNs is not configured locally: pushes skip).
    const device = await levi.send('device/register', {
      deviceId: randomId(),
      apnsToken: 'ab'.repeat(32),
      apnsEnvironment: 'sandbox',
      templates: {
        'invite.claimed': { title: 'Buddy request', body: 'Someone accepted your invite' },
        'pair.confirmed': { title: 'New buddy', body: 'You are now buddies' },
      },
    })
    expect(device.body).toEqual({ ok: true })

    // 3. Levi creates an invite.
    const invite = await inviteSecrets()
    const inviteCard = blobOfSize(256)
    const expiresAt = Date.now() + DAY_MS
    const created = await levi.send('invite/create', {
      inviteId: invite.inviteId,
      claimVerifier: invite.claimVerifier,
      blob: inviteCard,
      expiresAt,
    })
    expect(created.body).toEqual({ ok: true })

    // 4. Maria fetches the invite card.
    const fetched = await sendUnsigned('invite/fetch', { inviteId: invite.inviteId })
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual({ ok: true, blob: inviteCard, expiresAt, status: 'open' })

    // 5. Maria accepts: registers the Levi→Maria slot in her inbox, then claims.
    const leviWriterKey = await SigningKey.generate()
    const leviToMaria = new RelayWriter(maria.inboxId, randomId(), leviWriterKey)
    expect(
      (await maria.send('slot/add', { slotId: leviToMaria.slotId, writerPub: leviWriterKey.publicKey })).body
    ).toEqual({ ok: true })
    const claimBlob = blobOfSize(200)
    const wrongClaim = await sendUnsigned('invite/claim', {
      inviteId: invite.inviteId,
      claimSecret: b64u(randomBytes(32)),
      blob: claimBlob,
    })
    expect(wrongClaim.status).toBe(401)
    const claimed = await sendUnsigned('invite/claim', {
      inviteId: invite.inviteId,
      claimSecret: invite.claimSecret,
      blob: claimBlob,
    })
    expect(claimed.status).toBe(200)
    expect(claimed.body).toEqual({ ok: true })
    const reclaim = await sendUnsigned('invite/claim', {
      inviteId: invite.inviteId,
      claimSecret: invite.claimSecret,
      blob: claimBlob,
    })
    expect(reclaim.status).toBe(409)
    expect((await sendUnsigned('invite/fetch', { inviteId: invite.inviteId })).body.status).toBe('claimed')

    // 6. Levi syncs and sees the relay's invite.claimed event with Maria's claim blob.
    const afterClaim = await levi.sync()
    expect(afterClaim.status).toBe(200)
    expect(afterClaim.body.events).toEqual([
      expect.objectContaining({
        eventId: invite.inviteId,
        slotId: '',
        kind: 'invite.claimed',
        blob: claimBlob,
      }),
    ])

    // 7. Levi confirms: adds Maria→Levi slot, writes pair.confirmed + card into Maria's inbox, deletes the invite.
    const mariaWriterKey = await SigningKey.generate()
    const mariaToLevi = new RelayWriter(levi.inboxId, randomId(), mariaWriterKey)
    expect(
      (await levi.send('slot/add', { slotId: mariaToLevi.slotId, writerPub: mariaWriterKey.publicKey })).body
    ).toEqual({ ok: true })
    const confirmId = randomId()
    const confirmBlob = blobOfSize(64)
    const confirmed = await leviToMaria.send('event/put', {
      eventId: confirmId,
      kind: 'pair.confirmed',
      blob: confirmBlob,
      push: true,
    })
    expect(confirmed.status).toBe(200)
    const confirmSeq = confirmed.body.seq
    expect(confirmSeq).toBeGreaterThan(0)
    // Deduplicated on eventId: same seq back.
    const duplicate = await leviToMaria.send('event/put', {
      eventId: confirmId,
      kind: 'pair.confirmed',
      blob: confirmBlob,
      push: true,
    })
    expect(duplicate.body).toEqual({ ok: true, seq: confirmSeq })
    const leviCard = blobOfSize(1024)
    const leviCardPut = await leviToMaria.send('card/put', { blob: leviCard })
    expect(leviCardPut.status).toBe(200)
    expect((await levi.send('invite/delete', { inviteId: invite.inviteId })).body).toEqual({ ok: true })
    expect((await sendUnsigned('invite/fetch', { inviteId: invite.inviteId })).status).toBe(404)

    // 8. Maria's sync shows Levi's slot, confirmation, and card.
    const mariaSync = await maria.sync()
    expect(mariaSync.status).toBe(200)
    expect(mariaSync.body.slots).toEqual([
      { slotId: leviToMaria.slotId, createdAt: expect.any(Number) },
    ])
    expect(mariaSync.body.events).toEqual([
      expect.objectContaining({ eventId: confirmId, slotId: leviToMaria.slotId, kind: 'pair.confirmed', blob: confirmBlob, seq: confirmSeq }),
    ])
    expect(mariaSync.body.cards).toEqual([
      expect.objectContaining({ slotId: leviToMaria.slotId, blob: leviCard, seq: leviCardPut.body.seq }),
    ])
    // since = current seq returns nothing new.
    const mariaIdle = await maria.sync(mariaSync.body.seq)
    expect(mariaIdle.body).toMatchObject({ cards: [], events: [], roster: null })

    // 9. Maria writes her card into Levi's inbox; Levi reads only what's new.
    const leviBefore = afterClaim.body.seq
    const mariaCard = blobOfSize(2048)
    expect((await mariaToLevi.send('card/put', { blob: mariaCard })).status).toBe(200)
    const leviDelta = await levi.sync(leviBefore)
    expect(leviDelta.body.events).toEqual([])
    expect(leviDelta.body.cards).toEqual([
      expect.objectContaining({ slotId: mariaToLevi.slotId, blob: mariaCard }),
    ])

    // 10. Roster backup round-trips and is omitted once seen.
    const roster = blobOfSize(4096)
    const rosterPut = await levi.send('roster/put', { blob: roster })
    expect(rosterPut.status).toBe(200)
    const withRoster = await levi.sync(leviDelta.body.seq)
    expect(withRoster.body.roster).toEqual({ blob: roster, seq: rosterPut.body.seq })
    expect((await levi.sync(rosterPut.body.seq)).body.roster).toBeNull()

    // 11. Authentication holds on the live relay.
    const foreign = await sendSigned('inbox/sync', maria.key, { inboxId: levi.inboxId, since: 0 })
    expect(foreign.status).toBe(401)
    expect(foreign.body).toEqual({ error: 'bad_signature' })
    const replayed = await envelope(
      'inbox/sync',
      { ts: Date.now(), nonce: randomId(), inboxId: levi.inboxId, since: 0 },
      levi.key
    )
    expect((await buddies('inbox/sync', replayed)).status).toBe(200)
    const replay = await buddies('inbox/sync', replayed)
    expect(replay.status).toBe(409)
    expect(replay.body).toEqual({ error: 'replay' })
    const stale = await buddies(
      'inbox/sync',
      await envelope('inbox/sync', { ts: Date.now() - 6 * 60_000, nonce: randomId(), inboxId: levi.inboxId, since: 0 }, levi.key)
    )
    expect(stale.status).toBe(401)
    expect(stale.body).toEqual({ error: 'stale' })
    const wrongSlot = new RelayWriter(levi.inboxId, randomId(), mariaWriterKey)
    expect((await wrongSlot.send('card/put', { blob: blobOfSize(8) })).status).toBe(410)

    // 12. Maria ends the connection from both sides.
    expect((await maria.send('slot/remove', { slotId: leviToMaria.slotId })).body).toEqual({ ok: true })
    expect((await mariaToLevi.send('slot/leave')).body).toEqual({ ok: true })
    const leviAfterLeave = await levi.sync()
    expect(leviAfterLeave.body.slots).toEqual([])
    expect(leviAfterLeave.body.cards).toEqual([])
    expect((await mariaToLevi.send('card/put', { blob: blobOfSize(8) })).status).toBe(410)
    expect((await leviToMaria.send('card/put', { blob: blobOfSize(8) })).status).toBe(410)

    // 13. Delete-all wipes both inboxes.
    expect((await levi.send('inbox/delete')).body).toEqual({ ok: true })
    expect((await maria.send('inbox/delete')).body).toEqual({ ok: true })
    const gone = await levi.sync()
    expect(gone.status).toBe(404)
    expect(gone.body).toEqual({ error: 'not_found' })
  })
})

describe('relay limits and abuse', () => {
  it('rate limits unsigned ops per client IP at 30/min', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const res = await http('POST', '/buddies/v1/invite/fetch', {
        body: unsignedEnvelope({ inviteId: randomId() }),
        headers: { 'cf-connecting-ip': ip },
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true)
    expect(statuses[30]).toBe(429)
  })

  it('caps open invites at 3', async () => {
    const owner = await RelayOwner.register()
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const secrets = await inviteSecrets()
      const res = await owner.send('invite/create', {
        inviteId: secrets.inviteId,
        claimVerifier: secrets.claimVerifier,
        blob: blobOfSize(32),
        expiresAt: Date.now() + DAY_MS,
      })
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
    expect((await owner.send('inbox/delete')).status).toBe(200)
  })

  it('rejects unknown ops and GETs', async () => {
    expect((await buddies('inbox/explode', unsignedEnvelope({}))).status).toBe(404)
    expect((await http('GET', '/buddies/v1/inbox/sync')).status).toBe(404)
  })
})

describe.skipIf(!LOCAL_LAUNCHER)('kill switch (local KV)', () => {
  it('disables everything except leave/delete, then recovers', async () => {
    const owner = await RelayOwner.register()
    try {
      localKv('put', 'buddies:enabled', 'false')
      const fresh = await SigningKey.generate()
      const blocked = await sendSigned('inbox/register', fresh, { inboxId: randomId(), ownerPub: fresh.publicKey })
      expect(blocked.status).toBe(503)
      expect(blocked.body).toEqual({ error: 'disabled' })
      expect((await owner.sync()).body).toEqual({ error: 'disabled' })
      expect((await owner.send('inbox/delete')).body).toEqual({ ok: true })
    } finally {
      localKv('delete', 'buddies:enabled')
    }
    const back = await RelayOwner.register()
    expect((await back.sync()).status).toBe(200)
    await back.send('inbox/delete')
  })
})
