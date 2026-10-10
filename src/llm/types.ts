import type { JSONSchema7, LanguageModel, SystemModelMessage } from 'ai'

/**
 * Feature-neutral LLM layer. A feature describes WHAT it wants (prompt blocks,
 * a JSON schema, cache hints); an `LlmAdapter` decides HOW one provider is
 * called (model, routing, reasoning, cache markers). `streamStructuredObject`
 * (`./structured.ts`) runs any adapter the same way, so features never import a
 * provider SDK directly.
 */

export type LlmProviderId = 'anthropic' | 'openrouter'

/**
 * How long a prompt block is worth caching, for providers that take explicit
 * cache markers (Anthropic). Ignored by providers that cache automatically.
 *
 * - `stable`: identical for every caller (instructions). Long TTL, so sporadic
 *   traffic still hits it.
 * - `session`: identical only for one caller's follow-ups (their context, their
 *   notes on a refinement). Short TTL.
 */
export type CacheHint = 'stable' | 'session'

export interface PromptBlock {
  text: string
  /** Cache everything up to and including this block. */
  cache?: CacheHint
}

export interface StructuredRequest {
  /** System blocks, most stable first (cache prefixes are positional). */
  system: PromptBlock[]
  /** User-turn blocks, most stable first. */
  user: PromptBlock[]
  schema: JSONSchema7
  schemaName: string
  schemaDescription: string
  abortSignal?: AbortSignal
  /** Best-effort stream signals for progress UI. Never part of the result. */
  onEvent?: (event: LlmStreamEvent) => void
}

export type LlmStreamEvent =
  | { kind: 'reasoning-start' }
  | { kind: 'reasoning'; text: string }
  /** Structured output began streaming; `chars` is the running total. */
  | { kind: 'text'; chars: number }

/** Token usage normalized across providers. Unknown counts are 0. */
export interface LlmUsage {
  /** Every prompt token, cached or not. */
  inputTokens: number
  outputTokens: number
  /** Thinking tokens, already included in `outputTokens`. */
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface StructuredResult<T> {
  output: T
  usage: LlmUsage
  provider: LlmProviderId
  model: string
  /** The upstream host that served the call, when the provider reports one. */
  host?: string
  finishReason?: string
  /** True when the output came from `recover`, not the provider's output. */
  recovered: boolean
}

/** The AI SDK's provider-options shape (JSON values keyed by provider). */
export type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>

/** One provider + model, configured for a call site. */
export interface LlmAdapter {
  readonly provider: LlmProviderId
  readonly model: string
  languageModel(): LanguageModel
  /** Request-level provider options (routing, reasoning, structured output). */
  providerOptions(): ProviderOptions
  /** Per-block cache marker, or undefined when the provider caches implicitly. */
  cacheMarker(hint: CacheHint): ProviderOptions | undefined
  maxOutputTokens: number
  /** Undefined when the model rejects sampling parameters. */
  temperature?: number
  /** Upstream host from the response's provider metadata. */
  resolvedHost(metadata: Record<string, unknown> | undefined): string | undefined
  /**
   * True when the provider can misroute the final answer into the reasoning
   * channel, so callers may salvage it from there (OpenRouter ZDR hosts).
   */
  reasoningMayCarryOutput: boolean
}
