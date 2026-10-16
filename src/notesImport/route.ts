import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { retryAfterHeaders } from '../errors'
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
import {
  base64DecodedBytes,
  isTranscribeMimeType,
  matchesImageMagic,
  transcribeNotesPage,
} from './transcribe'
import { getNotesImportStatus } from './status'
import { getPublicNotesImportStatus } from './publicStatus'
import {
  appAttestLifecycle,
  appAttestProtocolVersion,
  AppAttestError,
  NOTES_IMPORT_KICKOFF_PURPOSE,
  NOTES_IMPORT_TRANSCRIBE_PURPOSE,
  type AppAttestAction,
  type AppAttestReason,
  type AppAttestAssertionPurpose,
} from '../appAttest'
import {
  computeNotesImportRequestHash,
  computeNotesImportTranscribeRequestHash,
} from '../appAttest/protocol'
import { isPlayIntegrityRequest, type PlayIntegrityReason } from '../playIntegrity'
import type { PlayIntegrityAction } from '../playIntegrity/errors'
import {
  appAttestFailureResponse,
  asRecord,
  asString,
  attestationBadRequest as appAttestBadRequest,
  isLowercaseSha256,
  isValidAccountId,
  parseV2AssertionFinalRequest,
  requireAttestation,
  verifyPlayIntegrityRecord,
  verifyV2Assertion,
} from '../attestation/http'
import { isEmptyImportResult, type NotesImportContext } from './schema'
import { handleAdminResetRequest } from './admin'
import {
  buildAllowanceDenial,
  type NotesImportKickoffResponse,
} from './contracts'
import type { NotesImportSuccess } from './events'
import { resolveTerminalSupporter } from './settlement'
import {
  analyticsDistinctId,
  analyticsEnabled,
  captureAnalyticsEvent,
  type AnalyticsEvent,
} from '../analytics'
import {
  notesImportFinishedEvent,
  notesImportLimitReachedEvent,
  notesImportStartedEvent,
  type NotesImportAnalyticsContext,
} from './analytics'

/** Send a usage event after the response, without delaying it. */
const track = (ctx: AppContext, event: AnalyticsEvent) => {
  if (!analyticsEnabled(ctx.env)) return
  const delivery = captureAnalyticsEvent(ctx.env, event)
  try {
    ctx.executionCtx.waitUntil(delivery)
  } catch {
    // No ExecutionContext (unit tests): the capture still runs unawaited.
  }
}

