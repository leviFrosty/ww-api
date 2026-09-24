import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { sha256Hex, timingSafeEqual, randomToken } from '../crypto'
import {
  getNotesImportConfig,
  limitsWindowDurationMs,
  resolveNotesImportLimits,
  selectEffectiveAllowances,
  type NotesImportConfig,
} from './config'
import { isSupporter, RevenueCatError } from '../revenuecat'
import type { CreditDecision, CreditsSnapshot } from '../credits'
import { runNotesImportModel } from './llm'
import { getNotesImportStatus } from './status'
import { getPublicNotesImportStatus } from './publicStatus'
import {
  appAttestLifecycle,
  appAttestProtocolVersion,
  AppAttestError,
  NOTES_IMPORT_KICKOFF_PURPOSE,
  NOTES_IMPORT_VERIFY_PURPOSE,
  type AppAttestAction,
  type AppAttestReason,
  type AppAttestAssertionPurpose,
} from '../appAttest'
import { appAttestHttpCode } from '../appAttest/errors'
import {
  computeNotesImportRequestHash,
  isAppAttestAssertionPurpose,
  isAppAttestChallenge,
  isAppAttestKeyId,
  isAppAttestOperationId,
  isAppAttestUuid,
  type V2AssertionChallengeRequest,
  type V2AssertionFinalRequest,
} from '../appAttest/protocol'
import { isEmptyImportResult, type NotesImportContext } from './schema'
import { handleAdminResetRequest, isValidMeterId } from './admin'
import {
  buildAllowanceDenial,
  type NotesImportKickoffResponse,
} from './contracts'
import type { NotesImportSuccess } from './events'
import { resolveTerminalSupporter } from './settlement'

const err = (
  ctx: AppContext,
  status: number,
  error: string,
  code?: string,
  detail?: string,
  credits?: CreditsSnapshot,
  reason?: AppAttestReason,
  action?: AppAttestAction
) => {
  const body: ErrorResponse = { error }
  if (code) body.code = code
  if (detail) body.detail = detail
  if (credits) body.credits = credits
  if (reason) body.reason = reason
  if (action) body.action = action
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx.json(body, status as any)
}

