import { describe, expect, it } from 'vitest'
import { bytesToBase64Url } from '../crypto'
import {
  parseEnvelope,
  readEnvelopeText,
  signedMessage,
  verifyBuddiesSignature,
} from './envelope'
import { SigningKey } from '../test/buddiesClient'

const encoder = new TextEncoder()
const b64u = (value: string | Uint8Array) =>
  bytesToBase64Url(typeof value === 'string' ? encoder.encode(value) : value)

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://relay.test/buddies/v1/inbox/sync', {
    method: 'POST',
    body,
    headers,
  })

describe('signedMessage', () => {
  it('prefixes the payload bytes with the protocol context and op', () => {
    const payload = encoder.encode('{"a":1}')
    const message = signedMessage('card/put', payload)
    expect(new TextDecoder().decode(message)).toBe(
      'ww-buddies/v1\ncard/put\n{"a":1}'
    )
  })
})

describe('verifyBuddiesSignature', () => {
  it('accepts the signer, and rejects a wrong key, tampered bytes, or another op', async () => {
    const key = await SigningKey.generate()
    const other = await SigningKey.generate()
    const payload = encoder.encode('{"inboxId":"x","since":0}')
    const signature = await key.sign(signedMessage('inbox/sync', payload))

    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        payload,
        signature
      )
    ).toBe(true)
    expect(
      await verifyBuddiesSignature(
        other.publicKey,
        'inbox/sync',
        payload,
        signature
      )
    ).toBe(false)

    const tampered = payload.slice()
    tampered[tampered.length - 2] ^= 1
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        tampered,
        signature
      )
    ).toBe(false)
    const flipped = signature.slice()
    flipped[0] ^= 0x80
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        payload,
        flipped
      )
    ).toBe(false)
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/delete',
        payload,
        signature
      )
    ).toBe(false)
  })

  it('treats malformed keys and signatures as invalid instead of throwing', async () => {
    const key = await SigningKey.generate()
    const payload = encoder.encode('{}')
    const signature = await key.sign(signedMessage('inbox/sync', payload))
    expect(
      await verifyBuddiesSignature(
        'not-a-key',
        'inbox/sync',
        payload,
        signature
      )
    ).toBe(false)
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        payload,
        signature.slice(0, 63)
      )
    ).toBe(false)
  })

  it('is sensitive to the exact payload bytes, so re-serializing would break it', async () => {
    const key = await SigningKey.generate()
    const original = encoder.encode('{ "since": 0, "inboxId": "x" }')
    const signature = await key.sign(signedMessage('inbox/sync', original))
    const reserialized = encoder.encode(
      JSON.stringify(JSON.parse('{ "since": 0, "inboxId": "x" }'))
    )
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        original,
        signature
      )
    ).toBe(true)
    expect(
      await verifyBuddiesSignature(
        key.publicKey,
        'inbox/sync',
        reserialized,
        signature
      )
    ).toBe(false)
  })
})

describe('parseEnvelope', () => {
  it('returns the decoded payload bytes, the parsed payload, and the raw signature', () => {
    const payload = '{"inboxId":"abc","since":0}'
    const parsed = parseEnvelope(JSON.stringify({ p: b64u(payload), s: 'sig' }))
    expect(parsed).not.toBeNull()
    expect(new TextDecoder().decode(parsed?.payloadBytes)).toBe(payload)
    expect(parsed?.payload).toEqual({ inboxId: 'abc', since: 0 })
    expect(parsed?.signature).toBe('sig')
  })

  it.each([
    ['non-JSON', 'nope'],
    ['an array', '[]'],
    ['a missing p', '{"s":"x"}'],
    ['an empty p', '{"p":""}'],
    ['padded base64', JSON.stringify({ p: `${b64u('{"a":1}')}=` })],
    ['standard base64', JSON.stringify({ p: '+/+/' })],
    ['a payload that is not JSON', JSON.stringify({ p: b64u('hello') })],
    ['a payload that is an array', JSON.stringify({ p: b64u('[1]') })],
    ['a payload that is null', JSON.stringify({ p: b64u('null') })],
    [
      'invalid UTF-8',
      JSON.stringify({ p: b64u(Uint8Array.from([0x7b, 0xff, 0x7d])) }),
    ],
  ])('rejects %s', (_, text) => {
    expect(parseEnvelope(text)).toBeNull()
  })
})

describe('readEnvelopeText', () => {
  it('reads a normal body', async () => {
    expect(await readEnvelopeText(post('{"p":"x"}'))).toBe('{"p":"x"}')
  })

  it('refuses a declared or streamed body over 256 KiB', async () => {
    expect(
      await readEnvelopeText(
        post('x', { 'content-length': String(300 * 1024) })
      )
    ).toBeNull()
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const request = new Request('https://relay.test/', {
      method: 'POST',
      body: stream,
      // @ts-expect-error Node's fetch requires duplex for streamed bodies.
      duplex: 'half',
    })
    expect(await readEnvelopeText(request)).toBeNull()
  })

  it('refuses a missing body and invalid UTF-8', async () => {
    expect(await readEnvelopeText(post(null))).toBeNull()
    expect(
      await readEnvelopeText(post(Uint8Array.from([0xff, 0xfe])))
    ).toBeNull()
  })
})
