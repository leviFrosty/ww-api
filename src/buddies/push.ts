import type { Environment } from '../types'
import {
  defaultApnsDependencies,
  sendApnsNotifications,
  type ApnsDependencies,
  type ApnsEnv,
} from '../apns'
import { sendFcmNotifications, type FcmEnv } from '../fcm'
import type { PushJob, PushTarget } from './contracts'

/**
 * Buddies on top of the generic APNs and FCM senders. Durable Objects only
 * decide *what* to push; the Worker sends it from `ctx.waitUntil`, so push
 * latency is billed as Worker CPU rather than DO wall-clock.
 *
 * Privacy: nothing here logs tokens, ids, or template text.
 */

export type PushEnv = ApnsEnv & FcmEnv & Pick<Environment, 'BUDDY_INBOX'>

/** `fetch`, clock, and sleep for both senders and Google's token exchange. */
export type PushDependencies = ApnsDependencies

/** The Android notification channel the app creates for Buddies alerts. */
export const BUDDIES_ANDROID_CHANNEL = 'buddies'

/**
 * How long FCM holds an alert for a device that is off or offline. Later than
 * this, the app has synced the event some other way or it's stale.
 */
const FCM_TTL = '86400s'

type ApnsTarget = Extract<PushTarget, { service: 'apns' }>
type FcmTarget = Extract<PushTarget, { service: 'fcm' }>

/**
 * The exact alert payload from the contract. No user content.
 * `content-available` also lets iOS wake the app to sync before it's opened;
 * the push stays an `alert` (apns-push-type) at the default priority 10.
 */
export const buildBuddiesPayload = (
  kind: string,
  target: Pick<PushTarget, 'title' | 'body'>
) => ({
  aps: {
    alert: { title: target.title, body: target.body },
    sound: 'default',
    'thread-id': 'buddies',
    'content-available': 1,
  },
  ww: { kind },
})

/**
 * The FCM counterpart: a data-only, high-priority message. expo-notifications
 * shows `title` and `message` in the `buddies` channel, hands the JSON in
 * `body` to the app as the notification's data (the same `ww` marker as iOS),
 * and wakes the app's background task to sync, as `content-available` does on
 * iOS. No user content.
 */
export const buildBuddiesFcmMessage = (
  kind: string,
  target: Pick<PushTarget, 'title' | 'body'>
) => ({
  data: {
    title: target.title,
    message: target.body,
    body: JSON.stringify({ ww: { kind } }),
    channelId: BUDDIES_ANDROID_CHANNEL,
  },
  android: { priority: 'HIGH', ttl: FCM_TTL },
})

const isApns = (target: PushTarget): target is ApnsTarget =>
  target.service === 'apns'
const isFcm = (target: PushTarget): target is FcmTarget =>
  target.service === 'fcm'

/**
 * Sends one alert per target, through APNs or FCM by the device's service, and
 * deletes devices whose token either reports as unregistered. Never throws: it
 * runs in `waitUntil`.
 */
export const deliverPushJob = async (
  env: PushEnv,
  job: PushJob,
  deps: PushDependencies = defaultApnsDependencies
): Promise<void> => {
  const apns = job.targets.filter(isApns)
  const fcm = job.targets.filter(isFcm)
  const [apnsOutcomes, fcmOutcomes] = await Promise.all([
    sendApnsNotifications(
      env,
      apns.map((target) => ({
        device: {
          token: target.token,
          environment: target.apnsEnvironment,
          ...(target.apnsTopic ? { topic: target.apnsTopic } : {}),
        },
        payload: buildBuddiesPayload(job.kind, target),
      })),
      deps
    ),
    sendFcmNotifications(
      env,
      fcm.map((target) => ({
        token: target.token,
        message: buildBuddiesFcmMessage(job.kind, target),
      })),
      deps
    ),
  ])

  const stale = [
    ...apns.filter((_, index) => apnsOutcomes[index] === 'unregistered'),
    ...fcm.filter((_, index) => fcmOutcomes[index] === 'unregistered'),
  ].map(({ deviceId, token }) => ({ deviceId, token }))
  if (!stale.length) return
  try {
    const inbox = env.BUDDY_INBOX.get(env.BUDDY_INBOX.idFromName(job.inboxId))
    await inbox.removeDevices(stale)
  } catch {
    console.warn('buddies: stale device cleanup failed')
  }
}
