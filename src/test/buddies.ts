import { vi } from 'vitest'
import { BuddyInbox } from '../buddies/inboxDO'
import { BuddyInvite } from '../buddies/inviteDO'
import { createBuddiesRoutes } from '../buddies/route'
import { resetApnsState } from '../apns'
import type { BuddiesSignedOp } from '../buddies/contracts'
import type { Environment } from '../types'
import { makeMemoryKv, type MemoryKv } from './memoryKv'
import { createNamespace, type FakeNamespace } from './durableObjects'
import {
  SigningKey,
  b64u,
  blobOfSize,
  envelope,
  hexToken,
  randomBytes,
  randomId,
} from './buddiesClient'

export * from './buddiesClient'

/**
 * End-to-end harness for the Buddies relay: the real Hono routes, the real
 * Durable Object classes on SQLite, an in-memory KV, a counting rate limiter,
 * and a recording APNs `fetch`. Requires `vi.mock('cloudflare:workers')` in
 * the calling test file.
 */

export const TEAM_ID = 'TEAMID1234'
export const APNS_KEY_ID = 'KEYID56789'
export const BUNDLE_ID = 'com.leviwilkerson.jwtimedev'

export interface RecordedPush {
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface ApiResponse {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

export interface HarnessOptions {
  enabled?: string
  kvEnabled?: string
  apnsConfigured?: boolean
  unsignedLimit?: number
}

export interface Harness {
  env: Environment
  kv: MemoryKv
  inboxes: FakeNamespace<BuddyInbox>
  invites: FakeNamespace<BuddyInvite>
  pushes: RecordedPush[]
  apnsPublicKey: CryptoKey
  /** Decides each APNs response; default 200. */
  apnsResponse: (push: RecordedPush) => Response
  rateLimitKeys: string[]
  post(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<ApiResponse>
  send(
    op: BuddiesSignedOp,
    key: SigningKey,
    payload: Record<string, unknown>
  ): Promise<ApiResponse>
  /** Awaits every `waitUntil` task (push delivery). */
  flush(): Promise<void>
}

const pem = (der: Uint8Array): string => {
  let binary = ''
  for (const byte of der) binary += String.fromCharCode(byte)
  const lines = btoa(binary).match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

export const createHarness = async (
  options: HarnessOptions = {}
): Promise<Harness> => {
  resetApnsState()
  const kv = makeMemoryKv()
  if (options.kvEnabled != null)
    await kv.put('buddies:enabled', options.kvEnabled)

  const apnsKeys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const apnsPrivateKey = pem(
    new Uint8Array(
      (await crypto.subtle.exportKey(
        'pkcs8',
        apnsKeys.privateKey
      )) as ArrayBuffer
    )
  )

  const rateLimitKeys: string[] = []
  const unsignedLimit = options.unsignedLimit ?? Number.POSITIVE_INFINITY
  const env = {
    NOTES_KV: kv,
    APPLE_TEAM_ID: TEAM_ID,
    IOS_BUNDLE_ID: BUNDLE_ID,
    BUDDIES_ENABLED: options.enabled ?? 'true',
    BUDDIES_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        rateLimitKeys.push(key)
        return {
          success:
            rateLimitKeys.filter((k) => k === key).length <= unsignedLimit,
        }
      },
    },
    ...(options.apnsConfigured === false
      ? {}
      : { APNS_KEY_ID, APNS_PRIVATE_KEY: apnsPrivateKey }),
  } as unknown as Environment & Record<string, unknown>

  const inboxes = createNamespace(
    (state) => new BuddyInbox(state as never, env as never)
  )
  const invites = createNamespace(
    (state) => new BuddyInvite(state as never, env as never)
  )
  env.BUDDY_INBOX = inboxes.namespace as Environment['BUDDY_INBOX']
  env.BUDDY_INVITE = invites.namespace as Environment['BUDDY_INVITE']

  const pending: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise)
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext

  const harness: Harness = {
    env,
    kv,
    inboxes,
    invites,
    pushes: [],
    apnsPublicKey: apnsKeys.publicKey,
    apnsResponse: () => new Response(null, { status: 200 }),
    rateLimitKeys,
    post: async () => {
      throw new Error('replaced below')
    },
    send: async () => {
      throw new Error('replaced below')
    },
    flush: async () => {
      while (pending.length) await Promise.all(pending.splice(0))
    },
  }

  const apnsFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const push: RecordedPush = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      }
      harness.pushes.push(push)
      return harness.apnsResponse(push)
    }
  )
  const routes = createBuddiesRoutes({
    apns: {
      fetch: apnsFetch as unknown as typeof fetch,
      now: () => Date.now(),
      sleep: async () => undefined,
    },
  })

  harness.post = async (path, body, headers = {}) => {
    const response = await routes.request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.7',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
      executionCtx
    )
    return { status: response.status, body: await response.json() }
  }

  harness.send = async (op, key, payload) =>
    harness.post(
      `/${op}`,
      await envelope(op, { ts: Date.now(), nonce: randomId(), ...payload }, key)
    )

  return harness
}

