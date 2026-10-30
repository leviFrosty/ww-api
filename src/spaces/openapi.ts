import { z } from 'zod'
import { describeRoute, type DescribeRouteOptions } from 'hono-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  apiErrorSchema,
  b64u,
  buddiesId,
  errorResponse,
  jsonBody,
  jsonResponse,
} from '../openapi/schemas'
import { BUDDIES_ABUSE_LIMITS } from '../buddies/limits'
import {
  SPACES_ERROR_STATUS,
  SPACES_HEADERS,
  SPACES_LIMITS,
  SPACES_LIVE_CLOSE,
  type SpacesErrorCode,
  type SpacesOp,
} from './contracts'

/**
 * OpenAPI descriptions for Shared Spaces (`/spaces/v1`). The wire contract
 * is witness-work's `docs/shared-cars-protocol.md`; the schemas below are
 * for readers only and mirror `SPACES_FIELD_PARSERS` in contracts.ts, which
 * stays the authority. Update both together.
 *
 * Like Buddies ops, every op is `POST /spaces/v1/{op}` rather than a
 * resource path, on purpose: space ids, member ids, and member tokens
 * travel in the body (the live socket's in a header), never the URL, which
 * Cloudflare and Sentry record.
 */

type Responses = NonNullable<DescribeRouteOptions['responses']>

const TAGS = ['Shared Spaces']

const describeOp = (options: DescribeRouteOptions) =>
  describeRoute({ tags: TAGS, security: [{ bearerAuth: [] }], ...options })

const KIB = 1_024
const count = (n: number) => n.toLocaleString('en-US')
const paragraphs = (...parts: string[]) => parts.join('\n\n')

// --- Fields -----------------------------------------------------------------

const spaceId = buddiesId('The space')
const memberId = buddiesId('Your member id in this space')
const inviteId = buddiesId('The invite')
const bytes32 = (description: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .meta({ description: `${description} (43-character base64url, 32 bytes)` })
const token = bytes32(
  'Your member token; the server compares its SHA-256 with your stored hash'
)
const tokenHash = bytes32('`b64u(SHA-256(token))` of your member token')
const dhPub = bytes32(
  'Your X25519 public key for this space, which `memberId` must commit to: `memberId` = `b64u(SHA-256("ww-spaces/v1/member-id|" + spaceId + "|" + dhPub)[0..16])`'
)
const wrap = b64u(
  `The epoch's space key wrapped to you, opaque to the server (at most ${SPACES_LIMITS.wrapBytes} bytes decoded)`
)
const seq = z.number().int().min(0).meta({
  description:
    'The space’s change counter: every stored record takes the next one, and so does every join, leave, removal, invite change, and rekey.',
})
const epoch = z.number().int().min(1).meta({
  description: 'The space’s key epoch (1, 2, …).',
})
const epochMs = (description: string) =>
  z.number().int().meta({ description: `${description}, epoch milliseconds.` })
const joinedAt = epochMs('When you joined, by the server’s clock')

const memberShape = { spaceId, memberId, token }

const okSchema = z.object({ ok: z.literal(true) })

// --- Refusals ---------------------------------------------------------------

const tier = (name: 'read' | 'write' | 'unsigned') =>
  `${count(BUDDIES_ABUSE_LIMITS.edge[name].perMinute)} a minute per account in the Buddies ${name} tier`

const DEFAULT_REASONS: Partial<Record<SpacesErrorCode, string>> = {
  bad_request: 'Malformed JSON, ids, tokens, or fields.',
  too_large: `A body over ${SPACES_LIMITS.requestBytes / KIB} KiB, declared or streamed.`,
  unauthorized:
    'The access token is missing, expired, or invalid (`WWW-Authenticate: Bearer error="invalid_token"`). Refresh once and resend.',
  forbidden: 'Your member token is wrong.',
  gone: 'The space was deleted, or you aren’t on it (you left or were removed). Make your personal copy and drop the space.',
  disabled:
    'Shared Spaces is off (KV `spaces:enabled`, then the `SPACES_ENABLED` var), or this worker has no account sessions. `Retry-After: 60`.',
}

const SUSPENDED =
  'The session’s account is suspended, and this op reaches other people. Reading, leaving, removing, rekeying, and deleting still work. From the account’s status, cached up to 30 s.'

const STATUS_SUMMARY: Record<number, string> = {
  400: 'Bad request.',
  401: 'Not authenticated.',
  403: 'Forbidden.',
  404: 'Not found.',
  409: 'Conflict.',
  410: 'Gone.',
  413: 'Too large.',
  426: 'Upgrade required.',
  429: 'Too many requests, or a cap was hit.',
  503: 'Switched off.',
}

const RETRY_AFTER_HEADER = {
  'Retry-After': {
    description:
      'Seconds to wait; repeated as `retryAfter` in the body. Absent on `limit`.',
    schema: { type: 'integer' as const },
  },
}

/** An op's error responses by status, each code with why this op returns it. */
const refusals = (
  reasons: Partial<Record<SpacesErrorCode, string | true>>
): Responses => {
  const byStatus = new Map<number, SpacesErrorCode[]>()
  for (const code of Object.keys(reasons) as SpacesErrorCode[]) {
    const status = SPACES_ERROR_STATUS[code]
    byStatus.set(status, [...(byStatus.get(status) ?? []), code])
  }
  const responses: Responses = {}
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    const lines = codes.map((code) => {
      const reason = reasons[code]
      return `- \`${code}\`: ${reason === true ? DEFAULT_REASONS[code] : reason}`
    })
    const response = errorResponse(
      `${STATUS_SUMMARY[status]}\n\n${lines.join('\n')}`,
      codes,
      apiErrorSchema
    )
    responses[status] =
      status === 429 || status === 503
        ? { ...response, headers: RETRY_AFTER_HEADER }
        : response
  }
  responses[500] = errorResponse(
    'Unexpected failure. The body never names the request.',
    ['internal']
  )
  return responses
}

