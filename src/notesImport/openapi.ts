import { z } from 'zod'
import { describeRoute } from 'hono-openapi'
import {
  apiErrorSchema,
  errorResponse,
  json,
  jsonBody,
  jsonResponse,
  rateLimitedResponse,
} from '../openapi/schemas'
import { notesImportResultValidator } from './schema'

/**
 * OpenAPI descriptions for the Notes Import routes (`src/notesImport/route.ts`).
 * Doc-only: the handlers keep their own parsing, so update this file with any
 * change to the wire contract.
 */

const TAG = 'Notes Import'

// --- Shared fields -------------------------------------------------------

const sha256Hex = (description: string) =>
  z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .meta({ description: `${description} (lowercase hex SHA-256)` })

const installId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .meta({
    description:
      'The install id (`uuid`). App Attest keys are pinned to it; usage is metered on it when no `accountId` is sent.',
  })

const accountId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .optional()
  .meta({
    description:
      'Optional shared account id. When present, Supporter status, allowances, the concurrency cap, and replay all key on it instead of `uuid`. A malformed value is a 400, never ignored.',
  })

const operationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/)
  .meta({
    description:
      'Client-chosen id for one challenge → request round trip. Reusing it with different data is `operation_conflict`.',
  })

const keyId = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .meta({
    description: 'The App Attest key id (standard base64 of 32 bytes).',
  })

const challenge = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .meta({
    description:
      'The one-time server challenge from `POST /notes-import/challenge` (43-character base64url). Consumed on use.',
  })

const purpose = z
  .enum([
    'notes-import-kickoff',
    'notes-import-verify',
    'notes-import-transcribe',
  ])
  .meta({
    description:
      'Which protected request the challenge is for. It must match the route that consumes it.',
  })

const expiresAt = z.number().int().meta({
  description: 'When the challenge expires (epoch ms; 5 minutes after issue).',
})

const playIntegrityProvider = z.literal('play-integrity').meta({
  description:
    'Opts the request into the Android Play Integrity path. Bodies without it take the App Attest path.',
})

const devBypassHeader = {
  name: 'x-ww-dev-bypass',
  in: 'header' as const,
  required: false,
  schema: { type: 'string' as const },
  description:
    'Development worker only: the `NOTES_IMPORT_DEV_BYPASS_TOKEN` secret. A match skips attestation and the RevenueCat check and uses the Supporter allowances. Production never sets the token, so the header is ignored there.',
}

// --- Shared bodies and responses ----------------------------------------

const creditsSchema = z
  .object({
    remaining: z.number().int().nullable().meta({
      description: 'Imports left in the current window; `null` is unlimited.',
    }),
    limit: z.number().int().nullable().meta({
      description: 'Imports allowed per window; `null` is unlimited.',
    }),
    resetsAt: z.string().nullable().meta({
      description:
        'When the current import window ends (ISO 8601). `null` before the first charged import or when unlimited.',
      format: 'date-time',
    }),
    isSupporter: z.boolean().meta({
      description:
        'The real RevenueCat entitlement. It never implies an allowance value (the dev bypass raises allowances without setting it).',
    }),
    refinements: z
      .object({
        remaining: z.number().int().nullable(),
        limit: z.number().int().nullable(),
      })
      .meta({
        description:
          'Refinements left and allowed for this content, a lifetime allowance per import; `null` is unlimited.',
      }),
  })
  .meta({
    id: 'NotesImportCredits',
    description:
      'Usage snapshot, shared by kickoff, `done`, the legacy response, and allowance denials.',
  })

const notesImportErrorSchema = apiErrorSchema
  .extend({
    detail: z.string().optional().meta({
      description:
        'On `unavailable`, why (`disabled`, `no_provider`, or an operator message). On the development worker, a debug detail for `server_error` and `model_error`.',
    }),
    reason: z.string().optional().meta({
      description:
        'Stable App Attest or Play Integrity reason, on attestation failures: `invalid_request`, `unsupported_protocol`, `operation_conflict`, `too_many_challenges`, `challenge_not_found`, `challenge_expired`, `identity_not_bound`, `key_not_active`, `recovery_not_enrolled`, `recovery_token_mismatch`, `attestation_invalid`, `assertion_invalid`, `counter_not_increasing`, `storage_unavailable`; Android adds `integrity_unavailable`, `integrity_token_invalid`, `app_not_recognized`, `device_integrity_failed`.',
    }),
    action: z
      .enum([
        'none',
        'retry',
        'request_challenge',
        'start_new_operation',
        'bind',
        'enroll_recovery',
        'use_active_key',
      ])
      .optional()
      .meta({
        description:
          'What the client should do next, beside `reason`. Transient failures never ask for key rotation.',
      }),
    credits: creditsSchema.optional().meta({
      description: 'On `limit_reached` and `refinement_limit`.',
    }),
  })
  .meta({
    id: 'NotesImportError',
    description:
      'The shared error envelope; `error` is a human-readable message. Attestation failures add `reason`/`action`, allowance denials add `credits`.',
  })

const niError = (description: string, codes: readonly string[]) =>
  errorResponse(description, codes, notesImportErrorSchema)

