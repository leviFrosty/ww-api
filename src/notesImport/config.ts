import { z } from 'zod'
import type { Environment } from '../types'
import type { AnthropicEffort, AnthropicInferenceGeo } from '../llm'

/**
 * Environment-only Notes Import controls (model/provider, abuse ceilings,
 * active concurrency, Empty Import grace, and retention). Usage allowances are
 * resolved separately at runtime from KV → env → defaults below.
 */
/** OpenRouter reasoning effort levels, or null to leave reasoning off. */
export type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | null

export interface NotesImportConfig {
  model: string
  /**
   * OpenRouter provider allowlist — vetted **Western** ZDR hosts (ADR 0008),
   * IN ROUTING-PRIORITY ORDER (used for both `only` and `order`): the first is
   * preferred, the rest are fallbacks tried in turn when it errors (e.g. a 429).
   * This list controls *jurisdiction*; `zdr: true` + `data_collection: 'deny'`
   * enforce *retention* separately. Keep it Western-only: ZDR means the data
   * isn't stored, but the host still processes it in-flight, and a Western host
   * means enforceable recourse if that policy is ever broken. DeepInfra is
   * deliberately excluded — its reasoning parser misroutes the structured JSON
   * into the reasoning channel (no genuine reasoning; see llm.ts recovery path).
   */
  providers: string[]
  maxChars: number
  maxOutputTokens: number
  /**
   * Rolling window (seconds) over which free Empty Imports are counted. An Empty
   * Import (a run that produced no records) doesn't spend a credit, but each still
   * costs a real model call — so only {@link emptyWindowLimit} of them are free
   * within this window before they charge again (ADR 0012). Default 7 days.
   */
  emptyWindowSeconds: number
  /** Free Empty Imports allowed per {@link emptyWindowSeconds} before soft degrade. Default 5. */
  emptyWindowLimit: number
  /**
   * @deprecated Ignored by `isSupporter` (witness-work ADR 0014). Remove once
   * no caller passes it.
   */
  entitlementId: string
  devBypassToken: string | null
  /** Reject development App Attest attestations in the production Worker. */
  requireProduction: boolean
  /** Max concurrent in-flight imports per identity (non-Supporter). */
  activeImportCap: number
  /** Max concurrent in-flight imports per identity (Supporter). */
  activeImportCapSupporter: number
  /** How long a finished import's DO retains its result for reconnect (seconds). */
  resultRetentionSeconds: number
  /** TTL of a subscribe capability token in KV (seconds). */
  subscribeTokenTtlSeconds: number
  /**
   * OpenRouter reasoning effort, or null to disable. DEFAULT `xhigh` — on
   * `deepseek-v4-flash` OpenRouter accepts only `high` and `xhigh`, and `xhigh`
   * IS the model's max ("Think Max", ~4.2× the reasoning tokens of `high`). NOTE:
   * `max` is DeepSeek's *native*-API token, NOT valid on OpenRouter — sending it
   * silently degrades to default effort, so we coerce `max → xhigh`. The notes
   * task (date-math + dedup + role inference over messy text) is exactly where
   * reasoning lifts accuracy.
   *
   * `deepseek-v4-flash` co-emits reasoning AND strict structured output (via
   * `response_format: json_schema`, which is what `Output.object` maps to — NOT
   * tool calling, which V4 rejects in thinking mode). The earlier "reasoning
   * breaks structured output" symptom was a provider-side reasoning-parser bug
   * (cf. vLLM deepseek-parser issue): a buggy ZDR host misroutes the final JSON
   * into the reasoning channel and leaves the completion blank. `runNotesImportModel`
   * recovers that JSON from the reasoning buffer, so reasoning stays on.
   */
  reasoningEffort: ReasoningEffort
  /**
   * Claude Platform settings, used when the `notes-import-claude` PostHog flag
   * is on for the run (see `provider.ts`).
   */
  anthropic: AnthropicNotesImportConfig
}

