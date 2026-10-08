import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LlmAdapter } from './types'

/** OpenRouter's normalized reasoning effort levels. */
export type OpenRouterReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export interface OpenRouterAdapterOptions {
  apiKey: string
  /** `<author>/<slug>`, e.g. `deepseek/deepseek-v4-flash`. */
  model: string
  /** Provider allowlist in routing-priority order (drives `only` and `order`). */
  providers: string[]
  /** Null leaves reasoning off. */
  reasoningEffort: OpenRouterReasoningEffort | null
  maxOutputTokens: number
}

/**
 * OpenRouter, pinned to zero-data-retention hosts.
 *
 * HARD ZDR INVARIANT (witness-work ADR 0008): `zdr: true` + `data_collection:
 * 'deny'` are global filters OpenRouter applies to every candidate (including
 * fallbacks), so routing can never reach a data-retaining host. `only` pins to
 * the vetted Western allowlist (jurisdiction bound); `order` makes the SAME
 * list a priority sequence, so a 429/error on the preferred host falls back to
 * the next WITHOUT escaping the allowlist. If none can serve, the request
 * errors.
 *
 * Some ZDR hosts ship a reasoning parser that misroutes the final JSON into the
 * reasoning channel and return a blank completion, so callers may salvage the
 * object from the reasoning text (`reasoningMayCarryOutput`).
 */
export const createOpenRouterAdapter = (
  options: OpenRouterAdapterOptions
): LlmAdapter => {
  const openrouter = createOpenRouter({ apiKey: options.apiKey })
  return {
    provider: 'openrouter',
    model: options.model,
    languageModel: () => openrouter(options.model),
    providerOptions: () => ({
      openrouter: {
        provider: {
          only: options.providers,
          order: options.providers,
          data_collection: 'deny',
          zdr: true,
          allow_fallbacks: true,
        },
        ...(options.reasoningEffort
          ? { reasoning: { enabled: true, effort: options.reasoningEffort } }
          : {}),
      },
    }),
    // OpenRouter hosts cache prefixes implicitly; there is nothing to mark.
    cacheMarker: () => undefined,
    maxOutputTokens: options.maxOutputTokens,
    temperature: 0,
    resolvedHost: (metadata) =>
      (metadata?.openrouter as { provider?: string } | undefined)?.provider,
    reasoningMayCarryOutput: true,
  }
}
