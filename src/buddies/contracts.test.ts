import { describe, expect, it } from 'vitest'
import { BUDDIES_PAYLOAD_PARSERS, decodeSignature } from './contracts'
import { bytesToBase64Url } from '../crypto'

const NOW = Date.UTC(2026, 8, 23)
const id = (fill = 'A') => fill.repeat(22)
const b64uOfBytes = (size: number) =>
  bytesToBase64Url(new Uint8Array(size).fill(7))
const signed = { ts: NOW, nonce: id('N'), inboxId: id('I') }

const parse = <K extends keyof typeof BUDDIES_PAYLOAD_PARSERS>(
  op: K,
  payload: Record<string, unknown>
) => BUDDIES_PAYLOAD_PARSERS[op](payload, NOW)

describe('ids, keys, and signatures', () => {
  it.each([
    ['22 url-safe chars', 'Ab0_-Ab0_-Ab0_-Ab0_-Ab', true],
    ['21 chars', 'A'.repeat(21), false],
    ['23 chars', 'A'.repeat(23), false],
    ['standard base64 chars', `${'A'.repeat(20)}+/`, false],
    ['padding', `${'A'.repeat(21)}=`, false],
  ])('validates an id with %s', (_, inboxId, valid) => {
    expect(parse('inbox/delete', { ...signed, inboxId }) !== null).toBe(valid)
  })

  it('requires an integer ts and a 22-char nonce', () => {
    expect(parse('inbox/delete', { ...signed, ts: NOW + 0.5 })).toBeNull()
    expect(parse('inbox/delete', { ...signed, ts: String(NOW) })).toBeNull()
    expect(parse('inbox/delete', { ...signed, nonce: 'short' })).toBeNull()
    expect(parse('inbox/delete', { ...signed, nonce: undefined })).toBeNull()
  })

  it('requires 32-byte keys and returns them canonically encoded', () => {
    const key = b64uOfBytes(32)
    expect(parse('inbox/register', { ...signed, ownerPub: key })).toEqual({
      ...signed,
      ownerPub: key,
    })
    expect(
      parse('inbox/register', { ...signed, ownerPub: b64uOfBytes(31) })
    ).toBeNull()
    expect(
      parse('inbox/register', { ...signed, ownerPub: b64uOfBytes(33) })
    ).toBeNull()
    // Unused trailing bits don't make a different key.
    const noncanonical = `${key.slice(0, 42)}${String.fromCharCode(key.charCodeAt(42) + 1)}`
    expect(
      parse('inbox/register', { ...signed, ownerPub: noncanonical })?.ownerPub
    ).toBe(key)
  })

  it('decodes only 64-byte signatures', () => {
    expect(decodeSignature(b64uOfBytes(64))).toHaveLength(64)
    expect(decodeSignature(b64uOfBytes(63))).toBeNull()
    expect(decodeSignature(undefined)).toBeNull()
  })

  it('drops unknown fields, including the reserved attest', () => {
    expect(
      parse('inbox/register', {
        ...signed,
        ownerPub: b64uOfBytes(32),
        attest: { x: 1 },
        extra: 1,
      })
    ).toEqual({ ...signed, ownerPub: b64uOfBytes(32) })
  })
})

describe('blob sizes (decoded bytes)', () => {
  it.each([
    ['roster/put', 32 * 1024, {}],
    ['card/put', 16 * 1024, { slotId: id('S') }],
    [
      'event/put',
      8 * 1024,
      { slotId: id('S'), eventId: id('E'), kind: 'pair.confirmed', push: true },
    ],
    [
      'invite/create',
      4 * 1024,
      { inviteId: id('V'), claimVerifier: b64uOfBytes(32), expiresAt: NOW + 1 },
    ],
  ] as const)('%s accepts up to %i bytes', (op, max, extra) => {
    expect(
      parse(op, { ...signed, ...extra, blob: b64uOfBytes(max) })
    ).not.toBeNull()
    expect(
      parse(op, { ...signed, ...extra, blob: b64uOfBytes(max + 1) })
    ).toBeNull()
    expect(parse(op, { ...signed, ...extra, blob: '' })).toBeNull()
    expect(parse(op, { ...signed, ...extra, blob: 'AAAAA' })).toBeNull()
  })

  it('invite/claim takes a 4 KiB blob and a 32-byte claim secret', () => {
    const claim = { inviteId: id('V'), claimSecret: b64uOfBytes(32) }
    expect(
      parse('invite/claim', { ...claim, blob: b64uOfBytes(4096) })
    ).toMatchObject({
      inviteId: id('V'),
      claimSecret: new Uint8Array(32).fill(7),
    })
    expect(
      parse('invite/claim', { ...claim, blob: b64uOfBytes(4097) })
    ).toBeNull()
    expect(
      parse('invite/claim', {
        ...claim,
        claimSecret: b64uOfBytes(31),
        blob: b64uOfBytes(1),
      })
    ).toBeNull()
  })
})