const NO_SESSIONS =
  'This worker has no account sessions (`Retry-After: 60`). The kill switch doesn’t apply to this op.'

/**
 * What every member op can answer, before its own refusals. An op the kill
 * switch spares still answers `disabled` on a worker without sessions.
 */
const memberRefusals = (
  edge: 'read' | 'write',
  { killSwitch = true } = {}
): Partial<Record<SpacesErrorCode, string | true>> => ({
  bad_request: true,
  unauthorized: true,
  forbidden: true,
  gone: true,
  too_large: true,
  rate_limited: `More than ${tier(edge)} (\`Retry-After: 60\`).`,
  disabled: killSwitch ? true : NO_SESSIONS,
})

const OWNER_ONLY = 'Your member token is wrong, or you aren’t the owner.'
const KILL_SWITCH_EXEMPT =
  'Works while Shared Spaces is off, so people can always leave.'
const NO_SUPPORTER = 'Free: there’s no Supporter check.'

// --- Ops --------------------------------------------------------------------

const recordView = z.object({
  recordId: z.string().meta({ description: 'The record’s id.' }),
  epoch,
  stamp: epochMs('The version’s `updatedAt`, or when it was deleted'),
  deleted: z.boolean(),
  blob: b64u('The sealed record, exactly as put'),
  seq: z.number().int().meta({ description: 'When this version was stored.' }),
})

