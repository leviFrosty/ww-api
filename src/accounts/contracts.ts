import { bytesToBase64Url } from '../crypto'
import {
  BUDDIES_ID_PATTERN,
  decodeB64u,
  isPlainObject,
} from '../buddies/contracts'

/**
 * The accounts wire contract (witness-work `docs/accounts-protocol.md`). An
 * account is a random `accountId` the server mints and the public key of the
 * account signing key, which every device derives from the User's account key.
 *
 * Requests use the Buddies envelope `{ "p": b64u(JSON), "s": b64u(Ed25519) }`
 * under their own signing context, so no account signature can pass for a
 * Buddies one or the other way round.
 */

export const ACCOUNTS_OPS = ['account/register', 'account/info'] as const
export type AccountsOp = (typeof ACCOUNTS_OPS)[number]

const SIGNING_CONTEXT = 'ww-account/v1\n'
const encoder = new TextEncoder()

const concat = (prefix: Uint8Array, rest: Uint8Array): Uint8Array => {
  const message = new Uint8Array(prefix.byteLength + rest.byteLength)
  message.set(prefix, 0)
  message.set(rest, prefix.byteLength)
  return message
}

/** The bytes an account op's signature covers: context, op, then `p` decoded. */
export const accountSignedMessage = (
  op: AccountsOp,
  payloadBytes: Uint8Array
): Uint8Array =>
  concat(encoder.encode(`${SIGNING_CONTEXT}${op}\n`), payloadBytes)

/**
 * What the account signing key signs to claim an inbox. `inbox/register`
 * carries it, inside a payload the inbox's owner key signs, so the link takes
 * both keys.
 */
export const inboxLinkMessage = (
  accountId: string,
  inboxId: string,
  ownerPub: string
): Uint8Array =>
  encoder.encode(
    `${SIGNING_CONTEXT}inbox/link\n${accountId}\n${inboxId}\n${ownerPub}`
  )

/** `account/register` and `account/info` both name the signing key. */
export interface AccountKeyPayload {
  accountPub: string
  ts: number
  nonce: string
}

export const isAccountId = (value: unknown): value is string =>
  typeof value === 'string' && BUDDIES_ID_PATTERN.test(value)

/** Canonical b64u of exactly 32 bytes, or null. */
const publicKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const bytes = decodeB64u(value)
  return bytes && bytes.length === 32 ? bytesToBase64Url(bytes) : null
}

/**
 * Validates `account/register`'s or `account/info`'s payload; null means
 * `bad_request`.
 */
export const parseAccountKeyPayload = (
  payload: unknown
): AccountKeyPayload | null => {
  if (!isPlainObject(payload)) return null
  const accountPub = publicKey(payload.accountPub)
  const ts = payload.ts
  if (!accountPub) return null
  if (typeof ts !== 'number' || !Number.isSafeInteger(Math.floor(ts)))
    return null
  if (!isAccountId(payload.nonce)) return null
  return { accountPub, ts: Math.floor(ts), nonce: payload.nonce }
}