/** Serialize a caught value to a useful single-string detail for dev debugging. */
const errorDetail = (e: unknown): string => {
  if (e instanceof Error) {
    const cause =
      e.cause != null && e.cause !== e
        ? `\nCaused by: ${errorDetail(e.cause)}`
        : ''
    return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}${cause}`
  }
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const appAttestBadRequest = (ctx: AppContext, message: string): Response =>
  err(
    ctx,
    HTTP_STATUS.BAD_REQUEST,
    message,
    'bad_request',
    undefined,
    undefined,
    'invalid_request',
    'none'
  )

const appAttestFailureResponse = (
  ctx: AppContext,
  error: AppAttestError,
  input: unknown
): Response => {
  // Stable reason only: request bodies may contain a recovery token.
  console.warn('notes-import App Attest rejected:', error.reason)
  if (error.reason === 'storage_unavailable') Sentry.captureException(error)

  const version = appAttestProtocolVersion(input)
  const status = version === 1 && error.status < 500 ? 401 : error.status
  const code = appAttestHttpCode(version, error.reason)
  return err(
    ctx,
    status,
    error.message,
    code,
    undefined,
    undefined,
    error.reason,
    error.action
  )
}

const readOptionalJson = async (
  ctx: AppContext
): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  const text = await ctx.req.text()
  if (!text.trim()) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/**
 * Shape gate for the client-supplied shared account id (witness-work ADR
 * 0011). It becomes a Durable Object name, a RevenueCat app-user-id path
 * segment, and a `|`-delimited clientData field, so keep it to a bounded
 * uuid-ish alphabet. Install ids (the value it defaults to on-device) are
 * `Crypto.randomUUID()` strings, which this accepts with room to spare.
 */
const isValidAccountId = isValidMeterId

const isLowercaseSha256 = (value: string): boolean =>
  /^[a-f0-9]{64}$/.test(value)

const parseV2AssertionChallengeRequest = (
  record: Record<string, unknown>
): V2AssertionChallengeRequest | null => {
  const operationId = asString(record.operationId)
  const uuid = asString(record.uuid)
  const keyId = asString(record.keyId)
  const purpose = asString(record.purpose)
  const contentHash = asString(record.contentHash)
  const requestHash = asString(record.requestHash)
  const accountId =
    record.accountId == null ? undefined : asString(record.accountId)
  if (
    record.protocolVersion !== 2 ||
    record.operation !== 'assert' ||
    !operationId ||
    !isAppAttestOperationId(operationId) ||
    !uuid ||
    !isAppAttestUuid(uuid) ||
    !keyId ||
    !isAppAttestKeyId(keyId) ||
    !purpose ||
    !isAppAttestAssertionPurpose(purpose) ||
    (record.accountId != null &&
      (!accountId || !isValidAccountId(accountId))) ||
    !contentHash ||
    !isLowercaseSha256(contentHash) ||
    !requestHash ||
    !isLowercaseSha256(requestHash)
  ) {
    return null
  }
  return {
    protocolVersion: 2,
    operation: 'assert',
    operationId,
    uuid,
    keyId,
    purpose,
    ...(accountId ? { accountId } : {}),
    contentHash,
    requestHash,
  }
}

const parseV2AssertionFinalRequest = (
  record: Record<string, unknown>,
  expectedPurpose: AppAttestAssertionPurpose
): V2AssertionFinalRequest | null => {
  const challengeRequest = parseV2AssertionChallengeRequest(record)
  const challenge = asString(record.challenge)
  const assertion = asString(record.assertion)
  if (
    !challengeRequest ||
    challengeRequest.purpose !== expectedPurpose ||
    !challenge ||
    !isAppAttestChallenge(challenge) ||
    !assertion ||
    assertion.length > 65_536
  ) {
    return null
  }
  return { ...challengeRequest, challenge, assertion }
}

const storageUnavailable = (cause: unknown): AppAttestError =>
  new AppAttestError('App Attest storage is temporarily unavailable', {
    reason: 'storage_unavailable',
    action: 'retry',
    status: 503,
    cause,
  })

const issueV2AssertionChallenge = async (
  ctx: AppContext,
  request: V2AssertionChallengeRequest
) => {
  try {
    const id = ctx.env.APP_ATTEST_IDENTITY.idFromName(request.uuid)
    const result = await ctx.env.APP_ATTEST_IDENTITY.get(id).issueChallenge(
      request
    )
    if (!result.ok) throw AppAttestError.fromFailure(result.error)
    return result.value
  } catch (error) {
    if (error instanceof AppAttestError) throw error
    throw storageUnavailable(error)
  }
}

const verifyV2Assertion = async (
  ctx: AppContext,
  request: V2AssertionFinalRequest
) => {
  try {
    const id = ctx.env.APP_ATTEST_IDENTITY.idFromName(request.uuid)
    const result = await ctx.env.APP_ATTEST_IDENTITY.get(id).verifyAssertion(
      request
    )
    if (!result.ok) throw AppAttestError.fromFailure(result.error)
    return result.value
  } catch (error) {
    if (error instanceof AppAttestError) throw error
    throw storageUnavailable(error)
  }
}

const subKey = (token: string) => `notes-import:sub:${token}`

/**
 * GET /notes-import/status — cheap availability probe for the app's import
 * entry points. No App Attest (it's a public health check) and no inference:
 * a manual KV kill-switch plus OpenRouter's free provider-health metadata.
 */
export async function handleNotesImportStatusRequest(ctx: AppContext) {
  const status = await getPublicNotesImportStatus(ctx.env)
  // Keep intermediary/browser caches from adding another freshness window.
  return ctx.json(status, 200, { 'Cache-Control': 'no-store' })
}

/** POST /notes-import/challenge — issue an App Attest challenge (v1 or v2). */
export async function handleChallengeRequest(ctx: AppContext) {
  const parsed = await readOptionalJson(ctx)
  if (!parsed.ok) return appAttestBadRequest(ctx, 'Invalid JSON')
  if (parsed.value !== undefined && !asRecord(parsed.value)) {
    return appAttestBadRequest(ctx, 'Invalid JSON body')
  }
  const record = asRecord(parsed.value)
  const isV2Assertion =
    record?.protocolVersion === 2 && record.operation === 'assert'
  const v2AssertionRequest = isV2Assertion
    ? parseV2AssertionChallengeRequest(record)
    : null
  if (isV2Assertion && !v2AssertionRequest) {
    return appAttestBadRequest(ctx, 'Invalid App Attest v2 assertion challenge')
  }

  try {
    const response = v2AssertionRequest
      ? await issueV2AssertionChallenge(ctx, v2AssertionRequest)
      : await appAttestLifecycle(ctx.env).issueChallenge(parsed.value)
    return ctx.json(response)
  } catch (e) {
    if (e instanceof AppAttestError) {
      return appAttestFailureResponse(ctx, e, parsed.value)
    }
    Sentry.captureException(e)
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Challenge error',
      'server_error'
    )
  }
}

/** POST /notes-import/attest — bind a key or enroll v2 recovery. */
export async function handleAttestRequest(ctx: AppContext) {
  let parsed: unknown
  try {
    parsed = await ctx.req.json()
  } catch {
    return appAttestBadRequest(ctx, 'Invalid JSON')
  }
  const body = asRecord(parsed)
  if (!body) return appAttestBadRequest(ctx, 'Invalid JSON body')

  // Keep the deployed v1 request gate and top-level error text unchanged.
  if (appAttestProtocolVersion(body) === 1) {
    const keyId = asString(body.keyId)
    const attestation = asString(body.attestation)
    const challenge = asString(body.challenge)
    const uuid = asString(body.uuid)
    if (!keyId || !attestation || !challenge || !uuid) {
      return appAttestBadRequest(
        ctx,
        'Missing keyId, attestation, challenge, or uuid'
      )
    }
  }

  try {
    const response = await appAttestLifecycle(ctx.env).register(body)
    return ctx.json(response)
  } catch (e) {
    if (e instanceof AppAttestError) {
      return appAttestFailureResponse(ctx, e, body)
    }
    Sentry.captureException(e)
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Attestation error',
      'server_error'
    )
  }
}

/**
 * POST /notes-import/verify — attested no-op for the app's dev-tools
 * diagnostics. Runs the exact verifyAssertion path the metered endpoints use
 * (challenge consumption and sign-count advance included) but touches no
 * credits and no inference, so the Tools screen can prove the full App Attest
 * boundary server-side. This no-payload probe requires `requestHash` to equal
 * its client-chosen `contentHash`; real kickoffs instead hash their canonical
 * Notes Import payload.
 */
export async function handleNotesImportVerifyRequest(ctx: AppContext) {
  let parsed: unknown
  try {
    parsed = await ctx.req.json()
  } catch {
    return appAttestBadRequest(ctx, 'Invalid JSON')
  }
  const body = asRecord(parsed)
  if (!body) return appAttestBadRequest(ctx, 'Invalid JSON body')

  const config = getNotesImportConfig(ctx.env)
  const bypassHeader = ctx.req.header('x-ww-dev-bypass') ?? ''
  const devBypass =
    config.devBypassToken != null &&
    timingSafeEqual(bypassHeader, config.devBypassToken)
  if (devBypass) {
    const version = appAttestProtocolVersion(body)
    if (version === 2) {
      const operationId = asString(body.operationId)
      const contentHash = asString(body.contentHash)
      const requestHash = asString(body.requestHash)
      if (
        !operationId ||
        !isAppAttestOperationId(operationId) ||
        body.operation !== 'assert' ||
        body.purpose !== NOTES_IMPORT_VERIFY_PURPOSE ||
        !contentHash ||
        !isLowercaseSha256(contentHash) ||
        requestHash !== contentHash
      ) {
        return appAttestBadRequest(ctx, 'Invalid App Attest v2 bypass probe')
      }
      return ctx.json({ ok: true, protocolVersion: 2, operationId })
    }
    return ctx.json({ ok: true })
  }

  const uuid = asString(body.uuid)
  const keyId = asString(body.keyId)
  const challenge = asString(body.challenge)
  const assertion = asString(body.assertion)
  const contentHash = asString(body.contentHash)
  if (!uuid || !keyId || !challenge || !assertion || !contentHash) {
    return appAttestBadRequest(
      ctx,
      'Missing uuid, keyId, challenge, assertion, or contentHash'
    )
  }
  // Same shape gates as kickoff: both values end up in the `|`-delimited
  // signed clientData, so keep them to their bounded alphabets.
  const accountId = body.accountId != null ? asString(body.accountId) : null
  if (body.accountId != null && (!accountId || !isValidAccountId(accountId))) {
    return appAttestBadRequest(ctx, 'Invalid accountId')
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return appAttestBadRequest(ctx, 'Invalid contentHash')
  }

  const version = appAttestProtocolVersion(body)
  let v2Request: V2AssertionFinalRequest | null = null
  if (version === 2) {
    const requestHash = asString(body.requestHash)
    if (
      !requestHash ||
      !isLowercaseSha256(requestHash) ||
      requestHash !== contentHash
    ) {
      return appAttestBadRequest(
        ctx,
        'requestHash must equal contentHash for App Attest verify'
      )
    }
    v2Request = parseV2AssertionFinalRequest(
      body,
      NOTES_IMPORT_VERIFY_PURPOSE
    )
    if (!v2Request) {
      return appAttestBadRequest(ctx, 'Invalid App Attest v2 verify assertion')
    }
  }

  try {
    const response = v2Request
      ? await verifyV2Assertion(ctx, v2Request)
      : await appAttestLifecycle(ctx.env).verifyAssertion(body, {
          uuid,
          accountId: accountId ?? undefined,
          contentHash,
          purpose: NOTES_IMPORT_VERIFY_PURPOSE,
        })
    return ctx.json(response)
  } catch (e) {
    if (e instanceof AppAttestError) {
      return appAttestFailureResponse(ctx, e, body)
    }
    Sentry.captureException(e)
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Verify error',
      'server_error'
    )
  }
}

interface NotesImportBody {
  uuid: string
  /** Shared account id (ADR 0011); absent on pre-account clients. */
  accountId?: string
  notesText: string
  contentHash: string
  requestHash?: string
  context: NotesImportContext
  /** Additive App Attest v2 assertion fields; absent on deployed v1 clients. */
  protocolVersion?: 1 | 2
  operation?: string
  operationId?: string
  purpose?: AppAttestAssertionPurpose
  keyId?: string
  challenge?: string
  assertion?: string
  refinement?: { previousResultJSON: string; instruction: string }
}

/** A request that passed authentication + the credit gate, ready to spend inference. */
interface GateOk {
  ok: true
  body: NotesImportBody
  uuid: string
  /**
   * The identity everything per-user keys on: the shared account id when the
   * client sent one, else the per-device install uuid (old clients). Names
   * the per-user index DO (credits + concurrency cap) and the RevenueCat
   * subscriber — so a Supporter's second device, which adopted the purchasing
   * device's account id, is recognized as that same RevenueCat customer
   * instead of being metered as a free user. App Attest key pinning stays on
   * `uuid`.
   */
  meterId: string
  notesText: string
  contentHash: string
  supporter: boolean
  /** Existing concurrency behavior: Supporters and dev bypass use the higher cap. */
  supporterConcurrency: boolean
  importLimit: number
  refinementLimit: number
  windowDurationMs: number
  decision: CreditDecision
  isRefinement: boolean
  /** True when the dev-bypass token was used (gates dev-only error detail). */
  devBypass: boolean
}
type GateResult = GateOk | { ok: false; response: Response }

/**
 * The shared security boundary for the metered model call: parse + validate the
 * body, recompute the authoritative content and request hashes, verify App
 * Attest (or the dev bypass), resolve supporter status, and run the credit
 * pre-flight. Both the streaming kickoff and legacy synchronous path use this
 * boundary; v1 signs the content hash, while v2 also signs the canonical
 * request hash. Returns either a ready-to-spend `GateOk` or a fully-formed
 * error `Response`.
 */
async function authenticateAndGate(
  ctx: AppContext,
  config: NotesImportConfig,
  assertionPurpose: AppAttestAssertionPurpose | null
): Promise<GateResult> {
  // Kill-switch / provider-health enforcement. `GET /notes-import/status`
  // advertises this so the app can disable its entry points BEFORE attesting,
  // but that's only advisory: a client already inside the composer, resuming a
  // run, or calling the API directly never re-checks it. So enforce the same
  // gate here — the single boundary both import paths pass through — before
  // spending an attestation round-trip or any inference. Cheap (KV kill-switch
  // first, then the cached provider probe) and fail-open by design. Internal
  // enforcement needs availability only; allowance resolution happens once
  // below after the real entitlement is known.
  const status = await getNotesImportStatus({
    kv: ctx.env.NOTES_KV,
    env: ctx.env,
    apiKey: ctx.env.OPENROUTER_API_KEY,
    config,
    includeLimits: false,
  })
  if (!status.available) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        'Notes Import is temporarily unavailable',
        'unavailable',
        status.reason
      ),
    }
  }

  let parsed: unknown
  try {
    parsed = await ctx.req.json()
  } catch {
    return {
      ok: false,
      response: err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request'),
    }
  }
  const record = asRecord(parsed)
  if (!record) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Invalid JSON body',
        'bad_request'
      ),
    }
  }
  const body = record as unknown as NotesImportBody

  const uuid = asString(body.uuid)
  const notesText = typeof body.notesText === 'string' ? body.notesText : null
  if (!uuid || notesText == null || !body.context) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Missing uuid, notesText, or context',
        'bad_request'
      ),
    }
  }

  // Optional shared account id. Reject a malformed one outright rather than
  // silently falling back to the uuid — a well-behaved client never sends one,
  // and letting garbage through would put it in a DO name and a signed field.
  const accountId = body.accountId != null ? asString(body.accountId) : null
  if (body.accountId != null && (!accountId || !isValidAccountId(accountId))) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Invalid accountId',
        'bad_request'
      ),
    }
  }

  if (notesText.length > config.maxChars) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.PAYLOAD_TOO_LARGE,
        `Notes exceed the ${config.maxChars}-character limit`,
        'too_large'
      ),
    }
  }

  // The content hash is authoritative: recompute it and require the client's
  // claimed hash to match, so the signed assertion provably covers exactly the
  // text being parsed (and the meter keys on real content).
  const contentHash = await sha256Hex(notesText)
  if (asString(body.contentHash) && body.contentHash !== contentHash) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'contentHash does not match notesText',
        'bad_request'
      ),
    }
  }

  const protocolVersion = appAttestProtocolVersion(body)
  let requestHash: string | undefined
  if (protocolVersion === 2) {
    requestHash = asString(body.requestHash) ?? undefined
    const expectedRequestHash = await computeNotesImportRequestHash({
      notesText,
      context: body.context,
      refinement: body.refinement ?? null,
    })
    if (
      !requestHash ||
      !isLowercaseSha256(requestHash) ||
      requestHash !== expectedRequestHash
    ) {
      return {
        ok: false,
        response: appAttestBadRequest(
          ctx,
          'requestHash does not match the Notes Import payload'
        ),
      }
    }
  }

  // --- Request authentication (the security boundary) -------------------
  const bypassHeader = ctx.req.header('x-ww-dev-bypass') ?? ''
  const devBypass =
    config.devBypassToken != null &&
    timingSafeEqual(bypassHeader, config.devBypassToken)

  if (!devBypass) {
    if (
      assertionPurpose == null &&
      appAttestProtocolVersion(body) === 2
    ) {
      return {
        ok: false,
        response: err(
          ctx,
          HTTP_STATUS.BAD_REQUEST,
          'App Attest v2 is not supported on the legacy synchronous endpoint',
          'bad_request',
          undefined,
          undefined,
          'unsupported_protocol',
          'none'
        ),
      }
    }
    const keyId = asString(body.keyId)
    const challenge = asString(body.challenge)
    const assertion = asString(body.assertion)
    if (!keyId || !challenge || !assertion) {
      return {
        ok: false,
        response: err(
          ctx,
          HTTP_STATUS.UNAUTHORIZED,
          'Missing App Attest credentials',
          'attestation_required',
          undefined,
          undefined,
          'invalid_request',
          'bind'
        ),
      }
    }
    const v2Request =
      protocolVersion === 2
        ? parseV2AssertionFinalRequest(
            record,
            assertionPurpose ?? NOTES_IMPORT_KICKOFF_PURPOSE
          )
        : null
    if (protocolVersion === 2 && !v2Request) {
      return {
        ok: false,
        response: appAttestBadRequest(
          ctx,
          'Invalid App Attest v2 protected assertion'
        ),
      }
    }
    try {
      if (v2Request) {
        await verifyV2Assertion(ctx, v2Request)
      } else {
        await appAttestLifecycle(ctx.env).verifyAssertion(body, {
          uuid,
          accountId: accountId ?? undefined,
          contentHash,
          purpose: assertionPurpose ?? NOTES_IMPORT_KICKOFF_PURPOSE,
        })
      }
    } catch (e) {
      if (e instanceof AppAttestError) {
        return {
          ok: false,
          response: appAttestFailureResponse(ctx, e, body),
        }
      }
      Sentry.captureException(e)
      return {
        ok: false,
        response: err(
          ctx,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          'Auth error',
          'server_error'
        ),
      }
    }
  }

  // --- Supporter status + credit gate -----------------------------------
  // Everything below keys on the account id when the client sent one (per-
  // person Supporter check, credits, caps — ADR 0011), else the install uuid.
  const meterId = accountId ?? uuid

  // Keep real entitlement distinct from dev bypass: bypass overrides allowance
  // values only, while only an actual Supporter suppresses Supporter CTAs.
  let supporter = false
  if (!devBypass) {
    try {
      supporter = await isSupporter({
        apiKey: ctx.env.REVENUECAT_API_KEY,
        appUserId: meterId,
        entitlementId: config.entitlementId,
      })
    } catch (e) {
      if (!(e instanceof RevenueCatError)) Sentry.captureException(e)
      // Fail closed to non-Supporter — the free meter still lets them import.
      supporter = false
    }
  }
  const supporterConcurrency = supporter || devBypass
  const limits = await resolveNotesImportLimits(ctx.env, ctx.env.NOTES_KV)
  const allowances = selectEffectiveAllowances(limits, supporter, devBypass)
  const windowDurationMs = limitsWindowDurationMs(limits)

  const isRefinement = !!body.refinement
  // Pre-flight the credit gate in the per-user index DO (single-threaded →
  // strongly consistent, unlike the old KV read). The commit after a successful
  // run goes through the same DO, so check and charge can't race.
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const checked = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).checkCredit({
    hash: contentHash,
    isSupporter: supporter,
    isRefinement,
    importLimit: allowances.imports,
    refinementLimit: allowances.refinements,
    windowDurationMs,
  })
  if (!checked.decision.allowed) {
    const denial = buildAllowanceDenial(
      checked.decision.reason!,
      checked.credits
    )
    return {
      ok: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: ctx.json(denial.body, denial.status as any),
    }
  }

  return {
    ok: true,
    body,
    uuid,
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    importLimit: allowances.imports,
    refinementLimit: allowances.refinements,
    windowDurationMs,
    decision: checked.decision,
    isRefinement,
    devBypass,
  }
}

/**
 * Stable, content-derived import id. Idempotent per (user, content) so a
 * reconnect lands on the same run DO; a refinement is a distinct run because its
 * instruction is part of the identity. `imp_` prefix keeps DO names readable.
 * Keyed on the meter identity (account id when present) so a person's devices
 * share replay idempotency, and so an import's slot always lives in the same
 * index DO that acquired it.
 */
const deriveImportId = async (
  meterId: string,
  contentHash: string,
  refinement?: { instruction: string }
): Promise<string> => {
  const basis = refinement
    ? `${meterId}|${contentHash}|r|${refinement.instruction}`
    : `${meterId}|${contentHash}`
  return `imp_${(await sha256Hex(basis)).slice(0, 40)}`
}

/**
 * POST /notes-import/kickoff — attested, metered entry point for the STREAMING
 * import. Authenticates + gates exactly like the legacy path, enforces the
 * per-user concurrency cap, starts a background run in a per-import Durable
 * Object, and returns immediately with `{ importId, subscribeToken }`. The
 * client then opens the SSE stream at `/notes-import/:importId/events`.
 */
export async function handleNotesImportKickoffRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const gate = await authenticateAndGate(
    ctx,
    config,
    NOTES_IMPORT_KICKOFF_PURPOSE
  )
  if (!gate.ok) return gate.response
  const {
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    importLimit,
    refinementLimit,
    windowDurationMs,
    decision,
    body,
    isRefinement,
  } = gate

  const importId = await deriveImportId(meterId, contentHash, body.refinement)

  // Per-user concurrency cap, enforced race-free in the single-threaded index DO.
  const cap = supporterConcurrency
    ? config.activeImportCapSupporter
    : config.activeImportCap
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const acquired = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).acquire(
    importId,
    cap
  )
  if (!acquired.ok) {
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap'
    )
  }

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(importId)
  let outcome
  try {
    outcome = await ctx.env.NOTES_IMPORT_RUN.get(runId).start({
      importId,
      uuid: meterId,
      contentHash,
      notesText,
      context: body.context,
      refinement: body.refinement,
      isSupporter: supporter,
      devBypass: gate.devBypass,
      decision,
    })
  } catch (e) {
    // Couldn't start → release the slot so it isn't leaked.
    await ctx.env.NOTES_IMPORT_INDEX.get(idxId).release(importId)
    Sentry.captureException(e)
    console.error('notes-import kickoff start failed', errorDetail(e))
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Could not start import',
      'server_error',
      gate.devBypass ? errorDetail(e) : undefined
    )
  }

  // A re-kick of an already-settled run (done/cancelled) does NOT consume the
  // slot we just acquired: start() no-ops for reconnect, but that run had
  // already released its slot when it first settled, so acquire() re-inserted an
  // ORPHAN row. Release it — the index DO has no TTL, so a leaked slot locks the
  // user out permanently once `cap` of them accumulate. A live/queued re-kick
  // ('running', slot still in use) and a fresh/error (re)start ('started', slot
  // legitimately consumed) both keep it. release() is idempotent (a DELETE).
  if (outcome === 'terminal') {
    await ctx.env.NOTES_IMPORT_INDEX.get(idxId).release(importId)
  }

  // Short-lived capability for the stream. App Attest can't sign a long-lived
  // SSE connection; it doesn't need to — the abusable operation (inference) was
  // already gated above, so the stream just reads an authorized resource.
  const subscribeToken = randomToken()
  await ctx.env.NOTES_KV.put(subKey(subscribeToken), importId, {
    expirationTtl: config.subscribeTokenTtlSeconds,
  })

  // Point-in-time usage preview. It writes nothing and can differ from terminal
  // state after success, time/config/entitlement changes, or another commit.
  const credits = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).kickoffCredits({
    hash: contentHash,
    decision,
    isSupporter: supporter,
    importLimit,
    refinementLimit,
    windowDurationMs,
  })

  const response = {
    importId,
    subscribeToken,
    refinement: isRefinement,
    credits,
  } satisfies NotesImportKickoffResponse
  return ctx.json(response)
}

/** Resolve + authorize a stream request to its run DO, or return an error Response. */
async function authorizeStream(
  ctx: AppContext
): Promise<{ importId: string } | { response: Response }> {
  const importId = ctx.req.param('importId')
  const token = ctx.req.query('token') ?? ''
  if (!importId || !token) {
    return {
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Missing importId or token',
        'bad_request'
      ),
    }
  }
  const mapped = await ctx.env.NOTES_KV.get(subKey(token))
  if (!mapped || mapped !== importId) {
    return {
      response: err(
        ctx,
        HTTP_STATUS.UNAUTHORIZED,
        'Invalid or expired subscribe token',
        'attestation_required'
      ),
    }
  }
  return { importId }
}

/**
 * GET /notes-import/:importId/events — the SSE progress stream. Authorized by
 * the kickoff's `?token=` capability. Forwards to the run DO, which replays the
 * event log since `Last-Event-ID` then tails live (lossless resume).
 */
export async function handleNotesImportEventsRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const lastEventId =
    ctx.req.header('Last-Event-ID') ?? ctx.req.query('lastEventId') ?? ''
  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const doReq = new Request(
    `https://do/events?lastEventId=${encodeURIComponent(lastEventId)}`,
    { headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined }
  )
  return ctx.env.NOTES_IMPORT_RUN.get(runId).fetch(doReq)
}

