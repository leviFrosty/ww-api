import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Breadcrumb,
  CloudflareOptions,
  ErrorEvent,
} from '@sentry/cloudflare'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  DatabaseError,
  Sentry,
  captureFailure,
  createSentryConfig,
  isDatabaseError,
  redactContactLinkPayloads,
  redactDatabaseErrors,
  reportableError,
} from './sentry'
import { recordSentryEvents, type SentryRecorder } from './test/sentry'
import type { Environment } from './types'

type TransactionEvent = Parameters<
  NonNullable<CloudflareOptions['beforeSendTransaction']>
>[0]

// gzip + base64url contact JSON, exactly as the app encodes it.
const PAYLOAD =
  'H4sIAAAAAAAAE42MMQvCMBQG_0r4VpPyUohgNsHJ2ckttA8MYl5IglVK_7tEcBduvLsVTy41SoKHHQga7Z0ZHktsiWtdpNzNJKmFqUGDX1lK4_nY4DHSuDd0MGQvRP7LQERXaPwKvyLO8JgsNFJ49PM5JFYn4a4VDn_c8k1SL3dWOecUWSJs2wdjV8GKuwAAAA'
const LINK = `https://ww-proxy.leviwilkerson.com/c/${PAYLOAD}`
const REDACTED_LINK = 'https://ww-proxy.leviwilkerson.com/c/[redacted]'

const config = createSentryConfig({
  SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
} as Environment)

describe('createSentryConfig', () => {
  it('does not send default PII', () => {
    expect(config.sendDefaultPii).toBe(false)
  })
})

describe('redactContactLinkPayloads', () => {
  it.each([
    [LINK, REDACTED_LINK],
    [`${LINK}?utm_source=share`, `${REDACTED_LINK}?utm_source=share`],
    [`GET /c/${PAYLOAD}`, 'GET /c/[redacted]'],
    [`/c/${PAYLOAD}/more`, '/c/[redacted]'],
    [`Bad link "${LINK}"`, `Bad link "${REDACTED_LINK}"`],
  ])('redacts %s', (input, expected) => {
    expect(redactContactLinkPayloads(input)).toBe(expected)
  })

  it.each([
    'https://ww-proxy.leviwilkerson.com/c',
    'GET /c/:payload',
    'GET /notes-import/:importId/events',
    'https://geocode.search.hereapi.com/v1/geocode?q=1',
  ])('leaves %s alone', (input) => {
    expect(redactContactLinkPayloads(input)).toBe(input)
  })
})

