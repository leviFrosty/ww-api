import { bytesToBase64Url } from '../crypto'
import { signedMessage } from '../buddies/envelope'
import type { BuddiesSignedOp } from '../buddies/contracts'

/** Client-side helpers for Buddies tests: keys, ids, and signed envelopes. */

const encoder = new TextEncoder()

export const b64u = (bytes: Uint8Array): string => bytesToBase64Url(bytes)
export const randomBytes = (size: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(size))
export const randomId = (): string => b64u(randomBytes(16))
export const blobOfSize = (size: number): string => b64u(randomBytes(size))

/** An Ed25519 signing key (WebCrypto), optionally from a 32-byte seed. */
export class SigningKey {
  private constructor(
    readonly publicKey: string,
    private readonly privateKey: CryptoKey
  ) {}

  static async generate(): Promise<SigningKey> {
    return SigningKey.fromSeed(randomBytes(32))
  }

  static async fromSeed(seed: Uint8Array): Promise<SigningKey> {
    // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
    const prefix = Uint8Array.from([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x04, 0x22, 0x04, 0x20,
    ])
    const pkcs8 = new Uint8Array(prefix.length + 32)
    pkcs8.set(prefix)
    pkcs8.set(seed, prefix.length)
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'Ed25519' },
      true,
      ['sign']
    )
    const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey
    return new SigningKey(jwk.x as string, privateKey)
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, this.privateKey, message)
    )
  }
}

export interface Envelope {
  p: string
  s?: string
}

/** Builds `{p, s}` over exact payload bytes (optionally pre-serialized). */
export const envelope = async (
  op: BuddiesSignedOp,
  payload: Record<string, unknown> | string,
  key: SigningKey
): Promise<Envelope> => {
  const bytes = encoder.encode(
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  )
  return { p: b64u(bytes), s: b64u(await key.sign(signedMessage(op, bytes))) }
}

export const unsignedEnvelope = (
  payload: Record<string, unknown>
): Envelope => ({
  p: b64u(encoder.encode(JSON.stringify(payload))),
})

/** Random lowercase hex, `size` bytes (an APNs device token). */
export const hexToken = (size: number): string =>
  [...randomBytes(size)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
