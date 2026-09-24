import {
  resolveNotesImportLimits,
  resolveNotesImportMinAppVersion,
  type NotesImportConfig,
  type NotesImportLimits,
} from './config'
import type { Environment } from '../types'
import { APP_ATTEST_PROTOCOL_VERSION } from '../appAttest/protocol'

/** The KV subset this module uses — keeps it trivially mockable in tests. */
export type StatusKv = Pick<KVNamespace, 'get' | 'put'>

/**
 * Notes Import availability probe. Backs `GET /notes-import/status` so the app
 * can disable the import entry points BEFORE a user spends an attestation
 * round-trip (and before we'd spend any inference) when the feature can't
 * actually run. Two independent gates, cheapest first:
 *
 *   1. Manual KV kill-switch (`notes-import:enabled`) — flip the feature off (or
 *      back on) instantly with no redeploy. The value is a JSON record mirroring
 *      the status response:
 *         {"available": false, "reason": "down for maintenance"}   // force OFF
 *         {"available": true,  "reason": ""}                       // default ON
 *      Only `available: false` short-circuits (the app shows `reason`, if any).
 *      `available: true` (or an absent key) falls through to the provider check,
 *      so the auto-disable below still applies. Bare `false`/`off` strings are
 *      also honored for back-compat.
 *
 *   2. Provider health — OpenRouter's endpoints metadata API reports a per-host
 *      `status`. We check whether ANY provider on our ZDR allowlist is currently
 *      healthy for the configured model. This is a metadata call: it consumes NO
 *      tokens / inference credits. Result is cached in KV (short TTL) so the
 *      probe stays fast and we don't hammer the upstream.
 *
 * Fail-open by design: if the upstream check itself errors, we report available.
 * A flaky probe must never block a feature that would actually work — the real
 * import path still enforces attestation, credits, and ZDR routing server-side.
 */

/** Machine reasons the worker emits; operators may set free-form text instead. */
export type NotesImportUnavailableReason = 'disabled' | 'no_provider'

export interface PublicNotesImportLimits {
  imports: { free: number | null; supporter: number | null }
  refinements: { free: number | null; supporter: number | null }
  windowDays: number
}

/**
 * Available responses normally carry the fresh public schedule. A fail-open
 * provider-probe error deliberately omits it so clients can attempt an import
 * without presenting allowance claims that the probe did not confirm.
 */
type NotesImportStatusState =
  | { available: true; limits?: PublicNotesImportLimits }
  | { available: false; reason?: string }

export interface NotesImportCapabilities {
  appAttest: {
    protocolVersions: readonly [1, typeof APP_ATTEST_PROTOCOL_VERSION]
  }
}

export type NotesImportStatusResponse = NotesImportStatusState & {
  capabilities: NotesImportCapabilities
  /**
   * Minimum app version (`major.minor.patch`) that can use Notes Import; omitted
   * when no floor is configured. Clients below it disable the composer
   * client-side and prompt for an update — the worker does not enforce it.
   */
  minAppVersion?: string
}

const NOTES_IMPORT_CAPABILITIES: NotesImportCapabilities = {
  appAttest: { protocolVersions: [1, APP_ATTEST_PROTOCOL_VERSION] },
}

const ENABLED_KEY = 'notes-import:enabled'
const PROVIDER_CACHE_KEY = 'notes-import:provider-health'
const PROVIDER_CACHE_TTL_SECONDS = 60

/** OpenRouter per-endpoint `status`: 0 = normal, negatives = degraded/disabled. */
const isHealthyStatus = (status: unknown): boolean => {
  if (status == null) return true // no signal → don't treat as down
  const n = typeof status === 'number' ? status : Number(status)
  return Number.isFinite(n) ? n >= 0 : true
}

/** Loose match of an OpenRouter `provider_name` to one of our allowlist slugs. */
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const matchesAllowlist = (
  providerName: string,
  allowlist: readonly string[]
): boolean => {
  const p = normalize(providerName)
  if (!p) return false
  return allowlist.some((slug) => {
    const s = normalize(slug)
    return s.length > 0 && (p === s || p.includes(s) || s.includes(p))
  })
}

interface OpenRouterEndpoint {
  provider_name?: string
  status?: number | string
}

export interface OpenRouterEndpointsResponse {
  data?: { endpoints?: OpenRouterEndpoint[] }
}

/**
 * Pure decision: does the OpenRouter endpoints payload show at least one
 * allowlisted provider in a healthy state for the model? Exported for tests.
 */
export const anyAllowlistedProviderHealthy = (
  body: OpenRouterEndpointsResponse,
  allowlist: readonly string[]
): boolean => {
  const endpoints = body.data?.endpoints ?? []
  return endpoints.some(
    (e) =>
      typeof e.provider_name === 'string' &&
      matchesAllowlist(e.provider_name, allowlist) &&
      isHealthyStatus(e.status)
  )
}

/**
 * Returns true if at least one allowlisted provider is healthy for the model,
 * per OpenRouter's free endpoints metadata API. Throws on a failed/garbled
 * upstream response so the caller can fail open.
 */