describe('Sentry scrubbers', () => {
  it('beforeSend scrubs URLs, request data and messages', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: `Failed to render ${LINK}`,
      request: {
        url: LINK,
        method: 'GET',
        headers: { referer: LINK, 'user-agent': 'Slackbot-LinkExpanding' },
      },
      exception: { values: [{ type: 'Error', value: `Bad link ${LINK}` }] },
      breadcrumbs: [{ category: 'fetch', data: { url: LINK } }],
      contexts: {
        trace: { trace_id: 't', span_id: 's', data: { 'url.full': LINK } },
      },
    }

    const scrubbed = config.beforeSend!(event, {}) as ErrorEvent

    expect(JSON.stringify(scrubbed)).not.toContain(PAYLOAD)
    expect(scrubbed.request?.url).toBe(REDACTED_LINK)
    expect(scrubbed.request?.headers).toEqual({
      referer: REDACTED_LINK,
      'user-agent': 'Slackbot-LinkExpanding',
    })
    expect(scrubbed.exception?.values?.[0].value).toBe(
      `Bad link ${REDACTED_LINK}`
    )
  })

  it('beforeSendTransaction scrubs transaction names, spans and request data', () => {
    const event: TransactionEvent = {
      type: 'transaction',
      transaction: `GET /c/${PAYLOAD}`,
      request: { url: LINK },
      contexts: {
        trace: { trace_id: 't', span_id: 's', data: { 'url.full': LINK } },
      },
      spans: [
        {
          span_id: 'c',
          trace_id: 't',
          start_timestamp: 0,
          description: `GET ${LINK}`,
          data: { 'url.full': LINK },
        },
      ],
    }

    const scrubbed = config.beforeSendTransaction!(
      event,
      {}
    ) as TransactionEvent

    expect(JSON.stringify(scrubbed)).not.toContain(PAYLOAD)
    expect(scrubbed.transaction).toBe('GET /c/[redacted]')
    expect(scrubbed.contexts?.trace?.data?.['url.full']).toBe(REDACTED_LINK)
  })

  it('beforeBreadcrumb scrubs breadcrumb URLs and messages', () => {
    const breadcrumb: Breadcrumb = {
      category: 'fetch',
      message: `GET ${LINK}`,
      data: { url: LINK, status_code: 200 },
    }

    expect(config.beforeBreadcrumb!(breadcrumb)).toEqual({
      category: 'fetch',
      message: `GET ${REDACTED_LINK}`,
      data: { url: REDACTED_LINK, status_code: 200 },
    })
  })

  it('drops the Buddies live-socket auth headers from events and transactions', () => {
    const headers = () => ({
      'x-buddies-payload': 'eyJpbmJveElkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9',
      'X-Buddies-Signature': 'c2lnbmF0dXJl',
      'x-buddies-p': 'eyJpbmJveElkIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9',
      'X-Buddies-S': 'c2lnbmF0dXJl',
      upgrade: 'websocket',
    })
    const error: ErrorEvent = {
      type: undefined,
      request: { url: 'https://ww-proxy.test/buddies/v1/inbox/live', headers: headers() },
    }
    const transaction: TransactionEvent = {
      type: 'transaction',
      request: { url: 'https://ww-proxy.test/buddies/v1/inbox/live', headers: headers() },
    }

    expect((config.beforeSend!(error, {}) as ErrorEvent).request?.headers).toEqual({
      upgrade: 'websocket',
    })
    expect(
      (config.beforeSendTransaction!(transaction, {}) as TransactionEvent).request?.headers
    ).toEqual({ upgrade: 'websocket' })
  })

  it('drops the account backup envelope headers, and only those', () => {
    const error: ErrorEvent = {
      type: undefined,
      request: {
        url: 'https://ww-proxy.test/accounts/v1/backup/put',
        headers: {
          'x-ww-payload': 'eyJhY2NvdW50UHViIjoiQUFBQSJ9',
          'X-WW-Signature': 'c2lnbmF0dXJl',
          'x-ww-p': 'eyJhY2NvdW50UHViIjoiQUFBQSJ9',
          'X-WW-S': 'c2lnbmF0dXJl',
          'x-ww-sha256': 'kept',
          'content-type': 'application/octet-stream',
        },
      },
    }
    expect((config.beforeSend!(error, {}) as ErrorEvent).request?.headers).toEqual({
      'x-ww-sha256': 'kept',
      'content-type': 'application/octet-stream',
    })
  })

  it('drops the bearer backup upload’s slot id', () => {
    const error: ErrorEvent = {
      type: undefined,
      request: {
        url: 'https://ww-proxy.test/accounts/v1/backup/put',
        headers: {
          Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln',
          'X-WW-Slot-Id': 'AAAAAAAAAAAAAAAAAAAAAA',
          'x-ww-sha256': 'kept',
          'content-length': '42',
        },
      },
    }
    expect((config.beforeSend!(error, {}) as ErrorEvent).request?.headers).toEqual({
      'x-ww-sha256': 'kept',
      'content-length': '42',
    })
  })

  it('drops bearer, admin, and dev bypass tokens from events and transactions', () => {
    const headers = () => ({
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln',
      'x-ww-admin-token': 'admin-secret',
      'X-WW-Dev-Bypass': 'bypass-secret',
      'x-authorization-hint': 'kept',
      accept: 'application/json',
    })
    const kept = { 'x-authorization-hint': 'kept', accept: 'application/json' }
    const error: ErrorEvent = {
      type: undefined,
      request: { url: 'https://ww-proxy.test/accounts/v1/account/info', headers: headers() },
    }
    const transaction: TransactionEvent = {
      type: 'transaction',
      request: { url: 'https://ww-proxy.test/admin/accounts/status', headers: headers() },
    }

    expect((config.beforeSend!(error, {}) as ErrorEvent).request?.headers).toEqual(kept)
    expect(
      (config.beforeSendTransaction!(transaction, {}) as TransactionEvent).request?.headers
    ).toEqual(kept)
  })

  it('leaves events without contact links untouched', () => {
    const event: TransactionEvent = {
      type: 'transaction',
      transaction: 'GET /c/:payload',
      request: { url: 'https://ww-proxy.leviwilkerson.com/geocode?q=1' },
    }
    const snapshot = structuredClone(event)

    expect(config.beforeSendTransaction!(event, {})).toEqual(snapshot)
  })
})

