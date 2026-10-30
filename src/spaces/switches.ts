import type { Environment } from '../types'
import { SPACES_LIMITS } from './contracts'

/**
 * Shared Spaces' switches (witness-work ADR 0037), both in `NOTES_KV` and
 * edge-cached for 60 seconds like `buddies:enabled`:
 *
 * - `spaces:enabled`: `"true"` turns Shared Spaces on, anything else off;
 *   absent (or unreadable), the `SPACES_ENABLED` var decides the same way.
 * - `spaces:maxMembers`: members plus open invites a space may hold, a
 *   whole number from 1 to `maxMembersCeiling`; absent or anything else,
 *   `defaultMaxMembers` (10).
 */

export const SPACES_ENABLED_KEY = 'spaces:enabled'
export const SPACES_MAX_MEMBERS_KEY = 'spaces:maxMembers'
const CACHE_TTL_SECONDS = 60

export type SpacesSwitchEnv = Pick<Environment, 'SPACES_ENABLED'> & {
  NOTES_KV: Pick<KVNamespace, 'get'>
}

const read = async (
  env: Pick<SpacesSwitchEnv, 'NOTES_KV'>,
  key: string
): Promise<string | null> => {
  try {
    return await env.NOTES_KV.get(key, { cacheTtl: CACHE_TTL_SECONDS })
  } catch {
    console.warn('spaces: switch KV read failed; using the default', { key })
    return null
  }
}

export const isSpacesEnabled = async (env: SpacesSwitchEnv): Promise<boolean> => {
  const value = await read(env, SPACES_ENABLED_KEY)
  return (value ?? env.SPACES_ENABLED ?? '').trim() === 'true'
}

/** The member cap a space's invites and joins are held to right now. */
export const spacesMaxMembers = async (
  env: Pick<SpacesSwitchEnv, 'NOTES_KV'>
): Promise<number> => {
  const value = (await read(env, SPACES_MAX_MEMBERS_KEY))?.trim() ?? ''
  const cap = /^\d{1,4}$/.test(value) ? Number(value) : NaN
  return cap >= 1 && cap <= SPACES_LIMITS.maxMembersCeiling
    ? cap
    : SPACES_LIMITS.defaultMaxMembers
}