/** The request's `waitUntil`, or undefined without an ExecutionContext (unit tests). */
const waitUntilOf = (
  ctx: AppContext
): ((promise: Promise<unknown>) => void) | undefined => {
  try {
    const executionCtx = ctx.executionCtx
    if (!executionCtx) return undefined
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}

/**
 * A 503 that didn't say otherwise (storage, Google, or provider trouble):
 * worth one more try after a short wait.
 */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30
/**
 * The kill switch and provider health are read through 60-second caches, so
 * nothing changes for at least that long.
 */
const KILL_SWITCH_RETRY_AFTER_SECONDS = 60
/** A run usually settles within a minute; poll for a free slot meanwhile. */
const ACTIVE_CAP_RETRY_AFTER_SECONDS = 15

/**
 * Notes Import's error response: the shared envelope (src/errors.ts) with the
 * human message in `error`, as shipped builds expect, and the stable `code`.
 * Every 503 carries `Retry-After`; 429s pass theirs explicitly.
 */
const err = (
  ctx: AppContext,
  status: number,
  error: string,
  code: string,
  detail?: string,
  credits?: CreditsSnapshot,
  reason?: AppAttestReason | PlayIntegrityReason,
  action?: AppAttestAction | PlayIntegrityAction,
  retryAfter: number | undefined = status === 503
    ? UNAVAILABLE_RETRY_AFTER_SECONDS
    : undefined
) => {
  const body: ErrorResponse = { ok: false, error, code }
  if (retryAfter != null) body.retryAfter = retryAfter
  if (detail) body.detail = detail
  if (credits) body.credits = credits
  if (reason) body.reason = reason
  if (action) body.action = action
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx.json(body, status as any, retryAfterHeaders(retryAfter))
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

const subKey = (token: string) => `notes-import:sub:${token}`

/**
 * GET /notes-import/status — cheap availability probe for the app's import
 * entry points. No App Attest (it's a public health check) and no inference:
 * a manual KV kill-switch plus OpenRouter's free provider-health metadata.
 */
export async function handleNotesImportStatusRequest(ctx: AppContext) {
  const status = await getPublicNotesImportStatus(ctx.env, waitUntilOf(ctx))
  // Keep intermediary/browser caches from adding another freshness window.
  return ctx.json(status, 200, { 'Cache-Control': 'no-store' })
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
  /** Usage-event context; the caller stamps `startedAt` when a run starts. */
  analytics: Omit<NotesImportAnalyticsContext, 'startedAt'>
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
    waitUntil: waitUntilOf(ctx),
  })
  if (!status.available) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        'Notes Import is temporarily unavailable',
        'unavailable',
        status.reason,
        undefined,
        undefined,
        undefined,
        KILL_SWITCH_RETRY_AFTER_SECONDS
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

  if (!devBypass && isPlayIntegrityRequest(record)) {
    if (assertionPurpose == null) {
      return {
        ok: false,
        response: err(
          ctx,
          HTTP_STATUS.BAD_REQUEST,
          'Play Integrity is not supported on the legacy synchronous endpoint',
          'bad_request',
          undefined,
          undefined,
          'unsupported_protocol',
          'none'
        ),
      }
    }
    // The token binds the canonical payload hash, so it must be authoritative.
    const expectedRequestHash = await computeNotesImportRequestHash({
      notesText,
      context: body.context,
      refinement: body.refinement ?? null,
    })
    if (body.requestHash !== expectedRequestHash) {
      return {
        ok: false,
        response: appAttestBadRequest(
          ctx,
          'requestHash does not match the Notes Import payload'
        ),
      }
    }
    const failure = await verifyPlayIntegrityRecord(
      ctx,
      record,
      assertionPurpose
    )
    if (failure) return { ok: false, response: failure }
  } else if (!devBypass) {
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
  const isRefinement = !!body.refinement
  const analytics: GateOk['analytics'] = {
    distinctId: await analyticsDistinctId(meterId),
    platform: devBypass
      ? 'dev'
      : isPlayIntegrityRequest(record)
        ? 'android'
        : 'ios',
    transport: assertionPurpose == null ? 'legacy' : 'stream',
    refinement: isRefinement,
    supporter,
    hasAccount: accountId != null,
    notesChars: notesText.length,
  }
  const limits = await resolveNotesImportLimits(ctx.env, ctx.env.NOTES_KV)
  const allowances = selectEffectiveAllowances(limits, supporter, devBypass)
  const windowDurationMs = limitsWindowDurationMs(limits)

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
    track(
      ctx,
      notesImportLimitReachedEvent(
        analytics,
        checked.decision.reason === 'refinement_limit'
          ? 'refinements'
          : 'imports'
      )
    )
    // No Retry-After: neither denial frees with a short wait (the import
    // window resets at `credits.resetsAt`; refinements never reset).
    return {
      ok: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: ctx.json({ ok: false, ...denial.body }, denial.status as any),
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
    analytics,
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
    track(ctx, notesImportLimitReachedEvent(gate.analytics, 'active_cap'))
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap',
      undefined,
      undefined,
      undefined,
      undefined,
      ACTIVE_CAP_RETRY_AFTER_SECONDS
    )
  }

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(importId)
  const analytics: NotesImportAnalyticsContext = {
    ...gate.analytics,
    startedAt: Date.now(),
  }
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
      analytics,
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
  // Only a fresh run counts; the run DO reports how it finishes.
  if (outcome === 'started') {
    track(ctx, notesImportStartedEvent(analytics, decision))
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
    track(ctx, notesImportLimitReachedEvent(gate.analytics, 'active_cap'))
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap',
      undefined,
      undefined,
      undefined,
      undefined,
      ACTIVE_CAP_RETRY_AFTER_SECONDS
    )
  }

  const analytics: NotesImportAnalyticsContext = {
    ...gate.analytics,
    startedAt: Date.now(),
  }
  track(ctx, notesImportStartedEvent(analytics, decision))

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
      track(
        ctx,
        notesImportFinishedEvent(analytics, 'model_error', Date.now())
      )
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

    track(
      ctx,
      notesImportFinishedEvent(analytics, 'success', Date.now(), {
        result: output.result,
        credits,
        emptyCharged,
        model: config.model,
        provider: output.resolvedProvider,
        usage: output.usage,
      })
    )

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

const TRANSCRIBE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * POST /notes-import/transcribe — attested Import from Paper step: reads one
 * photographed page into plain text with a vision model on the ZDR allowlist
 * and returns it. Nothing is stored; the app shows the text for the user to
 * edit, then sends it through the ordinary kickoff, which is where the Import
 * Credit is spent. Pages are free but counted per identity per rolling day,
 * and a free user with no imports left is refused before any page is read.
 */
export async function handleNotesImportTranscribeRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const status = await getNotesImportStatus({
    kv: ctx.env.NOTES_KV,
    env: ctx.env,
    apiKey: ctx.env.OPENROUTER_API_KEY,
    config,
    includeLimits: false,
    waitUntil: waitUntilOf(ctx),
  })
  if (!status.available) {
    return err(
      ctx,
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'Notes Import is temporarily unavailable',
      'unavailable',
      status.reason,
      undefined,
      undefined,
      undefined,
      KILL_SWITCH_RETRY_AFTER_SECONDS
    )
  }

  let parsed: unknown
  try {
    parsed = await ctx.req.json()
  } catch {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request')
  }
  const record = asRecord(parsed)
  if (!record) {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON body', 'bad_request')
  }

  const uuid = asString(record.uuid)
  const image = asString(record.image)
  const mimeType = record.mimeType
  if (!uuid || !image || !isTranscribeMimeType(mimeType)) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'Missing uuid, image, or a supported mimeType',
      'bad_request'
    )
  }
  const accountId = record.accountId != null ? asString(record.accountId) : null
  if (record.accountId != null && (!accountId || !isValidAccountId(accountId))) {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid accountId', 'bad_request')
  }

  const bytes = base64DecodedBytes(image)
  if (bytes == null || !matchesImageMagic(image, mimeType)) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'image is not a base64 image of the declared type',
      'bad_request'
    )
  }
  if (bytes > config.transcribeMaxBytes) {
    return err(
      ctx,
      HTTP_STATUS.PAYLOAD_TOO_LARGE,
      `Image exceeds the ${config.transcribeMaxBytes}-byte limit`,
      'too_large'
    )
  }

  // Both hashes are authoritative: the signed assertion must cover exactly
  // this image and mime type.
  const contentHash = await sha256Hex(image)
  const requestHash = await computeNotesImportTranscribeRequestHash({
    imageHash: contentHash,
    mimeType,
  })
  if (record.contentHash !== contentHash || record.requestHash !== requestHash) {
    return appAttestBadRequest(
      ctx,
      'contentHash or requestHash does not match the transcription payload'
    )
  }

  // --- Request authentication (v2 App Attest or Play Integrity only) ----
  const bypassHeader = ctx.req.header('x-ww-dev-bypass') ?? ''
  const devBypass =
    config.devBypassToken != null &&
    timingSafeEqual(bypassHeader, config.devBypassToken)
  if (!devBypass) {
    const failure = await requireAttestation(
      ctx,
      record,
      NOTES_IMPORT_TRANSCRIBE_PURPOSE,
      'Page transcription requires App Attest v2 or Play Integrity'
    )
    if (failure) return failure
  }

  // --- Entitlement, import allowance, and page limit --------------------
  const meterId = accountId ?? uuid
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
      supporter = false
    }
  }
  const limits = await resolveNotesImportLimits(ctx.env, ctx.env.NOTES_KV)
  const allowances = selectEffectiveAllowances(limits, supporter, devBypass)
  const idx = ctx.env.NOTES_IMPORT_INDEX.get(
    ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  )
  // Read-only pre-flight: the transcript can only be imported with a credit,
  // so don't read pages for someone who can't import them.
  const checked = await idx.checkCredit({
    hash: contentHash,
    isSupporter: supporter,
    isRefinement: false,
    importLimit: allowances.imports,
    refinementLimit: allowances.refinements,
    windowDurationMs: limitsWindowDurationMs(limits),
  })
  if (!checked.decision.allowed) {
    const denial = buildAllowanceDenial(
      checked.decision.reason!,
      checked.credits
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ctx.json({ ok: false, ...denial.body }, denial.status as any)
  }
  const pageLimit =
    supporter || devBypass
      ? config.transcribePagesPerDaySupporter
      : config.transcribePagesPerDay
  const taken = await idx.takeTranscribePage(pageLimit, TRANSCRIBE_WINDOW_MS)
  if (!taken.ok) {
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You've read ${pageLimit} pages today. Try again later.`,
      'transcribe_limit',
      undefined,
      undefined,
      undefined,
      undefined,
      Math.max(1, Math.ceil(taken.retryAfterMs / 1000))
    )
  }

  let output
  try {
    output = await transcribeNotesPage({
      apiKey: ctx.env.OPENROUTER_API_KEY,
      config,
      image,
      mimeType,
      abortSignal: ctx.req.raw?.signal,
    })
  } catch (e) {
    Sentry.captureException(e)
    console.error('notes-import transcribe model_error', errorDetail(e))
    return err(
      ctx,
      HTTP_STATUS.BAD_GATEWAY,
      'The page could not be read',
      'model_error',
      devBypass ? errorDetail(e) : undefined
    )
  }
  // Usage and routing only, for cost and ZDR audits; never the text or image.
  console.log(
    `notes-import transcribe model=${config.transcribeModel} ` +
      `provider=${output.resolvedProvider ?? 'unknown'} bytes=${bytes} ` +
      `chars=${output.text.length} finishReason=${output.finishReason} ` +
      `inputTokens=${output.usage.inputTokens ?? 0} outputTokens=${output.usage.outputTokens ?? 0}`
  )
  return ctx.json({
    ok: true,
    text: output.text,
    truncated: output.finishReason === 'length',
    pagesRemaining: taken.remaining,
  })
}