const V1_CODES = [
  'device_verification_failed',
  'assertion_failed',
  'challenge_expired',
  'counter_conflict',
] as const

const ATTESTATION_NOTE =
  'App Attest v1 (legacy) failures are always 401 with `device_verification_failed`, `assertion_failed`, `challenge_expired`, or `counter_conflict`, which never ask the client to rotate its key. App Attest v2 and Play Integrity failures are `attestation_failed` at the reason’s own status; branch on `reason`/`action`.'

const killSwitchUnavailable =
  '`unavailable`: the kill switch is off or no allowlisted model host is healthy (`detail` says which; `Retry-After: 60`). '

const storageUnavailable =
  '`server_error`: attestation storage or Google’s decode service is unavailable (`Retry-After: 30`).'

const attestationResponses = {
  401: niError(
    `Attestation failed: an unknown, consumed, or expired challenge, an invalid assertion or token, or an identity whose key isn’t bound or active. ${ATTESTATION_NOTE}`,
    ['attestation_failed', ...V1_CODES]
  ),
  403: niError(
    'Play Integrity only: the app isn’t the Play-distributed build (`app_not_recognized`) or the device fails the required integrity verdict (`device_integrity_failed`).',
    ['attestation_failed']
  ),
  409: niError(
    'App Attest v2 / Play Integrity: `operationId` was used with different data (`operation_conflict`), or the assertion’s sign count didn’t increase (`counter_not_increasing`). Start a new operation.',
    ['attestation_failed']
  ),
}

// --- Attested request fields --------------------------------------------

/** App Attest v2 assertion fields shared by verify, kickoff, and transcribe. */
const appAttestV2AssertionFields = (forPurpose: string) => ({
  protocolVersion: z.literal(2),
  operation: z.literal('assert'),
  operationId,
  keyId,
  purpose: z.literal(forPurpose),
  challenge,
  assertion: z.string().max(65_536).meta({
    description:
      'App Attest assertion (base64) over SHA-256 of the client data `witnesswork.app-attest|2|assert|<purpose>|<operationId>|<challenge>|<uuid>|<accountId or empty>|<contentHash>|<requestHash>`.',
  }),
})

/** Play Integrity fields shared by verify, kickoff, and transcribe. */
const playIntegrityFields = (forPurpose: string) => ({
  attestationProvider: playIntegrityProvider,
  protocolVersion: z.literal(1),
  operation: z.literal('assert'),
  operationId,
  purpose: z.literal(forPurpose),
  challenge,
  integrityToken: z.string().max(32_768).meta({
    description:
      'A Play Integrity standard-request token whose `requestHash` is the lowercase hex SHA-256 of `witnesswork.play-integrity|1|assert|<purpose>|<operationId>|<challenge>|<uuid>|<accountId or empty>|<contentHash>|<requestHash>`. Never send `keyId` or `assertion` with it.',
  }),
})

// --- GET /notes-import/status --------------------------------------------

const allowancePair = z.object({
  free: z.number().int().nullable(),
  supporter: z.number().int().nullable(),
})

const capabilitiesSchema = z.object({
  appAttest: z.object({
    protocolVersions: z.array(z.number().int()).meta({
      description: 'App Attest protocol versions accepted: `[1, 2]`.',
    }),
  }),
  playIntegrity: z
    .object({
      protocolVersions: z.array(z.number().int()).meta({
        description: 'Play Integrity protocol versions accepted: `[1]`.',
      }),
      cloudProjectNumber: z.string().meta({
        description:
          'The Google Cloud project number the app passes to the Play Integrity standard-request provider.',
      }),
    })
    .optional()
    .meta({
      description:
        'Present only when this worker can verify Android requests. Android keeps Notes Import closed while it is absent.',
    }),
  transcribe: z
    .object({
      maxPages: z
        .number()
        .int()
        .meta({ description: 'Pages per Import from Paper batch (10).' }),
      maxBytes: z.number().int().meta({
        description:
          'Largest decoded page image `POST /notes-import/transcribe` accepts.',
      }),
    })
    .meta({ description: 'Import from Paper limits.' }),
})

const statusSchema = z.object({
  available: z.boolean().meta({
    description:
      'Whether Notes Import can run. Advisory: the import routes enforce the same check themselves.',
  }),
  reason: z.string().optional().meta({
    description:
      'Only when unavailable: `disabled` (kill switch), `no_provider` (no healthy allowlisted host), or an operator-written message to show.',
  }),
  limits: z
    .object({
      imports: allowancePair.meta({
        description: 'Imports per window; `null` is unlimited.',
      }),
      refinements: allowancePair.meta({
        description: 'Refinements per import; `null` is unlimited.',
      }),
      windowDays: z.number().meta({
        description: 'Length of the import window in days (may be fractional).',
      }),
    })
    .optional()
    .meta({
      description:
        'The public allowance schedule. Omitted when unavailable, and when the provider probe failed open (available but unconfirmed).',
    }),
  capabilities: capabilitiesSchema,
  minAppVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional()
    .meta({
      description:
        'Oldest app version (`major.minor.patch`) that may use Notes Import. Older apps disable the composer and ask for an update; the worker does not enforce it. Omitted when no floor is set.',
    }),
})