describe('trace sampling', () => {
  const sample = (name: string, development = false, parentSampled?: boolean) =>
    createSentryConfig({ APP_ATTEST_ENVIRONMENT: development ? 'development' : 'production' } as Environment)
      .tracesSampler!({ name, transactionContext: { name }, parentSampled })

  it.each(['GET /notes-import/status', 'GET /attestation/v1/status', 'GET /geocode', 'GET /autocomplete', 'GET /health', 'GET /c/private-payload', 'GET /contacts', 'GET /unknown'])(
    'samples routine transaction %s at 10%, including sampled parents', (name) => {
      expect(sample(name)).toBe(0.1)
      expect(sample(name, false, true)).toBe(0.1)
    }
  )
  it.each(['POST /notes-import', 'POST /notes-import/kickoff', 'POST /notes-import/challenge', 'POST /notes-import/attest', 'GET /notes-import/id/events', 'POST /attestation/v1/challenge', 'POST /attestation/v1/register', 'POST /attestation/v1/verify'])(
    'retains import transaction %s even with an unsampled parent', (name) => {
      expect(sample(name, false, false)).toBe(1)
    }
  )
  it('keeps full tracing on dev without changing error sampling or redaction', () => {
    expect(sample('GET /notes-import/status', true)).toBe(1)
    expect(config.sampleRate).toBeUndefined()
    expect(config.beforeSend).toBeTypeOf('function')
    expect(config.beforeSendTransaction).toBeTypeOf('function')
  })
})

