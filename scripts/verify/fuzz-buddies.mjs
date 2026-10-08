#!/usr/bin/env node
/**
 * Buddies relay protocol fuzzer against a running worker.
 *
 *   pnpm fuzz:buddies [--runs 300] [--seed <uint32>] [--case <i>] [--url <base>] [--timeout-ms 5000]
 *
 * The seed fixes which mutation each case applies and its parameters; ids,
 * keys, and nonces are fresh every run so a seed can be replayed against the
 * same persisted state. Oracle per request: never 5xx, never slower than the
 * timeout, buddies errors are `{error}` JSON, and each mutation's documented
 * status (e.g. tampered signature -> 401). After all cases a canary identity's
 * full `inbox/sync` must equal its pre-fuzz snapshot. Writes a JSON report to
 * .verify/artifacts/fuzz-<timestamp>.json and exits 1 on any failure.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALL_OPS,
  SIGNED_OPS,
  WIRE_EDGE_LIMITS,
  WIRE_LIMITS as L,
  b64u,
  fromB64u,
  sha256,
  signedEnvelope,
  signingKeyFromSeed,
  unsignedEnvelope,
} from './buddies-wire.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTIFACTS = join(ROOT, '.verify', 'artifacts')

// --- CLI ------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1]
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  return inline ? inline.split('=')[1] : fallback
}
const stateUrl = () => {
  const path = join(ROOT, '.verify', 'state.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).url : undefined
}
const BASE = String(flag('url', process.env.WW_API_URL ?? stateUrl() ?? '')).replace(/\/$/, '')
const RUNS = Number(flag('runs', process.env.WW_FUZZ_RUNS ?? 300))
const SEED = Number(flag('seed', process.env.WW_FUZZ_SEED ?? randomBytes(4).readUInt32BE(0))) >>> 0
const ONLY = flag('case', undefined)
const TIMEOUT_MS = Number(flag('timeout-ms', 5_000))
if (!BASE) {
  console.error('fuzz: no worker URL; run `node scripts/verify/dev.mjs up` or pass --url / WW_API_URL')
  process.exit(2)
}
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error('fuzz: --runs must be a positive integer')
  process.exit(2)
}

// --- Seeded shape randomness (mulberry32), fresh entropy for ids/keys -----

const hash32 = (text) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const makeRng = (seed) => {
  const next = mulberry32(seed)
  const rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    bool: () => next() < 0.5,
  }
  return rng
}

const rid = () => b64u(randomBytes(16))
const blob = (bytes) => b64u(randomBytes(bytes))
const newKey = () => signingKeyFromSeed(randomBytes(32))
let ipCounter = randomBytes(2).readUInt16BE(0)
const nextIp = () => {
  ipCounter = (ipCounter + 1) % 65_536
  return `198.19.${ipCounter >> 8}.${ipCounter & 255}`
}

// --- HTTP with oracle ---------------------------------------------------------

class FuzzFailure extends Error {
  constructor(reason, exchange) {
    super(reason)
    this.exchange = exchange
  }
}

const stats = {
  requests: 0,
  devProxyRetries: 0,
  statuses: {},
  latencies: [],
  byGenerator: {},
}

let caseLog = []
const DEV_PROXY_503 = 'Your worker restarted mid-request.'

const describeBody = (body) => {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return `<${body.length} raw bytes, sha256 ${createHash('sha256').update(body).digest('hex').slice(0, 16)}>`
  return '<stream>'
}

const clip = (text, max) =>
  text && text.length > max
    ? `${text.slice(0, max)}…<${text.length} chars, sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 16)}>`
    : text

/**
 * Sends one request. `expect` is a status list (or predicate); `error` the
 * expected buddies error code. Global invariants apply to every request.
 */
