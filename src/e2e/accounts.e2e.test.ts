import { afterAll, describe, expect, it } from 'vitest'
import { accountSignedMessage, type AccountsOp } from '../accounts/contracts'
import {
  SigningKey,
  b64u,
  randomBytes,
  randomId,
  sha256B64u,
} from '../test/buddiesClient'
import { ADMIN_TOKEN, http, httpBytes, writeTranscript } from '../test/e2e'

/**
 * Anonymous accounts: register, read the account back with account/info, move
 * the key through a handoff channel, and back up to R2.
 */

afterAll(() => {
  writeTranscript('accounts')
})

const encoder = new TextEncoder()

const signedEnvelope = async (
  op: AccountsOp,
  key: SigningKey,
  fields: Record<string, unknown> = {},
  signer = key
) => {
  const bytes = encoder.encode(
    JSON.stringify({
      accountPub: key.publicKey,
      ts: Date.now(),
      nonce: randomId(),
      ...fields,
    })
  )
  return {
    payload: b64u(bytes),
    signature: b64u(await signer.sign(accountSignedMessage(op, bytes))),
  }
}

const send = async (
  op: AccountsOp,
  key: SigningKey,
  signer = key,
  fields: Record<string, unknown> = {}
) =>
  http('POST', `/accounts/v1/${op}`, {
    body: await signedEnvelope(op, key, fields, signer),
  })

const registered = async () => {
  const key = await SigningKey.generate()
  expect((await send('account/register', key)).status).toBe(200)
  return key
}

describe('POST /accounts/v1/account/info', () => {
  it('404s for a key that never registered, without creating it', async () => {
    const key = await SigningKey.generate()
    const res = await send('account/info', key)
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ ok: false, code: 'unknown_account' })
  })

  it('reads back the account register created', async () => {
    const key = await SigningKey.generate()
    const registered = await send('account/register', key)
    expect(registered.status).toBe(200)
    const { accountId } = registered.body as { accountId: string }

    const res = await send('account/info', key)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      accountId,
      accountPub: key.publicKey,
      status: 'active',
      createdAt: expect.any(Number),
      inboxIds: [],
      statusChanges: [],
    })
  })

  it('refuses another key’s signature', async () => {
    const key = await SigningKey.generate()
    await send('account/register', key)
    const res = await send('account/info', key, await SigningKey.generate())
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ code: 'bad_signature' })
  })

  it.skipIf(!ADMIN_TOKEN)('shows a suspension made through admin', async () => {
    const key = await SigningKey.generate()
    const { accountId } = (await send('account/register', key)).body as {
      accountId: string
    }
    const suspended = await http('POST', '/admin/accounts/status', {
      headers: { 'x-ww-admin-token': ADMIN_TOKEN ?? '' },
      body: { accountId, status: 'suspended', reason: 'admin' },
    })
    expect(suspended.status).toBe(200)

    const res = await send('account/info', key)
    expect(res.body).toMatchObject({
      status: 'suspended',
      statusChanges: [{ status: 'suspended', createdAt: expect.any(Number) }],
    })
    expect(JSON.stringify(res.body)).not.toContain('admin')
  })
})

