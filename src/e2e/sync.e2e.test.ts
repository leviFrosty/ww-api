import { afterAll, describe, expect, it } from 'vitest'
import { randomBytes, randomId, sha256B64u } from '../test/buddiesClient'
import {
  DEV_BYPASS_TOKEN,
  LOCAL_LAUNCHER,
  bearerHeaders,
  http,
  httpBytes,
  localKv,
  openLive,
  openSession,
  writeTranscript,
  type E2ESession,
} from '../test/e2e'

/**
 * Cloud Sync (witness-work ADR 0030) over real HTTP: the switches in
 * `/app/v1/config` and `GET /accounts/v1/sync`, a Supporter-only refusal,
 * then (with `sync:entitlement everyone` in the launcher's local KV) put,
 * list, get, the live socket's `hello` and `changed`, `If-Match`, the kill
 * switch, and delete.
 */

afterAll(() => {
  writeTranscript('sync')
})

const slot = () => randomId().slice(0, 16)

const put = async (
  session: E2ESession,
  slotId: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {}
) =>
  httpBytes('/accounts/v1/sync/put', {
    bytes,
    headers: {
      ...bearerHeaders(session),
      'x-ww-slot-id': slotId,
      'x-ww-sha256': await sha256B64u(bytes),
      ...headers,
    },
  })

const syncOp = (session: E2ESession, op: string, body: unknown = {}) =>
  http('POST', `/accounts/v1/sync/${op}`, {
    body,
    headers: bearerHeaders(session),
  })

describe('Cloud Sync switches', () => {
  it('says them in the public app config', async () => {
    const config = await http('GET', '/app/v1/config')
    expect(config.status).toBe(200)
    expect(config.body.sync).toEqual({
      enabled: expect.any(Boolean),
      entitlement: expect.stringMatching(/^(supporter|everyone)$/),
    })
  })
})

describe.skipIf(!DEV_BYPASS_TOKEN)('Cloud Sync with a session', () => {
  it('refuses an account that isn’t a Supporter while it’s a Supporter benefit', async () => {
    if (LOCAL_LAUNCHER) localKv('put', 'sync:entitlement', 'supporter')
    try {
      const session = await openSession()
      const status = await http('GET', '/accounts/v1/sync', {
        headers: bearerHeaders(session),
      })
      expect(status.status).toBe(200)
      if (status.body.entitlement !== 'supporter') return
      expect(status.body).toMatchObject({ supporter: false, entitled: false })
      const refused = await put(session, slot(), randomBytes(64))
      expect(refused.status).toBe(403)
      expect(refused.body.code).toBe('supporter_required')
      // Taking data off the server always works.
      expect((await syncOp(session, 'delete', { slotId: slot() })).status).toBe(200)
    } finally {
      if (LOCAL_LAUNCHER) localKv('delete', 'sync:entitlement')
    }
  })

  it.skipIf(!LOCAL_LAUNCHER)(
    'puts, lists, gets, streams changes to the other device, and deletes',
    async () => {
      localKv('put', 'sync:entitlement', 'everyone')
      try {
        const session = await openSession()
        const phone = slot()
        const tablet = slot()

        const tabletLive = await openLive(
          { ...bearerHeaders(session), upgrade: 'websocket', 'x-ww-slot-id': tablet },
          '/accounts/v1/sync/live'
        )
        expect(tabletLive.status).toBe(101)
        if (tabletLive.status !== 101) return
        const hello = JSON.parse(await tabletLive.connection.next())
        expect(hello).toEqual({ type: 'hello', seq: 0 })
        tabletLive.connection.send('ping')
        expect(await tabletLive.connection.next()).toBe('pong')

        const bytes = randomBytes(200_000)
        const stored = await put(session, phone, bytes)
        expect(stored.status).toBe(200)
        expect(stored.body).toMatchObject({
          ok: true,
          etag: await sha256B64u(bytes),
          size: 200_000,
          seq: 1,
        })
        expect(JSON.parse(await tabletLive.connection.next())).toEqual({
          type: 'changed',
          seq: 1,
        })

        const listed = await syncOp(session, 'list')
        expect(listed.body).toMatchObject({
          ok: true,
          seq: 1,
          slots: [{ slotId: phone, etag: stored.body.etag, size: 200_000 }],
        })

        const got = await httpBytes('/accounts/v1/sync/get', {
          json: { slotId: phone },
          headers: bearerHeaders(session),
        })
        expect(got.status).toBe(200)
        expect(got.bytes).toEqual(bytes)
        expect(got.headers.get('etag')).toBe(`"${stored.body.etag}"`)

        // A stale If-Match is refused; the current one goes through.
        await new Promise((resolve) => setTimeout(resolve, 2_100))
        const stale = await put(session, phone, randomBytes(10), {
          'if-match': `"${await sha256B64u(randomBytes(4))}"`,
        })
        expect(stale.status).toBe(412)
        const next = await put(session, phone, randomBytes(10), {
          'if-match': `"${stored.body.etag}"`,
        })
        expect(next.status).toBe(200)
        expect(JSON.parse(await tabletLive.connection.next())).toEqual({
          type: 'changed',
          seq: 2,
        })

        // The kill switch refuses reads and writes, never the delete.
        localKv('put', 'sync:enabled', 'false')
        try {
          const off = await syncOp(session, 'list')
          expect(off.status).toBe(503)
          expect(off.body.code).toBe('disabled')
        } finally {
          localKv('delete', 'sync:enabled')
        }

        expect((await syncOp(session, 'delete', { slotId: phone })).body).toEqual({
          ok: true,
          seq: 3,
        })
        expect(JSON.parse(await tabletLive.connection.next())).toEqual({
          type: 'changed',
          seq: 3,
        })
        expect((await syncOp(session, 'list')).body).toEqual({
          ok: true,
          seq: 3,
          slots: [],
        })
        tabletLive.connection.end()
      } finally {
        localKv('delete', 'sync:entitlement')
      }
    }
  )
})