const send = async ({ op, path, method = 'POST', body, headers = {}, expect, error, note }) => {
  const url = `${BASE}${path ?? `/buddies/v1/${op}`}`
  const finalHeaders = { 'cf-connecting-ip': nextIp(), ...headers }
  let payload = body
  if (body && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ReadableStream)) {
    payload = JSON.stringify(body)
    finalHeaders['content-type'] ??= 'application/json'
  }
  const exchange = {
    note,
    request: { method, url: url.slice(BASE.length), headers: finalHeaders, body: describeBody(payload) },
  }
  caseLog.push(exchange)
  const started = performance.now()
  let response
  let text
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      duplex: payload instanceof ReadableStream ? 'half' : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    text = await response.text()
    // `wrangler dev` only: after the worker cancels a chunked upload (the
    // oversized-envelope case), wrangler's local ProxyWorker answers the next
    // non-GET request with this canned 503 instead of forwarding it. It never
    // reaches the worker and doesn't exist in production, so retry once (only
    // when the body can be resent) and count it in the report.
    if (response.status === 503 && text.startsWith(DEV_PROXY_503) && !(payload instanceof ReadableStream)) {
      stats.devProxyRetries++
      exchange.devProxyRetry = true
      response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      text = await response.text()
    }
  } catch (cause) {
    const ms = Math.round(performance.now() - started)
    exchange.response = { error: String(cause?.name ?? cause), ms }
    throw new FuzzFailure(
      cause?.name === 'TimeoutError' ? `hang: no response within ${TIMEOUT_MS}ms` : `transport error: ${cause?.message}`,
      exchange
    )
  }
  const ms = Math.round(performance.now() - started)
  stats.requests++
  stats.statuses[response.status] = (stats.statuses[response.status] ?? 0) + 1
  stats.latencies.push(ms)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // checked below
  }
  exchange.response = { status: response.status, body: clip(text, 2_000), ms }

  if (response.status >= 500 && !(response.status === 503 && json?.error === 'disabled')) {
    throw new FuzzFailure(`server error ${response.status}`, exchange)
  }
  if (ms > TIMEOUT_MS) throw new FuzzFailure(`slow: ${ms}ms > ${TIMEOUT_MS}ms`, exchange)
  if (url.includes('/buddies/v1/') && response.status !== 404 && !json) {
    throw new FuzzFailure('non-JSON buddies response', exchange)
  }
  if (response.status >= 400 && json && typeof json.error !== 'string') {
    throw new FuzzFailure('error response without an error code', exchange)
  }
  const allowed = typeof expect === 'function' ? expect(response.status, json) : expect ? expect.includes(response.status) : true
  if (!allowed) {
    throw new FuzzFailure(`expected status ${Array.isArray(expect) ? expect.join('|') : 'predicate'}, got ${response.status}`, exchange)
  }
  if (error && json?.error !== error) {
    throw new FuzzFailure(`expected error "${error}", got ${JSON.stringify(json)}`, exchange)
  }
  return { status: response.status, json, text, headers: response.headers }
}

const signed = async (op, key, payload) =>
  signedEnvelope(op, { ts: Date.now(), nonce: rid(), ...payload }, key)

// --- Identities ---------------------------------------------------------------

const newOwner = async () => {
  const key = await newKey()
  const owner = { key, inboxId: rid() }
  owner.send = async (op, payload, expect = [200], error) =>
    send({ op, body: await signed(op, key, { inboxId: owner.inboxId, ...payload }), expect, error })
  await owner.send('inbox/register', { ownerPub: key.publicKey })
  return owner
}

const newWriter = async (owner) => {
  const key = await newKey()
  const writer = { key, inboxId: owner.inboxId, slotId: rid() }
  await owner.send('slot/add', { slotId: writer.slotId, writerPub: key.publicKey })
  writer.send = async (op, payload, expect = [200], error) =>
    send({
      op,
      body: await signed(op, key, { inboxId: writer.inboxId, slotId: writer.slotId, ...payload }),
      expect,
      error,
    })
  return writer
}

const inviteSecrets = async () => {
  const claimSecret = randomBytes(32)
  return {
    inviteId: rid(),
    claimSecret: b64u(claimSecret),
    claimVerifier: b64u(await sha256(claimSecret)),
  }
}

const TEMPLATES = { 'plan.joined': { title: 'Plans', body: 'A buddy is coming' } }

/** A valid payload (minus ts/nonce) for `op` against an identity + slot. */
const validPayload = async (op, ctx) => {
  const { owner, writer } = ctx
  const base = { inboxId: owner.inboxId }
  switch (op) {
    case 'inbox/register':
      return { ...base, ownerPub: owner.key.publicKey }
    case 'inbox/sync':
      return { ...base, since: 0 }
    case 'inbox/delete':
      return base
    case 'device/register':
      return { ...base, deviceId: rid(), pushService: 'apns', apnsToken: randomBytes(32).toString('hex'), apnsEnvironment: 'sandbox', apnsTopic: 'com.leviwilkerson.jwtimedev', templates: TEMPLATES }
    case 'device/unregister':
      return { ...base, deviceId: rid() }
    case 'slot/add':
      return { ...base, slotId: rid(), writerPub: (await newKey()).publicKey }
    case 'slot/remove':
      return { ...base, slotId: rid() }
    case 'roster/put':
      return { ...base, blob: blob(64) }
    case 'invite/create': {
      const secrets = await inviteSecrets()
      return { ...base, inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(64), expiresAt: Date.now() + 3_600_000 }
    }
    case 'invite/delete':
      return { ...base, inviteId: rid() }
    case 'card/put':
      return { ...base, slotId: writer.slotId, blob: blob(64) }
    case 'event/put':
      return { ...base, slotId: writer.slotId, eventId: rid(), kind: 'plan.joined', blob: blob(48), push: false }
    case 'slot/leave':
      return { ...base, slotId: writer.slotId }
    case 'invite/fetch':
      return { inviteId: rid() }
    case 'invite/claim':
      return { inviteId: rid(), claimSecret: b64u(randomBytes(32)), blob: blob(32) }
  }
  throw new Error(`no payload for ${op}`)
}

