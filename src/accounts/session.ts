import type { AppContext } from '../types'
import { isPlainObject } from '../buddies/contracts'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import { ACCOUNT_LIMITS, parseRefreshToken } from './contracts'
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
import { closeSession, createSession, refreshSession } from './sessionStore'
import {
  accessTokenKeys,
  refreshKeys,
  signAccessToken,
  type AccessTokenKeys,
} from './tokens'
import type { SessionPlatform } from './schema'

/**
 * Attested sessions (witness-work ADR 0027, `docs/accounts-protocol.md`,
 * "Sessions"): an account proves it's the app once, when it opens a session
 * (`POST /accounts/v1/sessions`, attested through `/attestation/v1/challenge`
 * under purpose `account-session`), and then calls with 15-minute access
 * tokens it renews with `POST /accounts/v1/sessions/refresh`. Every route
 * answers `disabled` without the accounts database or a token secret, so the
 * worker never hands out a session it can't verify.
 *
 * Limits: opening counts against the Buddies register edge tier and 20 per
 * account key a rolling day; refreshing and closing against the read tier.
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
 * attested for it (or the development bypass). Creates the account when the
 * key has none, opens a session, and ends the account's oldest past ten.
 * 201, with `Location` naming the session the new token addresses.
 */
const handleOpen = guarded('session/open', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/register')
  if (limited) return limited

  const verified = await verifiedBody(c, 'session/open')
  if ('refusal' in verified) return verified.refusal
  const { accountPub } = verified.payload
  const { attestation, device } = verified.fields

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

  let platform: SessionPlatform = 'dev'
  if (!isSessionDevBypass(c)) {
    const attested = await verifySessionAttestation(c, attestation, accountPub)
    if (!attested.ok) return attested.response
    platform = attested.platform
  }

  const db = accountsDb(setup.db)
  const account = await registerAccount(db, accountPub, newAccountId)
  const { session, refreshToken } = await createSession(
    db,
    setup.keys.current,
    { accountId: account.id, platform, device }
  )
  return c.json(
    {
      ok: true,
      accountId: account.id,
      status: account.status,
      sessionId: session.id,
      ...(await issueTokens(setup.keys, session, refreshToken)),
    },
    201,
    { Location: CURRENT_SESSION_PATH }
  )
})

/**
 * `POST /sessions/refresh`: plain JSON `{ refreshToken }`, replaced every
 * time. A malformed token, or one whose MAC doesn't verify, is 401 before
 * any database read.
 */
const handleRefresh = guarded('session/refresh', async (c) => {
  const setup = await ready(c)
  if ('refusal' in setup) return setup.refusal
  const limited = await refuseAtEdge(c, 'inbox/sync')
  if (limited) return limited

  const body = await readPlainJson(c)
  if (!isPlainObject(body) || typeof body.refreshToken !== 'string')
    return buddiesErrorResponse('bad_request')
  const token = parseRefreshToken(body.refreshToken)
  if (!token) return buddiesErrorResponse('unauthorized')
  const issued = await refreshSession(
    accountsDb(setup.db),
    refreshKeys(setup.keys),
    token
  )
  if (!issued) return buddiesErrorResponse('unauthorized')
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

export const sessionHandlers = {
  open: handleOpen,
  refresh: handleRefresh,
  close: handleClose,
}
