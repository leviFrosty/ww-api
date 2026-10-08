import { describe, expect, it, vi } from 'vitest'
import type { JSONSchema7 } from 'ai'
import { createAnthropicAdapter } from './anthropic'
import { streamStructuredObject } from './structured'

const sse = (events: Array<Record<string, unknown>>): Response =>
  new Response(
    events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

/** A Claude stream: one summarized thinking block, then the JSON answer. */
const claudeStream = (answer: string) =>
  sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4_000,
          output_tokens: 1,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Reading the notes.' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: answer },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 40 },
    },
    { type: 'message_stop' },
  ])

const SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['hours'],
  properties: { hours: { type: 'integer', minimum: 0 } },
}

const setup = (answer = '{"hours":2}') => {
  const fetchFn = vi.fn(async () => claudeStream(answer))
  const adapter = createAnthropicAdapter({
    apiKey: 'sk-test',
    model: 'claude-haiku-5-5',
    effort: 'medium',
    inferenceGeo: 'us',
    maxOutputTokens: 32_000,
    fetch: fetchFn as unknown as typeof fetch,
  })
  return { fetchFn, adapter }
}

const requestBody = (fetchFn: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  return { url, body: JSON.parse(init.body as string) }
}

describe('Claude Platform adapter', () => {
  it('sends native structured output, effort, geo, and cache markers', async () => {
    const { fetchFn, adapter } = setup()
    await streamStructuredObject<{ hours: number }>(adapter, {
      system: [
        { text: 'INSTRUCTIONS', cache: 'stable' },
        { text: 'CONTEXT', cache: 'session' },
      ],
      user: [{ text: 'NOTES', cache: 'session' }, { text: 'CORRECTION' }],
      schema: SCHEMA,
      schemaName: 'Test',
      schemaDescription: 'Test object',
    })

    const { url, body } = requestBody(fetchFn)
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body.max_tokens).toBe(32_000)
    expect(body.stream).toBe(true)
    expect(body.inference_geo).toBe('us')
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.temperature).toBeUndefined()
    expect(body.output_config.effort).toBe('medium')
    expect(body.output_config.format.type).toBe('json_schema')
    // The API rejects numeric constraints; the SDK moves them out of the schema.
    expect(body.output_config.format.schema.properties.hours.minimum).toBeUndefined()

    // 1h on the prefix every user shares, 5m on per-user blocks, none after.
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'INSTRUCTIONS',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'CONTEXT',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ])
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'NOTES',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
          { type: 'text', text: 'CORRECTION' },
        ],
      },
    ])
  })

  it('returns the parsed object, normalized usage, and stream events', async () => {
    const { adapter } = setup()
    const events: string[] = []
    const out = await streamStructuredObject<{ hours: number }>(adapter, {
      system: [{ text: 'INSTRUCTIONS', cache: 'stable' }],
      user: [{ text: 'NOTES' }],
      schema: SCHEMA,
      schemaName: 'Test',
      schemaDescription: 'Test object',
      onEvent: (event) => events.push(event.kind),
    })

    expect(out.output).toEqual({ hours: 2 })
    expect(out.provider).toBe('anthropic')
    expect(out.model).toBe('claude-haiku-5-5')
    expect(out.recovered).toBe(false)
    expect(out.usage).toMatchObject({
      inputTokens: 4_012,
      outputTokens: 40,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 0,
    })
    expect(events).toEqual(['reasoning-start', 'reasoning', 'text'])
  })

  it('never salvages output from thinking', async () => {
    const { adapter } = setup('not json')
    const recover = vi.fn(() => ({ hours: 9 }))
    await expect(
      streamStructuredObject<{ hours: number }>(
        adapter,
        {
          system: [{ text: 'INSTRUCTIONS' }],
          user: [{ text: 'NOTES' }],
          schema: SCHEMA,
          schemaName: 'Test',
          schemaDescription: 'Test object',
        },
        { recover }
      )
    ).rejects.toThrow()
    expect(recover).not.toHaveBeenCalled()
  })
})