const WRITER_OPS = new Set(['card/put', 'event/put', 'slot/leave'])
/** Valid payload fields the contract lets a client leave out. */
const OPTIONAL_FIELDS = new Set(['pushService', 'apnsTopic'])
const keyFor = (op, ctx) => (WRITER_OPS.has(op) ? ctx.writer.key : ctx.owner.key)
/** Ops whose valid form changes canary data; mutations must not land there. */
const CANARY_TARGET_OPS = SIGNED_OPS.filter((op) => op !== 'inbox/register')

// --- Invalid value pools (each is invalid for its field) -------------------

const ID_POOL = [null, 123, '', 'short', `${'A'.repeat(21)}!`, 'A'.repeat(23), '😀'.repeat(11), 'Ａ'.repeat(22), [], {}, true, 'A'.repeat(21) + '\u0000', 'x'.repeat(100_000)]
const INVALID = {
  inboxId: ID_POOL,
  slotId: ID_POOL,
  inviteId: ID_POOL,
  deviceId: ID_POOL,
  eventId: ID_POOL,
  nonce: ID_POOL,
  ts: ['1700000000000', null, 1.5, 1e300, [], true, {}, 2 ** 53],
  since: [-1, 1.5, '0', null, 2 ** 53, true, {}],
  ownerPub: ['', 'A'.repeat(42), 'A'.repeat(44), b64u(randomBytes(31)), b64u(randomBytes(33)), null, 7, '+/+/'.repeat(11)],
  writerPub: ['', 'A'.repeat(42), b64u(randomBytes(31)), null, 7],
  claimVerifier: ['', b64u(randomBytes(31)), b64u(randomBytes(33)), null, 1],
  blob: ['', 'not base64!', 'A', 'AAAAA', null, 5, 'ü'.repeat(10), [], 'AAAA='],
  kind: ['', 'Upper', '1abc', 'a'.repeat(41), 'a b', 'émoji', null, 3, 'a-b', '.a'],
  push: ['true', 1, null, 0, [], {}],
  expiresAt: [() => Date.now() - 1, () => Date.now() + L.maxInviteLifetimeMs + 120_000, '123', 1.5, null, -5],
  apnsToken: ['', 'xyz', 'zz'.repeat(32), 'ab'.repeat(15), 'ab'.repeat(129), null, 42],
  apnsEnvironment: ['dev', '', null, 'SANDBOX', 1],
  // 'fcm' is invalid here too: the payload carries no fcmToken.
  pushService: ['fcm', 'gcm', 'APNS', '', null, 1],
  // Unknown topics pass the shape check and are refused by the inbox.
  apnsTopic: ['', 'nodots', 'com.example.other', 'a/b.c', null, 1, 'a.'.repeat(80)],
  templates: [
    null,
    [],
    'x',
    { 'Bad Kind': { title: 'a', body: 'b' } },
    { a: { title: 'x'.repeat(L.templateChars + 1), body: '' } },
    { a: { title: 1, body: 'b' } },
    { a: null },
    Object.fromEntries(Array.from({ length: L.templates + 1 }, (_, i) => [`k${i}`, { title: 't', body: 'b' }])),
  ],
  claimSecret: [b64u(randomBytes(31)), '', null, 'not b64!', b64u(randomBytes(33))],
}

// --- Generators -----------------------------------------------------------------
// Each receives (rng, canary) and throws FuzzFailure on an oracle violation.

const flipBit = (bytes, rng) => {
  const copy = new Uint8Array(bytes)
  const bit = rng.int(0, copy.length * 8 - 1)
  copy[bit >> 3] ^= 1 << (bit & 7)
  return copy
}