export const statusDocs = describeRoute({
  tags: [TAG],
  summary: 'Availability, limits, and capabilities',
  description: `A cheap probe the app calls before showing its import entry points, so it can disable them before attesting. No attestation and no inference.

Availability checks the KV kill switch (\`notes-import:enabled\`) first, then whether any allowlisted model host is healthy on OpenRouter (a free metadata call, cached 60 seconds). Fails open: if the probe itself errors, the response says available without \`limits\`.

Completed responses are reused in each Worker isolate for up to 30 seconds (KV reads add up to 60 seconds more); the response itself is \`Cache-Control: no-store\`.`,
  responses: {
    200: jsonResponse('The current status.', statusSchema),
    ...rateLimitedResponse,
  },
})

// --- POST /notes-import/challenge ------------------------------------------

const challengeRequestSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(1).optional(),
    })
    .meta({
      title: 'App Attest v1 (legacy)',
      description:
        'An empty body, `{}`, or `{ "protocolVersion": 1 }`. Returns a bare challenge for a v1 attestation or assertion.',
    }),
  z
    .object({
      protocolVersion: z.literal(2),
      operation: z.enum(['bind', 'enroll']),
      operationId,
      uuid: installId,
      keyId,
    })
    .meta({
      title: 'App Attest v2 bind / enroll',
      description:
        'A challenge for `POST /notes-import/attest`: `bind` attests a new key, `enroll` adds a recovery token with the active key. No assertion fields allowed.',
    }),
  z
    .object({
      protocolVersion: z.literal(2),
      operation: z.literal('assert'),
      operationId,
      uuid: installId,
      keyId,
      purpose,
      accountId,
      contentHash: sha256Hex(
        'The content hash the protected request will carry'
      ),
      requestHash: sha256Hex(
        'The request hash the protected request will carry'
      ),
    })
    .meta({
      title: 'App Attest v2 assert',
      description:
        'A challenge bound to one protected request (verify, kickoff, or transcribe). The later request must repeat these values exactly.',
    }),
  z
    .object({
      attestationProvider: playIntegrityProvider,
      protocolVersion: z.literal(1),
      operation: z.literal('assert'),
      operationId,
      uuid: installId,
      accountId,
      purpose,
      contentHash: sha256Hex(
        'The content hash the protected request will carry'
      ),
      requestHash: sha256Hex(
        'The request hash the protected request will carry'
      ),
    })
    .meta({
      title: 'Play Integrity',
      description:
        'Android. Same binding as the App Attest v2 assert challenge, without `keyId`.',
    }),
])

const challengeResponseSchema = z.union([
  z.object({ challenge: z.string() }).meta({ title: 'App Attest v1 (legacy)' }),
  z
    .object({
      protocolVersion: z.literal(2),
      operation: z.enum(['bind', 'enroll', 'assert']),
      operationId,
      challenge,
      expiresAt,
    })
    .meta({ title: 'App Attest v2' }),
  z
    .object({
      attestationProvider: z.literal('play-integrity'),
      protocolVersion: z.literal(1),
      operation: z.literal('assert'),
      operationId,
      challenge,
      expiresAt,
    })
    .meta({ title: 'Play Integrity' }),
])

export const challengeDocs = describeRoute({
  tags: [TAG],
  summary: 'Issue an attestation challenge',
  description: `Step one of every attested call. Returns a one-time challenge (5-minute lifetime) for App Attest v1, App Attest v2 (\`bind\`, \`enroll\`, or \`assert\`), or Play Integrity.

v2 and Play Integrity challenges are bound to their request: the descriptor (operation, \`operationId\`, \`uuid\`, \`keyId\`, purpose, \`accountId\`, and both hashes) is stored, and the consuming request must match it. Re-requesting the same \`operationId\` with the same data returns the outstanding challenge. At most 32 unexpired challenges per install.

**Hashes.** \`contentHash\` is SHA-256 of \`notesText\` (kickoff), of the base64 \`image\` string as sent (transcribe), or any value the client picks (verify). \`requestHash\` is SHA-256 of the sorted-key canonical JSON \`{"context","notesText","refinement"}\` (kickoff; \`refinement\` is \`null\` when absent), of \`{"imageHash","mimeType"}\` (transcribe), or equal to \`contentHash\` (verify).`,
  requestBody: {
    required: false,
    description: 'Optional; an empty body asks for a v1 challenge.',
    content: json(challengeRequestSchema),
  },
  responses: {
    200: jsonResponse('A challenge.', challengeResponseSchema),
    400: niError(
      'Invalid JSON, an invalid challenge request (`reason: invalid_request`), or an unsupported `protocolVersion` (`reason: unsupported_protocol`). v2 requests the lifecycle rejects answer `attestation_failed`.',
      ['bad_request', 'attestation_failed']
    ),
    409: niError(
      '`operationId` was already used with different data (`operation_conflict`).',
      ['attestation_failed']
    ),
    429: niError(
      'Too many requests from this IP (`rate_limited`, `Retry-After: 60`), or 32 unexpired challenges for this install (`attestation_failed`, `reason: too_many_challenges`; Play Integrity sends `Retry-After: 300`).',
      ['rate_limited', 'attestation_failed']
    ),
    500: niError('Unexpected failure.', ['server_error']),
    503: niError(
      'Challenge storage is unavailable, or Play Integrity isn’t configured on this worker (`reason: integrity_unavailable`). `Retry-After: 30`.',
      ['server_error']
    ),
  },
})

