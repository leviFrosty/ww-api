import type { Environment } from '../types'

/**
 * Cloud Sync's switches (witness-work ADR 0030), both in `NOTES_KV` and
 * edge-cached for 60 seconds like `buddies:enabled`:
 *
 * - `sync:enabled`: `"true"` or `"on"` turns Cloud Sync on, anything else off;
 *   absent (or unreadable), the `SYNC_ENABLED` var decides the same way.
 * - `sync:entitlement`: `"everyone"` makes it free; `"supporter"` (and
 *   anything else) keeps it a Supporter benefit; absent, the
 *   `SYNC_ENTITLEMENT` var, else `supporter`.
 */

export const SYNC_ENABLED_KEY = 'sync:enabled'
export const SYNC_ENTITLEMENT_KEY = 'sync:entitlement'
const CACHE_TTL_SECONDS = 60
const ON = new Set(['true', 'on'])

export type SyncEntitlement = 'supporter' | 'everyone'

export type SyncSwitchEnv = Pick<
  Environment,
  'SYNC_ENABLED' | 'SYNC_ENTITLEMENT'
> & { NOTES_KV: Pick<KVNamespace, 'get'> }

const read = async (
  env: SyncSwitchEnv,
  key: string
): Promise<string | null> => {
  try {
    return await env.NOTES_KV.get(key, { cacheTtl: CACHE_TTL_SECONDS })
  } catch {
    console.warn('sync: switch KV read failed; using the var', { key })
    return null
  }
}

export const isSyncEnabled = async (env: SyncSwitchEnv): Promise<boolean> => {
  const value = await read(env, SYNC_ENABLED_KEY)
  return ON.has((value ?? env.SYNC_ENABLED ?? '').trim())
}

export const syncEntitlement = async (
  env: SyncSwitchEnv
): Promise<SyncEntitlement> => {
  const value = await read(env, SYNC_ENTITLEMENT_KEY)
  return (value ?? env.SYNC_ENTITLEMENT ?? '').trim() === 'everyone'
    ? 'everyone'
    : 'supporter'
}

/** Both switches, as `GET /app/v1/config` and `GET /accounts/v1/sync` say them. */
export const syncSwitches = async (
  env: SyncSwitchEnv
): Promise<{ enabled: boolean; entitlement: SyncEntitlement }> => {
  const [enabled, entitlement] = await Promise.all([
    isSyncEnabled(env),
    syncEntitlement(env),
  ])
  return { enabled, entitlement }
}
