import { createAnthropic } from '@ai-sdk/anthropic'
import type { CacheHint, LlmAdapter } from './types'

/** Claude Platform effort levels (`output_config.effort`). */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** `inference_geo`: `us` pins inference to US infrastructure (1.1× price). */
export type AnthropicInferenceGeo = 'us' | 'global'

export interface AnthropicAdapterOptions {
  apiKey: string
  /** e.g. `claude-haiku-5-5`. */
  model: string
  effort: AnthropicEffort
  inferenceGeo: AnthropicInferenceGeo
  /** Hard cap on thinking + answer tokens. */
  maxOutputTokens: number
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/**
 * Cache TTLs by hint. `stable` prefixes are shared by every caller, so the 1h
 * TTL keeps them warm through quiet periods (writes cost 2× instead of 1.25×,
 * reads 0.1× either way). `session` prefixes only repeat within minutes (a
 * refinement), so they take the default 5m. 1h breakpoints must precede 5m
 * ones, which "most stable first" block order guarantees.
 */
const CACHE_TTL: Record<CacheHint, '1h' | '5m'> = {
  stable: '1h',
  session: '5m',
}

/**
 * Claude Platform (api.anthropic.com) through `@ai-sdk/anthropic`.
 *
 * Structured output uses native `output_config.format` (constrained decoding),
 * so the answer always matches the schema; the SDK moves keywords the API
 * rejects (`minimum`, `maximum`, ...) into descriptions. Thinking is adaptive
 * and steered by `effort`; `display: 'summarized'` streams a thinking summary
 * for the progress UI at no extra cost.
 */
export const createAnthropicAdapter = (
  options: AnthropicAdapterOptions
): LlmAdapter => {
  const anthropic = createAnthropic({
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return {
    provider: 'anthropic',
    model: options.model,
    languageModel: () => anthropic(options.model),
    providerOptions: () => ({
      anthropic: {
        structuredOutputMode: 'outputFormat',
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: options.effort,
        inferenceGeo: options.inferenceGeo,
      },
    }),
    cacheMarker: (hint) => ({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: CACHE_TTL[hint] } },
    }),
    maxOutputTokens: options.maxOutputTokens,
    // Current Claude models reject sampling parameters.
    temperature: undefined,
    resolvedHost: () => 'anthropic',
    reasoningMayCarryOutput: false,
  }
}
