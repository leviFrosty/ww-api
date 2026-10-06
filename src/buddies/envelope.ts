import {
  BUDDIES_LIMITS,
  BUDDIES_LIVE_HEADERS,
  BUDDIES_LIVE_OP,
  BUDDIES_PAYLOAD_PARSERS,
  decodeB64u,
  decodeSignature,
  fail,
  isPlainObject,
  ok,
  type BuddiesPayloads,
  type BuddiesResult,
  type BuddiesSigningOp,
  type Signed,
} from './contracts'

/**
 * Request envelope `{ "p": b64u(UTF-8 JSON payload), "s": b64u(Ed25519 sig) }`.
 * The live socket's upgrade carries the same two values in headers instead.
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
  return isPlainObject(body) ? envelopeFromParts(body.p, body.s) : null
}

/** Decodes `p` and its JSON; `s` passes through. Null means `bad_request`. */
const envelopeFromParts = (p: unknown, s: unknown): Envelope | null => {
  if (typeof p !== 'string' || !p) return null
  const payloadBytes = decodeB64u(p)
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
  return { payloadBytes, payload, signature: s }
}

/**
 * Validates a signed op's payload (`bad_request`) and decodes its signature
 * (`bad_signature`). Verifying it is the inbox DO's job.
 */
export const signedCall = <K extends BuddiesSigningOp>(
  op: K,
  envelope: Envelope,
  now: number
): BuddiesResult<Signed<BuddiesPayloads[K]>> => {
  const payload = BUDDIES_PAYLOAD_PARSERS[op](envelope.payload, now)
  if (!payload) return fail('bad_request')
  const signature = decodeSignature(envelope.signature)
  if (!signature) return fail('bad_signature')
  return ok({ ...payload, payloadBytes: envelope.payloadBytes, signature })
}

export const isWebSocketUpgrade = (request: Request): boolean =>
  request.method === 'GET' &&
  request.headers.get('upgrade')?.trim().toLowerCase() === 'websocket'

/**
 * The `inbox/live` upgrade's signed call, from its `x-buddies-p` and
 * `x-buddies-s` headers. Both the Worker (to route) and the inbox DO (to
 * verify) read it, so neither trusts the other's parse.
 */
export const readLiveCall = (
  headers: Headers,
  now: number
): BuddiesResult<Signed<BuddiesPayloads[typeof BUDDIES_LIVE_OP]>> => {
  const envelope = envelopeFromParts(
    headers.get(BUDDIES_LIVE_HEADERS.payload),
    headers.get(BUDDIES_LIVE_HEADERS.signature)
  )
  return envelope
    ? signedCall(BUDDIES_LIVE_OP, envelope, now)
    : fail('bad_request')
}

/** The exact byte string an op's Ed25519 signature covers. */
export const signedMessage = (
  op: BuddiesSigningOp,
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
  op: BuddiesSigningOp,
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