// --- POST /notes-import/attest ---------------------------------------------

const recoveryToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .meta({
    description:
      'A 256-bit secret the app keeps (43-character base64url). Only a verifier is stored; it lets a reinstall or a new key take over the install id later.',
  })

const attestRequestSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(1).optional(),
      keyId: z.string(),
      attestation: z.string().meta({
        description: 'App Attest attestation object (base64).',
      }),
      challenge: z.string(),
      uuid: z.string(),
    })
    .meta({
      title: 'App Attest v1 (legacy)',
      description: 'Binds a key to the install id.',
    }),
  z
    .object({
      protocolVersion: z.literal(2),
      operation: z.literal('bind'),
      operationId,
      uuid: installId,
      keyId,
      challenge,
      attestation: z.string().meta({
        description:
          'App Attest attestation object (base64) whose client data hash is SHA-256 of `witnesswork.app-attest|2|bind|<operationId>|<challenge>|<uuid>|<tokenHash>`, where `tokenHash` is base64url SHA-256 of the decoded recovery token.',
      }),
      recoveryToken,
    })
    .meta({
      title: 'App Attest v2 bind',
      description:
        'Attests a key for the install id with a recovery token. Rebinding the same install to a new key requires the recovery token enrolled earlier.',
    }),
  z
    .object({
      protocolVersion: z.literal(2),
      operation: z.literal('enroll'),
      operationId,
      uuid: installId,
      keyId,
      challenge,
      assertion: z.string().max(65_536).meta({
        description:
          'Assertion by the active key over SHA-256 of `witnesswork.app-attest|2|enroll|<operationId>|<challenge>|<uuid>|<keyId>|<tokenHash>`.',
      }),
      recoveryToken,
    })
    .meta({
      title: 'App Attest v2 enroll',
      description:
        'Adds a recovery token to an install already bound by a legacy key.',
    }),
])

const attestResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).meta({ title: 'App Attest v1 (legacy)' }),
  z
    .object({
      ok: z.literal(true),
      protocolVersion: z.literal(2),
      operationId,
      status: z
        .enum(['bound', 'already_bound', 'rotated', 'recovery_enrolled'])
        .meta({
          description:
            '`bound`: first key; `already_bound`: this key was already active; `rotated`: a new key replaced the old one with the recovery token; `recovery_enrolled`: enroll succeeded.',
        }),
      recoveryEnrolled: z.boolean(),
    })
    .meta({ title: 'App Attest v2' }),
])

export const attestDocs = describeRoute({
  tags: [TAG],
  summary: 'Register an App Attest key',
  description: `iOS only. Binds a Secure Enclave key to the install id (v1 or v2 \`bind\`), or enrolls a v2 recovery token with the active key (\`enroll\`), using a challenge from \`POST /notes-import/challenge\`.

The attested App ID must be \`<team id>.<bundle id>\` for an accepted bundle id (the App Store app, plus the TestFlight Beta app on production); the key stays bound to the one it matched. Play Integrity has no registration step: a body with \`attestationProvider: "play-integrity"\` is a 400 with \`reason: unsupported_protocol\`.`,
  requestBody: jsonBody(attestRequestSchema),
  responses: {
    200: jsonResponse('Registered.', attestResponseSchema),
    400: niError(
      'Invalid JSON, missing fields, a Play Integrity body, or (v2) an invalid field or recovery token. Route-level checks answer `bad_request`; v2 checks in the lifecycle answer `attestation_failed` with `reason: invalid_request` or `unsupported_protocol`.',
      ['bad_request', 'attestation_failed']
    ),
    401: niError(
      `The challenge, attestation, or recovery token didn’t verify: \`challenge_not_found\`, \`challenge_expired\`, \`attestation_invalid\`, \`recovery_not_enrolled\` (\`action: enroll_recovery\`), \`recovery_token_mismatch\`, \`identity_not_bound\`. ${ATTESTATION_NOTE}`,
      ['attestation_failed', ...V1_CODES]
    ),
    409: niError(
      '`operationId` was already used with different data (`operation_conflict`).',
      ['attestation_failed']
    ),
    ...rateLimitedResponse,
    500: niError('Unexpected failure.', ['server_error']),
    503: niError('App Attest storage is unavailable. `Retry-After: 30`.', [
      'server_error',
    ]),
  },
})

// --- POST /notes-import/verify ---------------------------------------------

const verifyRequestSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(1).optional(),
      uuid: z.string(),
      accountId,
      keyId: z.string(),
      challenge: z.string(),
      assertion: z.string().meta({
        description:
          'Assertion over SHA-256 of `<challenge>|<uuid>|<contentHash>`, or `<challenge>|<uuid>|<accountId>|<contentHash>` when `accountId` is sent.',
      }),
      contentHash: sha256Hex('Any value the client picks'),
    })
    .meta({ title: 'App Attest v1 (legacy)' }),
  z
    .object({
      uuid: installId,
      accountId,
      ...appAttestV2AssertionFields('notes-import-verify'),
      contentHash: sha256Hex('Any value the client picks'),
      requestHash: sha256Hex('Must equal `contentHash`'),
    })
    .meta({ title: 'App Attest v2' }),
  z
    .object({
      uuid: installId,
      accountId,
      ...playIntegrityFields('notes-import-verify'),
      contentHash: sha256Hex('Any value the client picks'),
      requestHash: sha256Hex('Must equal `contentHash`'),
    })
    .meta({ title: 'Play Integrity' }),
])

const verifyResponseSchema = z.union([
  z
    .object({ ok: z.literal(true) })
    .meta({ title: 'App Attest v1 (or dev bypass)' }),
  z
    .object({
      ok: z.literal(true),
      protocolVersion: z.literal(2),
      operationId,
    })
    .meta({ title: 'App Attest v2' }),
  z
    .object({
      ok: z.literal(true),
      attestationProvider: z.literal('play-integrity'),
      protocolVersion: z.literal(1),
      operationId,
    })
    .meta({ title: 'Play Integrity' }),
])

export const verifyDocs = describeRoute({
  tags: [TAG],
  summary: 'Verify attestation (diagnostic)',
  description: `An attested no-op for the app’s developer tools. Runs the same verification as the metered routes, consuming the challenge and advancing the sign count, but touches no allowance and runs no model.

There is no payload, so \`requestHash\` must equal \`contentHash\` (v2 and Play Integrity), with purpose \`notes-import-verify\`. Not gated by the kill switch.`,
  parameters: [devBypassHeader],
  requestBody: jsonBody(verifyRequestSchema),
  responses: {
    200: jsonResponse('The attestation verified.', verifyResponseSchema),
    400: niError(
      'Invalid JSON, missing or malformed fields, `requestHash` ≠ `contentHash`, or an invalid v2 / Play Integrity request (`reason: invalid_request`).',
      ['bad_request', 'attestation_failed']
    ),
    ...attestationResponses,
    ...rateLimitedResponse,
    500: niError('Unexpected failure.', ['server_error']),
    503: niError(storageUnavailable, ['server_error']),
  },
})

// --- Import request (kickoff and legacy) -----------------------------------

const contextSchema = z
  .object({
    now: z.string().meta({
      description:
        'The user’s current time, ISO 8601 with offset (e.g. `2026-06-17T09:30:00-05:00`). Relative dates resolve against it.',
    }),
    timeZone: z
      .string()
      .meta({ description: 'IANA time zone, e.g. `America/Chicago`.' }),
    currentRole: z
      .enum([
        'publisher',
        'regularAuxiliary',
        'regularPioneer',
        'circuitOverseer',
        'specialPioneer',
        'custom',
      ])
      .optional()
      .meta({ description: 'The user’s current role, as context only.' }),
    existingContacts: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          address: z.string().optional(),
          phone: z.string().optional(),
        })
      )
      .meta({
        description:
          'Contacts the user already has, so visits attach to real ids instead of duplicates.',
      }),
    existingCategories: z
      .array(
        z.object({ id: z.string(), name: z.string(), isCredit: z.boolean() })
      )
      .meta({
        description:
          'Time categories the user already has, so entries reuse their ids.',
      }),
  })
  .meta({ description: 'What the model needs beyond the notes themselves.' })

const refinementSchema = z
  .object({
    previousResultJSON: z
      .string()
      .meta({ description: 'The earlier `result`, as a JSON string.' }),
    instruction: z
      .string()
      .meta({ description: 'The user’s correction, in their words.' }),
  })
  .optional()
  .meta({
    description:
      'Present to refine an earlier result of the same notes. Uses the refinement allowance instead of an import, and is its own run (the instruction is part of the import id).',
  })

const importBaseFields = {
  uuid: installId,
  accountId,
  notesText: z.string().meta({
    description: 'The notes to import, at most 100,000 characters by default.',
  }),
  context: contextSchema,
  refinement: refinementSchema,
}

const notesContentHash = sha256Hex(
  'SHA-256 of `notesText`. Recomputed by the worker; a mismatch is a 400'
)

const notesRequestHash = sha256Hex(
  'SHA-256 of the sorted-key canonical JSON `{"context","notesText","refinement"}` (`refinement: null` when absent). Recomputed by the worker; a mismatch is a 400'
)

const v1ImportFields = {
  protocolVersion: z.literal(1).optional(),
  keyId: z.string(),
  challenge: z.string(),
  assertion: z.string().meta({
    description:
      'Assertion over SHA-256 of `<challenge>|<uuid>|<contentHash>`, or `<challenge>|<uuid>|<accountId>|<contentHash>` when `accountId` is sent.',
  }),
  contentHash: notesContentHash.optional(),
}

