/**
 * The Hono app: every HTTP route the Worker serves. `src/index.ts` wraps it
 * with Sentry and the cron handler, and re-exports the Durable Objects.
 */
import { Hono } from "hono";
import type { Environment, AppContext, HealthCheckResponse } from "./types";
import { HERE_API, HTTP_STATUS } from "./config";
import { apiError, dateHeader } from "./errors";
import { rateLimit } from "./rateLimit";
import { proxyRequestToHereApi } from "./proxy";
import {
  handleAasaRequest,
  handleContactLinkRequest,
  handleLegacyContactLinkRequest,
} from "./contactLink";
import {
  handleNotesImportRequest,
  handleNotesImportStatusRequest,
  handleNotesImportKickoffRequest,
  handleNotesImportTranscribeRequest,
  handleNotesImportEventsRequest,
  handleNotesImportResultRequest,
  handleNotesImportCancelRequest,
  handleNotesImportDestroyRequest,
  handleNotesImportAdminResetRequest,
} from "./notesImport/route";
import {
  cancelDocs as notesImportCancelDocs,
  destroyDocs as notesImportDestroyDocs,
  eventsDocs as notesImportEventsDocs,
  kickoffDocs as notesImportKickoffDocs,
  legacyImportDocs as notesImportLegacyDocs,
  resultDocs as notesImportResultDocs,
  statusDocs as notesImportStatusDocs,
  transcribeDocs as notesImportTranscribeDocs,
} from "./notesImport/openapi";
import {
  ATTESTATION_BASE_PATH,
  deprecatedPath,
  handleAttestationChallengeRequest,
  handleAttestationRegisterRequest,
  handleAttestationStatusRequest,
  handleAttestationVerifyRequest,
} from "./attestation/route";
import {
  challengeDocs as attestationChallengeDocs,
  legacyAttestDocs,
  legacyChallengeDocs,
  legacyVerifyDocs,
  registerDocs as attestationRegisterDocs,
  statusDocs as attestationStatusDocs,
  verifyDocs as attestationVerifyDocs,
} from "./attestation/openapi";
import { handleAppStoreRatingsRequest } from "./appStoreRatings/route";
import { handleAppConfigRequest } from "./appConfig";
import { Sentry } from "./sentry";
import { createBuddiesRoutes } from "./buddies/route";
import { createAccountsRoutes } from "./accounts/route";
import { createAccountsAdminRoutes } from "./accounts/admin";
import { handleBuddyInvitePage } from "./buddies/invitePage";
import { handleHandoffPage } from "./accounts/handoffPage";
import { createRoutePlanningRoutes } from "./routePlanning/route";
import { mountApiDocs } from "./openapi/route";
import {
  aasaDocs,
  appConfigDocs,
  appStoreRatingsDocs,
  autocompleteDocs,
  buddyInvitePageDocs,
  handoffPageDocs,
  contactLinkDocs,
  geocodeDocs,
  healthDocs,
  legacyContactLinkDocs,
  shortBuddyInvitePageDocs,
  shortContactLinkDocs,
  shortHandoffPageDocs,
  notesImportAdminResetDocs,
} from "./openapi/coreDocs";

export const app = new Hono<{ Bindings: Environment }>();

async function handleGeocodeRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.GEOCODE_URL);
}

async function handleAutocompleteRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.AUTOCOMPLETE_URL);
}

/**
 * Liveness plus the server clock. Clients calibrate against `Date` (and
 * `serverTime`, epoch ms) before signing time-bound requests (Buddies `ts`),
 * so it is never cached anywhere: a cached copy would carry an old clock. No
 * I/O, no rate limit.
 */
function handleHealthCheckRequest(context: AppContext) {
  const now = Date.now();
  const response: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date(now).toISOString(),
    serverTime: now,
    versionId: context.env.CF_VERSION_METADATA.id,
    versionTag: context.env.CF_VERSION_METADATA.tag || undefined,
    deployedAt: context.env.CF_VERSION_METADATA.timestamp,
  };
  return context.json(response, 200, {
    "Cache-Control": "no-store",
    ...dateHeader(now),
  });
}

function handleNotFound() {
  return apiError(HTTP_STATUS.NOT_FOUND, "not_found");
}

function handleApplicationError(error: Error) {
  Sentry.captureException(error);
  console.error("Application error:", error);
  return apiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, "server_error");
}

// Each family counts in its own per-IP bucket (src/rateLimit.ts).
app.use("/geocode", rateLimit("places"));
app.use("/autocomplete", rateLimit("places"));
app.use("/notes-import", rateLimit("notes-import"));
app.use("/notes-import/*", rateLimit("notes-import"));
app.use("/attestation/*", rateLimit("attestation"));
app.use("/admin/*", rateLimit("admin"));
app.use("/route-planning/*", rateLimit("route-planning"));
app.use("/app/v1/*", rateLimit("app"));

