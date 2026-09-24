import {
  BUDDIES_LIMITS,
  decodeB64u,
  isPlainObject,
  type BuddiesSignedOp,
} from './contracts'

/**
 * Request envelope `{ "p": b64u(UTF-8 JSON payload), "s": b64u(Ed25519 sig) }`.
 *
 * The signature covers `UTF-8("ww-buddies/v1\n" + op + "\n") ‖ decoded(p)`: the
 * exact bytes the client sent, never a re-serialization of the parsed JSON.
 */

const SIGNING_CONTEXT = 'ww-buddies/v1\n'
const encoder = new TextEncoder()

export interface Envelope {
  /** Decoded bytes of `p`, exactly as signed. */
  payloadBytes: Uint8Array
  payload: Record<string, unknown>
  /** Raw `s`; unsigned ops ignore it. */
  signature: unknown
}

/**
 * Reads the request body as UTF-8 text, refusing anything over the envelope
 * ceiling without buffering it. Null means `bad_request`.
 */
export const readEnvelopeText = async (
  request: Request
): Promise<string | null> => {
  const limit = BUDDIES_LIMITS.requestBytes
  const declared = request.headers.get('content-length')
  if (declared != null && !(Number(declared) <= limit)) return null
  if (!request.body) return null

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      bytes
    )
  } catch {
    return null
  }
}

/** Parses the envelope and its payload JSON. Null means `bad_request`. */
export const parseEnvelope = (text: string): Envelope | null => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Never surface the parser message: V8 quotes the offending input.
    return null
  }
  if (!isPlainObject(body) || typeof body.p !== 'string' || !body.p) return null

  const payloadBytes = decodeB64u(body.p)
  if (!payloadBytes) return null

  let payload: unknown
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        payloadBytes
      )
    )
  } catch {
    return null
  }
  if (!isPlainObject(payload)) return null
  return { payloadBytes, payload, signature: body.s }
}

/** The exact byte string an op's Ed25519 signature covers. */
export const signedMessage = (
  op: BuddiesSignedOp,
  payloadBytes: Uint8Array
): Uint8Array => {
  const prefix = encoder.encode(`${SIGNING_CONTEXT}${op}\n`)
  const message = new Uint8Array(prefix.byteLength + payloadBytes.byteLength)
  message.set(prefix, 0)
  message.set(payloadBytes, prefix.byteLength)
  return message
}

/**
 * Verifies an Ed25519 signature with WebCrypto against a stored `b64u` public
 * key. Any malformed key or signature is simply "not valid".
 */
export const verifyBuddiesSignature = async (
  publicKey: string,
  op: BuddiesSignedOp,
  payloadBytes: Uint8Array,
  signature: Uint8Array
): Promise<boolean> => {
  const raw = decodeB64u(publicKey)
  if (!raw || raw.byteLength !== 32 || signature.byteLength !== 64) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      signedMessage(op, payloadBytes)
    )
  } catch {
    return false
  }
}
