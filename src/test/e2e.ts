import { spawnSync } from 'node:child_process'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuddiesSignedOp } from '../buddies/contracts'
import {
  SigningKey,
  envelope,
  liveHeaders,
  randomId,
  unsignedEnvelope,
  type Envelope,
} from './buddiesClient'

/**
 * Helpers for `pnpm test:e2e`: real HTTP against the worker started by
 * `node scripts/verify/dev.mjs up`. Every exchange lands in a transcript under
 * `.verify/artifacts/` so a run leaves evidence behind.
 */

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STATE_PATH = join(ROOT, '.verify', 'state.json')
export const ARTIFACTS_DIR = join(ROOT, '.verify', 'artifacts')

interface VerifyState {
  url: string
  tokens?: { devBypass?: string; admin?: string }
  configured?: Record<string, boolean>
}

const readState = (): VerifyState | null =>
  existsSync(STATE_PATH)
    ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as VerifyState)
    : null

const state = readState()

/** `WW_API_URL` wins; otherwise the URL `dev.mjs up` recorded. */
export const BASE_URL = (process.env.WW_API_URL ?? state?.url ?? '').replace(
  /\/$/,
  ''
)
if (!BASE_URL) {
  throw new Error(
    'No worker URL: run `node scripts/verify/dev.mjs up` or set WW_API_URL'
  )
}

/** Only available for the local launcher's worker (synthetic tokens). */
export const DEV_BYPASS_TOKEN =
  process.env.WW_API_DEV_BYPASS_TOKEN ?? state?.tokens?.devBypass ?? null
export const ADMIN_TOKEN =
  process.env.WW_API_ADMIN_TOKEN ?? state?.tokens?.admin ?? null
export const configured = (name: string): boolean =>
  Boolean(state?.configured?.[name])
/** True when the worker is the launcher's local instance (KV helpers work). */
export const LOCAL_LAUNCHER = !process.env.WW_API_URL && state != null

let ipCounter = Math.floor(Math.random() * 60_000)
/** A fresh client IP per request so per-IP rate limits never couple tests. */
export const nextIp = (): string => {
  ipCounter = (ipCounter + 1) % 65_536
  return `198.18.${ipCounter >> 8}.${ipCounter & 255}`
}

export interface Exchange {
  status: number
  headers: Headers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  text: string
  ms: number
}

const transcript: Array<Record<string, unknown>> = []
const clip = (text: string, max = 600) =>
  text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text

export const http = async (
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}
): Promise<Exchange> => {
  const headers: Record<string, string> = {
    'cf-connecting-ip': nextIp(),
    ...(init.body !== undefined || init.raw !== undefined
      ? { 'content-type': 'application/json' }
      : {}),
    ...init.headers,
  }
  const requestBody =
    init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  const started = Date.now()
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  const ms = Date.now() - started
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // HTML or plain text
  }
  transcript.push({
    method,
    path,
    // Secret-bearing headers are recorded by name only.
    headers: Object.keys(headers),
    request: requestBody === undefined ? undefined : clip(requestBody),
    status: response.status,
    response: clip(text),
    ms,
  })
  return { status: response.status, headers: response.headers, body, text, ms }
}