export interface AnthropicNotesImportConfig {
  /** Default `claude-haiku-5-5`. */
  model: string
  /**
   * Default `medium` (Haiku 5.5's API default, its recommended start). Effort
   * steers adaptive thinking, and thinking is billed as output.
   */
  effort: AnthropicEffort
  /**
   * Default `us`: keeps inference in US infrastructure (the Western
   * jurisdiction bound of ADR 0008) at 1.1× the token price.
   */
  inferenceGeo: AnthropicInferenceGeo
  /**
   * Thinking counts toward this cap, so it sits above the OpenRouter one; a
   * cut-off answer fails to parse. Default 32000.
   */
  maxOutputTokens: number
}

const DEFAULTS = {
  model: 'deepseek/deepseek-v4-flash',
  // Western ZDR hosts, in routing-priority order (ADR 0008). Fireworks first —
  // the verified genuine-reasoning host; DigitalOcean is the large, reliable
  // fallback when Fireworks' shared pool is rate-limited (429). DeepInfra stays
  // excluded (mislabels reasoning). `zdr: true` gates each endpoint's retention.
  providers: ['fireworks', 'digitalocean'],
  maxChars: 100_000,
  maxOutputTokens: 16_000,
  emptyWindowSeconds: 7 * 24 * 60 * 60,
  emptyWindowLimit: 5,
  entitlementId: 'Supporter',
  activeImportCap: 2,
  activeImportCapSupporter: 5,
  resultRetentionSeconds: 3_600,
  subscribeTokenTtlSeconds: 3_600,
  // `xhigh` = the model's max ("Think Max") on OpenRouter. See the
  // NotesImportConfig.reasoningEffort doc above (and why `max` is NOT used).
  reasoningEffort: 'xhigh' as ReasoningEffort,
  anthropic: {
    model: 'claude-haiku-5-5',
    effort: 'medium' as AnthropicEffort,
    inferenceGeo: 'us' as AnthropicInferenceGeo,
    maxOutputTokens: 32_000,
  },
} as const

export interface NotesImportLimits {
  importsFree: number
  importsSupporter: number
  refinementsFree: number
  refinementsSupporter: number
  windowDays: number
}

export interface EffectiveAllowances {
  imports: number
  refinements: number
}

/** Minimal KV interface for the runtime limits document. */
export interface LimitsKv {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>
}

const LIMITS_DEFAULTS: NotesImportLimits = {
  importsFree: 3,
  importsSupporter: -1,
  refinementsFree: 5,
  refinementsSupporter: -1,
  windowDays: 30,
}

const LIMITS_KEY = 'notes-import:limits'
const LIMITS_CACHE_TTL_SECONDS = 60
const DAY_MS = 24 * 60 * 60 * 1000
/** Last timestamp whose UTC ISO representation has a client-supported 4-digit year. */
const MAX_FOUR_DIGIT_UTC_MS = 253_402_300_799_999

const REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

/**
 * Parse the reasoning-effort env override; empty / `off` / `none` disables.
 * `max` is coerced to `xhigh`: on OpenRouter's normalized API `max` is invalid
 * for `deepseek-v4-flash` (it silently degrades to default effort), and `xhigh`
 * is the model's true maximum ("Think Max").
 */
const reasoningOr = (
  raw: string | undefined,
  fallback: ReasoningEffort
): ReasoningEffort => {
  if (raw == null) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'off' || v === 'none') return null
  if (v === 'max') return 'xhigh'
  return REASONING_EFFORTS.has(v) ? (v as ReasoningEffort) : fallback
}

const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const anthropicEffortOr = (
  raw: string | undefined,
  fallback: AnthropicEffort
): AnthropicEffort => {
  const v = raw?.trim().toLowerCase()
  return v && ANTHROPIC_EFFORTS.has(v) ? (v as AnthropicEffort) : fallback
}

