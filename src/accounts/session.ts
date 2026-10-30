import type { AppContext } from '../types'
import { BUDDIES_ID_PATTERN, isPlainObject } from '../buddies/contracts'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import {
  ACCOUNT_LIMITS,
  parseAppVersion,
  parseRefreshToken,
  type AccountFields,
  type AccountKeyPayload,
} from './contracts'
import { authenticateAccount, readPlainJson } from './auth'
import { isSessionDevBypass, verifySessionAttestation } from './attestation'
import {
  guarded,
  quotaName,
  refuseAtEdge,
  refuseOverDailyQuota,
  verifiedBody,
} from './signed'
import { accountsDb, newAccountId, registerAccount } from './store'
import {
  closeSession,
  isSessionLive,
  createSession,
  listLiveSessions,
  prepareSession,
  refreshSession,
  repeatSession,
  revokeSession,
  type IssuedSession,
  type RefreshRefusal,
} from './sessionStore'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import { credentialHash, openTicket, passkeyTokensReady } from './passkeyTokens'
import {
  accountPasskeys,
  batchUsingToken,
  findPasskeyAccountByPub,
  findUsedToken,
  usedTokenInsert,
} from './passkeyStore'
import {
  accessTokenKeys,
  refreshKeys,
  signAccessToken,
  type AccessTokenKeys,
} from './tokens'
import type { AccountStatus, SessionPlatform } from './schema'

/**
 * Attested sessions (witness-work ADR 0027, `docs/accounts-protocol.md`,
 * "Sessions"): an account proves it's the app once, when it opens a session
 * (`POST /accounts/v1/sessions`, attested through `/attestation/v1/challenge`
 * under purpose `account-session`), and then calls with 15-minute access
 * tokens it renews with `POST /accounts/v1/sessions/refresh`. Every route
 * answers `disabled` without the accounts database or a token secret, so the
 * worker never hands out a session it can't verify.
 *
 * `GET /sessions` lists the account's live sessions (Settings → Account →
 * Devices) and `POST /sessions/revoke` ends one from another (ADR 0028);
 * every session that opens or ends is logged to the account's activity.
 *
 * A browser opens a web session with a ticket in place of the attestation
 * (witness-work `docs/passkeys-protocol.md`, "Web sessions"): from a passkey
 * sign-in, a phone's approval, or a recovery key. Web sessions slide (180
 * days from their last refresh) and have their own cap of 3.
 *
 * Limits: opening counts against the Buddies register edge tier and 20 per
 * account key a rolling day; everything else against the read tier.
 *
 * Privacy: nothing here logs or reports bodies, keys, tokens, account ids, or
 * session ids.
 */

/** The session a bearer token addresses: its own. */
export const CURRENT_SESSION_PATH = '/accounts/v1/sessions/current'

type Ready = { db: D1Database; keys: AccessTokenKeys } | { refusal: Response }

const ready = async (c: AppContext): Promise<Ready> => {
  const db = c.env.ACCOUNTS_DB
  const keys = db ? await accessTokenKeys(c.env) : null
  return db && keys
    ? { db, keys }
    : { refusal: buddiesErrorResponse('disabled') }
}

/** The tokens opening and refreshing a session hand back. */
const issueTokens = async (
  keys: AccessTokenKeys,
  session: {
    id: string
    accountId: string
    platform: SessionPlatform
    expiresAt: number
  },
  refreshToken: string
) => {
  const access = await signAccessToken(keys, {
    accountId: session.accountId,
    sessionId: session.id,
    platform: session.platform,
    sessionExpiresAt: session.expiresAt,
  })
  return { ...access, refreshToken, sessionExpiresAt: session.expiresAt }
}

/**
 * `POST /sessions`: self-signed by the account key (op `session/open`) and
 * attested for it (or the development bypass), or a browser's `ticket` in
 * place of the attestation. Creates the account when the key has none
 * (never with a ticket), opens a session, and ends the account's oldest past
 * the cap. 201, with `Location` naming the session the new token addresses.
 */
