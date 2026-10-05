import { afterAll, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { DEV_BYPASS_TOKEN, configured, http, writeTranscript } from '../test/e2e'

/**
 * Notes Import without inference: the dev-bypass verify probe, the App Attest
 * challenge, and kickoff's auth gate. A real kickoff calls OpenRouter (paid),
 * so it only runs with WW_API_E2E_ALLOW_PAID=1 and OPENROUTER_API_KEY set.
 */

afterAll(() => {
  writeTranscript('notes-import')
})

const bypass = (token = DEV_BYPASS_TOKEN ?? '') => ({ 'x-ww-dev-bypass': token })
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe.skipIf(!DEV_BYPASS_TOKEN)('POST /notes-import/verify with the dev bypass', () => {
  it('accepts a v1 probe', async () => {
    const res = await http('POST', '/notes-import/verify', {
      body: {},
      headers: bypass(),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('echoes a valid v2 probe operationId', async () => {
    const hash = sha256('verify-probe')
    const operationId = `op_${randomUUID().replaceAll('-', '')}`
    const res = await http('POST', '/notes-import/verify', {
      headers: bypass(),
      body: {
        protocolVersion: 2,
        operation: 'assert',
        operationId,
        purpose: 'notes-import-verify',
        contentHash: hash,
        requestHash: hash,
      },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, protocolVersion: 2, operationId })
  })

  it('rejects a v2 probe whose requestHash differs', async () => {
    const res = await http('POST', '/notes-import/verify', {
      headers: bypass(),
      body: {
        protocolVersion: 2,
        operation: 'assert',
        operationId: 'op_mismatch01',
        purpose: 'notes-import-verify',
        contentHash: sha256('a'),
        requestHash: sha256('b'),
      },
    })
    expect(res.status).toBe(400)
  })

  it('treats a wrong bypass token as an unattested request', async () => {
    const res = await http('POST', '/notes-import/verify', {
      body: {},
      headers: bypass('not-the-token'),
    })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Missing uuid')
  })

  it('rejects malformed JSON', async () => {
    const res = await http('POST', '/notes-import/verify', {
      raw: '{not json',
      headers: bypass(),
    })
    expect(res.status).toBe(400)
  })
})

describe('App Attest handshake (no inference)', () => {
  it('POST /notes-import/challenge issues a challenge', async () => {
    const res = await http('POST', '/notes-import/challenge', { body: {} })
    expect(res.status).toBe(200)
    expect(typeof res.body.challenge).toBe('string')
    expect(res.body.challenge.length).toBeGreaterThan(16)
  })

  it('kickoff without credentials is refused before any model call', async () => {
    const status = await http('GET', '/notes-import/status')
    const res = await http('POST', '/notes-import/kickoff', {
      body: {
        uuid: randomUUID(),
        notesText: 'Visited Jane',
        context: {
          now: new Date().toISOString(),
          timeZone: 'UTC',
          existingContacts: [],
          existingCategories: [],
        },
      },
    })
    // 503 when the provider probe says no ZDR host is up; otherwise 401.
    expect(res.status).toBe(status.body.available ? 401 : 503)
  })

  it('stream endpoints refuse a missing token', async () => {
    const res = await http('GET', '/notes-import/someImportId/result')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

const allowPaid =
  process.env.WW_API_E2E_ALLOW_PAID === '1' &&
  configured('OPENROUTER_API_KEY') &&
  Boolean(DEV_BYPASS_TOKEN)

describe.skipIf(!allowPaid)('PAID: kickoff → result (WW_API_E2E_ALLOW_PAID=1)', () => {
  it('runs one tiny import to completion', { timeout: 180_000 }, async () => {
    const kickoff = await http('POST', '/notes-import/kickoff', {
      headers: bypass(),
      body: {
        uuid: randomUUID(),
        notesText: 'Oct 1: 2 hours in service. Return visit with Jane Doe, 12 Main St.',
        context: {
          now: new Date().toISOString(),
          timeZone: 'UTC',
          existingContacts: [],
          existingCategories: [],
        },
      },
    })
    expect(kickoff.status).toBe(200)
    const { importId, subscribeToken } = kickoff.body
    let result = { status: 'running' } as { status: string }
    const deadline = Date.now() + 170_000
    while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(result.status)) {
      await new Promise((r) => setTimeout(r, 3_000))
      result = (await http('GET', `/notes-import/${importId}/result?token=${subscribeToken}`)).body
    }
    expect(result.status).toBe('done')
  })
})
