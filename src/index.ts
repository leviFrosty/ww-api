import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type {
  Environment,
  AppContext,
  HealthCheckResponse,
  ErrorResponse,
} from "./types";
import { HERE_API, HTTP_STATUS } from "./config";
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
  handleNotesImportEventsRequest,
  handleNotesImportResultRequest,
  handleNotesImportCancelRequest,
  handleNotesImportDestroyRequest,
  handleNotesImportAdminResetRequest,
} from "./notesImport/route";
import { Sentry, createSentryConfig } from "./sentry";
import { createBuddiesRoutes } from "./buddies/route";
import { handleBuddyInvitePage } from "./buddies/invitePage";

// Durable Object classes must be re-exported from the entry module so Wrangler
// can bind them (see wrangler.toml [[durable_objects.bindings]] + migrations).
export { NotesImportRun } from "./notesImport/runDO";
export { NotesImportIndex } from "./notesImport/indexDO";
export { AppAttestIdentity } from "./appAttest/identityDO";
export { BuddyInbox } from "./buddies/inboxDO";
export { BuddyInvite } from "./buddies/inviteDO";

const app = new Hono<{ Bindings: Environment }>();

const rateLimitMiddleware: MiddlewareHandler<{ Bindings: Environment }> =
  async (context, next) => {
    const clientIp = context.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await context.env.RATE_LIMITER.limit({ key: clientIp });
    if (!success) {
      const response: ErrorResponse = { error: "Rate limit exceeded" };
      return context.json(response, HTTP_STATUS.TOO_MANY_REQUESTS);
    }
    await next();
  };

async function handleGeocodeRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.GEOCODE_URL);
}

async function handleAutocompleteRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.AUTOCOMPLETE_URL);
}

function handleHealthCheckRequest(context: AppContext) {
  const response: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date().toISOString(),
    versionId: context.env.CF_VERSION_METADATA.id,
    versionTag: context.env.CF_VERSION_METADATA.tag || undefined,
    deployedAt: context.env.CF_VERSION_METADATA.timestamp,
  };
  return context.json(response);
}

function handleNotFound(context: AppContext) {
  const response: ErrorResponse = { error: "Not found" };
  return context.json(response, HTTP_STATUS.NOT_FOUND);
}

function handleApplicationError(error: Error, context: AppContext) {
  Sentry.captureException(error);
  console.error("Application error:", error);

  const response: ErrorResponse = { error: "Internal server error" };
  return context.json(response, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

app.use("/geocode", rateLimitMiddleware);
app.use("/autocomplete", rateLimitMiddleware);
app.use("/notes-import", rateLimitMiddleware);
app.use("/notes-import/*", rateLimitMiddleware);
app.use("/admin/*", rateLimitMiddleware);

app.get("/geocode", handleGeocodeRequest);
app.get("/autocomplete", handleAutocompleteRequest);
app.get("/health", handleHealthCheckRequest);
// Notes Import: availability probe, App Attest handshake + the metered call.
app.get("/notes-import/status", handleNotesImportStatusRequest);
app.post("/notes-import/challenge", handleChallengeRequest);
app.post("/notes-import/attest", handleAttestRequest);
// Attested no-op: dev-tools diagnostics prove the assertion path server-side.
app.post("/notes-import/verify", handleNotesImportVerifyRequest);
// Streaming import: attested kickoff → SSE progress stream → result snapshot.
app.post("/notes-import/kickoff", handleNotesImportKickoffRequest);
app.get("/notes-import/:importId/events", handleNotesImportEventsRequest);
app.get("/notes-import/:importId/result", handleNotesImportResultRequest);
app.post("/notes-import/:importId/cancel", handleNotesImportCancelRequest);
app.post("/notes-import/:importId/destroy", handleNotesImportDestroyRequest);
// Legacy synchronous path (fallback during cutover).
app.post("/notes-import", handleNotesImportRequest);
// Maintainer-only usage reset (secret auth inside handler; 404 fail-closed).
app.post("/admin/notes-import/reset", handleNotesImportAdminResetRequest);
// Universal-link support for WitnessWork contact sharing. AASA must be served
// at this exact path with Content-Type application/json and no redirects.
app.get("/.well-known/apple-app-site-association", handleAasaRequest);
// Shared contacts ride in the fragment (`/c#<payload>`), which never reaches
// the worker. `/c/:payload` keeps links from older app versions working.
app.get("/c", handleContactLinkRequest);
app.get("/c/:payload", handleLegacyContactLinkRequest);
// Buddies relay: POST /buddies/v1/{op}, ids only in bodies. Unsigned ops are
// rate-limited by IP inside the handler (BUDDIES_RATE_LIMITER).
app.route("/buddies/v1", createBuddiesRoutes());
// Buddy invite no-app fallback; the invite secret stays in the URL fragment.
app.get("/b", handleBuddyInvitePage);
app.notFound(handleNotFound);
app.onError(handleApplicationError);

export default Sentry.withSentry(
  (environment: Environment) => createSentryConfig(environment),
  {
    async fetch(
      request: Request,
      environment: Environment,
      context: ExecutionContext
    ): Promise<Response> {
      return app.fetch(request, environment, context);
    },
  } satisfies ExportedHandler<Environment>
);
