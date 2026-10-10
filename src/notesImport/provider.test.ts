import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFeatureFlagCache } from '../featureFlags/posthog'
import type { Environment } from '../types'
import { getNotesImportConfig } from './config'
import {
  NOTES_IMPORT_CLAUDE_FLAG,
  notesImportStatusUsesClaude,
  resolveNotesImportAdapter,
} from './provider'

const baseEnv = {
  APP_ATTEST_ENVIRONMENT: 'production',
  OPENROUTER_API_KEY: 'openrouter-key',
  ANTHROPIC_API_KEY: 'anthropic-key',
  POSTHOG_PROJECT_TOKEN: 'phc_test',
} as unknown as Environment

const flag = (enabled: boolean | null) =>
  vi.fn(async () =>
    enabled == null
      ? new Response('down', { status: 503 })
      : Response.json({ flags: { [NOTES_IMPORT_CLAUDE_FLAG]: { enabled } } })
  )

const resolve = (env: Environment, fetchFn: ReturnType<typeof flag>) =>
  resolveNotesImportAdapter(
    env,
    getNotesImportConfig(env),
    'meter-123',
    fetchFn as unknown as typeof fetch
  )

beforeEach(() => {
  clearFeatureFlagCache()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('resolveNotesImportAdapter', () => {
  it('uses Claude Haiku 5.5 when the flag is on', async () => {
    const adapter = await resolve(baseEnv, flag(true))
    expect(adapter.provider).toBe('anthropic')
    expect(adapter.model).toBe('claude-haiku-5-5')
  })

  it('uses OpenRouter when the flag is off or undecidable', async () => {
    expect((await resolve(baseEnv, flag(false))).provider).toBe('openrouter')
    expect((await resolve(baseEnv, flag(null))).provider).toBe('openrouter')
  })

  it('uses OpenRouter without asking PostHog when no Claude key is set', async () => {
    const fetchFn = flag(true)
    const env = { ...baseEnv, ANTHROPIC_API_KEY: ' ' } as Environment
    expect((await resolve(env, fetchFn)).provider).toBe('openrouter')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sends PostHog an opaque, stable id and the environment', async () => {
    const fetchFn = flag(true)
    await resolve(baseEnv, fetchFn)
    clearFeatureFlagCache()
    await resolve(baseEnv, fetchFn)

    const bodies = fetchFn.mock.calls.map((call) => {
      const [, init] = call as unknown as [string, RequestInit]
      return JSON.parse(init.body as string)
    })
    expect(bodies[0].distinct_id).toMatch(/^[0-9a-f]{32}$/)
    expect(bodies[0].distinct_id).not.toContain('meter-123')
    expect(bodies[1].distinct_id).toBe(bodies[0].distinct_id)
    expect(bodies[0].person_properties).toEqual({
      ww_api_environment: 'production',
    })
  })

  it('applies the Claude env overrides', async () => {
    const env = {
      ...baseEnv,
      NOTES_IMPORT_ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    } as Environment
    expect((await resolve(env, flag(true))).model).toBe('claude-sonnet-5-5')
  })
})

describe('notesImportStatusUsesClaude', () => {
  it('follows the flag for the environment', async () => {
    await expect(
      notesImportStatusUsesClaude(baseEnv, flag(true) as unknown as typeof fetch)
    ).resolves.toBe(true)
    clearFeatureFlagCache()
    await expect(
      notesImportStatusUsesClaude(baseEnv, flag(null) as unknown as typeof fetch)
    ).resolves.toBe(false)
  })
})