const GENERATORS = {
  /** Valid payload for the canary, signature bit-flipped (decoded, re-encoded). */
  'tampered-signature': async (rng, canary) => {
    const op = rng.pick(CANARY_TARGET_OPS)
    const env = await signed(op, keyFor(op, canary), await validPayload(op, canary))
    env.s = b64u(flipBit(fromB64u(env.s), rng))
    await send({ op, body: env, expect: [401], error: 'bad_signature', note: `bit-flipped signature on ${op}` })
  },

  /** Signed payload, then a different payload sent under the same signature. */
  'tampered-payload': async (rng, canary) => {
    const op = rng.pick(['inbox/sync', 'roster/put', 'card/put', 'inbox/delete', 'slot/leave'])
    const payload = { ts: Date.now(), nonce: rid(), ...(await validPayload(op, canary)) }
    const env = await signedEnvelope(op, payload, keyFor(op, canary))
    const forged = { ...payload, nonce: rid() }
    if ('since' in forged) forged.since = rng.int(1, 1_000)
    if ('blob' in forged) forged.blob = blob(64)
    env.p = b64u(new TextEncoder().encode(JSON.stringify(forged)))
    await send({ op, body: env, expect: [401], error: 'bad_signature', note: `payload swapped under ${op} signature` })
  },

  /** Correct shape, signed by an unrelated key / the wrong role's key. */
  'wrong-key': async (rng, canary) => {
    const op = rng.pick(CANARY_TARGET_OPS)
    const variant = rng.pick(['stranger', 'swap-role'])
    const key =
      variant === 'stranger' ? await newKey() : WRITER_OPS.has(op) ? canary.owner.key : canary.writer.key
    await send({
      op,
      body: await signed(op, key, await validPayload(op, canary)),
      expect: [401],
      error: 'bad_signature',
      note: `${variant} key on ${op}`,
    })
  },

  /** A signature for one op replayed against another op's path. */
  'cross-op-signature': async (rng, canary) => {
    const signedAs = rng.pick(['inbox/sync', 'inbox/delete', 'slot/remove', 'device/unregister'])
    const sentTo = rng.pick(['inbox/delete', 'inbox/sync', 'slot/remove', 'roster/put', 'slot/leave'].filter((op) => op !== signedAs))
    const payload = { ...(await validPayload(signedAs, canary)), ...(await validPayload(sentTo, canary)) }
    const env = await signed(signedAs, keyFor(signedAs, canary), payload)
    await send({ op: sentTo, body: env, expect: [401], error: 'bad_signature', note: `signed as ${signedAs}, sent to ${sentTo}` })
  },

  /** Exact envelope resent, sequentially and in parallel: one 200, rest `replay`. */
  'replay': async (rng) => {
    const owner = await newOwner()
    const op = rng.pick(['inbox/sync', 'roster/put', 'device/unregister'])
    const env = await signed(op, owner.key, await validPayload(op, { owner }))
    const copies = rng.int(1, 8)
    if (rng.bool()) {
      await send({ op, body: env, expect: [200], note: 'original' })
      for (let i = 0; i < copies; i++) await send({ op, body: env, expect: [409], error: 'replay', note: `sequential replay ${i + 1}` })
    } else {
      const results = await Promise.all(
        Array.from({ length: copies + 1 }, (_, i) => send({ op, body: env, expect: [200, 409], note: `parallel copy ${i}` }))
      )
      const wins = results.filter((r) => r.status === 200).length
      if (wins !== 1) throw new FuzzFailure(`parallel replay: ${wins} of ${copies + 1} copies accepted (want exactly 1)`, caseLog.at(-1))
    }
  },

  /** Correctly signed but outside the ±5 min window. */
  'stale-timestamp': async (rng, canary) => {
    const op = rng.pick(CANARY_TARGET_OPS)
    const skew = L.timestampSkewMs + rng.int(1_000, 30 * 86_400_000)
    const ts = rng.pick([Date.now() - skew, Date.now() + skew, 0, -1, Number.MAX_SAFE_INTEGER])
    await send({
      op,
      body: await signed(op, keyFor(op, canary), { ...(await validPayload(op, canary)), ts }),
      expect: [401],
      error: 'stale',
      note: `ts=${ts}`,
    })
  },

  /** One field replaced by a value that is invalid for it. */
  'wrong-type': async (rng, canary) => {
    const op = rng.pick(CANARY_TARGET_OPS)
    const payload = { ts: Date.now(), nonce: rid(), ...(await validPayload(op, canary)) }
    const fields = Object.keys(payload).filter((name) => INVALID[name])
    const field = rng.pick(fields)
    let value = rng.pick(INVALID[field])
    if (typeof value === 'function') value = value()
    payload[field] = value
    await send({
      op,
      body: await signedEnvelope(op, payload, keyFor(op, canary)),
      expect: [400],
      error: 'bad_request',
      note: `${op}.${field} = ${clip(JSON.stringify(value) ?? String(value), 80)}`,
    })
  },

  /** One required field removed. */
  'missing-field': async (rng, canary) => {
    const op = rng.pick([...SIGNED_OPS, 'invite/fetch', 'invite/claim'])
    const payload = await validPayload(op, canary)
    const signedOp = SIGNED_OPS.includes(op)
    const full = signedOp ? { ts: Date.now(), nonce: rid(), ...payload } : payload
    const field = rng.pick(Object.keys(full).filter((name) => !OPTIONAL_FIELDS.has(name)))
    delete full[field]
    await send({
      op,
      body: signedOp ? await signedEnvelope(op, full, keyFor(op, canary)) : unsignedEnvelope(full),
      expect: [400],
      error: 'bad_request',
      note: `${op} without ${field}`,
    })
  },

  /** Envelope-level garbage: bad JSON, wrong shapes, bad base64, bad UTF-8. */
  'malformed-envelope': async (rng, canary) => {
    const op = rng.pick(ALL_OPS)
    const goodP = (await signed('inbox/sync', canary.owner.key, await validPayload('inbox/sync', canary))).p
    const cases = [
      ['raw', '{not json'],
      ['raw', ''],
      ['raw', 'null'],
      ['raw', '[]'],
      ['raw', '42'],
      ['raw', '"p"'],
      ['raw', '{"p":'],
      ['raw', '['.repeat(5_000) + ']'.repeat(5_000)],
      ['raw', `{"p":"${'A'.repeat(100)}"${',"x":1'.repeat(2_000)}}`],
      ['json', { p: 1 }],
      ['json', { p: '' }],
      ['json', { p: null, s: 'x' }],
      ['json', { p: 'not base64!' }],
      ['json', { p: 'A' }],
      ['json', { p: `${goodP}==` }],
      ['json', { p: b64u(Buffer.from('not json')) }],
      ['json', { p: b64u(Buffer.from('[1,2]')) }],
      ['json', { p: b64u(Buffer.from('"str"')) }],
      ['json', { p: b64u(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])) }],
      ['json', { p: b64u(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])) }],
      ['bytes', Uint8Array.from([0xff, 0xfe, 0xfd])],
      ['bytes', new TextEncoder().encode(`﻿{"p":"${goodP}"}`)],
    ]
    const [kind, value] = rng.pick(cases)
    await send({
      op,
      body: value,
      headers: kind === 'json' ? {} : { 'content-type': rng.pick(['application/json', 'text/plain', 'application/x-www-form-urlencoded']) },
      expect: [400],
      error: 'bad_request',
      note: `${kind} envelope on ${op}: ${clip(describeBody(typeof value === 'object' && !(value instanceof Uint8Array) ? JSON.stringify(value) : value), 80)}`,
    })
  },

  /** Valid payload, malformed `s` (missing, wrong type, wrong length, bad alphabet). */
  'malformed-signature': async (rng, canary) => {
    const op = rng.pick(CANARY_TARGET_OPS)
    const env = await signed(op, keyFor(op, canary), await validPayload(op, canary))
    const s = rng.pick([undefined, null, 7, '', env.s.slice(1), `${env.s}A`, `${env.s.slice(0, 85)}!`, `${env.s.slice(0, 84)}==`, 'A'.repeat(86), {}])
    await send({ op, body: { p: env.p, s }, expect: [401], error: 'bad_signature', note: `s=${clip(JSON.stringify(s) ?? 'undefined', 40)}` })
  },

  /** Blobs at the decoded-size limit succeed; one byte over is rejected. */
  'blob-boundaries': async (rng) => {
    const owner = await newOwner()
    const target = rng.pick(['roster', 'card', 'event', 'invite', 'claim'])
    const over = rng.bool()
    const status = over ? [400] : [200]
    const error = over ? 'bad_request' : undefined
    const size = (limit) => limit + (over ? 1 : 0)
    if (target === 'roster') {
      await owner.send('roster/put', { blob: blob(size(L.rosterBytes)) }, status, error)
    } else if (target === 'card' || target === 'event') {
      const writer = await newWriter(owner)
      if (target === 'card') await writer.send('card/put', { blob: blob(size(L.cardBytes)) }, status, error)
      else await writer.send('event/put', { eventId: rid(), kind: 'plan.joined', blob: blob(size(L.eventBytes)), push: false }, status, error)
    } else if (target === 'invite') {
      const secrets = await inviteSecrets()
      await owner.send(
        'invite/create',
        { inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(size(L.inviteBytes)), expiresAt: Date.now() + 60_000 },
        status,
        error
      )
    } else {
      const secrets = await inviteSecrets()
      await owner.send('invite/create', { inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(32), expiresAt: Date.now() + 60_000 })
      await send({
        op: 'invite/claim',
        body: unsignedEnvelope({ inviteId: secrets.inviteId, claimSecret: secrets.claimSecret, blob: blob(size(L.claimBytes)) }),
        expect: status,
        error,
        note: `claim blob ${size(L.claimBytes)} bytes`,
      })
    }
  },

  /** Whole envelopes past the 256 KiB ceiling, declared and streamed. */
  'oversized-envelope': async (rng, canary) => {
    const op = rng.pick(ALL_OPS)
    const bytes = L.requestBytes + rng.int(1, 64 * 1024)
    const filler = `{"p":"${'A'.repeat(bytes)}"}`
    if (rng.bool()) {
      await send({ op, body: filler, headers: { 'content-type': 'application/json' }, expect: [400], error: 'bad_request', note: `${filler.length}-byte envelope` })
    } else {
      const encoded = new TextEncoder().encode(filler)
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < encoded.length; i += 16_384) controller.enqueue(encoded.subarray(i, i + 16_384))
          controller.close()
        },
      })
      await send({ op, body: stream, headers: { 'content-type': 'application/json' }, expect: [400], error: 'bad_request', note: `${encoded.length}-byte chunked envelope` })
      // wrangler dev's local proxy breaks the request after a cancelled chunked
      // upload (503 for a body request, an indefinite queue for a GET). Absorb
      // it with a resendable POST so later cases measure the worker, not the proxy.
      await send({ path: '/verify-drain', body: '{}', expect: [404], note: 'drain wrangler-dev proxy after cancelled upload' })
    }
    void canary
  },

  /** Unknown ops, odd paths, wrong methods: always a 4xx. */
  'unknown-route': async (rng) => {
    const path = rng.pick([
      '/buddies/v1/inbox/explode',
      '/buddies/v1/INBOX/SYNC',
      '/buddies/v1/inbox/sync/',
      '/buddies/v1/inbox%2Fsync',
      '/buddies/v1/',
      '/buddies/v2/inbox/sync',
      `/buddies/v1/${'a'.repeat(8_000)}`,
      '/buddies/v1/%F0%9F%98%80',
      '/buddies/v1/invite/fetch%00',
      '/buddies/v1/..%2f..%2fhealth',
    ])
    const method = rng.pick(['POST', 'GET', 'PUT', 'DELETE', 'PATCH'])
    await send({
      path,
      method,
      body: method === 'GET' ? undefined : unsignedEnvelope({ inviteId: rid() }),
      expect: (status) => status >= 400 && status < 500,
      note: `${method} ${clip(path, 60)}`,
    })
    const known = rng.pick(ALL_OPS)
    const wrongMethod = rng.pick(['GET', 'PUT', 'DELETE'])
    await send({ op: known, method: wrongMethod, expect: (s) => s === 404 || s === 405, note: `${wrongMethod} on ${known}` })
  },

  /** Unicode, control chars, lone surrogates, huge strings in ignored and real fields. */
  'unicode-and-huge': async (rng) => {
    const owner = await newOwner()
    const weird = rng.pick([
      '😀👨‍👩‍👧‍👦',
      '‮evil‬',
      '\u0000\u0001\u001f',
      '\ud800',
      '\udfff\ud800',
      'é'.repeat(50_000),
      '￿￾',
      'x'.repeat(150_000),
    ])
    if (rng.bool()) {
      // Unknown fields (including the reserved `attest`) are dropped: still valid.
      await owner.send('inbox/sync', { since: 0, attest: weird, [`k${weird.slice(0, 8)}`]: 'v' }, [200])
    } else {
      const field = rng.pick(['nonce', 'inboxId', 'blob'])
      const payload = { ts: Date.now(), nonce: rid(), inboxId: owner.inboxId, blob: blob(32), [field]: weird }
      await send({ op: 'roster/put', body: await signedEnvelope('roster/put', payload, owner.key), expect: [400], error: 'bad_request', note: `roster/put.${field} weird string` })
    }
  },

  /** Count caps: slots + open invites ≤ 5, open invites ≤ 3, templates/kind limits. */
  'cap-boundaries': async (rng) => {
    const owner = await newOwner()
    const variant = rng.pick(['slots', 'invites', 'templates', 'kind', 'expiry'])
    if (variant === 'slots') {
      for (let i = 0; i < L.slotsPlusOpenInvites; i++) await newWriter(owner)
      await owner.send('slot/add', { slotId: rid(), writerPub: (await newKey()).publicKey }, [429], 'limit')
    } else if (variant === 'invites') {
      const create = async (expect, error) => {
        const secrets = await inviteSecrets()
        await owner.send('invite/create', { inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(16), expiresAt: Date.now() + 60_000 }, expect, error)
      }
      for (let i = 0; i < L.openInvites; i++) await create([200])
      await create([429], 'limit')
    } else if (variant === 'templates') {
      const count = rng.bool() ? L.templates : L.templates + 1
      const title = rng.bool() ? '😀'.repeat(L.templateChars) : '😀'.repeat(L.templateChars + 1)
      const ok = count <= L.templates && [...title].length <= L.templateChars
      const templates = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, { title, body: 'b' }]))
      await owner.send(
        'device/register',
        { deviceId: rid(), apnsToken: randomBytes(32).toString('hex'), apnsEnvironment: 'production', templates },
        ok ? [200] : [400],
        ok ? undefined : 'bad_request'
      )
    } else if (variant === 'kind') {
      const writer = await newWriter(owner)
      const over = rng.bool()
      await writer.send('event/put', { eventId: rid(), kind: 'a'.repeat(L.kindChars + (over ? 1 : 0)), blob: blob(8), push: false }, over ? [400] : [200])
    } else {
      const over = rng.bool()
      const secrets = await inviteSecrets()
      const expiresAt = Date.now() + (over ? L.maxInviteLifetimeMs + 60_000 : L.maxInviteLifetimeMs - 60_000)
      await owner.send('invite/create', { inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(16), expiresAt }, over ? [400] : [200])
    }
  },

  /** Five wrong claim secrets burn an invite; then even the right one is not_found. */
  'claim-burn': async (rng) => {
    const owner = await newOwner()
    const secrets = await inviteSecrets()
    await owner.send('invite/create', { inviteId: secrets.inviteId, claimVerifier: secrets.claimVerifier, blob: blob(16), expiresAt: Date.now() + 60_000 })
    const wrong = rng.int(1, 6)
    for (let i = 0; i < wrong; i++) {
      await send({
        op: 'invite/claim',
        body: unsignedEnvelope({ inviteId: secrets.inviteId, claimSecret: b64u(randomBytes(32)), blob: blob(16) }),
        expect: i < 5 ? [401] : [404],
        note: `wrong claim ${i + 1}`,
      })
    }
    const burned = wrong >= 5
    await send({
      op: 'invite/claim',
      body: unsignedEnvelope({ inviteId: secrets.inviteId, claimSecret: secrets.claimSecret, blob: blob(16) }),
      expect: burned ? [404] : [200],
      note: burned ? 'right secret after burn' : 'right secret before burn',
    })
  },

  /**
   * Per-caller edge limits: a fresh caller (an IPv4 address, or rotating
   * addresses in one IPv6 /64) gets `limit` answers, then 429 `rate_limited`
   * with Retry-After. Up to 2 × limit + 1 requests, since the limiter counts
   * in fixed minutes and a boundary may fall mid-burst.
   */
  'caller-limits': async (rng) => {
    const tier = rng.pick(['unsigned', 'register'])
    const limit = WIRE_EDGE_LIMITS[tier]
    const word = () => randomBytes(2).toString('hex')
    const v6 = rng.bool()
    const prefix = `2001:db8:${word()}:${word()}`
    const v4 = `100.${64 + (randomBytes(1)[0] & 63)}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`
    const owner = { key: await newKey(), inboxId: rid() }
    const expected = tier === 'unsigned' ? 404 : 200
    for (let i = 0; i < 2 * limit + 1; i++) {
      const headers = { 'cf-connecting-ip': v6 ? `${prefix}:${word()}:${word()}:${word()}:${word()}` : v4 }
      const request =
        tier === 'unsigned'
          ? { op: 'invite/fetch', body: unsignedEnvelope({ inviteId: rid() }) }
          : { op: 'inbox/register', body: await signed('inbox/register', owner.key, { inboxId: owner.inboxId, ownerPub: owner.key.publicKey }) }
      const response = await send({
        ...request,
        headers,
        expect: i < limit ? [expected] : [expected, 429],
        note: `${tier} request ${i + 1} from ${v6 ? 'one /64' : 'one IPv4'}`,
      })
      if (response.status === 429) {
        if (response.json?.error !== 'rate_limited' || response.headers.get('retry-after') !== '60')
          throw new FuzzFailure('edge refusal without rate_limited + Retry-After: 60', caseLog.at(-1))
        return
      }
    }
    throw new FuzzFailure(`no 429 after ${2 * limit + 1} ${tier} requests from one caller`, caseLog.at(-1))
  },

  /** Concurrent same-eventId writes dedupe to one seq. */
  'parallel-dedupe': async (rng) => {
    const owner = await newOwner()
    const writer = await newWriter(owner)
    const eventId = rid()
    const copies = rng.int(2, 8)
    const results = await Promise.all(
      Array.from({ length: copies }, () => writer.send('event/put', { eventId, kind: 'plan.joined', blob: blob(16), push: false }))
    )
    const seqs = new Set(results.map((r) => r.json?.seq))
    if (seqs.size !== 1) throw new FuzzFailure(`dedupe: ${copies} parallel puts of one eventId produced seqs ${[...seqs].join(',')}`, caseLog.at(-1))
    const sync = await owner.send('inbox/sync', { since: 0 })
    const stored = sync.json.events.filter((event) => event.eventId === eventId)
    if (stored.length !== 1) throw new FuzzFailure(`dedupe: sync shows ${stored.length} copies of the event`, caseLog.at(-1))
  },
}

