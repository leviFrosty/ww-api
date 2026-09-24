import type { Context } from 'hono';

export interface Environment {
  HERE_API_KEY: string;
  SENTRY_DSN: string;
  /**
   * Release name (git commit sha) injected at deploy time via
   * `--var SENTRY_RELEASE:$(sentry-cli releases propose-version)` so Sentry
   * can match events to uploaded source maps. Absent under `wrangler dev`
   * and legacy deploys that skip the flag.
   */
  SENTRY_RELEASE?: string;
  /**
   * Worker Version Metadata binding. Cloudflare populates this at runtime with
   * the deployed version's `id`/`tag`/`timestamp`, so `/health` can report the
   * actual deployed build instead of a stale plaintext var. Configured under
   * `[version_metadata]` in wrangler.toml (repeated for `[env.dev]`).
   */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /**
   * Apple Developer Team ID. Injected into the AASA response so iOS can
   * verify that the declared bundle IDs belong to this team. Also the App ID
   * prefix used to derive the App Attest relying-party id (`<team>.<bundle>`).
   */
  APPLE_TEAM_ID: string;
  RATE_LIMITER: RateLimit;

  // --- Notes Import ------------------------------------------------------

  /**
   * KV namespace backing Notes Import. Stores ONLY non-content metadata:
   * legacy App Attest identity/challenge compatibility records and short-lived
   * SSE subscribe tokens. New App Attest lifecycle state is authoritative in
   * `APP_ATTEST_IDENTITY`.
   * Never notes text or model output (ADR 0008). The per-identity credit meter
   * moved OUT of KV into the `NotesImportIndex` DO (atomic, strongly consistent).
   */
  NOTES_KV: KVNamespace;

  /**
   * Per-install App Attest identity lifecycle. SQLite is authoritative for the
   * active key, recovery verifier, challenges, operation replay, and counters.
   */
  APP_ATTEST_IDENTITY: DurableObjectNamespace<
    import('./appAttest/identityDO').AppAttestIdentity
  >;

  /**
   * Per-import Durable Object: runs the streaming model call in the background
   * and streams progress to the client over SSE (one instance per importId).
   */
  NOTES_IMPORT_RUN: DurableObjectNamespace<
    import('./notesImport/runDO').NotesImportRun
  >;

  /**
   * Per-user Durable Object (one instance per install uuid): enforces the
   * N-concurrent-imports cap, backs the app's active-imports list, and owns the
   * atomic free-credit meter (moved here from KV so check-then-charge can't race).
   */
  NOTES_IMPORT_INDEX: DurableObjectNamespace<
    import('./notesImport/indexDO').NotesImportIndex
  >;

  /** OpenRouter API key (secret). Routed ZDR-only to the inference host. */
  OPENROUTER_API_KEY: string;

  /** RevenueCat REST v1 secret key (`sk_...`) for server-side supporter checks (secret). */
  REVENUECAT_API_KEY: string;

  /** Explicit Worker environment; production fails closed if a dev bypass exists. */
  APP_ATTEST_ENVIRONMENT: 'development' | 'production';

  /**
   * Primary iOS bundle id, e.g. `com.leviwilkerson.jwtime`. Part of the App
   * Attest app id; keys stored without a bound bundle id verify against it.
   */
  IOS_BUNDLE_ID: string;

  /**
   * Optional comma-separated extra bundle ids whose App Attest keys are also
   * accepted (prod: the internal TestFlight beta `com.leviwilkerson.jwtimebeta`).
   * Each key is bound to the bundle id it attested with; its assertions verify
   * only against that id.
   */
  IOS_ADDITIONAL_BUNDLE_IDS?: string;

  /** RevenueCat entitlement id that denotes a Supporter. Default `Supporter`. */
  REVENUECAT_ENTITLEMENT_ID?: string;

  /** Override the model slug. Default `deepseek/deepseek-v4-flash`. */
  NOTES_IMPORT_MODEL?: string;

  /**
   * Comma-separated OpenRouter provider allowlist, in routing-priority order
   * (drives both `only` and `order`). Pins inference to vetted **Western** ZDR
   * hosts (ADR 0008) — keep it Western-only; `zdr: true` enforces retention
   * separately. Default `fireworks,digitalocean` (Fireworks preferred for
   * genuine reasoning, DigitalOcean the large 429 fallback; DeepInfra excluded —
   * mislabels reasoning).
   */
  NOTES_IMPORT_PROVIDERS?: string;

  /** Hard reject notes longer than this many characters. Default 100000. */
  NOTES_IMPORT_MAX_CHARS?: string;

