import {
  Output,
  jsonSchema,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
} from 'ai'
import type {
  LlmAdapter,
  LlmUsage,
  PromptBlock,
  StructuredRequest,
  StructuredResult,
} from './types'

export interface StructuredOptions<T> {
  /**
   * Salvage the object from the reasoning text when the provider's output
   * fails to parse. Only consulted for adapters with `reasoningMayCarryOutput`.
   */
  recover?: (reasoningText: string) => T | null
}

const joinBlocks = (blocks: PromptBlock[]): string =>
  blocks.map((block) => block.text).join('\n\n')

/**
 * Providers with explicit cache markers get one message part per block, each
 * marked as asked. Everyone else gets the blocks joined, so their request
 * looks the same as a single-string prompt.
 */
const buildPrompt = (
  adapter: LlmAdapter,
  request: StructuredRequest
): { system: string | SystemModelMessage[]; messages: ModelMessage[] } => {
  const usesMarkers = [...request.system, ...request.user].some(
    (block) => block.cache && adapter.cacheMarker(block.cache)
  )
  if (!usesMarkers) {
    return {
      system: joinBlocks(request.system),
      messages: [{ role: 'user', content: joinBlocks(request.user) }],
    }
  }
  const marker = (block: PromptBlock) =>
    block.cache ? adapter.cacheMarker(block.cache) : undefined
  return {
    system: request.system.map((block) => ({
      role: 'system' as const,
      content: block.text,
      providerOptions: marker(block),
    })),
    messages: [
      {
        role: 'user',
        content: request.user.map((block) => ({
          type: 'text' as const,
          text: block.text,
          providerOptions: marker(block),
        })),
      },
    ],
  }
}

export const normalizeUsage = (usage: LanguageModelUsage): LlmUsage => ({
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
})

/**
 * Streams one schema-constrained object through any adapter. The full stream
 * is drained ONLY for `onEvent`; the result always comes from the provider's
 * parsed output (`result.output`), never from the deltas.
 */
export const streamStructuredObject = async <T>(
  adapter: LlmAdapter,
  request: StructuredRequest,
  { recover }: StructuredOptions<T> = {}
): Promise<StructuredResult<T>> => {
  const { system, messages } = buildPrompt(adapter, request)
  const result = streamText({
    model: adapter.languageModel(),
    output: Output.object({
      schema: jsonSchema<T>(request.schema),
      name: request.schemaName,
      description: request.schemaDescription,
    }),
    system,
    messages,
    ...(adapter.temperature != null ? { temperature: adapter.temperature } : {}),
    maxOutputTokens: adapter.maxOutputTokens,
    maxRetries: 2,
    abortSignal: request.abortSignal,
    providerOptions: adapter.providerOptions(),
  })

  const { onEvent } = request
  let chars = 0
  let sawReasoning = false
  let reasoningText = ''
  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-start') {
      if (!sawReasoning) {
        sawReasoning = true
        onEvent?.({ kind: 'reasoning-start' })
      }
    } else if (part.type === 'reasoning-delta') {
      if (part.text) {
        reasoningText += part.text
        onEvent?.({ kind: 'reasoning', text: part.text })
      }
    } else if (part.type === 'text-delta') {
      chars += part.text.length
      onEvent?.({ kind: 'text', chars })
    }
  }

  // Usage and metadata resolve independently of output parsing, so a failed
  // parse can still be logged with its token spend and stop reason.
  const usage = normalizeUsage(await result.usage)
  const host = adapter.resolvedHost(
    (await result.providerMetadata) as Record<string, unknown> | undefined
  )
  const finishReason = await result.finishReason

  let output: T
  let recovered = false
  try {
    output = (await result.output) as T
  } catch (error) {
    const salvaged =
      adapter.reasoningMayCarryOutput && recover ? recover(reasoningText) : null
    if (!salvaged) {
      console.warn(
        `llm structured output failed provider=${adapter.provider} ` +
          `model=${adapter.model} finishReason=${finishReason} ` +
          `outputTokens=${usage.outputTokens}`
      )
      throw error
    }
    output = salvaged
    recovered = true
  }

  return {
    output,
    usage,
    provider: adapter.provider,
    model: adapter.model,
    host,
    finishReason,
    recovered,
  }
}
