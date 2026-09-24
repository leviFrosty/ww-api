import type { Environment } from '../types'
import {
  defaultApnsDependencies,
  sendApnsNotifications,
  type ApnsDependencies,
  type ApnsEnv,
} from '../apns'
import type { PushJob, PushTarget } from './contracts'

/**
 * Buddies on top of the generic APNs sender. Durable Objects only decide
 * *what* to push; the Worker sends it from `ctx.waitUntil`, so APNs latency is
 * billed as Worker CPU rather than DO wall-clock.
 *
 * Privacy: nothing here logs tokens, ids, or template text.
 */

export type PushEnv = ApnsEnv & Pick<Environment, 'BUDDY_INBOX'>

/** The exact alert payload from the contract. No user content. */
export const buildBuddiesPayload = (
  kind: string,
  target: Pick<PushTarget, 'title' | 'body'>
) => ({
  aps: {
    alert: { title: target.title, body: target.body },
    sound: 'default',
    'thread-id': 'buddies',
  },
  ww: { kind },
})

/**
 * Sends one alert per target and deletes devices whose token APNs reports as
 * unregistered. Never throws: it runs in `waitUntil`.
 */
export const deliverPushJob = async (
  env: PushEnv,
  job: PushJob,
  deps: ApnsDependencies = defaultApnsDependencies
): Promise<void> => {
  const outcomes = await sendApnsNotifications(
    env,
    job.targets.map((target) => ({
      device: { token: target.apnsToken, environment: target.apnsEnvironment },
      payload: buildBuddiesPayload(job.kind, target),
    })),
    deps
  )

  const stale = job.targets
    .filter((_, index) => outcomes[index] === 'unregistered')
    .map(({ deviceId, apnsToken }) => ({ deviceId, apnsToken }))
  if (!stale.length) return
  try {
    const inbox = env.BUDDY_INBOX.get(env.BUDDY_INBOX.idFromName(job.inboxId))
    await inbox.removeDevices(stale)
  } catch {
    console.warn('buddies: stale device cleanup failed')
  }
}
