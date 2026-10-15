import { z } from 'zod'
import { describeRoute } from 'hono-openapi'
import {
  staleErrorSchema,
  b64u,
  buddiesId,
  errorResponse,
  jsonBody,
  jsonResponse,
  signedBody,
} from '../openapi/schemas'
import { ACCOUNT_STATUS_REASONS, ACCOUNT_STATUSES } from './schema'

const accountId = buddiesId('The account id')
const status = z.enum(ACCOUNT_STATUSES)

const keySignedBody = (op: string) =>
  signedBody(
    z.object({
      accountPub: b64u(
        'Ed25519 public key of the account signing key, 32 bytes'
      ),
      ts: z.number().int().meta({
        description:
          'Client time in epoch milliseconds; must be within 5 minutes of the server’s.',
      }),
      nonce: buddiesId('A fresh random nonce'),
    }),
    `A signed envelope; \`s\` is the account key’s signature over \`ww-account/v1\\n${op}\\n\` followed by \`p\`’s bytes.`
  )

const signatureErrors = {
  400: errorResponse('Malformed envelope or payload.', ['bad_request']),
  401: errorResponse(
    'Bad signature, or `ts` too far from the server clock. `stale` carries `serverTime` (epoch ms) and a `Date` header.',
    ['bad_signature', 'stale'],
    staleErrorSchema
  ),
}

export const accountRegisterDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Register an account',
  description: `Returns the account for a signing key, creating it on first use. Self-signed by the account key under the \`ww-account/v1\` context, and idempotent: the same key always gets the same \`accountId\`.

Limits: the Buddies register tier (60 a minute per caller IP) and 2,000 registrations per caller per rolling day, shared in kind with \`inbox/register\`. Answers \`disabled\` on a worker without the accounts database.`,
  requestBody: keySignedBody('account/register'),
  responses: {
    200: jsonResponse(
      'The account for this key.',
      z.object({ ok: z.literal(true), accountId, status })
    ),
    ...signatureErrors,
    429: errorResponse('Over the per-caller rate or daily quota.', [
      'rate_limited',
    ]),
    500: errorResponse('Unexpected failure.', ['internal']),
    503: errorResponse('Accounts are off on this worker.', ['disabled']),
  },
})

const epochMs = (description: string) =>
  z.number().int().meta({ description: `${description}, epoch milliseconds.` })

export const accountInfoDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Read your account',
  description: `What the accounts database holds for the signing key’s own account, for the app’s developer tools: its id, status, creation time, linked inboxes, and status changes (without their reasons). Self-signed by the account key under the \`ww-account/v1\` context, so only the key’s holder can read it. Read-only: it never creates an account.

Limits: the Buddies read tier (600 a minute per caller IP). Answers \`disabled\` on a worker without the accounts database.`,
  requestBody: keySignedBody('account/info'),
  responses: {
    200: jsonResponse(
      'The account for this key.',
      z.object({
        ok: z.literal(true),
        accountId,
        accountPub: b64u('The account signing key’s public key'),
        status,
        createdAt: epochMs('When the account was registered'),
        inboxIds: z.array(buddiesId('An inbox linked to the account')),
        statusChanges: z.array(
          z.object({ status, createdAt: epochMs('When it changed') })
        ),
      })
    ),
    ...signatureErrors,
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    500: errorResponse('Unexpected failure.', ['internal']),
    503: errorResponse('Accounts are off on this worker.', ['disabled']),
  },
})

const adminErrors = {
  400: errorResponse('Invalid JSON or field.', ['bad_request']),
  404: errorResponse(
    'Missing or wrong admin token, no accounts database, or no such account.',
    ['not_found', 'unknown_account']
  ),
  429: errorResponse('Too many admin requests from this IP.', ['rate_limited']),
}

const accountSummary = z.object({
  id: accountId,
  status,
  inboxIds: z.array(buddiesId('An inbox linked to the account')),
})

export const accountLookupDocs = describeRoute({
  tags: ['Admin'],
  summary: 'Look up an account',
  description:
    'Finds an account, its status, and its inboxes. Abuse reports name the buddy’s `inboxId`; this finds the account behind it. Send `inboxId` or `accountId`.',
  security: [{ adminToken: [] }],
  requestBody: jsonBody(
    z.union([
      z.object({ inboxId: buddiesId('The reported inbox') }),
      z.object({ accountId }),
    ])
  ),
  responses: {
    200: jsonResponse(
      'The account.',
      z.object({ ok: z.literal(true), account: accountSummary })
    ),
    ...adminErrors,
  },
})

export const accountStatusDocs = describeRoute({
  tags: ['Admin'],
  summary: 'Suspend or reinstate an account',
  description:
    'Sets the account’s status, records the change in `account_status_events`, and tells each of its inboxes. A suspended account’s inboxes refuse owner ops with 403 `suspended` and close their live sockets. If `inboxesFailed` is above 0, send the same request again.',
  security: [{ adminToken: [] }],
  requestBody: jsonBody(
    z.object({
      accountId,
      status: status.meta({ description: '`active` reinstates.' }),
      reason: z.enum(ACCOUNT_STATUS_REASONS),
    })
  ),
  responses: {
    200: jsonResponse(
      'Status recorded. `ok` is false when some inboxes weren’t updated.',
      z.object({
        ok: z.boolean(),
        account: accountSummary,
        inboxesUpdated: z.number().int(),
        inboxesFailed: z.number().int(),
      })
    ),
    ...adminErrors,
  },
})
