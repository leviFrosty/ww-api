import { z } from 'zod'
import { describeRoute } from 'hono-openapi'
import {
  apiErrorSchema,
  staleErrorSchema,
  b64u,
  buddiesId,
  errorResponse,
  fieldTable,
  json,
  jsonBody,
  jsonResponse,
  signedBody,
  signedEnvelopeSchema,
} from '../openapi/schemas'
import {
  appAttestV2AssertionFields,
  playIntegrityFields,
  sha256Hex,
} from '../attestation/openapi'
import { ACCOUNT_SESSION_PURPOSE } from '../attestation/purposes'
import { ACCOUNT_STATUS_REASONS, ACCOUNT_STATUSES } from './schema'

/**
 * OpenAPI descriptions for `/accounts/v1/*` (src/accounts/route.ts) and the
 * accounts admin routes. Doc-only: the handlers keep their own parsing.
 *
 * Sessions and the account are REST resources (`/sessions`, `/account`).
 * Handoff and backup stay `POST /accounts/v1/{op}`, like Buddies, on purpose:
 * their channel and slot ids travel in bodies (or headers), never URLs, which
 * Cloudflare and Sentry record. `ID_IN_BODY` says so on each of them.
 */

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
    `A signed envelope; \`signature\` is the account key’s signature over \`ww-account/v1\\n${op}\\n\` followed by the decoded \`payload\` bytes.`
  )

const signatureErrors = {
  400: errorResponse('Malformed envelope or payload.', ['bad_request']),
  401: errorResponse(
    'Bad signature, or `ts` too far from the server clock. `stale` carries `serverTime` (epoch ms) and a `Date` header.',
    ['bad_signature', 'stale'],
    staleErrorSchema
  ),
}

// --- Bearer tokens and the legacy switch -----------------------------------

const keyPayloadShape = {
  accountPub: b64u('Ed25519 public key of the account signing key, 32 bytes'),
  ts: z.number().int().meta({
    description:
      'Client time in epoch milliseconds; must be within 5 minutes of the server’s.',
  }),
  nonce: buddiesId('A fresh random nonce'),
}

/** A bearer token, or (while the legacy switch is on) none: the envelope. */
const bearerOrLegacy: Record<string, string[]>[] = [{ bearerAuth: [] }, {}]

const LEGACY_FORM = (op: string) =>
  `**Legacy** (no \`Authorization\` header; app versions before sessions): a signed envelope instead, whose \`signature\` is the account key’s signature over \`ww-account/v1\\n${op}\\n\` followed by the decoded \`payload\` bytes. It works while the legacy switch (KV \`auth:legacy\`) is on and is 426 \`upgrade_required\` once it’s off. A request with an \`Authorization\` header is always a bearer request.`

/** Why handoff and backup ops aren't resource paths. */
const ID_IN_BODY =
  'Like Buddies ops, this is `POST /accounts/v1/{op}` rather than a resource path, so its ids travel in the body (or headers), never the URL, which Cloudflare and Sentry record.'

/** A bearer request's plain JSON fields, or the legacy envelope. */
const bearerOrSignedBody = (op: string, fields: z.ZodRawShape) =>
  jsonBody(
    z.union([
      z.object(fields).meta({ title: 'Bearer' }),
      signedEnvelopeSchema.meta({ title: 'Legacy envelope' }),
    ]),
    `**Bearer:** the fields as plain JSON.\n\n${LEGACY_FORM(op)}\n\n**Decoded \`payload\`:**\n\n${fieldTable(
      z.object({ ...keyPayloadShape, ...fields })
    )}`
  )

/** No body (bearer), or the legacy envelope. */
const optionalSignedBody = (op: string) => ({
  required: false,
  description: `**Bearer:** no body.\n\n${LEGACY_FORM(op)}\n\n**Decoded \`payload\`:**\n\n${fieldTable(
    z.object(keyPayloadShape)
  )}`,
  content: json(signedEnvelopeSchema),
})

const bearerErrors = {
  400: errorResponse('Malformed JSON, envelope, or field.', ['bad_request']),
  401: errorResponse(
    'A bearer request’s token is missing, expired, or invalid (`unauthorized`, with `WWW-Authenticate: Bearer error="invalid_token"`; refresh once and retry). A legacy request’s signature is bad (`bad_signature`) or its `ts` is more than 5 minutes off (`stale`, with `serverTime` and a `Date` header).',
    ['unauthorized', 'bad_signature', 'stale'],
    staleErrorSchema
  ),
}

