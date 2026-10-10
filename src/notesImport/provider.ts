import { isFeatureEnabled } from '../featureFlags/posthog'
import {
  createAnthropicAdapter,
  createOpenRouterAdapter,
  type LlmAdapter,
} from '../llm'
import type { Environment } from '../types'
import type { NotesImportConfig } from './config'

/**
 * PostHog flag that moves Notes Import from OpenRouter to Claude Platform.
 * On (and `ANTHROPIC_API_KEY` set) → Claude; off, unset, or undecidable →
 * OpenRouter.
 */
export const NOTES_IMPORT_CLAUDE_FLAG = 'notes-import-claude'

/** Distinct id for the per-environment status probe (no user involved). */
const STATUS_DISTINCT_ID = 'ww-api:notes-import-status'

/**
 * PostHog never sees the meter id itself: rollouts get a stable, opaque hash
 * of it, so a user keeps one provider across their imports and refinements.
 */
const flagDistinctId = async (meterId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`notes-import:${meterId}`)
  )
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

type FlagEnv = Pick<
  Environment,
  | 'ANTHROPIC_API_KEY'
  | 'POSTHOG_PROJECT_TOKEN'
  | 'POSTHOG_HOST'
  | 'APP_ATTEST_ENVIRONMENT'
>

const claudeFlagOn = async (
  env: FlagEnv,
  distinctId: string,
  fetchFn?: typeof fetch
): Promise<boolean> => {
  if (!env.ANTHROPIC_API_KEY?.trim()) return false
  const enabled = await isFeatureEnabled({
    env,
    flag: NOTES_IMPORT_CLAUDE_FLAG,
    distinctId,
    // Lets the flag target one worker (`development` / `production`).
    personProperties: { ww_api_environment: env.APP_ATTEST_ENVIRONMENT },
    fetchFn,
  })
  return enabled === true
}

/**
 * Whether the status probe should treat Claude as the active provider, which
 * skips the OpenRouter host-health check. Evaluated for the environment, not a
 * user, so it is exact for 0% / 100% rollouts and approximate in between
 * (status is advisory and fails open either way).
 */
export const notesImportStatusUsesClaude = (
  env: FlagEnv,
  fetchFn?: typeof fetch
): Promise<boolean> => claudeFlagOn(env, STATUS_DISTINCT_ID, fetchFn)

/** Picks the model adapter for one import run of `meterId`. */
export const resolveNotesImportAdapter = async (
  env: Environment,
  config: NotesImportConfig,
  meterId: string,
  fetchFn?: typeof fetch
): Promise<LlmAdapter> => {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim()
  if (anthropicKey && (await claudeFlagOn(env, await flagDistinctId(meterId), fetchFn))) {
    return createAnthropicAdapter({ apiKey: anthropicKey, ...config.anthropic })
  }
  return createOpenRouterAdapter({
    apiKey: env.OPENROUTER_API_KEY,
    model: config.model,
    providers: config.providers,
    // `reasoningOr` already coerces `max` (invalid on OpenRouter) to `xhigh`.
    reasoningEffort:
      config.reasoningEffort === 'max' ? 'xhigh' : config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
  })
}
