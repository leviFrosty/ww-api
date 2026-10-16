import { afterAll, describe, expect, it } from 'vitest'
import { accountSignedMessage, type AccountsOp } from '../accounts/contracts'
import {
  SigningKey,
  b64u,
  envelope,
  randomBytes,
  randomId,
  sha256B64u,
} from '../test/buddiesClient'
import {
  ADMIN_TOKEN,
  BearerRelayOwner,
  DEV_BYPASS_TOKEN,
  http,
  httpBytes,
  openSession as openE2ESession,
  writeTranscript,
} from '../test/e2e'

/**
 * The account activity log and device list (witness-work ADR 0028) over real
 * HTTP and the local D1: two devices sign in, one signs the other out, a
 * backup is downloaded and deleted, and the log reads all of it back, newest
 * first, a page at a time.
 */

afterAll(() => {
  writeTranscript('activity')
})

const encoder = new TextEncoder()

const signedEnvelope = async (
  op: AccountsOp,
  key: SigningKey,
  fields: Record<string, unknown> = {}
) => {
  const bytes = encoder.encode(
    JSON.stringify({ accountPub: key.publicKey, ts: Date.now(), nonce: randomId(), ...fields })
  )
  return {
    payload: b64u(bytes),
    signature: b64u(await key.sign(accountSignedMessage(op, bytes))),
  }
}

interface Session {
  key: SigningKey
  accountId: string
  sessionId: string
  accessToken: string
  refreshToken: string
}

/** An opaque stand-in for a sealed device label; the server never reads it. */
const label = (name: string) => b64u(encoder.encode(`sealed:${name}`))

const openSession = async (key: SigningKey, device: string): Promise<Session> => {
  const res = await http('POST', '/accounts/v1/sessions', {
    headers: { 'x-ww-dev-bypass': DEV_BYPASS_TOKEN ?? '' },
    body: await signedEnvelope('session/open', key, { device: label(device) }),
  })
  expect(res.status).toBe(201)
  return { key, ...(res.body as Omit<Session, 'key'>) }
}

const bearer = (session: Session) => ({ authorization: `Bearer ${session.accessToken}` })

describe.skipIf(!DEV_BYPASS_TOKEN)('account activity and devices (dev bypass)', () => {
  it('lists devices, signs one out, and logs it all', async () => {
    const key = await SigningKey.generate()
    const phone = await openSession(key, 'Phone')
    const lost = await openSession(key, 'Lost phone')

    const listed = await http('GET', '/accounts/v1/sessions', { headers: bearer(phone) })
    expect(listed.status).toBe(200)
    expect(
      listed.body.sessions.map((s: { sessionId: string; current: boolean; device: string }) => [
        s.sessionId,
        s.current,
        s.device,
      ])
    ).toEqual([
      [lost.sessionId, false, label('Lost phone')],
      [phone.sessionId, true, label('Phone')],
    ])

    const revoked = await http('POST', '/accounts/v1/sessions/revoke', {
      headers: bearer(phone),
      body: { sessionId: lost.sessionId },
    })
    expect(revoked).toMatchObject({ status: 200, body: { ok: true } })
    const refused = await http('POST', '/accounts/v1/sessions/refresh', {
      body: { refreshToken: lost.refreshToken },
    })
    expect(refused.status).toBe(401)
    const missing = await http('POST', '/accounts/v1/sessions/revoke', {
      headers: bearer(phone),
      body: { sessionId: randomId() },
    })
    expect(missing).toMatchObject({ status: 404, body: { code: 'not_found' } })

    // A backup downloaded twice (logged once) and deleted.
    const slotId = randomId()
    const bytes = randomBytes(2_048)
    const put = await httpBytes('/accounts/v1/backup/put', {
      bytes,
      headers: {
        ...bearer(phone),
        'x-ww-slot-id': slotId,
        'x-ww-sha256': await sha256B64u(bytes),
      },
    })
    expect(put.status).toBe(200)
    for (let i = 0; i < 2; i++) {
      const got = await httpBytes('/accounts/v1/backup/get', {
        json: { slotId },
        headers: bearer(phone),
      })
      expect(got.status).toBe(200)
    }
    const deleted = await http('POST', '/accounts/v1/backup/delete', {
      headers: bearer(phone),
      body: await signedEnvelope('backup/delete', key, { slotId }),
    })
    expect(deleted.status).toBe(200)

    const firstPage = await http('GET', '/accounts/v1/activity?limit=3', { headers: bearer(phone) })
    expect(firstPage.status).toBe(200)
    const secondPage = await http(
      'GET',
      `/accounts/v1/activity?limit=3&before=${firstPage.body.nextCursor}`,
      { headers: bearer(phone) }
    )
    expect(secondPage.body.nextCursor).toBeNull()
    const entries = [...firstPage.body.activity, ...secondPage.body.activity]
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual([
      'backup.deleted',
      'backup.downloaded',
      'session.revoked',
      'session.opened',
      'session.opened',
      'account.created',
    ])
    expect(entries[0]).toMatchObject({
      slotId,
      session: { sessionId: phone.sessionId, device: label('Phone') },
    })
    expect(entries[2]).toMatchObject({
      session: { sessionId: lost.sessionId, device: label('Lost phone') },
      actor: { sessionId: phone.sessionId, device: label('Phone') },
    })

    const bad = await http('GET', '/accounts/v1/activity?limit=500', { headers: bearer(phone) })
    expect(bad.status).toBe(400)
    expect((await http('GET', '/accounts/v1/activity')).status).toBe(401)
  })

  it.skipIf(!ADMIN_TOKEN)('logs a suspension and reinstatement without the reason', async () => {
    const session = await openSession(await SigningKey.generate(), 'Phone')
    for (const status of ['suspended', 'active'])
      expect(
        (
          await http('POST', '/admin/accounts/status', {
            headers: { 'x-ww-admin-token': ADMIN_TOKEN ?? '' },
            body: { accountId: session.accountId, status, reason: 'report' },
          })
        ).status
      ).toBe(200)
    const read = await http('GET', '/accounts/v1/activity', { headers: bearer(session) })
    expect(read.body.activity.slice(0, 2).map((e: { kind: string }) => e.kind)).toEqual([
      'account.reinstated',
      'account.suspended',
    ])
    expect(JSON.stringify(read.body)).not.toContain('report')
  })

  it('logs a Buddies inbox linked and deleted, and nothing for a buddy writing', async () => {
    const session = await openE2ESession()
    const owner = await BearerRelayOwner.create(session)
    const buddy = await openE2ESession()
    const writer = await owner.addWriter()
    const put = await http('POST', '/buddies/v1/card/put', {
      headers: { authorization: `Bearer ${buddy.accessToken}` },
      body: await envelope(
        'card/put',
        {
          inboxId: writer.inboxId,
          slotId: writer.slotId,
          blob: b64u(randomBytes(64)),
          ts: Date.now(),
          nonce: randomId(),
        },
        writer.key
      ),
    })
    expect(put.status).toBe(200)
    expect((await owner.op('inbox/delete')).status).toBe(200)

    const kinds = async (accessToken: string) =>
      (
        await http('GET', '/accounts/v1/activity', {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).body.activity.map((e: { kind: string }) => e.kind)
    expect(await kinds(session.accessToken)).toEqual([
      'buddies.deleted',
      'buddies.inbox_linked',
      'session.opened',
      'account.created',
    ])
    expect(await kinds(buddy.accessToken)).toEqual(['session.opened', 'account.created'])
  })
})