/**
 * POST /notes-import/:importId/cancel — interrupt a running import. Authorized by
 * the kickoff's `?token=` capability (same as the stream/result reads — cancel
 * only STOPS work, it can't spend inference, so it needs no App Attest). Aborts
 * the in-flight model call in the run DO and marks it cancelled; because the
 * credit is only spent on success, an interrupted run is never charged. Used by
 * the client's "edit & resend" flow before kicking off the edited import.
 */
export async function handleNotesImportCancelRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const snapshot = await ctx.env.NOTES_IMPORT_RUN.get(runId).cancel()
  return ctx.json(snapshot)
}

/**
 * POST /notes-import/:importId/destroy — forget a run entirely, on demand. Same
 * subscribe-token capability as cancel/stream/result (destroy can't spend
 * inference, so it needs no App Attest). Aborts any in-flight model call, frees
 * the user's concurrency slot, and wipes all DO state immediately instead of
 * waiting for the retention alarm. Backs the history view's per-row delete.
 */
export async function handleNotesImportDestroyRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  await ctx.env.NOTES_IMPORT_RUN.get(runId).destroy()
  return ctx.json({ ok: true })
}

/**
 * GET /notes-import/:importId/result — final-result snapshot for a client that
 * reconnects after the stream closed (or missed the terminal event). Same
 * capability auth as the stream.
 */