const inferenceGeoOr = (
  raw: string | undefined,
  fallback: AnthropicInferenceGeo
): AnthropicInferenceGeo => {
  const v = raw?.trim().toLowerCase()
  return v === 'us' || v === 'global' ? v : fallback
}

const intOr = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const validAllowance = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= -1

const windowDurationMs = (
  value: unknown,
  now = Date.now()
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  const duration = value * DAY_MS
  if (!Number.isFinite(duration) || duration <= 0) return null

  // JavaScript's ISO formatter supports extended years such as +010240, but the
  // client contract accepts only 0000-9999. Every active anchor is at or before
  // now, so bounding the newest possible anchor also bounds every reset emitted
  // from an older one. Subtraction avoids overflowing `now + duration`.
  if (
    !Number.isFinite(now) ||
    now > MAX_FOUR_DIGIT_UTC_MS ||
    duration > MAX_FOUR_DIGIT_UTC_MS - now
  ) {
    return null
  }
  return duration
}

const validWindowDays = (value: unknown, now = Date.now()): value is number =>
  windowDurationMs(value, now) != null

const envAllowanceOr = (raw: string | undefined, fallback: number): number => {
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  return validAllowance(value) ? value : fallback
}

const envWindowDaysOr = (
  raw: string | undefined,
  fallback: number,
  now: number
): number => {
  if (raw != null && raw.trim() !== '') {
    const value = Number(raw)
    if (validWindowDays(value, now)) return value
  }
  if (validWindowDays(fallback, now)) return fallback
  throw new RangeError('Invalid default Notes Import windowDays')
}

const listOr = (raw: string | undefined, fallback: readonly string[]): string[] => {
  if (!raw) return [...fallback]
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length ? items : [...fallback]
}

/**
 * Resolve allowance policy independently per field: KV, then environment, then
 * code default. KV is edge-cached for 60 seconds. Bad runtime configuration is
 * observable but never blocks Notes Import.
 */
export const resolveNotesImportLimits = async (
  env: Environment,
  kv: LimitsKv
): Promise<NotesImportLimits> => {
  const now = Date.now()
  let document: Record<string, unknown> = {}
  try {
    const raw = await kv.get(LIMITS_KEY, {
      cacheTtl: LIMITS_CACHE_TTL_SECONDS,
    })
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        document = parsed as Record<string, unknown>
      } else {
        console.warn('notes-import limits KV document must be a JSON object')
      }
    }
  } catch (error) {
    console.warn('notes-import limits KV read/parse failed', error)
  }

  const envLimits: NotesImportLimits = {
    importsFree: envAllowanceOr(
      env.NOTES_IMPORT_FREE_CREDITS,
      LIMITS_DEFAULTS.importsFree
    ),
    importsSupporter: envAllowanceOr(
      env.NOTES_IMPORT_FREE_CREDITS_SUPPORTER,
      LIMITS_DEFAULTS.importsSupporter
    ),
    refinementsFree: envAllowanceOr(
      env.NOTES_IMPORT_MAX_REFINEMENTS,
      LIMITS_DEFAULTS.refinementsFree
    ),
    refinementsSupporter: envAllowanceOr(
      env.NOTES_IMPORT_MAX_REFINEMENTS_SUPPORTER,
      LIMITS_DEFAULTS.refinementsSupporter
    ),
    windowDays: envWindowDaysOr(
      env.NOTES_IMPORT_WINDOW_DAYS,
      LIMITS_DEFAULTS.windowDays,
      now
    ),
  }

  const allowanceField = (
    key: keyof Omit<NotesImportLimits, 'windowDays'>
  ): number => {
    if (!(key in document)) return envLimits[key]
    const value = document[key]
    if (validAllowance(value)) return value
    console.warn(`notes-import limits KV field ${key} is invalid`)
    return envLimits[key]
  }

  let windowDays = envLimits.windowDays
  if ('windowDays' in document) {
    if (validWindowDays(document.windowDays, now)) windowDays = document.windowDays
    else console.warn('notes-import limits KV field windowDays is invalid')
  }

  return {
    importsFree: allowanceField('importsFree'),
    importsSupporter: allowanceField('importsSupporter'),
    refinementsFree: allowanceField('refinementsFree'),
    refinementsSupporter: allowanceField('refinementsSupporter'),
    windowDays,
  }
}

