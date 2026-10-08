import type { JSONSchema7 } from 'ai'
import {
  streamStructuredObject,
  type LlmAdapter,
  type LlmProviderId,
  type LlmUsage,
  type PromptBlock,
} from '../llm'
import { NOTES_IMPORT_INSTRUCTIONS, buildNotesImportContext } from './prompt'
import {
  NOTES_IMPORT_SCHEMA,
  type NotesImportContext,
  type NotesImportResult,
} from './schema'

export interface RefinementInput {
  /** The model's previous full result, as the JSON string the client cached. */
  previousResultJSON: string
  /** The user's natural-language correction (e.g. "Maria's visit was Tuesday"). */
  instruction: string
}

/**
 * A best-effort signal emitted WHILE the model streams, purely so the client can
 * show that work is happening. Never affects the returned result — the
 * structured object always comes from the provider's parsed output, never
 * assembled from these deltas (see docs/notes-import-streaming-durable-objects.md).
 */
export type ModelProgress =
  | { kind: 'phase'; phase: 'starting' | 'thinking' | 'structuring' }
  | { kind: 'reasoning'; text: string }
  | { kind: 'progress'; chars: number }

export interface RunModelArgs {
  /** Which provider/model to call; see `resolveNotesImportAdapter`. */
  adapter: LlmAdapter
  /** The notes being parsed (original notes for a refinement). */
  notesText: string
  context: NotesImportContext
  refinement?: RefinementInput
  abortSignal?: AbortSignal
  /** Optional live progress sink. Absent on the legacy synchronous path. */
  onProgress?: (p: ModelProgress) => void
}

export interface RunModelOutput {
  result: NotesImportResult
  usage: LlmUsage
  provider: LlmProviderId
  model: string
  /** The upstream host that served the call (OpenRouter's routed ZDR host). */
  resolvedProvider?: string
}

/**
 * The user turn. The notes come first and identically in an import and in
 * every refinement of it, so a refinement reuses the cached prefix through the
 * notes; only the correction is new input.
 */
const buildUserBlocks = (
  notesText: string,
  refinement: RefinementInput | undefined
): PromptBlock[] => {
  const notes: PromptBlock = {
    text: `<ORIGINAL NOTES>\n${notesText}\n</ORIGINAL NOTES>`,
    cache: 'session',
  }
  if (!refinement) return [notes]
  return [
    notes,
    {
      text: `You previously produced this structured result for the notes above:

<PREVIOUS RESULT>
${refinement.previousResultJSON}
</PREVIOUS RESULT>

The user has a correction. Apply it and return a FRESH, COMPLETE structured
result for the ORIGINAL notes above — not a diff, the whole object — with the
correction incorporated. Keep everything else the same unless the correction
implies otherwise.

<USER CORRECTION>
${refinement.instruction}
</USER CORRECTION>`,
    },
  ]
}

/** Emit a `progress` tick at most every N streamed output chars. */
const PROGRESS_CHAR_STRIDE = 400

/**
 * Runs the notes-import model, streaming, through whichever adapter the run
 * resolved (Claude Platform or OpenRouter). The model is forced to the
 * NOTES_IMPORT_SCHEMA shape; the parsed object is the result.
 *
 * Prompt layout, most stable first so prompt caching can reuse prefixes:
 * the fixed instructions (shared by every user), then this user's context,
 * then the notes, then (refinements only) the previous result + correction.
 *
 * On OpenRouter, some ZDR hosts misroute the final JSON into the reasoning
 * channel and return a blank completion; the object is then recovered from
 * the reasoning text (`recoverNotesImportJson`).
 */
export const runNotesImportModel = async ({
  adapter,
  notesText,
  context,
  refinement,
  abortSignal,
  onProgress,
}: RunModelArgs): Promise<RunModelOutput> => {
  onProgress?.({ kind: 'phase', phase: 'starting' })

  let sawText = false
  let lastTickAt = 0
  const out = await streamStructuredObject<NotesImportResult>(
    adapter,
    {
      system: [
        { text: NOTES_IMPORT_INSTRUCTIONS, cache: 'stable' },
        { text: buildNotesImportContext(context), cache: 'session' },
      ],
      user: buildUserBlocks(notesText, refinement),
      schema: NOTES_IMPORT_SCHEMA as unknown as JSONSchema7,
      schemaName: 'NotesImport',
      schemaDescription:
        'Structured WitnessWork records parsed from free-form ministry notes.',
      abortSignal,
      onEvent: (event) => {
        if (event.kind === 'reasoning-start') {
          onProgress?.({ kind: 'phase', phase: 'thinking' })
        } else if (event.kind === 'reasoning') {
          onProgress?.({ kind: 'reasoning', text: event.text })
        } else {
          if (!sawText) {
            sawText = true
            onProgress?.({ kind: 'phase', phase: 'structuring' })
          }
          if (event.chars - lastTickAt >= PROGRESS_CHAR_STRIDE) {
            lastTickAt = event.chars
            onProgress?.({ kind: 'progress', chars: event.chars })
          }
        }
      },
    },
    { recover: recoverNotesImportJson }
  )

  const { usage } = out
  console.log(
    `notes-import model provider=${out.provider} model=${out.model} ` +
      `host=${out.host ?? 'unknown'} ` +
      `inputTokens=${usage.inputTokens} cacheReadTokens=${usage.cacheReadTokens} ` +
      `cacheWriteTokens=${usage.cacheWriteTokens} ` +
      `outputTokens=${usage.outputTokens} reasoningTokens=${usage.reasoningTokens}` +
      (out.recovered ? ' recovered=reasoning-channel' : '')
  )

  return {
    result: out.output,
    usage,
    provider: out.provider,
    model: out.model,
    resolvedProvider: out.host,
  }
}

/**
 * Salvage the structured result when a provider's reasoning parser misroutes the
 * final JSON into the reasoning channel (leaving the completion blank, so
 * `result.output` rejects). The reasoning buffer in that case holds the
 * complete, schema-shaped JSON. Strip any `<think>` wrapper, slice to the
 * outermost object, parse, and structurally sanity-check it. Returns null when
 * the buffer is not a usable result, so the caller surfaces the real error.
 */
const recoverNotesImportJson = (reasoning: string): NotesImportResult | null => {
  if (!reasoning) return null
  const unwrapped = reasoning.replace(/<\/?think>/gi, '')
  const start = unwrapped.indexOf('{')
  const end = unwrapped.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapped.slice(start, end + 1))
  } catch {
    return null
  }
  if (!isNotesImportResultShape(parsed)) return null
  // `summary` and `assistantMessage` are schema-required, but this salvage path
  // bypasses `Output.object`'s strict validation; default them so the recovered
  // object stays type-sound.
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    ...parsed,
    summary: str((parsed as { summary?: unknown }).summary),
    assistantMessage: str((parsed as { assistantMessage?: unknown }).assistantMessage),
  }
}

/**
 * Light structural guard for a recovered result. The provider already enforced
 * the full schema via `response_format` strict mode; this only confirms we
 * salvaged a plausibly-complete object (all required top-level collections
 * present) before bypassing `Output.object`'s own validation.
 */
const isNotesImportResultShape = (v: unknown): v is NotesImportResult => {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    Array.isArray(o.contacts) &&
    Array.isArray(o.visits) &&
    Array.isArray(o.timeEntries) &&
    Array.isArray(o.categories) &&
    Array.isArray(o.warnings) &&
    'publisher' in o
  )
}