describe('event kinds and templates', () => {
  const event = {
    ...signed,
    slotId: id('S'),
    eventId: id('E'),
    blob: b64uOfBytes(4),
    push: false,
  }

  it.each([
    ['pair.confirmed', true],
    ['a'.repeat(40), true],
    ['a'.repeat(41), false],
    ['Pair.confirmed', false],
    ['1abc', false],
    ['pair_confirmed', false],
    ['', false],
  ])('kind %j valid=%s', (kind, valid) => {
    expect(parse('event/put', { ...event, kind }) !== null).toBe(valid)
  })

  it('requires push to be a boolean', () => {
    expect(parse('event/put', { ...event, kind: 'k', push: 'yes' })).toBeNull()
    expect(
      parse('event/put', { ...event, kind: 'k', push: undefined })
    ).toBeNull()
  })

  const device = {
    ...signed,
    deviceId: id('D'),
    apnsToken: 'AB'.repeat(32),
    apnsEnvironment: 'sandbox',
  }

  it('accepts templates up to 200 characters, counting code points', () => {
    const emoji = '\u{1F64C}'.repeat(200)
    const parsed = parse('device/register', {
      ...device,
      templates: {
        'invite.claimed': { title: emoji, body: 'b'.repeat(200), extra: 1 },
      },
    })
    expect(parsed).toMatchObject({
      apnsToken: 'ab'.repeat(32),
      templates: { 'invite.claimed': { title: emoji, body: 'b'.repeat(200) } },
    })
    expect(parsed?.templates['invite.claimed']).toEqual({
      title: emoji,
      body: 'b'.repeat(200),
    })
    expect(
      parse('device/register', {
        ...device,
        templates: { 'invite.claimed': { title: 't', body: 'b'.repeat(201) } },
      })
    ).toBeNull()
  })

  it('rejects bad template keys, shapes, counts, tokens, and environments', () => {
    const template = { title: 't', body: 'b' }
    expect(
      parse('device/register', { ...device, templates: { Bad: template } })
    ).toBeNull()
    expect(
      parse('device/register', {
        ...device,
        templates: { k: { title: 1, body: 'b' } },
      })
    ).toBeNull()
    expect(parse('device/register', { ...device, templates: [] })).toBeNull()
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`k${i}`, template])
    )
    expect(parse('device/register', { ...device, templates: many })).toBeNull()
    expect(
      parse('device/register', { ...device, templates: {} })
    ).not.toBeNull()
    expect(
      parse('device/register', { ...device, templates: {}, apnsToken: 'xyz' })
    ).toBeNull()
    expect(
      parse('device/register', { ...device, templates: {}, apnsToken: 'abc' })
    ).toBeNull()
    expect(
      parse('device/register', {
        ...device,
        templates: {},
        apnsEnvironment: 'development',
      })
    ).toBeNull()
  })
})

describe('invite/create expiry and inbox/sync cursor', () => {
  const invite = {
    ...signed,
    inviteId: id('V'),
    claimVerifier: b64uOfBytes(32),
    blob: b64uOfBytes(10),
  }

  it('accepts expiresAt in (now, now + 7 days + 5 minutes]', () => {
    const ceiling = NOW + 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000
    expect(
      parse('invite/create', { ...invite, expiresAt: ceiling })
    ).not.toBeNull()
    expect(
      parse('invite/create', { ...invite, expiresAt: ceiling + 1 })
    ).toBeNull()
    expect(parse('invite/create', { ...invite, expiresAt: NOW })).toBeNull()
    expect(
      parse('invite/create', { ...invite, expiresAt: NOW + 1.5 })
    ).toBeNull()
  })

  it('requires since to be a non-negative integer', () => {
    expect(parse('inbox/sync', { ...signed, since: 0 })).toEqual({
      ...signed,
      since: 0,
    })
    expect(parse('inbox/sync', { ...signed, since: -1 })).toBeNull()
    expect(parse('inbox/sync', { ...signed, since: 1.5 })).toBeNull()
    expect(parse('inbox/sync', { ...signed })).toBeNull()
  })
})