const upgradeRequired = {
  426: errorResponse(
    'A legacy request after the legacy switch (KV `auth:legacy`) was turned off. Update the app; there’s no `Retry-After`.',
    ['upgrade_required']
  ),
}

export const accountRegisterDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Register an account (legacy)',
  deprecated: true,
  description: `Returns the account for a signing key, creating it on first use. Self-signed by the account key under the \`ww-account/v1\` context, and idempotent: the same key always gets the same \`accountId\`.

Replaced by opening a session (\`POST /accounts/v1/sessions\`), and kept for app versions before sessions: once the legacy switch (KV \`auth:legacy\`) is off, it’s 426 \`upgrade_required\`.

Limits: the Buddies register tier (60 a minute per caller IP) and 2,000 registrations per caller per rolling day, shared in kind with \`inbox/register\`. Answers \`disabled\` on a worker without the accounts database.`,
  requestBody: keySignedBody('account/register'),
  responses: {
    200: jsonResponse(
      'The account for this key.',
      z.object({ ok: z.literal(true), accountId, status })
    ),
    ...signatureErrors,
    ...upgradeRequired,
    429: errorResponse('Over the per-caller rate or daily quota.', [
      'rate_limited',
    ]),
    500: errorResponse('Unexpected failure.', ['internal']),
    503: errorResponse('Accounts are off on this worker.', ['disabled']),
  },
})

const epochMs = (description: string) =>
  z.number().int().meta({ description: `${description}, epoch milliseconds.` })

const accountInfoSchema = z.object({
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

export const accountDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Read your account',
  description: `What the accounts database holds for the access token’s own account, for Settings → Account and the app’s developer tools: its id, public key, status, creation time, linked inboxes, and status changes (without their reasons). Read-only: it never creates an account.

Limits: the Buddies read tier (600 a minute per caller IP). Answers \`disabled\` on a worker without the accounts database.`,
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse('The token’s account.', accountInfoSchema),
    401: errorResponse(
      'Missing, expired, or invalid token (`WWW-Authenticate: Bearer error="invalid_token"`; refresh once and retry).',
      ['unauthorized']
    ),
    404: errorResponse('The token’s account is gone.', ['unknown_account']),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    500: errorResponse('Unexpected failure.', ['internal']),
    503: errorResponse('Accounts are off on this worker.', ['disabled']),
  },
})

export const accountInfoDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Read your account (legacy)',
  description: `\`GET /accounts/v1/account\`’s answer, for app versions before it. A bearer request with no body reads the token’s account.

${LEGACY_FORM('account/info')} An unregistered key is 404 \`unknown_account\`.

Limits: the Buddies read tier (600 a minute per caller IP). Answers \`disabled\` on a worker without the accounts database.`,
  deprecated: true,
  security: bearerOrLegacy,
  requestBody: optionalSignedBody('account/info'),
  responses: {
    200: jsonResponse('The account.', accountInfoSchema),
    ...bearerErrors,
    404: errorResponse(
      'No account has this key (legacy), or the token’s account is gone.',
      ['unknown_account']
    ),
    ...upgradeRequired,
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

// --- Handoff (Set Up Another Device) ---------------------------------------

const channelId = buddiesId('The channel id from the QR code')
const claimToken = buddiesId(
  'The claim token, `HKDF-SHA256(secret, "", "ww-account/v1/handoff/claim\\n" + channelId, 16)`'
)
const expiresAt = epochMs('When the channel and everything in it is deleted')
const handoffStatus = z.enum(['open', 'claimed', 'sent', 'done', 'cancelled'])

/** A signed envelope whose payload adds `fields` to the key payload. */
const keySignedWith = (op: string, fields: z.ZodRawShape) =>
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
      ...fields,
    }),
    `A signed envelope; \`signature\` is the account key’s signature over \`ww-account/v1\\n${op}\\n\` followed by the decoded \`payload\` bytes.`
  )

