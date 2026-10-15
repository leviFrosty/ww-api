import type { Environment } from "./types";
import { runRatingsSweepStep } from "./appStoreRatings/ratings";
import { Sentry, createSentryConfig } from "./sentry";
import { app } from "./app";

// Durable Object classes must be re-exported from the entry module so Wrangler
// can bind them (see wrangler.toml [[durable_objects.bindings]] + migrations).
export { NotesImportRun } from "./notesImport/runDO";
export { NotesImportIndex } from "./notesImport/indexDO";
export { AppAttestIdentity } from "./appAttest/identityDO";
export { PlayIntegrityChallenges } from "./playIntegrity/challengeDO";
export { BuddyInbox } from "./buddies/inboxDO";
export { BuddyInvite } from "./buddies/inviteDO";
export { RoutePlanningQuota } from "./routePlanning/quotaDO";
export { BuddyRegistrationQuota } from "./buddies/registrationQuota";
export { AccountHandoff } from "./accounts/handoffDO";

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
    async scheduled(
      _controller: ScheduledController,
      environment: Environment,
      context: ExecutionContext
    ): Promise<void> {
      // Hourly (wrangler.toml [triggers]); idle once a daily sweep is done.
      context.waitUntil(runRatingsSweepStep({ kv: environment.NOTES_KV }));
    },
  } satisfies ExportedHandler<Environment>
);
