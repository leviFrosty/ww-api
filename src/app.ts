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
  handleChallengeRequest,
  handleAttestRequest,
  handleNotesImportVerifyRequest,
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
  attestDocs as notesImportAttestDocs,
  cancelDocs as notesImportCancelDocs,
  challengeDocs as notesImportChallengeDocs,
  destroyDocs as notesImportDestroyDocs,
  eventsDocs as notesImportEventsDocs,
  kickoffDocs as notesImportKickoffDocs,
  legacyImportDocs as notesImportLegacyDocs,
  resultDocs as notesImportResultDocs,
  statusDocs as notesImportStatusDocs,
  transcribeDocs as notesImportTranscribeDocs,
  verifyDocs as notesImportVerifyDocs,
} from "./notesImport/openapi";
import { handleAppStoreRatingsRequest } from "./appStoreRatings/route";
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
  appStoreRatingsDocs,
  autocompleteDocs,
  buddyInvitePageDocs,
  handoffPageDocs,
  contactLinkDocs,
  geocodeDocs,
  healthDocs,
  legacyContactLinkDocs,
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
app.use("/admin/*", rateLimit("admin"));
app.use("/route-planning/*", rateLimit("route-planning"));

app.get("/geocode", geocodeDocs, handleGeocodeRequest);
app.get("/autocomplete", autocompleteDocs, handleAutocompleteRequest);
app.get("/health", healthDocs, handleHealthCheckRequest);
// Paywall social proof (App Store ratings), edge-cached; refreshed by cron.
app.get(
  "/app-store/ratings",
  appStoreRatingsDocs,
  handleAppStoreRatingsRequest
);
// Notes Import: availability probe, App Attest handshake + the metered call.
app.get(
  "/notes-import/status",
  notesImportStatusDocs,
  handleNotesImportStatusRequest
);
app.post(
  "/notes-import/challenge",
  notesImportChallengeDocs,
  handleChallengeRequest
);
app.post("/notes-import/attest", notesImportAttestDocs, handleAttestRequest);
// Attested no-op: dev-tools diagnostics prove the assertion path server-side.
app.post(
  "/notes-import/verify",
  notesImportVerifyDocs,
  handleNotesImportVerifyRequest
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
// Shared contacts ride in the fragment (`/c#<payload>`), which never reaches
// the worker. `/c/:payload` keeps links from older app versions working.
app.get("/c", contactLinkDocs, handleContactLinkRequest);
app.get("/c/:payload", legacyContactLinkDocs, handleLegacyContactLinkRequest);
// Buddies relay: POST /buddies/v1/{op}, ids only in bodies. Every op is
// rate-limited per caller inside the handler (src/buddies/limits.ts).
app.route("/buddies/v1", createBuddiesRoutes());
// Anonymous accounts (witness-work ADR 0024, 0026): POST /accounts/v1/{op},
// signed like Buddies ops (handoff's new-phone ops carry a claim token
// instead) and rate-limited per caller inside the handler.
app.route("/accounts/v1", createAccountsRoutes());
// Buddy invite no-app fallback; the invite secret stays in the URL fragment.
app.get("/b", buddyInvitePageDocs, handleBuddyInvitePage);
// Set Up Another Device QR codes opened by a camera instead of the app; the
// handoff secret stays in the URL fragment.
app.get("/h", handoffPageDocs, handleHandoffPage);
// Supporter-only route ordering (HERE Waypoints Sequence); coordinates only,
// with per-account limits in the RoutePlanningQuota DO.
app.route("/route-planning", createRoutePlanningRoutes());
// The OpenAPI document and Scalar reference for every route above.
mountApiDocs(app);
app.notFound(handleNotFound);
app.onError(handleApplicationError);