const kickoffRequestSchema = z.union([
  z
    .object({ ...importBaseFields, ...v1ImportFields })
    .meta({ title: 'App Attest v1 (legacy)' }),
  z
    .object({
      ...importBaseFields,
      ...appAttestV2AssertionFields('notes-import-kickoff'),
      contentHash: notesContentHash,
      requestHash: notesRequestHash,
    })
    .meta({ title: 'App Attest v2' }),
  z
    .object({
      ...importBaseFields,
      ...playIntegrityFields('notes-import-kickoff'),
      contentHash: notesContentHash,
      requestHash: notesRequestHash,
    })
    .meta({ title: 'Play Integrity' }),
])

const successSchema = z
  .object({
    result: notesImportResultValidator.meta({
      id: 'NotesImportResult',
      description:
        'The structured import, validated against the model’s output schema (`NOTES_IMPORT_SCHEMA` in `src/notesImport/schema.ts`). Field descriptions are the instructions the model receives.',
    }),
    contentHash: sha256Hex('SHA-256 of the imported `notesText`'),
    refinement: z
      .boolean()
      .meta({ description: 'Whether this was a refinement.' }),
    emptyCharged: z.boolean().meta({
      description:
        'The run produced no records and still used an import, because the free Empty Import allowance (5 per 7 days by default) was spent. Treat absent as `false`.',
    }),
    credits: creditsSchema,
  })
  .meta({
    id: 'NotesImportSuccess',
    description:
      'A finished import. The same shape on the legacy response, the `done` event, and `/result`.',
  })

const importGateErrors = (legacy: boolean) => ({
  400: niError(
    legacy
      ? 'Invalid JSON; missing `uuid`, `notesText`, or `context`; an invalid `accountId`; `contentHash` doesn’t match `notesText`; or an App Attest v2 / Play Integrity body (`reason: unsupported_protocol`).'
      : 'Invalid JSON; missing `uuid`, `notesText`, or `context`; an invalid `accountId`; `contentHash` or `requestHash` doesn’t match the payload; or an invalid v2 / Play Integrity request (`reason: invalid_request`).',
    ['bad_request', 'attestation_failed']
  ),
  401: niError(
    `No App Attest credentials (\`attestation_required\`, \`action: bind\`), or attestation failed. ${ATTESTATION_NOTE}`,
    ['attestation_required', 'attestation_failed', ...V1_CODES]
  ),
  402: niError(
    'The import allowance for this window is used up. `credits` says when it resets; no `Retry-After`. Replays of already-imported content are free and never get this.',
    ['limit_reached']
  ),
  ...(legacy
    ? {}
    : {
        403: attestationResponses[403],
        409: attestationResponses[409],
      }),
  413: niError('`notesText` is over the character limit.', ['too_large']),
  429: niError(
    'Too many requests from this IP (`rate_limited`, `Retry-After: 60`); this content’s refinement allowance is used up (`refinement_limit`, with `credits`, no `Retry-After`; it never resets); or this user already has the maximum imports running (`active_cap`, 2 free / 5 Supporter by default, `Retry-After: 15`).',
    ['rate_limited', 'refinement_limit', 'active_cap']
  ),
})

const GATE_DESCRIPTION = `**Gate**, in order: the kill switch and provider health (503 \`unavailable\`), body checks, the content and request hashes, attestation (or the dev bypass), Supporter status from RevenueCat on \`accountId\` or \`uuid\` (an outage counts as free), then the allowance. Content already imported by this user replays without using an import; a refinement uses the per-content refinement allowance. An import is charged only when it succeeds.`

export const kickoffDocs = describeRoute({
  tags: [TAG],
  summary: 'Start a streaming import',
  description: `The attested, metered entry point. Starts the model run in a per-import Durable Object and returns at once with an \`importId\` and a \`subscribeToken\` for \`GET /notes-import/{importId}/events\`, \`/result\`, \`/cancel\`, and \`/destroy\`.

${GATE_DESCRIPTION}

The \`importId\` is derived from the user and the content (plus the refinement instruction), so kicking off the same notes again reconnects to the same run instead of starting another; a run that failed restarts. The subscribe token lasts 1 hour, and a finished result is kept for 1 hour.

\`credits\` is a point-in-time preview and may differ from the terminal snapshot on \`done\`.`,
  parameters: [devBypassHeader],
  requestBody: jsonBody(kickoffRequestSchema),
  responses: {
    200: jsonResponse(
      'The run is started (or already running, or finished).',
      z.object({
        importId: z
          .string()
          .regex(/^imp_[a-f0-9]{40}$/)
          .meta({
            description: 'The run’s id, stable per user and content.',
          }),
        subscribeToken: z.string().meta({
          description:
            'Capability for this import’s stream, result, cancel, and destroy routes (`?token=`). Expires after 1 hour.',
        }),
        refinement: z.boolean(),
        credits: creditsSchema,
      })
    ),
    ...importGateErrors(false),
    500: niError('The run could not be started.', ['server_error']),
    503: niError(`${killSwitchUnavailable}${storageUnavailable}`, [
      'unavailable',
      'server_error',
    ]),
  },
})