  /** `maxOutputTokens` ceiling for the model call. Default 16000. */
  NOTES_IMPORT_MAX_OUTPUT_TOKENS?: string;

  /** Free-tier imports per fixed window. -1 unlimited, 0 none, default 5. */
  NOTES_IMPORT_FREE_CREDITS?: string;

  /** Supporter imports per fixed window. -1 unlimited, 0 none, default -1. */
  NOTES_IMPORT_FREE_CREDITS_SUPPORTER?: string;

  /** Free-tier lifetime refinements per content hash. Default 5. */
  NOTES_IMPORT_MAX_REFINEMENTS?: string;

  /** Supporter lifetime refinements per content hash. Default -1. */
  NOTES_IMPORT_MAX_REFINEMENTS_SUPPORTER?: string;

  /** Fixed import-window duration in days; positive fractions allowed. Default 30. */
  NOTES_IMPORT_WINDOW_DAYS?: string;

  /**
   * Minimum app version (`major.minor.patch`) allowed to use Notes Import;
   * surfaced as `minAppVersion` on GET /notes-import/status. KV
   * `notes-import:min-version` overrides. Unset = no floor.
   */
  NOTES_IMPORT_MIN_APP_VERSION?: string;

  /** Rolling window (seconds) for counting free Empty Imports. Default 604800 (7d). */
  NOTES_IMPORT_EMPTY_WINDOW_SECONDS?: string;

  /** Free Empty Imports per window before they charge a credit again. Default 5. */
  NOTES_IMPORT_EMPTY_WINDOW_LIMIT?: string;

  /** Max concurrent in-flight imports per identity (non-Supporter). Default 2. */
  NOTES_IMPORT_ACTIVE_CAP?: string;

  /** Max concurrent in-flight imports per identity (Supporter). Default 5. */
  NOTES_IMPORT_ACTIVE_CAP_SUPPORTER?: string;

  /** Seconds a finished import's result is retained for reconnect. Default 3600. */
  NOTES_IMPORT_RESULT_RETENTION_SECONDS?: string;

  /** TTL of a subscribe capability token. Default 3600. */
  NOTES_IMPORT_SUBSCRIBE_TOKEN_TTL_SECONDS?: string;

  /**
   * OpenRouter reasoning effort. For `deepseek-v4-flash` only `high` and `xhigh`
   * are valid; `xhigh` is the model's max ("Think Max"). DEFAULT `xhigh`. `max`
   * is accepted here but coerced to `xhigh` (raw `max` is invalid on OpenRouter
   * and silently degrades). `off`/`none`/empty disables. The model co-emits
   * reasoning + strict structured output; a buggy ZDR host's parser may misroute
   * the JSON into the reasoning channel, which the run DO recovers.
   */
  NOTES_IMPORT_REASONING_EFFORT?: string;

  /**
   * When set, a request carrying header `x-ww-dev-bypass: <this value>` skips
   * App Attest verification. Set ONLY on a dev/staging worker so the iOS
   * simulator (no Secure Enclave) can exercise the flow. Unset in production.
   */
  NOTES_IMPORT_DEV_BYPASS_TOKEN?: string;

  /** Dedicated admin reset credential. Secret; distinct per prod/dev worker. */
  ADMIN_API_TOKEN?: string;
}

export type AppContext = Context<{ Bindings: Environment }>;

export interface HealthCheckResponse {
  status: 'ok';
  /** Current server time (request handling time). */
  timestamp: string;
  /** Deployed Worker version id (from the version_metadata binding). */
  versionId: string;
  /** Optional version tag, if one was set at upload (`wrangler versions upload --tag`). */
  versionTag?: string;
  /** ISO timestamp of when this Worker version was uploaded (from version_metadata). */
  deployedAt: string;
}

export interface ErrorResponse {
  error: string;
  /** Stable machine-readable code so the app can branch (e.g. show the paywall). */
  code?: string;
  /** Stable App Attest failure reason (additive to the legacy `code`). */
  reason?: import('./appAttest/errors').AppAttestReason;
  /** Recovery-safe next action; transient failures never request key rotation. */
  action?: import('./appAttest/errors').AppAttestAction;
  /**
   * Underlying error detail, surfaced ONLY to dev-bypass callers (i.e. DEV app
   * builds) so the real cause of an otherwise-opaque failure (e.g. `model_error`)
   * is visible on-device. Never populated for attested production requests.
   */
  detail?: string;
  /** Required authoritative state on structured usage denials. */
  credits?: import('./credits').CreditsSnapshot;
}