/** One person's Buddies identity: an inbox and the owner key that signs for it. */
export class Owner {
  readonly inboxId = randomId()

  private constructor(
    readonly harness: Harness,
    readonly key: SigningKey
  ) {}

  static async create(harness: Harness, register = true): Promise<Owner> {
    const owner = new Owner(harness, await SigningKey.generate())
    if (register) {
      const response = await owner.send('inbox/register', {
        ownerPub: owner.key.publicKey,
      })
      if (response.status !== 200)
        throw new Error(`register failed: ${response.status}`)
    }
    return owner
  }

  send(
    op: BuddiesSignedOp,
    payload: Record<string, unknown> = {}
  ): Promise<ApiResponse> {
    return this.harness.send(op, this.key, {
      inboxId: this.inboxId,
      ...payload,
    })
  }

  sync(since = 0): Promise<ApiResponse> {
    return this.send('inbox/sync', { since })
  }

  registerDevice(
    deviceId = randomId(),
    templates: Record<string, { title: string; body: string }> = {
      'invite.claimed': {
        title: 'Buddy request',
        body: 'Someone accepted your invite',
      },
      'pair.confirmed': {
        title: 'You are buddies',
        body: 'Your buddy confirmed',
      },
      'plan.joined': { title: 'Plans', body: 'A buddy is coming' },
    },
    apnsToken = hexToken(32),
    apnsEnvironment: 'sandbox' | 'production' = 'sandbox'
  ): Promise<ApiResponse> {
    return this.send('device/register', {
      deviceId,
      apnsToken,
      apnsEnvironment,
      templates,
    })
  }

  /** Adds a slot and returns the writer key a buddy would sign with. */
  async addWriter(slotId = randomId()): Promise<Writer> {
    const key = await SigningKey.generate()
    const response = await this.send('slot/add', {
      slotId,
      writerPub: key.publicKey,
    })
    if (response.status !== 200)
      throw new Error(`slot/add failed: ${response.status}`)
    return new Writer(this.harness, this.inboxId, slotId, key)
  }
}

/** A buddy's write capability into one recipient inbox slot. */
export class Writer {
  constructor(
    readonly harness: Harness,
    readonly inboxId: string,
    readonly slotId: string,
    readonly key: SigningKey
  ) {}

  send(
    op: BuddiesSignedOp,
    payload: Record<string, unknown> = {}
  ): Promise<ApiResponse> {
    return this.harness.send(op, this.key, {
      inboxId: this.inboxId,
      slotId: this.slotId,
      ...payload,
    })
  }

  putCard(blob = blobOfSize(64)): Promise<ApiResponse> {
    return this.send('card/put', { blob })
  }

  putEvent(
    fields: Partial<{
      eventId: string
      kind: string
      blob: string
      push: boolean
    }> = {}
  ) {
    return this.send('event/put', {
      eventId: randomId(),
      kind: 'plan.joined',
      blob: blobOfSize(48),
      push: false,
      ...fields,
    })
  }
}

/** Invite secrets as the contract derives them; ids here are just random. */
export const inviteSecrets = async () => {
  const claimSecret = randomBytes(32)
  const verifier = new Uint8Array(
    await crypto.subtle.digest('SHA-256', claimSecret)
  )
  return {
    inviteId: randomId(),
    claimSecret: b64u(claimSecret),
    claimVerifier: b64u(verifier),
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000
