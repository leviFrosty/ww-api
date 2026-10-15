import { z } from 'zod'
import { describeRoute } from 'hono-openapi'
import {
  staleErrorSchema,
  b64u,
  buddiesId,
  errorResponse,
  fieldTable,
  jsonBody,
  jsonResponse,
  signedBody,
  signedEnvelopeSchema,
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
    `A signed envelope; \`s\` is the account key’s signature over \`ww-account/v1\\n${op}\\n\` followed by \`p\`’s bytes.`
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
  ...signatureErrors,
  403: errorResponse('Another account opened this channel.', ['forbidden']),
  404: errorResponse(
    `${extra} Also \`unknown_account\` when no account has the signing key.`,
    ['not_found', 'unknown_account']
  ),
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

Limits: the Buddies register tier (60 a minute per caller IP) and 20 opens per account a rolling day.`,
  requestBody: keySignedWith('handoff/open', {
    channelId,
    verifier: b64u('`SHA-256(claimToken bytes)`, 32 bytes'),
  }),
  responses: {
    200: jsonResponse(
      'Opened.',
      z.object({ ok: z.literal(true), expiresAt })
    ),
    ...signatureErrors,
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
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

${readTier}`,
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

${readTier}`,
  requestBody: keySignedWith('handoff/status', { channelId }),
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

${readTier}`,
  requestBody: keySignedWith('handoff/send', {
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

${readTier}`,
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

${readTier}`,
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
  description: `Either phone ends the channel: the server deletes every blob at once and keeps only the status (\`cancelled\`) until the channel expires. Idempotent; a \`done\` channel stays \`done\`. The old phone sends a signed envelope (op \`handoff/cancel\`, payload \`channelId\` plus the key payload) and must be the opening account; the new phone sends plain JSON with \`claimToken\`.

${readTier}`,
  requestBody: jsonBody(
    z.union([signedEnvelopeSchema, z.object({ channelId, claimToken })]),
    'The old phone’s signed envelope, or the new phone’s `channelId` and `claimToken`.'
  ),
  responses: {
    200: okOnly,
    400: errorResponse('Malformed envelope, JSON, or field.', ['bad_request']),
    401: errorResponse(
      'Bad signature, stale `ts`, or a wrong `claimToken` (the fifth cancels the channel).',
      ['bad_signature', 'stale'],
      staleErrorSchema
    ),
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
  ) + `\n\nSigned over \`ww-account/v1\\n${op}\\n\` followed by \`p\`’s bytes.`

export const backupPutDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Upload a backup',
  description: `Replaces this device’s slot with an end-to-end encrypted backup (\`0x01 ‖ nonce[24] ‖ XChaCha20-Poly1305\`). The body is the raw blob, at most 20 MiB; the signed envelope (op \`backup/put\`) rides in the \`x-ww-p\` and \`x-ww-s\` headers.

**Decoded \`x-ww-p\`:**

${keyPayloadFields('backup/put', {
  slotId,
  size: z.number().int().min(1).meta({
    description:
      'The body’s exact length, at most 20 MiB. `Content-Length`, when sent, must match.',
  }),
  sha256: b64u('`SHA-256(body)`, 32 bytes'),
})}

Limits: 20 MiB a blob, 8 slots an account, one upload a slot a minute, and the Buddies photo-upload tier (60 a minute per caller IP). ${backupNotes}`,
  parameters: [
    {
      name: 'x-ww-p',
      in: 'header' as const,
      required: true,
      schema: { type: 'string' as const },
      description: 'The payload JSON, UTF-8 encoded, base64url.',
    },
    {
      name: 'x-ww-s',
      in: 'header' as const,
      required: true,
      schema: { type: 'string' as const },
      description: 'The account key’s Ed25519 signature, base64url.',
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
    401: signatureErrors[401],
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
    413: errorResponse(
      '`size`, `Content-Length`, or the streamed body is over 20 MiB.',
      ['too_large']
    ),
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
  description: `Every slot of the signing key’s account, for a restore.

${readTier} ${backupNotes}`,
  requestBody: keySignedWith('backup/list', {}),
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
    ...signatureErrors,
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})

export const backupGetDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Download a backup',
  description: `Streams one slot’s bytes exactly as uploaded.

${readTier}`,
  requestBody: keySignedWith('backup/get', { slotId }),
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
    ...signatureErrors,
    404: errorResponse(
      'The account has no such slot (`not_found`), or no account has the key.',
      ['not_found', 'unknown_account']
    ),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})

export const backupDeleteDocs = describeRoute({
  tags: ['Accounts'],
  summary: 'Delete backups',
  description: `Deletes one slot, or every slot of the account when \`slotId\` is left out (before Delete Buddies replaces the account key). Gone from storage at once; idempotent.

${readTier}`,
  requestBody: keySignedWith('backup/delete', {
    slotId: slotId.optional(),
  }),
  responses: {
    200: okOnly,
    ...signatureErrors,
    404: errorResponse('No account has this key; register first.', [
      'unknown_account',
    ]),
    429: errorResponse('Over the per-caller rate.', ['rate_limited']),
    ...internal,
    ...backupOff,
  },
})