/** Writes this file's request/response transcript as proof. */
export const writeTranscript = (name: string): string => {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const path = join(
    ARTIFACTS_DIR,
    `e2e-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  writeFileSync(
    path,
    `${JSON.stringify({ baseUrl: BASE_URL, exchanges: transcript }, null, 2)}\n`
  )
  return path
}

/** Edits the launcher's isolated local KV (only valid with LOCAL_LAUNCHER). */
export const localKv = (
  action: 'get' | 'put' | 'delete',
  key: string,
  value?: string
): string => {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts/verify/dev.mjs'),
      'kv',
      action,
      key,
      ...(value === undefined ? [] : [value]),
    ],
    { cwd: ROOT, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`kv ${action} failed: ${result.stderr}`)
  return result.stdout
}

// --- Buddies --------------------------------------------------------------

export const buddies = (op: string, envelopeBody: Envelope | unknown) =>
  http('POST', `/buddies/v1/${op}`, { body: envelopeBody })

export const sendSigned = async (
  op: BuddiesSignedOp,
  key: SigningKey,
  payload: Record<string, unknown>
) =>
  buddies(
    op,
    await envelope(op, { ts: Date.now(), nonce: randomId(), ...payload }, key)
  )

export const sendUnsigned = (op: string, payload: Record<string, unknown>) =>
  buddies(op, unsignedEnvelope(payload))

/** One synthetic person: an inbox and the owner key that signs for it. */
export class RelayOwner {
  readonly inboxId = randomId()
  private constructor(readonly key: SigningKey) {}

  static async register(): Promise<RelayOwner> {
    const owner = new RelayOwner(await SigningKey.generate())
    const response = await owner.send('inbox/register', {
      ownerPub: owner.key.publicKey,
    })
    if (response.status !== 200) {
      throw new Error(`inbox/register ${response.status} ${response.text}`)
    }
    return owner
  }

  send(op: BuddiesSignedOp, payload: Record<string, unknown> = {}) {
    return sendSigned(op, this.key, { inboxId: this.inboxId, ...payload })
  }

  sync(since = 0) {
    return this.send('inbox/sync', { since })
  }

  /** Signed `inbox/live` upgrade headers (fresh nonce each call). */
  liveHeaders(key: SigningKey = this.key) {
    return liveHeaders(
      { inboxId: this.inboxId, ts: Date.now(), nonce: randomId() },
      key
    )
  }
}

/** A buddy's write capability into one recipient inbox slot. */
export class RelayWriter {
  constructor(
    readonly inboxId: string,
    readonly slotId: string,
    readonly key: SigningKey
  ) {}

  send(op: BuddiesSignedOp, payload: Record<string, unknown> = {}) {
    return sendSigned(op, this.key, {
      inboxId: this.inboxId,
      slotId: this.slotId,
      ...payload,
    })
  }
}

// --- Buddies live socket ----------------------------------------------------

export interface LiveConnection {
  /** The next text message, in order. */
  next(timeoutMs?: number): Promise<string>
  /** The close frame the server sent. */
  closed: Promise<{ code: number; reason: string }>
  send(text: string): void
  end(): void
}

export type LiveAttempt =
  | { status: 101; connection: LiveConnection }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { status: number; body: any }

/** A masked client frame (FIN set), as RFC 6455 requires of clients. */
const clientFrame = (opcode: number, payload: Buffer): Buffer => {
  const mask = nodeRandomBytes(4)
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
  const length = payload.length
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
  return Buffer.concat([header, mask, masked])
}

const liveConnection = (socket: Socket, head: Buffer): LiveConnection => {
  const messages: string[] = []
  const waiters: Array<() => void> = []
  let resolveClosed: (close: { code: number; reason: string }) => void
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve
  })
  let buffer = Buffer.alloc(0)
  const read = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (buffer.length < offset + length) return
      const payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      if (opcode === 1) {
        messages.push(payload.toString('utf8'))
        for (const wake of waiters.splice(0)) wake()
      } else if (opcode === 8) {
        resolveClosed({
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString('utf8'),
        })
        socket.write(clientFrame(8, payload.subarray(0, 2)))
      }
    }
  }
  socket.on('data', read)
  socket.on('error', () => undefined)
  if (head.length) read(head)

  let taken = 0
  return {
    closed,
    next: (timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no live message within ${timeoutMs} ms`)),
          timeoutMs
        )
        const check = () => {
          if (taken < messages.length) {
            clearTimeout(timer)
            resolve(messages[taken++])
          } else waiters.push(check)
        }
        check()
      }),
    send: (text) => socket.write(clientFrame(1, Buffer.from(text, 'utf8'))),
    end: () => socket.destroy(),
  }
}

/**
 * `GET /buddies/v1/inbox/live` as a raw WebSocket handshake, so refusals keep
 * their status and JSON body. Header values never reach the transcript.
 */
export const openLive = (headers: Record<string, string>): Promise<LiveAttempt> =>
  new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}/buddies/v1/inbox/live`)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        headers: {
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': nodeRandomBytes(16).toString('base64'),
          'cf-connecting-ip': nextIp(),
          ...headers,
        },
        timeout: 10_000,
      }
    )
    const started = Date.now()
    const record = (status: number, response: string) =>
      transcript.push({
        method: 'GET',
        path: '/buddies/v1/inbox/live',
        headers: Object.keys(headers),
        status,
        response: clip(response),
        ms: Date.now() - started,
      })
    request.on('upgrade', (response, socket, head) => {
      record(response.statusCode ?? 101, '(websocket)')
      resolve({ status: 101, connection: liveConnection(socket, head) })
    })
    request.on('response', (response) => {
      let text = ''
      response.on('data', (chunk) => (text += chunk))
      response.on('end', () => {
        record(response.statusCode ?? 0, text)
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // plain text
        }
        resolve({ status: response.statusCode ?? 0, body })
      })
    })
    request.on('timeout', () => request.destroy(new Error('live handshake timed out')))
    request.on('error', reject)
    request.end()
  })