const syncSchema = z.object({
  ok: z.literal(true),
  seq: z.number().int().meta({
    description:
      'The space’s head; when `more`, the last returned record’s `seq` instead: sync again from it.',
  }),
  epoch,
  wrap: b64u('Your own wrap of the current epoch’s key'),
  ownerId: buddiesId('The owner’s member id'),
  members: z
    .array(
      z.object({
        memberId: z.string(),
        dhPub: z.string().meta({
          description:
            'Their X25519 public key; check it against `memberId` before wrapping a key to it.',
        }),
        joinedAt: epochMs('When they joined'),
      })
    )
    .meta({ description: 'Always the complete list, earliest first.' }),
  invites: z
    .array(
      z.object({
        inviteId: z.string(),
        invitedBy: z.string().meta({ description: 'The inviter’s member id.' }),
        expiresAt: epochMs('When it lapses'),
      })
    )
    .meta({ description: 'Always the complete list of open invites.' }),
  rekeyNeeded: z.boolean().meta({
    description:
      'A member left or was removed since the current epoch began. Only the owner acts on it.',
  }),
  records: z.array(recordView).meta({
    description: `The current version of every record with \`seq > since\`, in \`seq\` order, up to \`limit\`. A page also stops once its blobs pass ${SPACES_LIMITS.syncChars / KIB / KIB} MiB of text.`,
  }),
  more: z.boolean().meta({
    description: 'More records are waiting: sync again from `seq`.',
  }),
})

const putRecord = z.object({
  recordId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).meta({
    description: 'The record’s id (`^[A-Za-z0-9._-]{1,64}$`).',
  }),
  epoch: epoch.meta({ description: 'Must be the space’s current epoch.' }),
  stamp: epochMs(
    'The version’s `updatedAt` (or deletion time); at most 24 h past the server’s clock'
  ),
  deleted: z.boolean().optional().meta({ description: 'Default false.' }),
  blob: b64u(
    `The sealed record, at most ${SPACES_LIMITS.blobBytes / KIB} KiB decoded`
  ),
})