// --- Canary -------------------------------------------------------------------

const setupCanary = async () => {
  const owner = await newOwner()
  const writer = await newWriter(owner)
  await writer.send('card/put', { blob: blob(512) })
  await writer.send('event/put', { eventId: rid(), kind: 'plan.joined', blob: blob(64), push: false })
  await owner.send('roster/put', { blob: blob(256) })
  await owner.send('device/register', { deviceId: rid(), apnsToken: randomBytes(32).toString('hex'), apnsEnvironment: 'sandbox', templates: TEMPLATES })
  const snapshot = (await owner.send('inbox/sync', { since: 0 })).json
  return { owner, writer, snapshot }
}

const stable = (value) => JSON.stringify(value)

// --- Main -----------------------------------------------------------------------

const names = Object.keys(GENERATORS)
const offset = hash32(`offset:${SEED}`) % names.length
const indices = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: RUNS }, (_, i) => i)
const failures = []
const startedAt = new Date()
console.log(`fuzz: ${indices.length} case(s) against ${BASE} with seed ${SEED}`)

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null)
if (!health?.ok) {
  console.error(`fuzz: ${BASE}/health is not ok; start the worker first (node scripts/verify/dev.mjs up)`)
  process.exit(2)
}

caseLog = []
let canary
try {
  canary = await setupCanary()
} catch (error) {
  console.error('fuzz: canary setup failed (harness or server bug):', error.message, JSON.stringify(error.exchange ?? {}, null, 2))
  process.exit(1)
}

