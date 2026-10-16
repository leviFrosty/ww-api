import { afterAll, describe, expect, it } from 'vitest'
import { accountSignedMessage } from '../accounts/contracts'
import { SigningKey, b64u, randomId } from '../test/buddiesClient'
import {
  DEV_BYPASS_TOKEN,
  LOCAL_LAUNCHER,
  configured,
  http,
  localKv,
  writeTranscript,
} from '../test/e2e'

/**
 * Notes Import on account sessions: a dev-bypass session's bearer token runs
 * kickoff → SSE events → result → destroy, another account gets 404 for that
 * import, and legacy requests get 426 once the legacy switch is off.
 *
 * The lifecycle runs only against the local launcher without an OpenRouter
 * key, where the run fails at the model call (free) and still walks every
 * route; with a key it would spend, so it needs WW_API_E2E_ALLOW_PAID=1.
 */

afterAll(() => {
  writeTranscript('notes-import-accounts')
})

const encoder = new TextEncoder()
const CONTEXT = {
  now: '2026-10-15T08:00:00-04:00',
  timeZone: 'America/New_York',
  existingContacts: [],
  existingCategories: [],
}

interface Session {
  accountId: string
  accessToken: string
}

/** Opens a session with the dev bypass in place of attestation. */
const openSession = async (): Promise<Session> => {
  const key = await SigningKey.generate()
  const bytes = encoder.encode(
    JSON.stringify({ accountPub: key.publicKey, ts: Date.now(), nonce: randomId() })
  )
  const res = await http('POST', '/accounts/v1/sessions', {
    headers: { 'x-ww-dev-bypass': DEV_BYPASS_TOKEN ?? '' },
    body: {
      payload: b64u(bytes),
      signature: b64u(await key.sign(accountSignedMessage('session/open', bytes))),
    },
  })
  expect(res.status).toBe(201)
  return res.body
}

const bearer = (session: Session) => ({
  authorization: `Bearer ${session.accessToken}`,
})

const runRoute = (importId: string, op: string, session: Session) =>
  http(op === 'events' || op === 'result' ? 'GET' : 'POST', `/notes-import/${importId}/${op}`, {
    headers: bearer(session),
  })

const TERMINAL = ['done', 'error', 'cancelled']