describe('POST /accounts/v1/handoff/*', () => {
  it('relays a sealed key from the old phone to the new one', async () => {
    const key = await registered()
    const token = randomBytes(16)
    const channelId = randomId()
    const claimToken = b64u(token)
    const opened = await send('handoff/open', key, key, {
      channelId,
      verifier: await sha256B64u(token),
    })
    expect(opened.status).toBe(200)
    expect(opened.body).toEqual({ ok: true, expiresAt: expect.any(Number) })

    const claimPub = (await SigningKey.generate()).publicKey
    const hello = b64u(randomBytes(120))
    const claim = { channelId, claimToken, claimPub, hello }
    expect((await http('POST', '/accounts/v1/handoff/claim', { body: claim })).status).toBe(200)
    // A lost response, repeated.
    expect((await http('POST', '/accounts/v1/handoff/claim', { body: claim })).status).toBe(200)

    const status = await send('handoff/status', key, key, { channelId })
    expect(status.body).toMatchObject({ ok: true, status: 'claimed', claimPub, hello })
    // Another account can't read it.
    const stranger = await registered()
    expect((await send('handoff/status', stranger, stranger, { channelId })).body.code).toBe('forbidden')

    const sealedKey = b64u(randomBytes(80))
    expect((await send('handoff/send', key, key, { channelId, key: sealedKey })).status).toBe(200)
    const received = await http('POST', '/accounts/v1/handoff/receive', {
      body: { channelId, claimToken },
    })
    expect(received.body).toEqual({ ok: true, status: 'sent', key: sealedKey })
    expect(
      (await http('POST', '/accounts/v1/handoff/done', { body: { channelId, claimToken } })).status
    ).toBe(200)
    expect((await send('handoff/status', key, key, { channelId })).body).toEqual({
      ok: true,
      status: 'done',
      expiresAt: opened.body.expiresAt,
    })
  })

  it('burns a channel after five wrong tokens', async () => {
    const key = await registered()
    const token = randomBytes(16)
    const channelId = randomId()
    await send('handoff/open', key, key, { channelId, verifier: await sha256B64u(token) })
    for (let i = 0; i < 5; i++) {
      const wrong = await http('POST', '/accounts/v1/handoff/receive', {
        body: { channelId, claimToken: randomId() },
      })
      expect(wrong.body.code).toBe('bad_signature')
    }
    expect((await send('handoff/status', key, key, { channelId })).body.status).toBe('cancelled')
  })
})

describe('POST /accounts/v1/backup/*', () => {
  const put = async (key: SigningKey, slotId: string, bytes: Uint8Array) => {
    const { payload, signature } = await signedEnvelope('backup/put', key, {
      slotId,
      size: bytes.byteLength,
      sha256: await sha256B64u(bytes),
    })
    return httpBytes('/accounts/v1/backup/put', {
      bytes,
      headers: { 'x-ww-payload': payload, 'x-ww-signature': signature },
    })
  }

  it('round-trips a slot through R2 and deletes it', async () => {
    const key = await registered()
    const slotId = randomId()
    const bytes = randomBytes(64 * 1_024)
    const stored = await put(key, slotId, bytes)
    expect(stored.status).toBe(200)
    expect(stored.body).toEqual({ ok: true, uploadedAt: expect.any(Number) })
    // One put a slot a minute.
    const again = await put(key, slotId, bytes)
    expect(again.status).toBe(429)
    expect(again.body.code).toBe('rate_limited')

    const listed = await send('backup/list', key)
    expect(listed.body).toEqual({
      ok: true,
      slots: [{ slotId, size: bytes.byteLength, uploadedAt: stored.body.uploadedAt }],
    })

    const got = await httpBytes('/accounts/v1/backup/get', {
      json: await signedEnvelope('backup/get', key, { slotId }),
    })
    expect(got.status).toBe(200)
    expect(got.bytes).toEqual(bytes)

    expect((await send('backup/delete', key)).status).toBe(200)
    expect((await send('backup/list', key)).body.slots).toEqual([])
  })

  it('refuses a body whose sha256 differs', async () => {
    const key = await registered()
    const bytes = randomBytes(1_000)
    const { payload, signature } = await signedEnvelope('backup/put', key, {
      slotId: randomId(),
      size: bytes.byteLength,
      sha256: await sha256B64u(randomBytes(1_000)),
    })
    const res = await httpBytes('/accounts/v1/backup/put', {
      bytes,
      headers: { 'x-ww-payload': payload, 'x-ww-signature': signature },
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_request')
  })
})

describe('GET /accounts/handoff', () => {
  it.each(['/accounts/handoff', '/h'])('%s serves the scan-from-the-app page', async (path) => {
    const res = await http('GET', path)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Scan this code in WitnessWork')
  })
})
