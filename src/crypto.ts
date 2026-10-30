/**
 * Small WebCrypto helpers shared by the credit meter and App Attest. Workers
 * runtime — everything goes through `crypto.subtle` / global `crypto`.
 */

const encoder = new TextEncoder()

/** Lowercase hex of `bytes`. */
export const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** SHA-256 of raw bytes. */
export const sha256Bytes = async (data: Uint8Array): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

/**
 * Canonical content hash for a notes string: lowercase hex SHA-256 of its UTF-8
 * bytes. MUST stay byte-for-byte identical to the witness-work client's
 * `notesContentHash` so credit metering and the client ledger agree on identity
 * (decisions 6 & 8).
 */
export const sha256Hex = async (text: string): Promise<string> =>
  bytesToHex(await sha256Bytes(encoder.encode(text)))

/**
 * Fixed-work string comparison for bounded secret tokens. Folding the lengths
 * into the result and always scanning the same 256 UTF-16 positions avoids the
 * early length/content exits that create a useful token timing oracle.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length
  for (let i = 0; i < 256; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0 && a.length <= 256 && b.length <= 256
}

/** Decodes standard or URL-safe base64 to bytes. */
export const base64ToBytes = (b64: string): Uint8Array => {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encodes bytes to URL-safe base64 without padding. */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Cryptographically-random URL-safe token of `byteLength` random bytes. */
export const randomToken = (byteLength = 32): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