const MIN_APP_VERSION_KEY = 'notes-import:min-version'
const MIN_APP_VERSION_CACHE_TTL_SECONDS = 60
/** Strict `major.minor.patch` — matches the app's `app.config.ts` version. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

/** A trimmed `major.minor.patch` string. Shared by the KV and env schemas. */
const appVersionSchema = z.string().trim().regex(SEMVER_PATTERN)

/**
 * KV `notes-import:min-version` document: `{ "minVersion": "1.42.0" }` or a bare
 * `"1.42.0"` string. Normalised to the version string.
 */
const kvMinAppVersionSchema = z
  .union([z.object({ minVersion: appVersionSchema }), appVersionSchema])
  .transform((value) => (typeof value === 'string' ? value : value.minVersion))

/** JSON when it parses, otherwise the raw text (an unquoted `1.42.0`). */
const parseJsonOrRaw = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Parse a raw KV `notes-import:min-version` value into a `major.minor.patch`
 * string, or null when it isn't one. Pure — never throws, never logs.
 */
export const parseMinAppVersion = (raw: string): string | null => {
  const result = kvMinAppVersionSchema.safeParse(parseJsonOrRaw(raw))
  return result.success ? result.data : null
}

const isBlank = (value: string | null | undefined): boolean =>
  value == null || value.trim() === ''

const readMinAppVersionFromKv = async (
  kv: LimitsKv
): Promise<string | null> => {
  let raw: string | null
  try {
    raw = await kv.get(MIN_APP_VERSION_KEY, {
      cacheTtl: MIN_APP_VERSION_CACHE_TTL_SECONDS,
    })
  } catch (error) {
    console.warn('notes-import min-version KV read failed', error)
    return null
  }
  if (raw == null || isBlank(raw)) return null

  const version = parseMinAppVersion(raw)
  if (version == null) {
    console.warn('notes-import min-version KV value is invalid')
  }
  return version
}

const readMinAppVersionFromEnv = (env: Environment): string | null => {
  const raw = env.NOTES_IMPORT_MIN_APP_VERSION
  if (raw == null || isBlank(raw)) return null

  const result = appVersionSchema.safeParse(raw)
  if (result.success) return result.data
  console.warn('NOTES_IMPORT_MIN_APP_VERSION is invalid')
  return null
}

/**
 * Resolve the minimum app version allowed to use Notes Import, or null when
 * unset. Resolution: KV `notes-import:min-version` → `NOTES_IMPORT_MIN_APP_VERSION`
 * env var → null. KV accepts `{"minVersion":"1.42.0"}`, a bare JSON string, or
 * an unquoted `1.42.0`. Invalid values are warned about and ignored — never
 * throws, never blocks.
 *
 * Bump this when a deploy changes the request/response contract in a way older
 * app builds can't handle. The app compares it against its own
 * `Constants.expoConfig.version` and disables the composer when below.
 */
export const resolveNotesImportMinAppVersion = async (
  env: Environment,
  kv: LimitsKv
): Promise<string | null> =>
  (await readMinAppVersionFromKv(kv)) ?? readMinAppVersionFromEnv(env)

/** Select tier policy; dev bypass changes allowances only, never entitlement. */
export const selectEffectiveAllowances = (
  limits: NotesImportLimits,
  isSupporter: boolean,
  devBypass: boolean
): EffectiveAllowances => {
  if (devBypass) return { imports: -1, refinements: -1 }
  return isSupporter
    ? {
        imports: limits.importsSupporter,
        refinements: limits.refinementsSupporter,
      }
    : { imports: limits.importsFree, refinements: limits.refinementsFree }
}