for (const index of indices) {
  const name = names[(index + offset) % names.length]
  const rng = makeRng(hash32(`${SEED}:${index}`))
  caseLog = []
  const bucket = (stats.byGenerator[name] ??= { cases: 0, failures: 0 })
  bucket.cases++
  try {
    await GENERATORS[name](rng, canary)
  } catch (error) {
    bucket.failures++
    const failure = {
      case: index,
      generator: name,
      reason: error.message,
      failingExchange: error.exchange ?? null,
      transcript: caseLog,
      repro: `pnpm fuzz:buddies --seed ${SEED} --case ${index}`,
    }
    if (!(error instanceof FuzzFailure)) failure.stack = error.stack
    failures.push(failure)
    console.log(`FAIL case ${index} [${name}]: ${error.message}`)
  }
}

// Post-fuzz invariants: canary intact, worker healthy.
caseLog = []
let canaryOk = false
let canaryDetail = null
try {
  const after = await canary.owner.send('inbox/sync', { since: 0 })
  canaryOk = stable(after.json) === stable(canary.snapshot)
  if (!canaryOk) canaryDetail = { before: canary.snapshot, after: after.json }
} catch (error) {
  canaryDetail = { error: error.message, exchange: error.exchange }
}
if (!canaryOk) {
  failures.push({ case: 'canary', generator: 'canary', reason: 'canary inbox changed or became unsyncable', detail: canaryDetail, transcript: caseLog })
  console.log('FAIL canary: inbox state changed or unsyncable after fuzzing')
}
const healthAfter = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.ok).catch(() => false)
if (!healthAfter) failures.push({ case: 'health', generator: 'health', reason: '/health not ok after fuzzing' })
// Clean up the canary so repeated runs don't accumulate state.
await canary.owner.send('inbox/delete', {}).catch(() => undefined)