const handleOpen = guarded('session/open', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/register')
  if (limited) return limited

  const verified = await verifiedBody(c, 'session/open')
  if ('refusal' in verified) return verified.refusal
  const { accountPub } = verified.payload
  const { fields } = verified
  const { attestation, device } = fields

  // Before the attestation, so failed attempts spend the quota too. Keyed on
  // the key, which names one account, so a new account has one as well.
  const overQuota = await refuseOverDailyQuota(
    c.env,
    await quotaName('session-open', accountPub),
    ACCOUNT_LIMITS.sessionOpensPerDay,
    'session/open',
    'sessionOpensPerDay'
  )
  if (overQuota) return overQuota

  if (fields.ticket != null)
    return openWithTicket(c, setup, verified.payload, fields)

  let platform: SessionPlatform = 'dev'
  if (!isSessionDevBypass(c)) {
    const attested = await verifySessionAttestation(c, attestation, accountPub)
    if (!attested.ok) return attested.response
    platform = attested.platform
  }

  const db = accountsDb(setup.db)
  const account = await registerAccount(db, accountPub, newAccountId)
  const issued = await createSession(db, setup.keys.current, {
    accountId: account.id,
    platform,
    device,
    method: platform === 'dev' ? 'dev' : 'attestation',
    appVersion: fields.appVersion,
  })
  return opened(c, setup.keys, account, issued)
})

/** 201 with the new session's tokens, as every way of opening answers. */
const opened = async (
  c: AppContext,
  keys: AccessTokenKeys,
  account: { id: string; status: AccountStatus },
  issued: IssuedSession
) =>
  c.json(
    {
      ok: true,
      accountId: account.id,
      status: account.status,
      sessionId: issued.session.id,
      platform: issued.session.platform,
      ...(await issueTokens(keys, issued.session, issued.refreshToken)),
    },
    201,
    { Location: CURRENT_SESSION_PATH }
  )

const encoder = new TextEncoder()

/** What a ticket's open is recognized by when it's repeated: the key and nonce. */
const openRequestHash = async (payload: AccountKeyPayload): Promise<string> =>
  bytesToBase64Url(
    await sha256Bytes(
      encoder.encode(`ww-account/v1/ticket-open\n${payload.accountPub}\n${payload.nonce}`)
    )
  )

/**
 * A web session from a ticket: the ticket must be this worker's, unexpired,
 * and for `accountPub`'s account, which must exist (a ticket never creates
 * one). An `approval` ticket's phone session must still be live. Its id is
 * recorded as used in the session's own batch, with the request's hash, so
 * the same signed request again within the ticket's 2 minutes (a lost
 * response) gets the same session, a new access token, and the same refresh
 * token (or, if that one was refreshed in the last minute, the token it was
 * replaced by: `repeatSession`); any other use is `ticket_invalid`.
 */
const openWithTicket = async (
  c: AppContext,
  setup: { db: D1Database; keys: AccessTokenKeys },
  payload: AccountKeyPayload,
  fields: AccountFields<'session/open'>
): Promise<Response> => {
  if (!(await passkeyTokensReady(c.env))) return buddiesErrorResponse('disabled')
  const invalid = () => buddiesErrorResponse('ticket_invalid')
  const claims = await openTicket(c.env, fields.ticket)
  if (!claims) return invalid()
  const db = accountsDb(setup.db)
  const account = await findPasskeyAccountByPub(db, payload.accountPub)
  if (!account || account.id !== claims.accountId) return invalid()
  const requestHash = await openRequestHash(payload)

  const repeat = async (): Promise<Response> => {
    const used = await findUsedToken(db, claims.id)
    if (!used || used.sessionId == null || used.requestHash !== requestHash)
      return invalid()
    const issued = await repeatSession(db, refreshKeys(setup.keys), {
      accountId: account.id,
      sessionId: used.sessionId,
    })
    return issued ? opened(c, setup.keys, account, issued) : invalid()
  }
  if (await findUsedToken(db, claims.id)) return repeat()

  // An approval opens a session only while the phone that approved is
  // still signed in.
  if (
    claims.kind === 'approval' &&
    !(await isSessionLive(db, account.id, claims.actorSessionId!))
  )
    return invalid()

  // A passkey ticket's credential must still be the account's.
  let stepUpCredentialId: string | null = null
  if (claims.kind === 'passkey') {
    for (const passkey of await accountPasskeys(db, account.id)) {
      if ((await credentialHash(passkey.credentialId)) === claims.credentialHash)
        stepUpCredentialId = passkey.credentialId
    }
    if (!stepUpCredentialId) return invalid()
  }

  const { statements, issued } = await prepareSession(db, setup.keys.current, {
    accountId: account.id,
    platform: 'web',
    device: fields.device,
    method: claims.kind,
    appVersion: fields.appVersion,
    actorSessionId: claims.actorSessionId ?? null,
    stepUpCredentialId,
  })
  const result = await batchUsingToken(db, claims.id, () =>
    db.batch([
      usedTokenInsert(db, {
        id: claims.id,
        expiresAt: claims.expiresAt,
        sessionId: issued.session.id,
        requestHash,
      }),
      ...statements,
    ])
  )
  if ('used' in result) return repeat()
  return opened(c, setup.keys, account, issued)
}

