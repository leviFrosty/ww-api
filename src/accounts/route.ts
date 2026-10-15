import { Hono } from 'hono'
import type { AppContext, Environment } from '../types'
import { Sentry } from '../sentry'
import { bytesToBase64Url } from '../crypto'
import {
  buddiesErrorResponse,
  buddiesInternalError,
} from '../buddies/errorResponse'
import { buddiesCallerKey } from '../buddies/limits'
import { accountsDb, findAccountInfo, registerAccount } from './store'
import {
  quotaName,
  refuseAtEdge,
  refuseOverDailyQuota,
  verifiedBody,
} from './signed'
import { handoffHandlers } from './handoff'
import { backupHandlers } from './backup'
import {
  accountInfoDocs,
  accountRegisterDocs,
  backupDeleteDocs,
  backupGetDocs,
  backupListDocs,
  backupPutDocs,
  handoffCancelDocs,
  handoffClaimDocs,
  handoffDoneDocs,
  handoffOpenDocs,
  handoffReceiveDocs,
  handoffSendDocs,
  handoffStatusDocs,
} from './openapi'

const randomAccountId = (): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))

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
    const limited = await refuseAtEdge(c, 'inbox/register')
    if (limited) return limited

    const verified = await verifiedBody(c, 'account/register')
    if ('refusal' in verified) return verified.refusal
    const { payload } = verified

    // The caller's rolling-day registration quota, shared in kind with
    // Buddies' `inbox/register` (a DO per caller, under its own name).
    const callerKey = buddiesCallerKey(c.req.header('CF-Connecting-IP'))
    const refused = await refuseOverDailyQuota(
      c.env,
      await quotaName('register-caller', callerKey),
      undefined,
      'account/register',
      'registrationsPerDay'
    )
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
    const limited = await refuseAtEdge(c, 'inbox/sync')
    if (limited) return limited

    const verified = await verifiedBody(c, 'account/info')
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
  routes.post('/handoff/open', handoffOpenDocs, handoffHandlers.open)
  routes.post('/handoff/claim', handoffClaimDocs, handoffHandlers.claim)
  routes.post('/handoff/status', handoffStatusDocs, handoffHandlers.status)
  routes.post('/handoff/send', handoffSendDocs, handoffHandlers.send)
  routes.post('/handoff/receive', handoffReceiveDocs, handoffHandlers.receive)
  routes.post('/handoff/done', handoffDoneDocs, handoffHandlers.done)
  routes.post('/handoff/cancel', handoffCancelDocs, handoffHandlers.cancel)
  routes.post('/backup/put', backupPutDocs, backupHandlers.put)
  routes.post('/backup/list', backupListDocs, backupHandlers.list)
  routes.post('/backup/get', backupGetDocs, backupHandlers.get)
  routes.post('/backup/delete', backupDeleteDocs, backupHandlers.delete)
  return routes
}
