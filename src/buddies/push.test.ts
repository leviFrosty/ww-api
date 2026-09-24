import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetApnsState } from '../apns'
import { deliverPushJob, type PushEnv } from './push'
import type { PushJob, PushTarget } from './contracts'
import { makeMemoryKv } from '../test/memoryKv'
import {
  APNS_KEY_ID,
  BUNDLE_ID,
  Owner,
  TEAM_ID,
  createHarness,
  hexToken,
  randomId,
} from '../test/buddies'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: unknown
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const NOW = Date.UTC(2026, 8, 23, 12)

const target = (overrides: Partial<PushTarget> = {}): PushTarget => ({
  deviceId: randomId(),
  apnsToken: hexToken(32),
  apnsEnvironment: 'sandbox',
  title: 'Buddy request',
  body: 'Someone accepted your invite',
  ...overrides,
})

const setup = async () => {
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer
  )
  let binary = ''
  for (const byte of der) binary += String.fromCharCode(byte)
  const removeDevices = vi.fn(async () => undefined)
  const env = {
    APNS_KEY_ID,
    APNS_PRIVATE_KEY: btoa(binary),
    APPLE_TEAM_ID: TEAM_ID,
    IOS_BUNDLE_ID: BUNDLE_ID,
    NOTES_KV: makeMemoryKv(),
    BUDDY_INBOX: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ removeDevices }),
    },
  } as unknown as PushEnv
  const requests: Array<{ url: string; init: RequestInit }> = []
  let respond = (_url: string): Response => new Response(null, { status: 200 })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return respond(String(input))
  })
  const deps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
    sleep: async () => undefined,
  }
  return {
    env,
    removeDevices,
    requests,
    deps,
    respondWith: (fn: (url: string) => Response) => {
      respond = fn
    },
  }
}

beforeEach(() => resetApnsState())
afterEach(() => vi.restoreAllMocks())

describe('deliverPushJob', () => {
  it('sends the contract alert to each target environment', async () => {
    const { env, requests, deps } = await setup()
    const sandbox = target()
    const production = target({
      apnsEnvironment: 'production',
      title: 'Hola',
      body: 'Cuerpo',
    })
    const job: PushJob = {
      inboxId: randomId(),
      kind: 'invite.claimed',
      targets: [sandbox, production],
    }

    await deliverPushJob(env, job, deps)

    expect(requests.map((request) => request.url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${sandbox.apnsToken}`,
      `https://api.push.apple.com/3/device/${production.apnsToken}`,
    ])
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      aps: {
        alert: { title: 'Buddy request', body: 'Someone accepted your invite' },
        sound: 'default',
        'thread-id': 'buddies',
      },
      ww: { kind: 'invite.claimed' },
    })
    expect(JSON.parse(String(requests[1].init.body)).aps.alert).toEqual({
      title: 'Hola',
      body: 'Cuerpo',
    })
  })

  it('deletes only devices APNs reports as unregistered', async () => {
    const { env, removeDevices, deps, respondWith } = await setup()
    const gone = target()
    const bad = target()
    const wrongTopic = target()
    const fine = target({ apnsEnvironment: 'production' })
    respondWith((url) => {
      if (url.endsWith(gone.apnsToken))
        return Response.json({ reason: 'Unregistered' }, { status: 410 })
      if (url.endsWith(bad.apnsToken))
        return Response.json({ reason: 'BadDeviceToken' }, { status: 400 })
      if (url.endsWith(wrongTopic.apnsToken)) {
        return Response.json(
          { reason: 'DeviceTokenNotForTopic' },
          { status: 400 }
        )
      }
      return new Response(null, { status: 200 })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const inboxId = randomId()

    await deliverPushJob(
      env,
      { inboxId, kind: 'k', targets: [gone, bad, wrongTopic, fine] },
      deps
    )

    expect(removeDevices).toHaveBeenCalledTimes(1)
    expect(removeDevices).toHaveBeenCalledWith([
      { deviceId: gone.deviceId, apnsToken: gone.apnsToken },
      { deviceId: bad.deviceId, apnsToken: bad.apnsToken },
    ])
    // Logged failures never carry the token or ids.
    const logged = JSON.stringify(warn.mock.calls)
    for (const secret of [wrongTopic.apnsToken, wrongTopic.deviceId, inboxId]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('removes nothing when APNs is not configured', async () => {
    const { env, removeDevices, requests, deps } = await setup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await deliverPushJob(
      { ...env, APNS_KEY_ID: undefined },
      { inboxId: randomId(), kind: 'k', targets: [target()] },
      deps
    )

    expect(requests).toHaveLength(0)
    expect(removeDevices).not.toHaveBeenCalled()
  })
})

describe('stale device cleanup through the relay', () => {
  it('removes a device from the inbox after APNs answers 410', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      const h = await createHarness()
      const owner = await Owner.create(h)
      const staleToken = hexToken(32)
      await owner.registerDevice(randomId(), undefined, staleToken)
      await owner.registerDevice()
      h.apnsResponse = (push) =>
        push.url.endsWith(staleToken)
          ? Response.json({ reason: 'Unregistered' }, { status: 410 })
          : new Response(null, { status: 200 })

      const buddy = await owner.addWriter()
      await buddy.putEvent({ push: true })
      await h.flush()

      expect(h.pushes).toHaveLength(2)
      const tokens = h.inboxes
        .storage(owner.inboxId)
        .query('SELECT apns_token AS token FROM device')
        .map((row) => row.token)
      expect(tokens).toHaveLength(1)
      expect(tokens).not.toContain(staleToken)
    } finally {
      vi.useRealTimers()
    }
  })
})
