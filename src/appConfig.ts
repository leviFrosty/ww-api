import type { AppContext, Environment } from './types'
import { parseMinAppVersion } from './notesImport/config'

/**
 * `GET /app/v1/config` (witness-work ADR 0027, `docs/accounts-protocol.md`,
 * "Updates and the legacy switch"): what every app version from sessions on
 * reads at launch and on returning to the foreground. Below `minAppVersion`
 * the app shows a blocking Update Required screen with a store link. It's the
 * app-wide successor to Notes Import's own `notes-import:min-version`.
 *
 * No authentication; the worker never rejects a request for its version.
 */

export const APP_MIN_VERSION_KEY = 'app:min-version'
const CACHE_TTL_SECONDS = 60
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * The app's minimum version (`major.minor.patch`), or null without a floor:
 * KV `app:min-version` (`{"minVersion":"1.42.0"}`), else the
 * `APP_MIN_VERSION` var. Invalid values are logged and ignored; the KV read
 * is edge-cached for 60 seconds.
 */
export const resolveAppMinVersion = async (
  env: Pick<Environment, 'APP_MIN_VERSION'> & {
    NOTES_KV: Pick<KVNamespace, 'get'>
  }
): Promise<string | null> => {
  let raw: string | null = null
  try {
    raw = await env.NOTES_KV.get(APP_MIN_VERSION_KEY, {
      cacheTtl: CACHE_TTL_SECONDS,
    })
  } catch {
    console.warn('app: min-version KV read failed; using APP_MIN_VERSION')
  }
  if (raw != null && raw.trim() !== '') {
    const version = parseMinAppVersion(raw)
    if (version) return version
    console.warn('app: min-version KV value is invalid')
  }
  const fallback = env.APP_MIN_VERSION?.trim()
  if (!fallback) return null
  if (SEMVER_PATTERN.test(fallback)) return fallback
  console.warn('APP_MIN_VERSION is invalid')
  return null
}

export const handleAppConfigRequest = async (c: AppContext) => {
  const minAppVersion = await resolveAppMinVersion(c.env)
  return c.json(minAppVersion ? { ok: true, minAppVersion } : { ok: true }, 200, {
    'Cache-Control': 'no-store',
  })
}
