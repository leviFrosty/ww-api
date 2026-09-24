import type { Environment } from '../types'

export const BUDDIES_ENABLED_KEY = 'buddies:enabled'
const CACHE_TTL_SECONDS = 60

export type KillSwitchEnv = Pick<Environment, 'BUDDIES_ENABLED'> & {
  NOTES_KV: Pick<KVNamespace, 'get'>
}

/**
 * Buddies is enabled iff KV `buddies:enabled` is `"true"`. When the key is
 * absent (or KV can't be read) the `BUDDIES_ENABLED` var decides. The KV read
 * is edge-cached for 60 seconds, like `notes-import:limits`.
 */
export const isBuddiesEnabled = async (
  env: KillSwitchEnv
): Promise<boolean> => {
  let value: string | null = null
  try {
    value = await env.NOTES_KV.get(BUDDIES_ENABLED_KEY, {
      cacheTtl: CACHE_TTL_SECONDS,
    })
  } catch {
    console.warn('buddies: kill-switch KV read failed; using BUDDIES_ENABLED')
  }
  if (value != null) return value.trim() === 'true'
  return env.BUDDIES_ENABLED?.trim() === 'true'
}