export const spacesOpDocs: Record<SpacesOp, MiddlewareHandler> = {
  create: describeOp({
    summary: 'Create a space',
    description: paragraphs(
      'Makes the space at epoch 1 with the caller as its only member and owner. The server stores `dhPub`, `tokenHash`, and `wrap`, never the session’s account.',
      'An identical retry (same `memberId`, `dhPub`, `tokenHash`, and `wrap`) on a space nothing has changed since gets the same answer again, and doesn’t count against the daily creates again.',
      `Limits: ${count(SPACES_LIMITS.spacesPerDay)} spaces per account a rolling day, and ${tier('write')}. ${NO_SUPPORTER}`
    ),
    requestBody: jsonBody(
      z.object({ spaceId, memberId, dhPub, tokenHash, wrap }),
      'The new space and its first member.'
    ),
    responses: {
      200: jsonResponse(
        'Created.',
        z.object({ ok: z.literal(true), seq: seq.meta({ description: 'Always 1.' }), joinedAt })
      ),
      ...refusals({
        bad_request: 'Malformed fields, or `memberId` doesn’t match `dhPub`.',
        unauthorized: true,
        suspended: SUSPENDED,
        too_large: true,
        conflict: '`spaceId` already exists, and this isn’t an identical retry.',
        gone: 'The space was deleted; its id can’t be used again.',
        rate_limited: `Over ${tier('write')}, or ${SPACES_LIMITS.spacesPerDay} spaces a rolling day (\`Retry-After\` until the oldest ages out).`,
        disabled: true,
      }),
    },
  }),
  sync: describeOp({
    summary: 'Read what changed',
    description: paragraphs(
      'The current version of every record stored after `since`, the complete members and open invites, the owner, the epoch, your own wrap, and whether the owner should rekey. Touches the space’s last activity: a space is deleted after 400 days without a `sync` or `put`.',
      `Limits: ${tier('read')}.`
    ),
    requestBody: jsonBody(
      z.object({
        ...memberShape,
        since: z.number().int().min(0).meta({
          description: 'The last `seq` this device synced through; 0 for everything.',
        }),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SPACES_LIMITS.syncRecords)
          .optional()
          .meta({ description: `Records a page; default ${count(SPACES_LIMITS.syncRecords)}.` }),
      })
    ),
    responses: {
      200: jsonResponse('The changes.', syncSchema),
      ...refusals(memberRefusals('read')),
    },
  }),
  put: describeOp({
    summary: 'Store records',
    description: paragraphs(
      'Stores each record unless the space holds a version of it with a higher `stamp`. On an equal `stamp` a deletion wins, then the lower SHA-256 of the decoded blob (compared as bytes). Each stored record takes the next `seq`, and the space’s live sockets hear `changed`.',
      '`results` lists `{ recordId, stored }` in order. `stored: false` means a newer version is already there, which the next `sync` returns; resending the version the space already holds is `stored: true` and takes no new `seq`.',
      'Reserved ids: `m.<memberId>` is that member’s alone, and `k.<x>` (the key chain) the owner’s. A put naming one of someone else’s is `forbidden`, and nothing in it is stored.',
      `Limits: ${count(SPACES_LIMITS.putRecords)} records and ${SPACES_LIMITS.putBytes / KIB / KIB} MiB a put, ${SPACES_LIMITS.blobBytes / KIB} KiB a blob, ${count(SPACES_LIMITS.records)} records and ${SPACES_LIMITS.spaceBytes / KIB / KIB} MiB of decoded blobs a space (deletions included), ${SPACES_LIMITS.memberPuts} puts a minute per member (a \`forbidden\` or \`stale_key\` put doesn’t count), ${count(SPACES_LIMITS.spaceRecordsPerDay)} records a rolling day per space, and ${tier('write')}.`
    ),
    requestBody: jsonBody(
      z.object({
        ...memberShape,
        records: z.array(putRecord).min(1).max(SPACES_LIMITS.putRecords),
      })
    ),
    responses: {
      200: jsonResponse(
        'Stored.',
        z.object({
          ok: z.literal(true),
          seq: seq.meta({ description: 'The space’s head after the put.' }),
          results: z.array(
            z.object({ recordId: z.string(), stored: z.boolean() })
          ),
        })
      ),
      ...refusals({
        ...memberRefusals('write'),
        bad_request:
          'Malformed fields, or a `stamp` more than 24 h past the server’s clock.',
        forbidden:
          'Your member token is wrong, or a record is someone else’s `m.<memberId>`, or a `k.<x>` and you aren’t the owner; nothing was stored.',
        suspended: `${SUSPENDED} Keep the changes and put them once a put succeeds.`,
        stale_key:
          'A record is sealed under an epoch that isn’t current; nothing was stored. Sync, open your new wrap, and seal again.',
        too_large: `A blob over ${SPACES_LIMITS.blobBytes / KIB} KiB, more than ${SPACES_LIMITS.putRecords} records, or a body over ${SPACES_LIMITS.putBytes / KIB / KIB} MiB.`,
        limit: `The put would take the space past ${count(SPACES_LIMITS.records)} records or ${SPACES_LIMITS.spaceBytes / KIB / KIB} MiB of decoded blobs.`,
        rate_limited: `Over ${tier('write')}, ${SPACES_LIMITS.memberPuts} puts a minute for this member, or ${count(SPACES_LIMITS.spaceRecordsPerDay)} records a rolling day for the space (\`Retry-After\`).`,
      }),
    },
  }),
  'invite/create': describeOp({
    summary: 'Open an invite',
    description: paragraphs(
      'Any member opens an invite for one of their buddies, at the current epoch: the one whose key the invitation carries. The server keeps who made it and `joinVerifier`, never the secret. Sending the same invite again (a lost answer) is a no-op while it’s open. The invite closes when it’s used, deleted, burned, or expires, when its inviter leaves, at any removal, and at a rekey; its id can’t be opened again.',
      `Limits: members plus open invites at most KV \`spaces:maxMembers\` (default ${SPACES_LIMITS.defaultMaxMembers}), and ${tier('write')}.`
    ),
    requestBody: jsonBody(
      z.object({
        ...memberShape,
        inviteId,
        joinVerifier: bytes32('`b64u(SHA-256(joinSecret))`'),
        expiresAt: epochMs('When it lapses: in the future and at most 7 days (plus 5 minutes) away'),
        epoch: epoch.meta({
          description: 'The epoch of the key the invitation carries; must be current.',
        }),
      })
    ),
    responses: {
      200: jsonResponse('Open.', okSchema),
      ...refusals({
        ...memberRefusals('write'),
        suspended: SUSPENDED,
        stale_key:
          '`epoch` isn’t current: sync, open your new wrap, and create the invite again.',
        conflict:
          '`inviteId` is already used for another invite, or was closed, used, or burned before it expired.',
        limit: 'Members plus open invites are at the cap.',
      }),
    },
  }),
  'invite/delete': describeOp({
    summary: 'Close an invite',
    description: paragraphs(
      'Its inviter or the owner closes an open invite. Idempotent: an unknown, used, or expired invite is already closed, so any member gets `ok` and nothing changes.',
      `Limits: ${tier('write')}.`
    ),
    requestBody: jsonBody(z.object({ ...memberShape, inviteId })),
    responses: {
      200: jsonResponse('Closed.', okSchema),
      ...refusals({
        ...memberRefusals('write'),
        forbidden:
          'Your member token is wrong, or the invite is open and you’re neither its inviter nor the owner.',
      }),
    },
  }),
  join: describeOp({
    summary: 'Join with an invite',
    description: paragraphs(
      'Checks `SHA-256(joinSecret)` against the invite’s verifier in constant time; five wrong secrets burn the invite. `epoch` (the invitation’s) must be the space’s current one, so nobody joins with a key for another epoch. On success the caller becomes a member with its own public key, token hash, and wrap, and the invite is used.',
      'A retry with the same `joinSecret`, `memberId`, `dhPub`, and `tokenHash` from someone still on the space (a lost answer), whatever its `epoch`, is `ok` again, with the space’s head and current epoch and the original `joinedAt`. Any other join by a current member is `conflict`.',
      `Limits: ${tier('unsigned')}. ${NO_SUPPORTER}`
    ),
    requestBody: jsonBody(
      z.object({
        spaceId,
        inviteId,
        joinSecret: bytes32('The invite’s join secret, from `car.invite`'),
        epoch: epoch.meta({
          description: 'The invitation’s epoch, from `car.invite`; a fresh join’s must be current.',
        }),
        memberId,
        dhPub,
        tokenHash,
        wrap: wrap.meta({
          description:
            'The current epoch’s key wrapped to you (base64url, no padding)',
        }),
      })
    ),
    responses: {
      200: jsonResponse(
        'Joined.',
        z.object({ ok: z.literal(true), seq, epoch, joinedAt })
      ),
      ...refusals({
        bad_request: 'Malformed fields, or `memberId` doesn’t match `dhPub`.',
        unauthorized: true,
        too_large: true,
        forbidden:
          'Wrong `joinSecret`; the fifth wrong one burns the invite.',
        suspended: SUSPENDED,
        not_found:
          'Unknown, expired, closed, used, or burned invite; an invite whose inviter is no longer on the space; or a space that never existed.',
        conflict: '`memberId` is already on the space, and this isn’t an identical retry.',
        stale_key:
          '`epoch` isn’t the space’s current one, and this isn’t an identical retry: nobody joined.',
        gone: 'The space was deleted.',
        limit: 'Members plus open invites are past the cap (it was lowered).',
        rate_limited: `More than ${tier('unsigned')} (\`Retry-After: 60\`).`,
        disabled: true,
      }),
    },
  }),
  leave: describeOp({
    summary: 'Leave the space',
    description: paragraphs(
      'Deletes your token hash, public key, and wrap, and closes the invites you made that nobody used; your live sockets close with `4001 "gone"`. When the owner leaves, the member who joined first becomes owner. When no member is left, the space is deleted. The owner should rekey afterwards (`rekeyNeeded`).',
      `${KILL_SWITCH_EXEMPT} Limits: ${tier('write')}.`
    ),
    requestBody: jsonBody(z.object(memberShape)),
    responses: {
      200: jsonResponse('Left.', okSchema),
      ...refusals(memberRefusals('write', { killSwitch: false })),
    },
  }),
  'member/remove': describeOp({
    summary: 'Remove a member (owner)',
    description: paragraphs(
      'Deletes `removeId`’s token hash, public key, and wrap; their live sockets close with `4001 "gone"` and their next request is `gone`. Closes every open invite, not only theirs, so they can’t come back through another member’s invitation before the rekey; inviters send theirs again after it. Idempotent: an unknown `removeId` is `ok` and changes nothing. The owner can’t remove themselves: they leave or delete instead. Rekey afterwards (`rekeyNeeded`).',
      `${KILL_SWITCH_EXEMPT} Limits: ${tier('write')}.`
    ),
    requestBody: jsonBody(
      z.object({ ...memberShape, removeId: buddiesId('The member to remove') })
    ),
    responses: {
      200: jsonResponse('Removed.', okSchema),
      ...refusals({
        ...memberRefusals('write', { killSwitch: false }),
        bad_request: 'Malformed fields, or `removeId` is you.',
        forbidden: OWNER_ONLY,
      }),
    },
  }),
  rekey: describeOp({
    summary: 'Move to a new key epoch (owner)',
    description: paragraphs(
      'Sets the next epoch with a wrap of its key for every current member, exactly, and closes every open invite (their inviters send them again with the new key). Puts sealed under the old epoch get `stale_key` from now on.',
      'In the same step it stores `link` as the record `k.<epoch>` at the new epoch, at a `seq` of its own after the rekey’s, replacing any version of `k.<epoch>` the space holds whatever its stamp (so a link planted ahead of time can’t block it). The link is checked as a `put` record is, and counts toward the space’s record and byte caps but not the put rates.',
      `Limits: ${SPACES_LIMITS.blobBytes / KIB} KiB for the link’s blob, and ${tier('write')}.`
    ),
    requestBody: jsonBody(
      z.object({
        ...memberShape,
        epoch: epoch.meta({ description: 'The current epoch plus one.' }),
        wraps: z
          .array(z.object({ memberId: buddiesId('A current member'), wrap }))
          .max(SPACES_LIMITS.maxMembersCeiling)
          .meta({
            description:
              'One per current member (the owner included), no more. A list that misses anyone, an empty one included, is `conflict`.',
          }),
        link: z
          .object({
            stamp: epochMs(
              'The link’s `stamp`; at most 24 h past the server’s clock'
            ),
            blob: b64u(
              `The record \`k.<epoch>\`: the previous epoch’s key sealed under the new one, at most ${SPACES_LIMITS.blobBytes / KIB} KiB decoded`
            ),
          })
          .meta({
            description:
              'The key chain’s link for the new epoch, stored as the record `k.<epoch>`.',
          }),
      })
    ),
    responses: {
      200: jsonResponse(
        'Rekeyed.',
        z.object({
          ok: z.literal(true),
          seq: seq.meta({ description: 'The space’s head: the link’s `seq`.' }),
        })
      ),
      ...refusals({
        ...memberRefusals('write'),
        bad_request:
          'Malformed fields, `epoch` below 2, `wraps` naming a member twice, or a link `stamp` more than 24 h past the server’s clock.',
        too_large: `The link’s blob is over ${SPACES_LIMITS.blobBytes / KIB} KiB, or the body over ${SPACES_LIMITS.requestBytes / KIB} KiB.`,
        forbidden: OWNER_ONLY,
        conflict:
          '`wraps` misses a current member or names someone who isn’t on the space: membership changed, so sync and try again.',
        stale_key: '`epoch` isn’t the current one plus one: sync and try again.',
        limit: `Storing the link would take the space past ${count(SPACES_LIMITS.records)} records or ${SPACES_LIMITS.spaceBytes / KIB / KIB} MiB of decoded blobs.`,
      }),
    },
  }),
  delete: describeOp({
    summary: 'Delete the space (owner)',
    description: paragraphs(
      'Wipes the space: records, members, wraps, and invites. Every live socket closes with `4001 "gone"`, and every later request is `gone`.',
      `${KILL_SWITCH_EXEMPT} Limits: ${tier('write')}.`
    ),
    requestBody: jsonBody(z.object(memberShape)),
    responses: {
      200: jsonResponse('Deleted.', okSchema),
      ...refusals({
        ...memberRefusals('write', { killSwitch: false }),
        forbidden: OWNER_ONLY,
      }),
    },
  }),
}

