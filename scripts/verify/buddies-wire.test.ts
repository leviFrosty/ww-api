import { expect, it } from 'vitest'
import { BUDDIES_LIMITS, BUDDIES_OPS, BUDDIES_UNSIGNED_OPS } from '../../src/buddies/contracts'
import { signedMessage, verifyBuddiesSignature } from '../../src/buddies/envelope'
import * as wire from './buddies-wire.mjs'

/** Keeps the verify fuzzer's plain-Node wire client in sync with the relay. */

it('mirrors the relay limits the fuzzer probes', () => {
  for (const [name, value] of Object.entries(wire.WIRE_LIMITS)) {
    expect(BUDDIES_LIMITS[name as keyof typeof BUDDIES_LIMITS], name).toBe(value)
  }
})

it('knows every op', () => {
  expect([...wire.ALL_OPS].sort()).toEqual([...BUDDIES_OPS].sort())
  expect(wire.UNSIGNED_OPS).toEqual([...BUDDIES_UNSIGNED_OPS])
})

it('signs exactly what the relay verifies', async () => {
  const key = await wire.signingKeyFromSeed(new Uint8Array(32).fill(7))
  const envelope = await wire.signedEnvelope('inbox/sync', { since: 0 }, key)
  const payloadBytes = wire.fromB64u(envelope.p)
  expect(wire.signedMessage('inbox/sync', payloadBytes)).toEqual(
    signedMessage('inbox/sync', payloadBytes)
  )
  expect(
    await verifyBuddiesSignature(key.publicKey, 'inbox/sync', payloadBytes, wire.fromB64u(envelope.s))
  ).toBe(true)
})