const okOnly = jsonResponse('Done.', z.object({ ok: z.literal(true) }))
const internal = { 500: errorResponse('Unexpected failure.', ['internal']) }
const accountsOff = {
  503: errorResponse('Accounts are off on this worker.', ['disabled']),
}
const readTier = 'Limits: the Buddies read tier (600 a minute per caller IP).'
const notFound = errorResponse(
  'No such channel, or it expired (10 minutes after `handoff/open`).',
  ['not_found']
)
const oldPhoneErrors = (extra: string) => ({
  ...bearerErrors,
  403: errorResponse('Another account opened this channel.', ['forbidden']),
  404: errorResponse(
    `${extra} Also \`unknown_account\` when no account has the signing key (legacy).`,
    ['not_found', 'unknown_account']
  ),
  ...upgradeRequired,
})
const tokenErrors = {
  400: errorResponse('Malformed JSON or field.', ['bad_request']),
  401: errorResponse(
    'Wrong `claimToken`. The fifth wrong token on a channel cancels it.',
    ['bad_signature']
  ),
  404: notFound,
}
const tokenBody = (extra: z.ZodRawShape = {}) =>
  jsonBody(z.object({ channelId, claimToken, ...extra }))

export const handoffOpenDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Open a handoff channel (old phone)',
  description: `The phone with the account opens a channel for Set Up Another Device and shows its QR code. The server stores the account, the claim token’s verifier, and nothing else until a new phone claims it. The channel and everything in it is deleted 10 minutes after opening.

Limits: the Buddies register tier (60 a minute per caller IP) and 20 opens per account a rolling day.

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: bearerOrSignedBody('handoff/open', {
    channelId,
    verifier: b64u('`SHA-256(claimToken bytes)`, 32 bytes'),
  }),
  responses: {
    200: jsonResponse(
      'Opened.',
      z.object({ ok: z.literal(true), expiresAt })
    ),
    ...bearerErrors,
    404: errorResponse('No account has this key; register first (legacy).', [
      'unknown_account',
    ]),
    ...upgradeRequired,
    409: errorResponse('The channel already exists.', ['conflict']),
    429: errorResponse('Over the per-caller rate or the daily opens.', [
      'rate_limited',
    ]),
    ...internal,
    ...accountsOff,
  },
})

export const handoffClaimDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Claim a handoff channel (new phone)',
  description: `The new phone answers the QR code with its temporary X25519 public key and its sealed hello. The first valid claim wins; repeating it with the same body gets \`ok\` again (a lost response), and any other claim is \`conflict\`. Plain JSON, authorized by \`claimToken\`.

${readTier}

${ID_IN_BODY}`,
  requestBody: tokenBody({
    claimPub: b64u('The new phone’s temporary X25519 public key, 32 bytes'),
    hello: b64u(
      'The hello, sealed with `helloKey` (`0x01 ‖ nonce[12] ‖ ChaCha20-Poly1305`), at most 2,048 characters'
    ),
  }),
  responses: {
    200: jsonResponse(
      'Claimed (or the same claim again).',
      z.object({ ok: z.literal(true), expiresAt })
    ),
    ...tokenErrors,
    409: errorResponse('Another phone claimed it, or it was cancelled.', [
      'conflict',
    ]),
    413: errorResponse('`hello` is over 2,048 characters.', ['too_large']),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

export const handoffStatusDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Read a handoff channel (old phone)',
  description: `What the old phone polls (every 1.5 seconds) while it shows the code: the status and, once claimed, the new phone’s public key and sealed hello. Only the opening account can read it.

${readTier}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: bearerOrSignedBody('handoff/status', { channelId }),
  responses: {
    200: jsonResponse(
      'The channel.',
      z.object({
        ok: z.literal(true),
        status: handoffStatus,
        expiresAt,
        claimPub: b64u(
          'The new phone’s temporary public key, from `claimed` until `done` or `cancelled`'
        ).optional(),
        hello: b64u(
          'The sealed hello, from `claimed` until `done` or `cancelled`'
        ).optional(),
      })
    ),
    ...oldPhoneErrors('No such channel, or it expired.'),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

export const handoffSendDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Send the account key (old phone)',
  description: `After the User approves the new phone, the old phone sends the account key sealed with \`keyKey\`. Only while \`claimed\`; the status becomes \`sent\`.

${readTier}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: bearerOrSignedBody('handoff/send', {
    channelId,
    key: b64u(
      'The account key, sealed with `keyKey`, at most 1,024 characters'
    ),
  }),
  responses: {
    200: okOnly,
    ...oldPhoneErrors('No such channel, or it expired.'),
    409: errorResponse('The channel isn’t `claimed`.', ['conflict']),
    413: errorResponse('`key` is over 1,024 characters.', ['too_large']),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

export const handoffReceiveDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Poll for the account key (new phone)',
  description: `The new phone polls (every 1.5 seconds) until the status is \`sent\`, which carries the sealed key, or \`cancelled\`.

${readTier}

${ID_IN_BODY}`,
  requestBody: tokenBody(),
  responses: {
    200: jsonResponse(
      'The status, and the key once sent.',
      z.object({
        ok: z.literal(true),
        status: handoffStatus,
        key: b64u('The sealed account key, while `sent`').optional(),
      })
    ),
    ...tokenErrors,
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

export const handoffDoneDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Finish a handoff (new phone)',
  description: `The new phone has the key: the server deletes the blobs at once and keeps only the status (\`done\`) until the channel expires. Repeating it is \`ok\`.

${readTier}

${ID_IN_BODY}`,
  requestBody: tokenBody(),
  responses: {
    200: okOnly,
    ...tokenErrors,
    409: errorResponse('The key wasn’t sent, or the channel was cancelled.', [
      'conflict',
    ]),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

export const handoffCancelDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Cancel a handoff (either phone)',
  description: `Either phone ends the channel: the server deletes every blob at once and keeps only the status (\`cancelled\`) until the channel expires. Idempotent; a \`done\` channel stays \`done\`. The new phone sends plain JSON with \`claimToken\` (with or without a session of its own). The old phone sends \`{ channelId }\` as a bearer request and must be the opening account; before sessions it sent a signed envelope (op \`handoff/cancel\`, payload \`channelId\` plus the key payload), which works while the legacy switch is on.

${readTier}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: jsonBody(
    z.union([
      z.object({ channelId, claimToken }).meta({ title: 'New phone' }),
      z.object({ channelId }).meta({ title: 'Old phone (bearer)' }),
      signedEnvelopeSchema.meta({ title: 'Old phone (legacy envelope)' }),
    ]),
    'A body with `claimToken` is the new phone’s. Otherwise a bearer request, or a signed envelope, is the old phone’s.'
  ),
  responses: {
    200: okOnly,
    400: errorResponse('Malformed envelope, JSON, or field.', ['bad_request']),
    401: errorResponse(
      'The old phone’s token is missing, expired, or invalid (`unauthorized`), its envelope’s signature is bad or `ts` stale (legacy), or the new phone’s `claimToken` is wrong (`bad_signature`; the fifth cancels the channel).',
      ['unauthorized', 'bad_signature', 'stale'],
      staleErrorSchema
    ),
    ...upgradeRequired,
    403: errorResponse('Another account opened this channel.', ['forbidden']),
    404: errorResponse(
      'No such channel, it expired, or no account has the signing key.',
      ['not_found', 'unknown_account']
    ),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...accountsOff,
  },
})

// --- Backup ------------------------------------------------------------------

const slotId = buddiesId('The device’s backup slot')
const backupOff = {
  503: errorResponse(
    'Backups are off on this worker (no backup bucket or accounts database).',
    ['disabled']
  ),
}
const backupNotes =
  'A suspended account can still back up. A slot is deleted 400 days after its last upload.'

const binary = (description: string) => ({
  description,
  content: {
    'application/octet-stream': {
      schema: { type: 'string' as const, format: 'binary' },
    },
  },
})

const keyPayloadFields = (op: string, fields: z.ZodRawShape) =>
  fieldTable(
    z.object({
      accountPub: b64u(
        'Ed25519 public key of the account signing key, 32 bytes'
      ),
      ts: z.number().int().meta({
        description:
          'Client time in epoch milliseconds; must be within 5 minutes of the server’s.',
      }),
      nonce: buddiesId('A fresh random nonce'),
      ...fields,
    })
  ) + `\n\nSigned over \`ww-account/v1\\n${op}\\n\` followed by the decoded \`payload\` bytes.`

export const backupPutDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Upload a backup',
  description: `Replaces this device’s slot with an end-to-end encrypted backup (\`0x01 ‖ nonce[24] ‖ XChaCha20-Poly1305\`). A bearer request; the body is the raw blob, at most 20 MiB, with the slot in \`x-ww-slot-id\`, \`b64u(SHA-256(body))\` in \`x-ww-sha256\`, and its length in \`Content-Length\`.

**Legacy** (no \`Authorization\` header): the signed envelope (op \`backup/put\`) rides in the \`x-ww-payload\` and \`x-ww-signature\` headers instead, while the legacy switch is on (older builds send \`x-ww-p\`/\`x-ww-s\`).

**Decoded \`x-ww-payload\`:**

${keyPayloadFields('backup/put', {
  slotId,
  size: z.number().int().min(1).meta({
    description:
      'The body’s exact length, at most 20 MiB. `Content-Length`, when sent, must match.',
  }),
  sha256: b64u('`SHA-256(body)`, 32 bytes'),
})}

Limits: 20 MiB a blob, 8 slots an account, one upload a slot a minute, and the Buddies photo-upload tier (60 a minute per caller IP). ${backupNotes}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  parameters: [
    {
      name: 'x-ww-slot-id',
      in: 'header' as const,
      required: false,
      schema: { type: 'string' as const },
      description: 'Bearer: the device’s slot id (22-character base64url).',
    },
    {
      name: 'x-ww-sha256',
      in: 'header' as const,
      required: false,
      schema: { type: 'string' as const },
      description: 'Bearer: `SHA-256(body)`, 32 bytes, base64url.',
    },
    {
      name: 'Content-Length',
      in: 'header' as const,
      required: false,
      schema: { type: 'integer' as const },
      description:
        'The body’s length; required on a bearer request (it is the size), at most 20 MiB.',
    },
    {
      name: 'x-ww-payload',
      in: 'header' as const,
      required: false,
      schema: { type: 'string' as const },
      description: 'Legacy: the request’s fields as UTF-8 JSON, base64url.',
    },
    {
      name: 'x-ww-signature',
      in: 'header' as const,
      required: false,
      schema: { type: 'string' as const },
      description: 'Legacy: the account key’s Ed25519 signature, base64url.',
    },
  ],
  requestBody: { required: true, ...binary('The encrypted backup bytes.') },
  responses: {
    200: jsonResponse(
      'Stored.',
      z.object({
        ok: z.literal(true),
        uploadedAt: epochMs('When the slot was written'),
      })
    ),
    400: errorResponse(
      'Missing or malformed headers or payload, or a body whose length isn’t `size` or whose SHA-256 isn’t `sha256`.',
      ['bad_request']
    ),
    401: bearerErrors[401],
    404: errorResponse('No account has this key; register first (legacy).', [
      'unknown_account',
    ]),
    413: errorResponse(
      '`size`, `Content-Length`, or the streamed body is over 20 MiB.',
      ['too_large']
    ),
    ...upgradeRequired,
    429: errorResponse(
      'The account has 8 other slots (`limit`; delete one first), the slot was written less than a minute ago, or over the per-caller rate (`rate_limited`, with `Retry-After`).',
      ['limit', 'rate_limited']
    ),
    ...internal,
    ...backupOff,
  },
})

export const backupListDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'List backups',
  description: `Every slot of the caller’s account, for a restore. A bearer request with no body.

${LEGACY_FORM('backup/list')}

${readTier} ${backupNotes}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: optionalSignedBody('backup/list'),
  responses: {
    200: jsonResponse(
      'The account’s slots.',
      z.object({
        ok: z.literal(true),
        slots: z.array(
          z.object({
            slotId,
            size: z.number().int().meta({ description: 'Bytes.' }),
            uploadedAt: epochMs('When the slot was last written'),
          })
        ),
      })
    ),
    ...bearerErrors,
    404: errorResponse('No account has this key; register first (legacy).', [
      'unknown_account',
    ]),
    ...upgradeRequired,
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})

export const backupGetDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Download a backup',
  description: `Streams one slot’s bytes exactly as uploaded. A bearer request.

${readTier}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: bearerOrSignedBody('backup/get', { slotId }),
  responses: {
    200: {
      ...binary('The encrypted backup bytes.'),
      headers: {
        'Cache-Control': {
          description: '`no-store`.',
          schema: { type: 'string' as const },
        },
        'Content-Length': { schema: { type: 'integer' as const } },
      },
    },
    ...bearerErrors,
    404: errorResponse(
      'The account has no such slot (`not_found`), or no account has the key (legacy).',
      ['not_found', 'unknown_account']
    ),
    ...upgradeRequired,
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})

export const backupDeleteDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Delete backups',
  description: `Deletes one slot, or every slot of the account when \`slotId\` is left out (before Delete Buddies replaces the account key). Gone from storage at once; idempotent.

A bearer request **and** a signed envelope: \`signature\` is the account key’s signature over \`ww-account/v1\\nbackup/delete\\n\` followed by the decoded \`payload\` bytes, and the key must be the token’s own account (\`forbidden\` otherwise), so a leaked token alone can’t delete backups. **Legacy** (no \`Authorization\` header): the envelope alone, while the legacy switch is on.

${readTier}

${ID_IN_BODY}`,
  security: bearerOrLegacy,
  requestBody: keySignedWith('backup/delete', {
    slotId: slotId.optional(),
  }),
  responses: {
    200: okOnly,
    ...bearerErrors,
    403: errorResponse(
      'The envelope is signed by another account than the token’s.',
      ['forbidden']
    ),
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
    ...upgradeRequired,
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})

// --- Sessions ----------------------------------------------------------------

const sessionsOff = {
  503: errorResponse(
    'Sessions are off on this worker (no accounts database or token secret).',
    ['disabled']
  ),
}

const sessionHash = sha256Hex(
  '`SHA-256(UTF-8("ww-account/v1/session\\n" + accountPub))`; `contentHash` and `requestHash` are both this'
)
const sessionInstallId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .meta({
    description:
      'The install id (`uuid`) the challenge was issued for; its App Attest key is pinned to it.',
  })
const sessionAttestationBinding = {
  uuid: sessionInstallId,
  contentHash: sessionHash,
  requestHash: sessionHash,
}
const appAttestSessionAttestation = z
  .object({
    ...appAttestV2AssertionFields(ACCOUNT_SESSION_PURPOSE),
    ...sessionAttestationBinding,
  })
  .meta({ title: 'App Attest v2 (iOS)' })
const playIntegritySessionAttestation = z
  .object({
    ...playIntegrityFields(ACCOUNT_SESSION_PURPOSE),
    ...sessionAttestationBinding,
  })
  .meta({ title: 'Play Integrity (Android)' })
const sessionOpenPayload = z.object({
  ...keyPayloadShape,
  attestation: z
    .union([appAttestSessionAttestation, playIntegritySessionAttestation])
    .optional()
    .meta({
      description:
        'The challenge request’s fields plus `challenge` and the assertion or integrity token (tables below). Required except with the development bypass.',
    }),
  device: b64u('The sealed device label, at most 512 characters').optional(),
})

/** `attestation_failed` and the attestation `bad_request`s carry these. */
const sessionAttestationErrorSchema = apiErrorSchema
  .extend({
    reason: z.string().optional().meta({
      description:
        'The attestation routes’ stable reason: `device_integrity_failed`, `app_not_recognized`, `integrity_token_invalid`, `integrity_unavailable`, a challenge reason (`challenge_not_found`, `challenge_expired`, `operation_conflict`), an App Attest key reason (`identity_not_bound`, `key_not_active`, `assertion_invalid`, `counter_not_increasing`), or `invalid_request` / `unsupported_protocol` on a 400.',
    }),
    action: z.string().optional().meta({
      description:
        'What to do next, as on the attestation routes: `none`, `retry`, `start_new_operation`, `bind`, …',
    }),
  })
  .meta({
    id: 'SessionAttestationError',
    description:
      'The accounts error envelope (`error` repeats `code`) plus the attestation’s `reason` and `action`.',
  })

/** Refresh tokens: `<sessionId>.<secret>`, b64u of 16 and 32 bytes. */
const refreshTokenSchema = (description: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    .meta({
      description: `${description}. Opaque to the app: the session’s id and a secret, \`<sessionId>.<secret>\` (base64url, 16 and 32 bytes); store and send it as is`,
    })

const tokenPair = {
  accessToken: z.string().meta({
    description:
      'A JWT (HS256) for `Authorization: Bearer`, opaque to the app. Keep it in memory only.',
  }),
  accessExpiresAt: epochMs('When the access token expires (15 minutes)'),
  refreshToken: refreshTokenSchema(
    'The session’s refresh token. Keep it in the platform keystore, not synced; each refresh replaces it'
  ),
  sessionExpiresAt: epochMs(
    'When the session ends (90 days after it opened; refreshing never extends it)'
  ),
}

const sessionDevBypassHeader = {
  name: 'x-ww-dev-bypass',
  in: 'header' as const,
  required: false,
  schema: { type: 'string' as const },
  description:
    'Development worker only: the `NOTES_IMPORT_DEV_BYPASS_TOKEN` secret, in place of `attestation` (platform `dev`). Production never sets the token, so the header is ignored there.',
}

export const sessionOpenDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Open a session',
  description: `The one place an account proves it’s the app. First get a challenge from \`POST /attestation/v1/challenge\` with \`purpose: "account-session"\` and both hashes set to the hash of \`accountPub\`: an App Attest v2 \`assert\` challenge on iOS (the install’s key, bound through \`POST /attestation/v1/register\`), or a Play Integrity v1 challenge on Android (\`attestationProvider: "play-integrity"\`). Then send this envelope, self-signed by the account key (op \`session/open\`) and carrying the answer: the signature covers the attestation and the attestation covers \`accountPub\`.

Creates the account when the key has none (it replaces \`account/register\`). A suspended account still gets a session (\`status: suspended\`). Opening an eleventh live session for an account ends its oldest. Answers 201 with \`Location: /accounts/v1/sessions/current\`, the session the new access token addresses.

\`device\` is the device’s label, sealed (Buddies \`seal\` format) under \`HKDF-SHA256(accountKey, "", "ww-account/v1/device", 32)\` with AAD \`"ww-account/v1/device\\n" + accountPub\`; the server stores it and can’t read it.

Limits: the Buddies register tier (60 a minute per caller IP) and 20 opens per account key a rolling day.`,
  parameters: [sessionDevBypassHeader],
  requestBody: jsonBody(
    signedEnvelopeSchema,
    `A signed envelope; \`signature\` is the account key’s signature over \`ww-account/v1\\nsession/open\\n\` followed by the decoded \`payload\` bytes.

**Decoded \`payload\`:**

${fieldTable(sessionOpenPayload)}

**\`attestation\`, App Attest v2 (iOS):**

${fieldTable(appAttestSessionAttestation)}

**\`attestation\`, Play Integrity (Android):**

${fieldTable(playIntegritySessionAttestation)}`
  ),
  responses: {
    201: {
      ...jsonResponse(
        'The session.',
        z.object({
          ok: z.literal(true),
          accountId,
          status,
          sessionId: buddiesId('The session'),
          ...tokenPair,
        })
      ),
      headers: {
        Location: {
          description: '`/accounts/v1/sessions/current`.',
          schema: { type: 'string' as const },
        },
      },
    },
    400: errorResponse(
      'Malformed envelope, payload, or attestation, or an attestation for another key or purpose.',
      ['bad_request'],
      sessionAttestationErrorSchema
    ),
    401: signatureErrors[401],
    403: errorResponse(
      'The attestation was refused. There’s no fallback: no attestation, no session.',
      ['attestation_failed'],
      sessionAttestationErrorSchema
    ),
    413: errorResponse('`device` is over 512 characters.', ['too_large']),
    429: errorResponse(
      'Over the per-caller rate, the account key’s 20 opens a day, or the install’s open challenges (`too_many_challenges`, `Retry-After: 300`).',
      ['rate_limited'],
      sessionAttestationErrorSchema
    ),
    ...internal,
    ...sessionsOff,
  },
})