const { gone, replaced } = SPACES_LIVE_CLOSE

export const spacesLiveDocs = describeOp({
  summary: 'Live socket (WebSocket)',
  description: paragraphs(
    'Upgrades to a WebSocket that says *that* the space changed, so the app syncs at once while in the foreground. It never carries content.',
    `Headers: \`Authorization: Bearer <access token>\`, \`Upgrade: websocket\`, \`${SPACES_HEADERS.live}\`: \`b64u(UTF-8 JSON { spaceId, memberId })\` (at most ${count(SPACES_LIMITS.liveHeaderChars)} characters), and \`${SPACES_HEADERS.liveToken}\`: \`b64u(token)\`, since an upgrade has no body and ids never go in URLs. Their names hold "auth" and "token" so Cloudflare’s logs redact them. The Worker passes the upgrade on without \`Authorization\`.`,
    '**Server → app messages:**\n\n- `{"type":"hello","seq":N}` right after the upgrade, `N` being the space’s head; sync when it’s past your cursor.\n- `{"type":"changed","seq":N}` after every put that stored something, join, leave, removal, rekey, and invite change, to every socket on the space (the writing device’s included).',
    '**Keepalive:** send the text `ping` about every 25 s; the server answers `pong` without waking the space. Anything else the app sends is ignored.',
    `**Close codes:** \`${gone.code} "${gone.reason}"\` the space was deleted, or you left or were removed; \`${replaced.code} "${replaced.reason}"\` a socket past the cap opened on the space (${SPACES_LIMITS.liveSocketsPerMember} per member the cap allows, so ${SPACES_LIMITS.liveSocketsPerMember * SPACES_LIMITS.defaultMaxMembers} at ${SPACES_LIMITS.defaultMaxMembers}) and closed this one: the opener’s own oldest when they already held ${SPACES_LIMITS.liveSocketsPerMember} or more, else the oldest of whichever member holds the most, so one member can’t push the others off. Reconnect with backoff while in the foreground; after \`${replaced.code}\`, wait at least a minute.`,
    `Limits: ${tier('read')}. Turning Shared Spaces off refuses new sockets but doesn’t close open ones.`
  ),
  parameters: [
    {
      name: 'Upgrade',
      in: 'header' as const,
      required: true,
      schema: { type: 'string' as const, enum: ['websocket'] },
      description: 'Must be `websocket`, else `426 upgrade_required`.',
    },
    {
      name: SPACES_HEADERS.live,
      in: 'header' as const,
      required: true,
      schema: { type: 'string' as const },
      description: '`b64u(UTF-8 JSON { spaceId, memberId })`: the space and your member id.',
    },
    {
      name: SPACES_HEADERS.liveToken,
      in: 'header' as const,
      required: true,
      schema: { type: 'string' as const },
      description: '`b64u(token)`: your member token (43 characters).',
    },
  ],
  responses: {
    101: { description: 'Switching protocols: the socket is open.' },
    ...refusals({
      bad_request: `Missing or malformed \`${SPACES_HEADERS.live}\` or \`${SPACES_HEADERS.liveToken}\`.`,
      unauthorized: true,
      forbidden: true,
      gone: true,
      upgrade_required: 'Not a WebSocket upgrade. No `Retry-After`.',
      rate_limited: `More than ${tier('read')} (\`Retry-After: 60\`).`,
      disabled: true,
    }),
  },
})
