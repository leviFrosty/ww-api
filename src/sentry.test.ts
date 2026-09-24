import { describe, expect, it } from 'vitest'
import type {
  Breadcrumb,
  CloudflareOptions,
  ErrorEvent,
} from '@sentry/cloudflare'
import { createSentryConfig, redactContactLinkPayloads } from './sentry'
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