export const sessionRefreshDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Refresh a session',
  description: `Plain JSON, no envelope: a new access token and a new refresh token, which replaces this one. Sending the refresh token just replaced again within 60 seconds (a lost response) gets a new pair; sending it later, or any older one, ends the session. An ended or expired session is \`unauthorized\`: open a new one, attesting again, without asking the User.

A \`POST\` on the \`sessions\` collection rather than the session itself, since the refresh token, not an id in the URL, names the session.

${readTier}`,
  requestBody: jsonBody(
    z.object({
      refreshToken: refreshTokenSchema('The session’s current refresh token'),
    })
  ),
  responses: {
    200: jsonResponse(
      'New tokens.',
      z.object({ ok: z.literal(true), ...tokenPair })
    ),
    400: errorResponse('Malformed JSON, or no `refreshToken`.', ['bad_request']),
    401: errorResponse(
      'Malformed, unknown, replaced, ended, or expired: open a new session. A replaced token presented after its minute, or any older one, also ends the session.',
      ['unauthorized']
    ),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...sessionsOff,
  },
})

export const sessionCloseDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Close the current session',
  description: `Ends the access token’s own session (\`current\`; there’s no other session id in a URL): its refresh token stops working at once, and the access token within 15 minutes. Idempotent. No body. The app calls it on sign out, before replacing the account key, and before Delete Buddies.

${readTier}`,
  security: [{ bearerAuth: [] }],
  responses: {
    200: okOnly,
    401: errorResponse('Missing, expired, or invalid token.', ['unauthorized']),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...sessionsOff,
  },
})
