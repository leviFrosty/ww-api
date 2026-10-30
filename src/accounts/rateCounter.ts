import type { Environment } from '../types'
import { bytesToBase64Url } from '../crypto'
import { derivedHmacKey, MIN_TOKEN_SECRET_CHARS } from './tokens'

/**
 * Names for the accounts routes' rolling counters
 * (src/accounts/rateCounterDO.ts): the object a count lives in and its keys
 * are HMAC-SHA256s of what they count (a caller's IP or network) under a key
 * from `ACCOUNT_TICKET_SECRET`, never a plain hash, which anyone could
 * compute for every IPv4 address. Derived from the secret alone, so a count
 * is found again by every isolate and after a restart; rotating the secret
 * starts every count over.
 *
 * Privacy: names never reach logs; the values they're made from never leave
 * the Worker.
 */

const encoder = new TextEncoder()

/**
 * The name of what `label` counts for `value` (`passkey-assert-failures`
 * and an IP, say). `scope` keeps keys apart that rotate (`web-caps/<day>`)
 * from those that don't. Throws without a usable secret; the routes that
 * count answer `disabled` before they get here.
 */
export const counterName = async (
  env: Pick<Environment, 'ACCOUNT_TICKET_SECRET'>,
  label: string,
  value: string,
  scope = 'names'
): Promise<string> => {
  const secret = env.ACCOUNT_TICKET_SECRET?.trim()
  if (!secret || secret.length < MIN_TOKEN_SECRET_CHARS)
    throw new Error('accounts: ACCOUNT_TICKET_SECRET is not configured')
  const key = await derivedHmacKey(`ww-account/v1/rate-counter/${scope}`, secret)
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${label}\n${value}`)
  )
  return bytesToBase64Url(new Uint8Array(mac))
}

/** The counter object named `name`. */
export const rateCounter = (
  env: Pick<Environment, 'ACCOUNT_RATE_COUNTER'>,
  name: string
) => env.ACCOUNT_RATE_COUNTER.get(env.ACCOUNT_RATE_COUNTER.idFromName(name))
