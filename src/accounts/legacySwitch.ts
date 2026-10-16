import type { Environment } from '../types'
import { buddiesErrorResponse } from '../buddies/errorResponse'

/**
 * The legacy switch (witness-work ADR 0027, `docs/accounts-protocol.md`,
 * "Updates and the legacy switch"). While it's on, every route converted to
 * bearer tokens (accounts, backup, handoff, and later Buddies and Notes
 * Import) also accepts the way it authenticated before sessions: the signed
 * envelope or the per-request attestation. Off, those requests get 426
 * `upgrade_required`, and the app shows Update Required.
 *
 * KV `auth:legacy` in `NOTES_KV`: `"off"` (or `"false"`) turns it off, `"on"`
 * (or `"true"`) on. Absent, unreadable, or anything else falls back to the
 * `AUTH_LEGACY` var the same way, and then to on. Edge-cached for 60 seconds.
 */

export const AUTH_LEGACY_KEY = 'auth:legacy'
const CACHE_TTL_SECONDS = 60
const OFF = new Set(['off', 'false'])
const ON = new Set(['on', 'true'])

export type LegacySwitchEnv = Pick<Environment, 'AUTH_LEGACY'> & {
  NOTES_KV: Pick<KVNamespace, 'get'>
}

export const isLegacyAuthEnabled = async (
  env: LegacySwitchEnv
): Promise<boolean> => {
  let value: string | null = null
  try {
    value = await env.NOTES_KV.get(AUTH_LEGACY_KEY, {
      cacheTtl: CACHE_TTL_SECONDS,
    })
  } catch {
    console.warn('accounts: legacy switch KV read failed; using AUTH_LEGACY')
  }
  const stored = value?.trim().toLowerCase()
  if (stored && OFF.has(stored)) return false
  if (stored && ON.has(stored)) return true
  return !OFF.has(env.AUTH_LEGACY?.trim().toLowerCase() ?? '')
}

/** 426 `upgrade_required`, without `Retry-After`: only updating helps. */
export const upgradeRequiredResponse = (): Response =>
  buddiesErrorResponse('upgrade_required')

/**
 * For a request authenticated the old way: null while the legacy switch is
 * on, 426 `upgrade_required` once it's off.
 */
export const refuseLegacyAuth = async (
  env: LegacySwitchEnv
): Promise<Response | null> =>
  (await isLegacyAuthEnabled(env)) ? null : upgradeRequiredResponse()