const probeProviderHealth = async (
  apiKey: string,
  config: NotesImportConfig,
  fetchFn: typeof fetch
): Promise<boolean> => {
  // Model slug is `<author>/<slug>` (e.g. `deepseek/deepseek-v4-flash`).
  const slash = config.model.indexOf('/')
  if (slash <= 0) return true // unrecognized slug shape → don't block
  const author = config.model.slice(0, slash)
  const slug = config.model.slice(slash + 1)
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(
    author
  )}/${encodeURIComponent(slug)}/endpoints`

  const controller = new AbortController()
  // Bound both response headers and body consumption; a stalled metadata probe
  // must not hold the public status endpoint open until the app's 8s timeout.
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`OpenRouter endpoints API returned ${res.status}`)
    }
    const body = (await res.json()) as OpenRouterEndpointsResponse
    return anyAllowlistedProviderHealthy(body, config.providers)
  } finally {
    clearTimeout(timeout)
  }
}

const KILL_SWITCH_OFF = new Set(['false', 'off', '0', 'no', 'disabled'])

interface EnabledOverride {
  available: boolean
  reason?: string
}

/**
 * Parses the `notes-import:enabled` record into a manual override, or null when
 * the value is absent/unrecognized (→ no override, fall through to the probe).
 * Accepts the canonical JSON `{ available, reason }`, a bare JSON boolean, and
 * legacy falsy strings (`false`/`off`/...).
 */
const parseEnabledOverride = (raw: string | null): EnabledOverride | null => {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (KILL_SWITCH_OFF.has(trimmed.toLowerCase())) return { available: false }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'boolean') return { available: parsed }
    if (parsed && typeof parsed === 'object' && 'available' in parsed) {
      const obj = parsed as { available?: unknown; reason?: unknown }
      const reason =
        typeof obj.reason === 'string' && obj.reason.trim().length > 0
          ? obj.reason.trim()
          : undefined
      // Anything but an explicit `false` means "not manually disabled".
      return { available: obj.available !== false, reason }
    }
  } catch {
    // Not JSON and not a known string → treat as no override.
  }
  return null
}

export interface NotesImportStatusDeps {
  kv: StatusKv
  env: Environment
  apiKey: string
  config: NotesImportConfig
  /** Internal enforcement probes skip schedule resolution to avoid a second KV read. */
  includeLimits?: boolean
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

/**
 * Resolves whether Notes Import is currently usable. Cheap KV kill-switch first,
 * then a cached provider-health probe. Never throws — fails open.
 */
const publicSchedule = (limits: NotesImportLimits): PublicNotesImportLimits => {
  const wire = (value: number): number | null => (value === -1 ? null : value)
  return {
    imports: {
      free: wire(limits.importsFree),
      supporter: wire(limits.importsSupporter),
    },
    refinements: {
      free: wire(limits.refinementsFree),
      supporter: wire(limits.refinementsSupporter),
    },
    windowDays: limits.windowDays,
  }
}

const resolveNotesImportStatus = async ({
  kv,
  env,
  apiKey,
  config,
  includeLimits = true,
  fetchFn = fetch,
}: NotesImportStatusDeps): Promise<NotesImportStatusState> => {
  const availableWithSchedule = async (): Promise<NotesImportStatusState> =>
    includeLimits
      ? {
          available: true,
          limits: publicSchedule(await resolveNotesImportLimits(env, kv)),
        }
      : { available: true }
  // 1. Manual kill-switch. Read and decide this stage independently: once an
  // explicit OFF value has been observed, a later provider-cache failure must
  // never turn the feature back on.
  let overrideRaw: string | null
  try {
    overrideRaw = await kv.get(ENABLED_KEY)
  } catch {
    return { available: true }
  }
  const override = parseEnabledOverride(overrideRaw)
  if (override && !override.available) {
    return { available: false, reason: override.reason ?? 'disabled' }
  }

  // 2. Provider health cache. Its read may fail open, but cannot bypass the
  // already-decided kill-switch stage above.
  let cached: string | null
  try {
    cached = await kv.get(PROVIDER_CACHE_KEY)
  } catch {
    return { available: true }
  }
  if (cached === 'up') return availableWithSchedule()
  if (cached === 'down') return { available: false, reason: 'no_provider' }

  // 3. Probe. Only probe failures fail open. Persisting the confirmed result is
  // best effort and must not reverse an unhealthy result when KV.put fails.
  let healthy: boolean
  try {
    healthy = await probeProviderHealth(apiKey, config, fetchFn)
  } catch {
    return { available: true }
  }
  try {
    await kv.put(PROVIDER_CACHE_KEY, healthy ? 'up' : 'down', {
      expirationTtl: PROVIDER_CACHE_TTL_SECONDS,
    })
  } catch {
    // The current probe result is still authoritative for this response.
  }
  return healthy
    ? availableWithSchedule()
    : { available: false, reason: 'no_provider' }
}

export const getNotesImportStatus = async (
  dependencies: NotesImportStatusDeps
): Promise<NotesImportStatusResponse> => {
  const [state, minAppVersion] = await Promise.all([
    resolveNotesImportStatus(dependencies),
    resolveNotesImportMinAppVersion(dependencies.env, dependencies.kv),
  ])
  return {
    ...state,
    capabilities: NOTES_IMPORT_CAPABILITIES,
    ...(minAppVersion ? { minAppVersion } : {}),
  }
}