export const limitsWindowDurationMs = (limits: NotesImportLimits): number => {
  const duration = windowDurationMs(limits.windowDays)
  if (duration == null) throw new RangeError('Invalid Notes Import windowDays')
  return duration
}

const appAttestConfig = (
  env: Environment
): Pick<NotesImportConfig, 'devBypassToken' | 'requireProduction'> => {
  const token = env.NOTES_IMPORT_DEV_BYPASS_TOKEN?.trim() || null
  if (env.APP_ATTEST_ENVIRONMENT === 'production') {
    if (token) {
      throw new Error(
        'NOTES_IMPORT_DEV_BYPASS_TOKEN cannot be set in production'
      )
    }
    return { devBypassToken: null, requireProduction: true }
  }
  if (env.APP_ATTEST_ENVIRONMENT === 'development') {
    return { devBypassToken: token, requireProduction: false }
  }
  throw new Error('APP_ATTEST_ENVIRONMENT must be explicitly configured')
}

export const getNotesImportConfig = (env: Environment): NotesImportConfig => ({
  model: env.NOTES_IMPORT_MODEL?.trim() || DEFAULTS.model,
  providers: listOr(env.NOTES_IMPORT_PROVIDERS, DEFAULTS.providers),
  maxChars: intOr(env.NOTES_IMPORT_MAX_CHARS, DEFAULTS.maxChars),
  maxOutputTokens: intOr(
    env.NOTES_IMPORT_MAX_OUTPUT_TOKENS,
    DEFAULTS.maxOutputTokens
  ),
  emptyWindowSeconds: intOr(
    env.NOTES_IMPORT_EMPTY_WINDOW_SECONDS,
    DEFAULTS.emptyWindowSeconds
  ),
  emptyWindowLimit: intOr(
    env.NOTES_IMPORT_EMPTY_WINDOW_LIMIT,
    DEFAULTS.emptyWindowLimit
  ),
  entitlementId:
    env.REVENUECAT_ENTITLEMENT_ID?.trim() || DEFAULTS.entitlementId,
  ...appAttestConfig(env),
  activeImportCap: intOr(env.NOTES_IMPORT_ACTIVE_CAP, DEFAULTS.activeImportCap),
  activeImportCapSupporter: intOr(
    env.NOTES_IMPORT_ACTIVE_CAP_SUPPORTER,
    DEFAULTS.activeImportCapSupporter
  ),
  resultRetentionSeconds: intOr(
    env.NOTES_IMPORT_RESULT_RETENTION_SECONDS,
    DEFAULTS.resultRetentionSeconds
  ),
  subscribeTokenTtlSeconds: intOr(
    env.NOTES_IMPORT_SUBSCRIBE_TOKEN_TTL_SECONDS,
    DEFAULTS.subscribeTokenTtlSeconds
  ),
  reasoningEffort: reasoningOr(
    env.NOTES_IMPORT_REASONING_EFFORT,
    DEFAULTS.reasoningEffort
  ),
  anthropic: {
    model:
      env.NOTES_IMPORT_ANTHROPIC_MODEL?.trim() || DEFAULTS.anthropic.model,
    effort: anthropicEffortOr(
      env.NOTES_IMPORT_ANTHROPIC_EFFORT,
      DEFAULTS.anthropic.effort
    ),
    inferenceGeo: inferenceGeoOr(
      env.NOTES_IMPORT_ANTHROPIC_INFERENCE_GEO,
      DEFAULTS.anthropic.inferenceGeo
    ),
    maxOutputTokens: intOr(
      env.NOTES_IMPORT_ANTHROPIC_MAX_OUTPUT_TOKENS,
      DEFAULTS.anthropic.maxOutputTokens
    ),
  },
})