describe('database errors', () => {
  // What Drizzle puts in a failed query's message: ids, token hashes.
  const ACCOUNT_ID = 'AcctAcctAcctAcctAcct0w'
  const TOKEN_HASH = 'HashHashHashHashHashHashHashHashHashHashHa0'
  const QUERY =
    'select "id", "account_id" from "account_sessions" where "account_sessions"."refresh_hash" = ? and "account_sessions"."account_id" = ?'
  const queryError = () =>
    new DrizzleQueryError(
      QUERY,
      [TOKEN_HASH, ACCOUNT_ID],
      new Error(`D1_TYPE_ERROR: Type 'object' not supported for value '${ACCOUNT_ID}'`)
    )

  let recorder: SentryRecorder
  beforeEach(() => {
    recorder = recordSentryEvents()
  })
  afterEach(() => recorder.stop())

  const leaks = (value: unknown) => {
    const text = JSON.stringify(value)
    return text.includes(ACCOUNT_ID) || text.includes(TOKEN_HASH)
  }

  it('reports a database error, or one it caused, as the operation alone', () => {
    const error = queryError()
    expect(isDatabaseError(error)).toBe(true)
    const reported = reportableError(error, 'session/refresh') as Error
    expect(reported).toBeInstanceOf(DatabaseError)
    expect(reported.name).toBe('DatabaseError')
    expect(reported.message).toBe('database query failed: session/refresh')
    expect(reported.cause).toBeUndefined()
    expect(Object.keys(reported)).toEqual(['name'])
    // The stack keeps the frames and nothing from the query.
    expect(reported.stack).toMatch(
      /^DatabaseError: database query failed: session\/refresh\n\s+at /
    )
    expect(reported.stack).not.toContain('Failed query')
    expect(leaks(reported.stack)).toBe(false)

    const wrapped = new Error('kickoff failed', { cause: queryError() })
    expect(reportableError(wrapped, 'kickoff')).toBeInstanceOf(DatabaseError)
    const d1 = new Error(`D1_ERROR: no such column: ${ACCOUNT_ID}`)
    expect(reportableError(d1, 'account status')).toBeInstanceOf(DatabaseError)
  })

  it('reports anything else unchanged', () => {
    const plain = new Error('RPC reply lost', { cause: new Error('socket') })
    expect(isDatabaseError(plain)).toBe(false)
    expect(reportableError(plain, 'inbox/sync')).toBe(plain)
    expect(reportableError('text', 'inbox/sync')).toBe('text')
    const loop = new Error('loop') as Error & { cause?: unknown }
    loop.cause = loop
    expect(reportableError(loop, 'inbox/sync')).toBe(loop)
  })

  it('captureFailure sends the operation, never the query', async () => {
    captureFailure(queryError(), 'session/refresh')
    const events = await recorder.events()
    expect(events).toHaveLength(1)
    expect(events[0].exception?.values).toEqual([
      expect.objectContaining({
        type: 'DatabaseError',
        value: 'database query failed: session/refresh',
      }),
    ])
    expect(leaks(events)).toBe(false)
  })

  it('beforeSend redacts a raw query error and drops its cause chain', async () => {
    Sentry.captureException(queryError())
    const [event] = await recorder.events()
    expect(event.exception?.values).toEqual([
      expect.objectContaining({ type: 'Error', value: '[redacted database query]' }),
    ])
    expect(leaks(event)).toBe(false)
  })

  it('beforeSend keeps the errors above one and drops only those below', async () => {
    const deeper = queryError()
    ;(deeper.cause as Error).cause = new Error(`D1 detail ${ACCOUNT_ID}`)
    Sentry.captureException(new Error('settling failed', { cause: deeper }))
    const [event] = await recorder.events()
    expect(event.exception?.values?.map((value) => value.value)).toEqual([
      '[redacted database query]',
      'settling failed',
    ])
    expect(leaks(event)).toBe(false)

    // Chains without a database error keep every cause.
    Sentry.captureException(
      new Error('outer', { cause: new Error('middle', { cause: new Error('inner') }) })
    )
    const [, plain] = await recorder.events()
    expect(plain.exception?.values?.map((value) => value.value)).toEqual([
      'inner',
      'middle',
      'outer',
    ])
  })

  it('redacts query text in messages, extras, and breadcrumbs', async () => {
    const text = queryError().message
    Sentry.captureMessage(`accounts: ${text}`)
    const [event] = await recorder.events()
    expect(event.message).toBe('accounts: [redacted database query]')

    const scrubbed = config.beforeSend!(
      { type: undefined, extra: { detail: { reason: text } } },
      {}
    ) as ErrorEvent
    expect(scrubbed.extra).toEqual({
      detail: { reason: '[redacted database query]' },
    })
    expect(
      config.beforeBreadcrumb!({ message: `failed: ${text}` }, {})
    ).toEqual({ message: 'failed: [redacted database query]' })
    // Truncated before `params:`, the query alone still goes.
    expect(redactDatabaseErrors(`Failed query: ${QUERY.slice(0, 40)}…`)).toBe(
      '[redacted database query]'
    )
    expect(redactDatabaseErrors(`x\nparams: ${ACCOUNT_ID}`)).toBe(
      'x[redacted database query]'
    )
    expect(redactDatabaseErrors('No query here; params are fine')).toBe(
      'No query here; params are fine'
    )
  })
})