export const legacyImportDocs = describeRoute({
  tags: [TAG],
  summary: 'Import notes synchronously (legacy)',
  description: `The original path, kept as a fallback: holds the request open for the whole model run (often over a minute) and returns the result in one response. App Attest v1 only; v2 and Play Integrity bodies are refused (use \`POST /notes-import/kickoff\`).

${GATE_DESCRIPTION} The same concurrency cap as kickoff applies.`,
  deprecated: true,
  parameters: [devBypassHeader],
  requestBody: jsonBody(
    z
      .object({ ...importBaseFields, ...v1ImportFields })
      .meta({ title: 'App Attest v1' })
  ),
  responses: {
    200: jsonResponse('The finished import.', successSchema),
    ...importGateErrors(true),
    500: niError('Unexpected failure.', ['server_error']),
    502: niError('The model failed or returned an invalid result.', [
      'model_error',
    ]),
    503: niError(`${killSwitchUnavailable}${storageUnavailable}`, [
      'unavailable',
      'server_error',
    ]),
  },
})

// --- POST /notes-import/transcribe -----------------------------------------

const transcribeBaseFields = {
  uuid: installId,
  accountId,
  image: z.string().meta({
    description:
      'The page photo, standard base64 with padding. Its first bytes must match `mimeType`. At most 4 MiB decoded by default (`capabilities.transcribe.maxBytes`).',
  }),
  mimeType: z.enum(['image/jpeg', 'image/png']),
  contentHash: sha256Hex('SHA-256 of the `image` string as sent'),
  requestHash: sha256Hex(
    'SHA-256 of the sorted-key canonical JSON `{"imageHash":<contentHash>,"mimeType":<mimeType>}`'
  ),
}

export const transcribeDocs = describeRoute({
  tags: [TAG],
  summary: 'Read a photographed page',
  description: `Import from Paper: reads one page image into plain text with a vision model on the zero-data-retention allowlist. Nothing is stored. The app shows the text for editing, then imports it through \`POST /notes-import/kickoff\`, which is where an import is used.

App Attest v2 (purpose \`notes-import-transcribe\`) or Play Integrity only; v1 is a 400 with \`reason: unsupported_protocol\`. Gated by the kill switch. Pages are free but limited per user per rolling 24 hours (40 free, 200 Supporter by default), and a free user with no imports left is refused before any page is read.`,
  parameters: [devBypassHeader],
  requestBody: jsonBody(
    z.union([
      z
        .object({
          ...transcribeBaseFields,
          ...appAttestV2AssertionFields('notes-import-transcribe'),
        })
        .meta({ title: 'App Attest v2' }),
      z
        .object({
          ...transcribeBaseFields,
          ...playIntegrityFields('notes-import-transcribe'),
        })
        .meta({ title: 'Play Integrity' }),
    ])
  ),
  responses: {
    200: jsonResponse(
      'The page’s text.',
      z.object({
        ok: z.literal(true),
        text: z.string().meta({ description: 'The transcribed text.' }),
        truncated: z.boolean().meta({
          description: 'The model hit its output limit before finishing.',
        }),
        pagesRemaining: z.number().int().meta({
          description: 'Pages left in the rolling 24 hours.',
        }),
      })
    ),
    400: niError(
      'Invalid JSON; missing `uuid` or `image`; an unsupported `mimeType`; an invalid `accountId`; an image that isn’t base64 of the declared type; a hash mismatch; App Attest v1 (`reason: unsupported_protocol`); or an invalid v2 / Play Integrity request.',
      ['bad_request', 'attestation_failed']
    ),
    401: niError(`Attestation failed. ${ATTESTATION_NOTE}`, [
      'attestation_failed',
    ]),
    402: niError(
      'A free user with no imports left in this window (with `credits`).',
      ['limit_reached']
    ),
    403: attestationResponses[403],
    409: attestationResponses[409],
    413: niError('The decoded image is over the byte limit.', ['too_large']),
    429: niError(
      'Too many requests from this IP (`rate_limited`, `Retry-After: 60`), or the daily page limit is reached (`transcribe_limit`, `Retry-After` until the oldest page ages out).',
      ['rate_limited', 'transcribe_limit']
    ),
    500: niError('Unexpected failure.', ['server_error']),
    502: niError('The vision model couldn’t read the page.', ['model_error']),
    503: niError(`${killSwitchUnavailable}${storageUnavailable}`, [
      'unavailable',
      'server_error',
    ]),
  },
})

// --- Run routes (subscribe-token capability) ---------------------------------

const importIdParameter = {
  name: 'importId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const },
  description: 'The `importId` from kickoff.',
}

const tokenParameter = {
  name: 'token',
  in: 'query' as const,
  required: true,
  schema: { type: 'string' as const },
  description:
    'The `subscribeToken` from kickoff. It must have been issued for this `importId`; it expires after 1 hour.',
}

const runAuthErrors = {
  400: niError('Missing `token`.', ['bad_request']),
  401: niError(
    'The token is unknown, expired, or for another import. Kick off again for a fresh one.',
    ['attestation_required']
  ),
  ...rateLimitedResponse,
}

const RUN_AUTH =
  'Authorized by the kickoff’s `subscribeToken` instead of attestation: this route can’t spend inference.'

