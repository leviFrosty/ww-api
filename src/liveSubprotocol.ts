import type { Environment } from './types'
import { allowedWebOrigin } from './cors'

/**
 * The browser's way onto a live socket (witness-work ADR 0038 §10). Browsers
 * can't set headers on a WebSocket, so a web client offers its access token
 * and the ids it would otherwise send in headers as `Sec-WebSocket-Protocol`
 * entries, next to `ww.v1`:
 *
 * ```
 * Sec-WebSocket-Protocol: ww.v1, bearer.<access token>, slot.<slotId>
 * ```
 *
 * Ids never go in the URL (production logs URLs). Every entry is an RFC 9110
 * token. The Worker checks the offer and `Origin` (an exact match in
 * `WEB_APP_ORIGINS`) before verifying the token or touching a Durable Object,
 * forwards only the verified account and ids (never the token) in its
 * internal headers, and answers the 101 with `Sec-WebSocket-Protocol:
 * ww.v1`, which a browser requires. Native apps keep the header path and
 * never send a subprotocol.
 *
 * Privacy: the offer holds the token; never log it or forward it.
 */

/** The subprotocol a live socket speaks, echoed on every browser upgrade. */
export const LIVE_SUBPROTOCOL = 'ww.v1'

/** The token's entry: `bearer.<access token>`. */
const BEARER_PREFIX = 'bearer'

/**
 * The longest offer read: an access token is about 400 characters, a
 * Buddies payload about 60; anything this long is not a client's.
 */
const MAX_OFFER_CHARS = 4_096

/** RFC 9110 `token`: what a `Sec-WebSocket-Protocol` entry may hold. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Close codes are per socket; both sockets close an expired token with this. */
export const LIVE_EXPIRED_CLOSE = { code: 4004, reason: 'expired' } as const

export type BrowserLive<P extends string> =
  | {
      ok: true
      /** The `bearer.` entry's token, or null when the offer has none. */
      token: string | null
      /** Each id prefix's value, when offered. */
      ids: Partial<Record<P, string>>
    }
  | { ok: false; error: 'bad_request' | 'forbidden' }

/**
 * The browser's upgrade, or null for a native (header-path) one: a request
 * without `Sec-WebSocket-Protocol`. Refuses with `bad_request` an offer that
 * isn't a list of tokens, repeats an entry, has one this socket doesn't
 * know, has no `ww.v1`, or comes with an `Authorization` header too; and
 * with `forbidden` one whose `Origin` isn't the web app's.
 */
export const readBrowserLive = <P extends string>(
  env: Pick<Environment, 'WEB_APP_ORIGINS'>,
  headers: Headers,
  idPrefixes: readonly P[]
): BrowserLive<P> | null => {
  const offer = headers.get('sec-websocket-protocol')
  if (offer == null) return null
  // A foreign page learns nothing about what a well-formed offer looks like.
  if (!allowedWebOrigin(env, headers.get('origin')))
    return { ok: false, error: 'forbidden' }
  const bad = { ok: false, error: 'bad_request' } as const
  if (offer.length > MAX_OFFER_CHARS || headers.has('authorization')) return bad

  let subprotocol = false
  let token: string | null = null
  const ids: Partial<Record<P, string>> = {}
  for (const entry of offer.split(',').map((part) => part.trim())) {
    if (!TOKEN.test(entry)) return bad
    if (entry === LIVE_SUBPROTOCOL) {
      if (subprotocol) return bad
      subprotocol = true
      continue
    }
    const dot = entry.indexOf('.')
    const prefix = dot > 0 ? entry.slice(0, dot) : ''
    const value = entry.slice(dot + 1)
    if (dot < 0 || !value) return bad
    if (prefix === BEARER_PREFIX) {
      if (token != null) return bad
      token = value
    } else if ((idPrefixes as readonly string[]).includes(prefix)) {
      if (ids[prefix as P] != null) return bad
      ids[prefix as P] = value
    } else return bad
  }
  if (!subprotocol) return bad
  return { ok: true, token, ids }
}

/**
 * The request a Durable Object gets for a browser upgrade: `headers` minus
 * the offer and any `Authorization`, plus the internal ones the Worker set.
 */
export const forwardedLiveRequest = (
  request: Request,
  internal: Record<string, string>
): Request => {
  const headers = new Headers(request.headers)
  headers.delete('sec-websocket-protocol')
  headers.delete('authorization')
  for (const [name, value] of Object.entries(internal)) headers.set(name, value)
  return new Request(request, { headers })
}

/**
 * The Durable Object's answer with `Sec-WebSocket-Protocol: ww.v1` on a 101;
 * a refusal passes through.
 */
export const acceptLiveSubprotocol = (response: Response): Response =>
  response.status === 101 && response.webSocket
    ? new Response(null, {
        status: 101,
        webSocket: response.webSocket,
        headers: { 'sec-websocket-protocol': LIVE_SUBPROTOCOL },
      })
    : response

/**
 * A socket attachment's token expiry from the Worker's internal header:
 * epoch ms, or null without the header (a header-path socket, which keeps
 * outliving its token). Undefined when it's malformed.
 */
export const readLiveExpiry = (value: string | null): number | null | undefined => {
  if (value == null) return null
  const expiresAt = Number(value)
  return /^\d{1,16}$/.test(value) && Number.isSafeInteger(expiresAt)
    ? expiresAt
    : undefined
}

/** Closes every socket whose `expiresAt` has passed with `4004 "expired"`. */
export const closeExpiredSockets = (
  sockets: WebSocket[],
  expiresAt: (ws: WebSocket) => number | null | undefined,
  now: number
): void => {
  for (const ws of sockets) {
    const at = expiresAt(ws)
    if (at == null || at > now) continue
    try {
      ws.close(LIVE_EXPIRED_CLOSE.code, LIVE_EXPIRED_CLOSE.reason)
    } catch {
      // Already closing or gone.
    }
  }
}

/** The soonest expiry among `sockets`, or null. */
export const soonestSocketExpiry = (
  sockets: WebSocket[],
  expiresAt: (ws: WebSocket) => number | null | undefined
): number | null => {
  let soonest: number | null = null
  for (const ws of sockets) {
    const at = expiresAt(ws)
    if (at != null && (soonest == null || at < soonest)) soonest = at
  }
  return soonest
}