const sorted = [...stats.latencies].sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
const report = {
  seed: SEED,
  runs: indices.length,
  only: ONLY ?? null,
  url: BASE,
  startedAt: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  requests: stats.requests,
  devProxyRetries: stats.devProxyRetries,
  statuses: stats.statuses,
  latencyMs: { p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? 0 },
  generators: stats.byGenerator,
  canary: { intact: canaryOk, detail: canaryDetail },
  healthAfter,
  failures,
}
mkdirSync(ARTIFACTS, { recursive: true })
const reportPath = join(ARTIFACTS, `fuzz-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(
  `fuzz: ${indices.length} cases, ${stats.requests} requests, statuses ${JSON.stringify(stats.statuses)}, p95 ${pct(95)}ms, max ${report.latencyMs.max}ms, wrangler-dev proxy retries ${stats.devProxyRetries}`
)
console.log(`fuzz: canary ${canaryOk ? 'intact' : 'BROKEN'}, health after ${healthAfter ? 'ok' : 'FAILED'}`)
console.log(`fuzz: report ${reportPath}`)
if (failures.length) {
  console.log(`fuzz: ${failures.length} failure(s); seed ${SEED}. First repro:`)
  const first = failures[0]
  console.log(`  ${first.repro ?? '(post-run invariant)'}`)
  if (first.failingExchange) console.log(JSON.stringify(first.failingExchange, (k, v) => (typeof v === 'string' ? clip(v, 500) : v), 2))
  process.exit(1)
}
console.log('fuzz: ok')