const importStatus = z
  .enum([
    'queued',
    'starting',
    'thinking',
    'structuring',
    'done',
    'error',
    'cancelled',
  ])
  .nullable()
  .meta({
    description:
      'The run’s state. `null` means no run exists: it was destroyed, or its 1-hour retention passed.',
  })

const failureSchema = z
  .object({
    code: z.string().meta({
      description:
        '`model_error` (the model failed or returned an invalid result), `interrupted` (the run stopped midway; kick off again), `server_error`, or `unknown`.',
    }),
    message: z.string(),
  })
  .meta({ description: 'Why the run failed.' })

const snapshotSchema = z.object({
  status: importStatus,
  payload: successSchema
    .optional()
    .meta({ description: 'Only when `status` is `done`.' }),
  error: failureSchema
    .optional()
    .meta({ description: 'Only when `status` is `error`.' }),
})

export const eventsDocs = describeRoute({
  tags: [TAG],
  summary: 'Stream import progress (SSE)',
  description: `A Server-Sent Events stream of one run. ${RUN_AUTH}

The stream replays the run’s persisted events after the resume cursor, then tails live until a terminal event, and closes. A run that has already finished (or doesn’t exist) replays and closes at once. Resume with the \`Last-Event-ID\` header (or \`lastEventId\` query parameter) set to the last \`id:\` seen; omit it to replay from the start. While live, a comment frame (\`:\`) every 15 seconds lets a client detect a dead connection.

Each frame has an \`event:\` line naming the type and a \`data:\` line with the event as JSON (including \`type\`). Persisted events also carry \`id: <seq>\`; \`reasoning\` and \`progress\` frames are cosmetic, have no \`id:\`, and are not replayed.

| \`event\` | \`data\` | Persisted |
| --- | --- | --- |
| \`status\` | \`{ "type": "status", "status": "starting" \\| "thinking" \\| "structuring" }\` | yes |
| \`reasoning\` | \`{ "type": "reasoning", "text": string }\`: a chunk of the model’s reasoning, when it emits any | no |
| \`progress\` | \`{ "type": "progress", "chars": number }\`: output length so far | no |
| \`done\` | \`{ "type": "done", "payload": <the legacy 200 body: result, contentHash, refinement, emptyCharged, credits> }\` | yes, terminal |
| \`error\` | \`{ "type": "error", "code": "model_error" \\| "interrupted" \\| "server_error", "message": string }\` | yes, terminal |
| \`cancelled\` | \`{ "type": "cancelled" }\` (never charged) | yes, terminal |

The stream is for showing progress; the result is read only from \`done\` or \`GET /notes-import/{importId}/result\`.`,
  parameters: [
    importIdParameter,
    tokenParameter,
    {
      name: 'Last-Event-ID',
      in: 'header' as const,
      required: false,
      schema: { type: 'string' as const },
      description: 'Resume after this event `seq`.',
    },
    {
      name: 'lastEventId',
      in: 'query' as const,
      required: false,
      schema: { type: 'string' as const },
      description:
        'The same cursor, for clients that can’t set headers. The header wins.',
    },
  ],
  responses: {
    200: {
      description:
        'The event stream (`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`).',
      content: {
        'text/event-stream': {
          schema: { type: 'string' as const },
          example:
            'id: 1\nevent: status\ndata: {"type":"status","status":"starting"}\n\nevent: progress\ndata: {"type":"progress","chars":512}\n\nid: 3\nevent: done\ndata: {"type":"done","payload":{...}}\n\n',
        },
      },
    },
    ...runAuthErrors,
  },
})

export const resultDocs = describeRoute({
  tags: [TAG],
  summary: 'Get an import’s result',
  description: `The run’s current state and, once finished, its result, for a client that reconnects after the stream closed or missed the terminal event. ${RUN_AUTH} Results are kept for 1 hour after the run ends.`,
  parameters: [importIdParameter, tokenParameter],
  responses: {
    200: jsonResponse('The run’s snapshot.', snapshotSchema),
    ...runAuthErrors,
  },
})

export const cancelDocs = describeRoute({
  tags: [TAG],
  summary: 'Cancel a running import',
  description: `Stops a queued or running import: aborts the model call, frees the concurrency slot, and ends the stream with \`cancelled\`. A cancelled run is never charged. ${RUN_AUTH}

No-op once the run has ended. If the run is already settling its result, cancel waits and returns \`done\` instead. Used by the app’s “edit & resend” flow.`,
  parameters: [importIdParameter, tokenParameter],
  responses: {
    200: jsonResponse('The run’s snapshot after the cancel.', snapshotSchema),
    ...runAuthErrors,
  },
})

export const destroyDocs = describeRoute({
  tags: [TAG],
  summary: 'Delete an import',
  description: `Forgets a run now instead of after its retention: aborts any model call (uncharged), frees the concurrency slot, closes the stream, and deletes all stored state, the result included. Idempotent. ${RUN_AUTH} Backs the history view’s delete.`,
  parameters: [importIdParameter, tokenParameter],
  responses: {
    200: jsonResponse('Deleted.', z.object({ ok: z.literal(true) })),
    ...runAuthErrors,
  },
})