export async function handleNotesImportResultRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const snapshot = await ctx.env.NOTES_IMPORT_RUN.get(runId).getResult()
  return ctx.json(snapshot)
}

/** Secret-protected maintainer reset; registered under the shared rate limiter. */
export function handleNotesImportAdminResetRequest(ctx: AppContext) {
  return handleAdminResetRequest(ctx.req.raw, {
    adminToken: ctx.env.ADMIN_API_TOKEN,
    indexFor: (meterId) => {
      const id = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
      const stub = ctx.env.NOTES_IMPORT_INDEX.get(id)
      return {
        objectId: id.toString(),
        resetUsage: () => stub.resetUsage(),
      }
    },
  })
}

/**
 * POST /notes-import — LEGACY synchronous path. Held open for the full model run
 * and returns the result in one response. Kept as a fallback during the
 * streaming cutover (gate behind the KV kill-switch on the client). Identical
 * auth/credit/ZDR semantics as kickoff via the shared gate.
 */
export async function handleNotesImportRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const gate = await authenticateAndGate(ctx, config, null)
  if (!gate.ok) return gate.response
  const {
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    decision,
    body,
    isRefinement,
  } = gate

  // The legacy path has no run DO, so it must enforce the same per-user
  // concurrency cap itself — without it a single-second burst of DISTINCT-hash
  // requests races the meter (the very bypass this fix closes). Namespace the
  // slot key ('legacy:') so it can NEVER collide with a streaming run's
  // importId: a run DO releases by the bare importId, so a shared key would let
  // this path's finally-release drop a live streaming run's slot. Distinct keys
  // keep the two paths independent; a duplicate-content legacy burst still
  // collapses to one slot (acquire is idempotent for a held id), while the
  // distinct-hash attack takes one slot each and is capped. Synchronous path →
  // a plain try/finally release (no run DO to hand the slot off to).
  const cap = supporterConcurrency
    ? config.activeImportCapSupporter
    : config.activeImportCap
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const idx = ctx.env.NOTES_IMPORT_INDEX.get(idxId)
  const slotKey = `legacy:${await deriveImportId(meterId, contentHash, body.refinement)}`
  const acquired = await idx.acquire(slotKey, cap)
  if (!acquired.ok) {
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap'
    )
  }

  try {
    let output
    try {
      output = await runNotesImportModel({
        apiKey: ctx.env.OPENROUTER_API_KEY,
        config,
        notesText,
        context: body.context,
        refinement: body.refinement,
      })
    } catch (e) {
      Sentry.captureException(e)
      console.error('notes-import model_error', errorDetail(e))
      return err(
        ctx,
        HTTP_STATUS.BAD_GATEWAY,
        'The import model could not process these notes',
        'model_error',
        gate.devBypass ? errorDetail(e) : undefined
      )
    }

    // Resolve terminal policy again: the success snapshot is authoritative and
    // may differ from kickoff after runtime policy or entitlement changes.
    const terminalSupporter = await resolveTerminalSupporter({
      kickoffSupporter: supporter,
      devBypass: gate.devBypass,
      apiKey: ctx.env.REVENUECAT_API_KEY,
      appUserId: meterId,
      entitlementId: config.entitlementId,
    })
    const terminalLimits = await resolveNotesImportLimits(
      ctx.env,
      ctx.env.NOTES_KV
    )
    const terminalAllowances = selectEffectiveAllowances(
      terminalLimits,
      terminalSupporter,
      gate.devBypass
    )
    const { credits, emptyCharged } = await idx.recordUsage({
      hash: contentHash,
      isSupporter: terminalSupporter,
      decision,
      importLimit: terminalAllowances.imports,
      refinementLimit: terminalAllowances.refinements,
      windowDurationMs: limitsWindowDurationMs(terminalLimits),
      isEmpty: isEmptyImportResult(output.result),
      emptyWindowSeconds: config.emptyWindowSeconds,
      emptyWindowLimit: config.emptyWindowLimit,
    })

    const response = {
      result: output.result,
      contentHash,
      refinement: isRefinement,
      emptyCharged,
      credits,
    } satisfies NotesImportSuccess
    return ctx.json(response)
  } finally {
    await idx.release(slotKey)
  }
}