app.get("/geocode", geocodeDocs, handleGeocodeRequest);
app.get("/autocomplete", autocompleteDocs, handleAutocompleteRequest);
app.get("/health", healthDocs, handleHealthCheckRequest);
// The app's minimum version (Update Required), read at launch and foreground.
app.get("/app/v1/config", appConfigDocs, handleAppConfigRequest);
// Paywall social proof (App Store ratings), edge-cached; refreshed by cron.
app.get(
  "/app-store/ratings",
  appStoreRatingsDocs,
  handleAppStoreRatingsRequest
);
// Device attestation for the whole API (App Attest on iOS, Play Integrity on
// Android): challenges, App Attest key registration, and a diagnostic verify.
// Each protected route checks its own assertion (src/attestation/http.ts).
const attestationPath = (op: string) => `${ATTESTATION_BASE_PATH}/${op}`;
app.get(
  attestationPath("status"),
  attestationStatusDocs,
  handleAttestationStatusRequest
);
app.post(
  attestationPath("challenge"),
  attestationChallengeDocs,
  handleAttestationChallengeRequest
);
app.post(
  attestationPath("register"),
  attestationRegisterDocs,
  handleAttestationRegisterRequest
);
app.post(
  attestationPath("verify"),
  attestationVerifyDocs,
  handleAttestationVerifyRequest
);
// Notes Import: availability probe, the metered calls, and its run routes.
app.get(
  "/notes-import/status",
  notesImportStatusDocs,
  handleNotesImportStatusRequest
);
// The attestation routes' old paths, for deployed apps: same handlers, plus a
// `Deprecation` header. Remove once the minimum app version uses the new ones.
app.post(
  "/notes-import/challenge",
  legacyChallengeDocs,
  deprecatedPath("/notes-import/challenge", attestationPath("challenge")),
  handleAttestationChallengeRequest
);
app.post(
  "/notes-import/attest",
  legacyAttestDocs,
  deprecatedPath("/notes-import/attest", attestationPath("register")),
  handleAttestationRegisterRequest
);
app.post(
  "/notes-import/verify",
  legacyVerifyDocs,
  deprecatedPath("/notes-import/verify", attestationPath("verify")),
  handleAttestationVerifyRequest
);
// Streaming import: attested kickoff → SSE progress stream → result snapshot.
app.post(
  "/notes-import/kickoff",
  notesImportKickoffDocs,
  handleNotesImportKickoffRequest
);
app.post(
  "/notes-import/transcribe",
  notesImportTranscribeDocs,
  handleNotesImportTranscribeRequest
);
app.get(
  "/notes-import/:importId/events",
  notesImportEventsDocs,
  handleNotesImportEventsRequest
);
app.get(
  "/notes-import/:importId/result",
  notesImportResultDocs,
  handleNotesImportResultRequest
);
app.post(
  "/notes-import/:importId/cancel",
  notesImportCancelDocs,
  handleNotesImportCancelRequest
);
app.post(
  "/notes-import/:importId/destroy",
  notesImportDestroyDocs,
  handleNotesImportDestroyRequest
);
// Legacy synchronous path (fallback during cutover).
app.post("/notes-import", notesImportLegacyDocs, handleNotesImportRequest);
// Maintainer-only usage reset (secret auth inside handler; 404 fail-closed).
app.post(
  "/admin/notes-import/reset",
  notesImportAdminResetDocs,
  handleNotesImportAdminResetRequest
);
// Account moderation: look up and suspend accounts (token auth; 404 fail-closed).
app.route("/admin/accounts", createAccountsAdminRoutes());
// Universal-link support for WitnessWork contact sharing. AASA must be served
// at this exact path with Content-Type application/json and no redirects.
app.get("/.well-known/apple-app-site-association", aasaDocs, handleAasaRequest);
// Shared contacts ride in the fragment (`/contacts#<payload>`), which never
// reaches the worker. The short `/c` (and `/c/:payload`, from the oldest
// builds) are in links people already sent, so they stay for good.
app.get("/contacts", contactLinkDocs, handleContactLinkRequest);
app.get("/c", shortContactLinkDocs, handleContactLinkRequest);
app.get("/c/:payload", legacyContactLinkDocs, handleLegacyContactLinkRequest);
// Buddies relay: POST /buddies/v1/{op}, ids only in bodies. Every op is
// rate-limited per caller inside the handler (src/buddies/limits.ts).
app.route("/buddies/v1", createBuddiesRoutes());
// Anonymous accounts (witness-work ADR 0024, 0026): POST /accounts/v1/{op},
// signed like Buddies ops (handoff's new-phone ops carry a claim token
// instead) and rate-limited per caller inside the handler.
app.route("/accounts/v1", createAccountsRoutes());
// Buddy invite no-app fallback; the invite secret stays in the URL fragment.
// `/b` is the short path in invites already sent.
app.get("/buddies/invite", buddyInvitePageDocs, handleBuddyInvitePage);
app.get("/b", shortBuddyInvitePageDocs, handleBuddyInvitePage);
// Set Up Another Device QR codes opened by a camera instead of the app; the
// handoff secret stays in the URL fragment. `/h` is the short path.
app.get("/accounts/handoff", handoffPageDocs, handleHandoffPage);
app.get("/h", shortHandoffPageDocs, handleHandoffPage);
// Supporter-only route ordering (HERE Waypoints Sequence); coordinates only,
// with per-account limits in the RoutePlanningQuota DO.
app.route("/route-planning", createRoutePlanningRoutes());
// The OpenAPI document and Scalar reference for every route above.
mountApiDocs(app);
app.notFound(handleNotFound);
app.onError(handleApplicationError);