/** 401 `unauthorized` with why (`REFRESH_REFUSALS`). */
const refusedRefresh = (reason: RefreshRefusal): Response =>
  buddiesErrorResponse('unauthorized', { extras: { reason } })

/**
 * `POST /sessions/refresh`: plain JSON `{ refreshToken, appVersion? }`,
 * replaced every time. A malformed token, or one whose MAC doesn't verify,
 * is 401 before any database read. A refusal carries `reason`.
 */
const handleRefresh = guarded('session/refresh', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/sync')
  if (limited) return limited

  const body = await readPlainJson(c)
  if (!isPlainObject(body) || typeof body.refreshToken !== 'string')
    return buddiesErrorResponse('bad_request')
  const appVersion = parseAppVersion(body.appVersion)
  if (appVersion === undefined) return buddiesErrorResponse('bad_request')
  const token = parseRefreshToken(body.refreshToken)
  if (!token) return refusedRefresh('unknown')
  const outcome = await refreshSession(
    accountsDb(setup.db),
    refreshKeys(setup.keys),
    token,
    Date.now(),
    appVersion
  )
  if ('refused' in outcome) return refusedRefresh(outcome.refused)
  const { issued } = outcome
  return c.json({
    ok: true,
    ...(await issueTokens(setup.keys, issued.session, issued.refreshToken)),
  })
})

/** `DELETE /sessions/current`: Bearer, no body. Ends the token's session; idempotent. */
const handleClose = guarded('session/close', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/sync')
  if (limited) return limited
  const auth = await authenticateAccount(c)
  if (!auth.ok) return auth.response
  await closeSession(
    accountsDb(setup.db),
    auth.account.accountId,
    auth.account.sessionId
  )
  return c.json({ ok: true })
})

/**
 * `GET /sessions`: Bearer. The account's live sessions, newest first. A
 * caller whose own session has ended is 401, so it never shows a list
 * without itself.
 */
const handleList = guarded('session/list', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/sync')
  if (limited) return limited
  const auth = await authenticateAccount(c, { requireLiveSession: true })
  if (!auth.ok) return auth.response
  const { accountId, sessionId } = auth.account
  const sessions = await listLiveSessions(accountsDb(setup.db), accountId)
  return c.json({
    ok: true,
    sessions: sessions.map((session) => ({
      ...session,
      current: session.sessionId === sessionId,
    })),
  })
})

/**
 * `POST /sessions/revoke`: Bearer, `{ sessionId }`. Ends one of the account's
 * sessions (the session id stays out of the URL). 404 `not_found` for a
 * session the account doesn't have. A caller whose own session has ended is
 * 401, before the body is read or, when two devices revoke each other at
 * once, in the same statements as the revoke.
 */
const handleRevoke = guarded('session/revoke', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/sync')
  if (limited) return limited
  const auth = await authenticateAccount(c, { requireLiveSession: true })
  if (!auth.ok) return auth.response
  const body = await readPlainJson(c)
  if (
    !isPlainObject(body) ||
    typeof body.sessionId !== 'string' ||
    !BUDDIES_ID_PATTERN.test(body.sessionId)
  )
    return buddiesErrorResponse('bad_request')
  const outcome = await revokeSession(accountsDb(setup.db), {
    accountId: auth.account.accountId,
    sessionId: body.sessionId,
    bySessionId: auth.account.sessionId,
  })
  if (outcome === 'not_found') return buddiesErrorResponse('not_found')
  if (outcome === 'caller_ended') return buddiesErrorResponse('unauthorized')
  return c.json({ ok: true })
})

export const sessionHandlers = {
  open: handleOpen,
  refresh: handleRefresh,
  close: handleClose,
  list: handleList,
  revoke: handleRevoke,
}
