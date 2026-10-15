import { afterAll, describe, expect, it } from 'vitest'
import { accountSignedMessage, type AccountsOp } from '../accounts/contracts'
import { SigningKey, b64u, randomId } from '../test/buddiesClient'
import { ADMIN_TOKEN, http, writeTranscript } from '../test/e2e'

/** Anonymous accounts: register, then read the account back with account/info. */

afterAll(() => {
  writeTranscript('accounts')
})

const encoder = new TextEncoder()

const send = async (op: AccountsOp, key: SigningKey, signer = key) => {
  const bytes = encoder.encode(
    JSON.stringify({ accountPub: key.publicKey, ts: Date.now(), nonce: randomId() })
  )
  return http('POST', `/accounts/v1/${op}`, {
    body: {
      p: b64u(bytes),
      s: b64u(await signer.sign(accountSignedMessage(op, bytes))),
    },
  })
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
