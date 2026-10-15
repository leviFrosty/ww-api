import { Hono } from 'hono'
import type { AppContext, Environment } from '../types'
import { Sentry } from '../sentry'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import { BUDDIES_LIMITS, decodeSignature } from '../buddies/contracts'
import {
  parseEnvelope,
  readEnvelopeText,
  verifyEd25519,
} from '../buddies/envelope'
import {
  buddiesErrorResponse,
  buddiesInternalError,
} from '../buddies/errorResponse'
import {
  allowBuddiesCaller,
  buddiesCallerKey,
  EDGE_RETRY_AFTER_SECONDS,
  logLimitHit,
} from '../buddies/limits'
import {
  type AccountKeyPayload,
  type AccountsOp,
  accountSignedMessage,
  parseAccountKeyPayload,
} from './contracts'
import { accountsDb, findAccountInfo, registerAccount } from './store'
import { accountInfoDocs, accountRegisterDocs } from './openapi'

const randomAccountId = (): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))

const quotaName = async (callerKey: string): Promise<string> =>
  bytesToBase64Url(
    await sha256Bytes(
      new TextEncoder().encode(`ww-account/v1/register-caller\n${callerKey}`)
    )
  )

/**
 * The caller's rolling-day registration quota, shared in kind with Buddies'
 * `inbox/register` (a DO per caller, under its own name). Null admits; a quota
 * outage admits too.
 */
const refuseOverQuota = async (
  env: Environment,
  callerKey: string
): Promise<Response | null> => {
  try {
    const quota = env.BUDDY_REGISTRATION_QUOTA
    const admission = await quota
      .get(quota.idFromName(await quotaName(callerKey)))
      .admit(Date.now())
    if (admission.ok) return null
    logLimitHit('account/register', 'registrationsPerDay')
    return buddiesErrorResponse('rate_limited', {
      retryAfterSeconds: admission.retryAfterSeconds,
    })
  } catch (error) {
    console.warn('accounts: registration quota unavailable; allowing')
    Sentry.captureException(error)
    return null
  }
}

/**
 * The payload of a self-signed account op, after the envelope, its signature
 * by the named key, and its timestamp check out; otherwise the refusal.
 */
const verifiedKeyPayload = async (
  c: AppContext,
  op: AccountsOp
): Promise<{ payload: AccountKeyPayload } | { refusal: Response }> => {
  const text = await readEnvelopeText(c.req.raw)
  const envelope = text == null ? null : parseEnvelope(text)
  const payload = envelope ? parseAccountKeyPayload(envelope.payload) : null
  if (!envelope || !payload)
    return { refusal: buddiesErrorResponse('bad_request') }
  const signature = decodeSignature(envelope.signature)
  if (!signature) return { refusal: buddiesErrorResponse('bad_signature') }
  if (Math.abs(Date.now() - payload.ts) > BUDDIES_LIMITS.timestampSkewMs)
    return { refusal: buddiesErrorResponse('stale') }
  const valid = await verifyEd25519(
    payload.accountPub,
    accountSignedMessage(op, envelope.payloadBytes),
    signature
  )
  return valid
    ? { payload }
    : { refusal: buddiesErrorResponse('bad_signature') }
}

/**
 * `POST /accounts/v1/account/register`: the account for a signing key, created
 * on first use. Self-signed, like `inbox/register`, and idempotent: the same
 * key always gets the same `accountId`, so a replay learns nothing new. It
 * counts against the register edge tier and the caller's daily quota.
 *
 * Privacy: nothing here logs or reports the body, the key, or the account id.
 */
const handleRegister = async (c: AppContext): Promise<Response> => {
  try {
    if (!c.env.ACCOUNTS_DB) return buddiesErrorResponse('disabled')
    const callerKey = buddiesCallerKey(c.req.header('CF-Connecting-IP'))
    if (!(await allowBuddiesCaller(c.env, 'inbox/register', callerKey)))
      return buddiesErrorResponse('rate_limited', {
        retryAfterSeconds: EDGE_RETRY_AFTER_SECONDS,
      })

    const verified = await verifiedKeyPayload(c, 'account/register')
    if ('refusal' in verified) return verified.refusal
    const { payload } = verified

    const refused = await refuseOverQuota(c.env, callerKey)
    if (refused) return refused

    const account = await registerAccount(
      accountsDb(c.env.ACCOUNTS_DB),
      payload.accountPub,
      randomAccountId
    )
    return c.json({ ok: true, accountId: account.id, status: account.status })
  } catch (error) {
    console.error('accounts: request failed', { op: 'account/register' })
    Sentry.captureException(error)
    return buddiesInternalError()
  }
}

/**
 * `POST /accounts/v1/account/info`: what the database holds for the signing
 * key's own account, for the app's developer tools. Read-only and self-signed,
 * so only the account key's holder can read it; it never creates an account
 * (an unknown key is 404 `unknown_account`). Counts against the read edge tier.
 *
 * Privacy: nothing here logs or reports the body, the key, or the account id.
 */
const handleInfo = async (c: AppContext): Promise<Response> => {
  try {
    if (!c.env.ACCOUNTS_DB) return buddiesErrorResponse('disabled')
    const callerKey = buddiesCallerKey(c.req.header('CF-Connecting-IP'))
    if (!(await allowBuddiesCaller(c.env, 'inbox/sync', callerKey)))
      return buddiesErrorResponse('rate_limited', {
        retryAfterSeconds: EDGE_RETRY_AFTER_SECONDS,
      })

    const verified = await verifiedKeyPayload(c, 'account/info')
    if ('refusal' in verified) return verified.refusal
    const { payload } = verified

    const info = await findAccountInfo(
      accountsDb(c.env.ACCOUNTS_DB),
      payload.accountPub
    )
    if (!info) return buddiesErrorResponse('unknown_account')
    const { id, ...rest } = info
    return c.json({ ok: true, accountId: id, ...rest })
  } catch (error) {
    console.error('accounts: request failed', { op: 'account/info' })
    Sentry.captureException(error)
    return buddiesInternalError()
  }
}

/** Mounted at `/accounts/v1` by the Worker entry point. */
export const createAccountsRoutes = () => {
  const routes = new Hono<{ Bindings: Environment }>()
  routes.post('/account/register', accountRegisterDocs, handleRegister)
  routes.post('/account/info', accountInfoDocs, handleInfo)
  return routes
}