const waitForTerminal = async (importId: string, session: Session) => {
  let result = await runRoute(importId, 'result', session)
  const deadline = Date.now() + 25_000
  while (!TERMINAL.includes(result.body.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    result = await runRoute(importId, 'result', session)
  }
  return result
}

const freeRun =
  (LOCAL_LAUNCHER && !configured('OPENROUTER_API_KEY')) ||
  process.env.WW_API_E2E_ALLOW_PAID === '1'

describe.skipIf(!DEV_BYPASS_TOKEN)('Notes Import with a bearer token', () => {
  it('refuses a bad token with 401 and never falls back to attestation', async () => {
    const res = await http('POST', '/notes-import/kickoff', {
      headers: {
        authorization: 'Bearer not.a.token',
        'x-ww-dev-bypass': DEV_BYPASS_TOKEN ?? '',
      },
      body: { uuid: 'E5F6A7B8-0000-4000-8000-000000000004', notesText: 'x', context: CONTEXT },
    })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(typeof res.body.error).toBe('string')
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
  })

  it('answers an unknown import with 404 not_found', async () => {
    const session = await openSession()
    const res = await runRoute(`imp_${'0'.repeat(40)}`, 'result', session)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ ok: false, error: 'Import not found', code: 'not_found' })
  })

  it.skipIf(!freeRun)(
    'kickoff → events → result → destroy, and another account gets 404',
    { timeout: 60_000 },
    async () => {
      const owner = await openSession()
      const stranger = await openSession()
      const body = { notesText: `Field service 1 hour ${randomId()}`, context: CONTEXT }
      const kickoff = await http('POST', '/notes-import/kickoff', {
        headers: bearer(owner),
        body,
      })
      expect(kickoff.status).toBe(200)
      expect(Object.keys(kickoff.body).sort()).toEqual(['credits', 'importId', 'refinement'])
      expect(kickoff.body.importId).toMatch(/^imp_[a-f0-9]{40}$/)
      // A dev session gets the bypass's unlimited allowances.
      expect(kickoff.body.credits).toMatchObject({ limit: null, isSupporter: false })
      const { importId } = kickoff.body

      const result = await waitForTerminal(importId, owner)
      expect(result.status).toBe(200)
      expect(TERMINAL).toContain(result.body.status)

      const events = await runRoute(importId, 'events', owner)
      expect(events.status).toBe(200)
      expect(events.headers.get('content-type')).toContain('text/event-stream')
      expect(events.text).toMatch(/event: (done|error)\n/)

      for (const op of ['events', 'result', 'cancel', 'destroy']) {
        const foreign = await runRoute(importId, op, stranger)
        expect(foreign.status, op).toBe(404)
        expect(foreign.body, op).toEqual({ ok: false, error: 'Import not found', code: 'not_found' })
      }
      // The stranger's destroy touched nothing.
      expect((await runRoute(importId, 'result', owner)).body.status).toBe(result.body.status)

      const destroyed = await runRoute(importId, 'destroy', owner)
      expect(destroyed.status).toBe(200)
      expect(destroyed.body).toEqual({ ok: true })
      expect((await runRoute(importId, 'result', owner)).status).toBe(404)

      // The same notes again: the same run object, recreated after deleteAll().
      const again = await http('POST', '/notes-import/kickoff', {
        headers: bearer(owner),
        body,
      })
      expect(again.status).toBe(200)
      expect(again.body.importId).toBe(importId)
      expect(TERMINAL).toContain((await waitForTerminal(importId, owner)).body.status)
      await runRoute(importId, 'destroy', owner)
    }
  )
})

describe.skipIf(!LOCAL_LAUNCHER || !DEV_BYPASS_TOKEN)('the legacy switch (local KV)', () => {
  it('refuses legacy Notes Import requests with 426 while bearer ones work', async () => {
    const session = await openSession()
    const legacyKickoff = {
      uuid: 'F6A7B8C9-0000-4000-8000-000000000005',
      notesText: 'Field service 1 hour',
      context: CONTEXT,
    }
    try {
      localKv('put', 'auth:legacy', 'off')
      const refused = [
        await http('POST', '/notes-import/kickoff', {
          headers: { 'x-ww-dev-bypass': DEV_BYPASS_TOKEN ?? '' },
          body: legacyKickoff,
        }),
        await http('POST', '/notes-import/transcribe', {
          headers: { 'x-ww-dev-bypass': DEV_BYPASS_TOKEN ?? '' },
          body: { uuid: legacyKickoff.uuid, image: '/9j/4AAQ', mimeType: 'image/jpeg' },
        }),
        await http('GET', `/notes-import/imp_${'0'.repeat(40)}/result?token=anything`),
      ]
      for (const res of refused) {
        expect(res.status).toBe(426)
        expect(res.body).toEqual({
          ok: false,
          error: 'Update WitnessWork to keep using Notes Import',
          code: 'upgrade_required',
        })
        expect(res.headers.get('retry-after')).toBeNull()
      }
      // Bearer requests carry on (no inference: an unknown import).
      const viaToken = await runRoute(`imp_${'0'.repeat(40)}`, 'result', session)
      expect(viaToken.status).toBe(404)
      // Status stays public.
      expect((await http('GET', '/notes-import/status')).status).toBe(200)
    } finally {
      localKv('delete', 'auth:legacy')
    }
    const back = await http('GET', `/notes-import/imp_${'0'.repeat(40)}/result?token=anything`)
    expect(back.status).toBe(401)
  })
})
