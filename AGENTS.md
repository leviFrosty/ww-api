# Agent guide — ww-proxy

This codebase is the backend API that powers the WitnessWork expo (react native) application found at ~/dev/witness-work.

A Cloudflare Workers API/proxy (HERE API, iOS universal links, Notes Import). See
`README.md` for general setup; this file documents agent-relevant operational
details, primarily the **environments**.

## Environments

There are two deployed Workers, defined in `wrangler.toml`:

| Env  | Worker name    | URL                                          | Deploy command        |
| ---- | -------------- | -------------------------------------------- | --------------------- |
| prod | `ww-proxy`     | `https://ww-proxy.leviwilkerson.com`         | `pnpm run deploy`     |
| dev  | `ww-proxy-dev` | `https://ww-proxy-dev.<subdomain>.workers.dev` | `pnpm run deploy:dev` |

Prefer the `pnpm run deploy*` scripts over raw `wrangler deploy` — they also
inject the `SENTRY_RELEASE` var and upload source maps to Sentry (see
[Sentry source maps](#sentry-source-maps) below). CI (`.github/workflows/deploy.yml`)
deploys prod on `v*` tags with the same source map upload.

`dev` is a **fully separate Worker** — its own name, KV namespace, rate-limit
namespace, secrets, and `workers.dev` URL. `wrangler deploy --env dev` can never
overwrite prod. Plain `wrangler deploy` always targets prod, so the `--env dev`
flag is the isolation boundary.

The dev worker exists for **real-device App Attest end-to-end testing**: it pins
to the dev iOS bundle id `com.leviwilkerson.jwtimedev` (from witness-work
`app.config.ts`, `IS_DEV` branch) and is the only place
`NOTES_IMPORT_DEV_BYPASS_TOKEN` should ever be set — **never on prod.**

### App Attest bundle ids

Prod accepts App Attest keys from two apps: the App Store app
(`IOS_BUNDLE_ID = com.leviwilkerson.jwtime`) and the internal-TestFlight
"WitnessWork Beta" app (`IOS_ADDITIONAL_BUNDLE_IDS = com.leviwilkerson.jwtimebeta`,
comma-separated, top-level `[vars]` only). TestFlight builds always use Apple's
production App Attest environment, so Beta talks to the prod worker, not dev.

An attestation must match one accepted App ID (`<APPLE_TEAM_ID>.<bundle id>`);
the matched bundle id is stored on the key's `AppAttestIdentity` row (and its
KV mirror), and every later assertion for that key verifies against that bound
id only. Keys stored before binding (NULL / absent) are bound to
`IOS_BUNDLE_ID`. Removing a bundle id from config makes its bound keys fail
closed. `APP_ATTEST_ENVIRONMENT` is independent of the bundle id.

Note: in Wrangler, `vars`, `kv_namespaces`, and `ratelimits` are **not inherited**
by a named env, so they are repeated under `[env.dev]` in `wrangler.toml`. Keep
them in sync with the top-level prod config when adding new bindings.

## Deploying to dev (one-time setup)

```bash
# 1. Create a dedicated dev KV namespace, then paste the printed id into
#    wrangler.toml under [[env.dev.kv_namespaces]] (replacing REPLACE_WITH_DEV_NOTES_KV_ID).
wrangler kv namespace create NOTES_KV --env dev

# 2. Set the dev worker's secrets (the --env dev flag keeps them off prod).
wrangler secret put OPENROUTER_API_KEY --env dev
wrangler secret put REVENUECAT_API_KEY --env dev
wrangler secret put NOTES_IMPORT_DEV_BYPASS_TOKEN --env dev   # dev only
wrangler secret put ADMIN_API_TOKEN --env dev  # unique dev reset token
# Plus any other secrets prod uses that dev needs (HERE_API_KEY, SENTRY_DSN, ...).
# Production uses a different token: wrangler secret put ADMIN_API_TOKEN

# 3. Deploy.
wrangler deploy --env dev
```

After setup, redeploying dev is just:

```bash
pnpm run deploy:dev
```

## Local iteration (no deploy)

```bash
wrangler dev                 # local runtime
wrangler dev --remote --env dev   # Cloudflare edge with dev bindings
```

Neither gives a stable public URL for an iOS device — use the deployed
`--env dev` worker (or a `cloudflared` tunnel) for real-device App Attest tests.

## Notes Import runtime limits and admin reset

Allowance policy lives in each environment's `NOTES_KV` under
`notes-import:limits` and is edge-cached for 60 seconds. Its JSON shape is:

```json
{"importsFree":5,"importsSupporter":-1,"refinementsFree":5,"refinementsSupporter":-1,"windowDays":30}
```

Each field independently resolves KV → the matching `wrangler.toml` env var →
code default. Allowances accept integer `-1` (unlimited), `0` (none), or a
positive value; `windowDays` accepts any positive finite number, including
fractions for short dev windows.

### Minimum app version

`GET /notes-import/status` also returns `minAppVersion` (`major.minor.patch`)
when a floor is configured. The app compares it against its own
`app.config.ts` version; below the floor it disables the Notes Import composer
and shows an "update required" message with an App Store link. The worker does
not reject requests — this is a client-side gate only. Bump it right after
deploying a contract-breaking change:

```bash
wrangler kv key put --binding NOTES_KV notes-import:min-version '{"minVersion":"1.42.0"}'            # production
wrangler kv key put --binding NOTES_KV notes-import:min-version '{"minVersion":"1.42.0"}' --env dev  # development
wrangler kv key delete --binding NOTES_KV notes-import:min-version                                   # remove the floor
```

Resolution is KV → `NOTES_IMPORT_MIN_APP_VERSION` env var → unset (no floor);
invalid values are logged and ignored. The read is edge-cached for 60 seconds.

To reset one meter's rolling aggregate and Empty Import rows while preserving
permanent replay/refinement records, copy `.env.example` to the gitignored
`.env`, set the environment-specific token/URL, then run:

```bash
pnpm run admin:reset-usage <meterId>         # production
pnpm run admin:reset-usage --dev <meterId>   # development
```

`ADMIN_API_TOKEN` and `ADMIN_API_TOKEN_DEV` must match separate Wrangler
`ADMIN_API_TOKEN` secrets in prod/dev. Never reuse the development bypass token.

## Status caching and trace sampling

`GET /notes-import/status` reuses completed public responses in each Worker
isolate for up to 30 seconds, scoped to the current environment. Degraded
fail-open responses without limits are not cached. The response uses
`Cache-Control: no-store`; no CDN or browser cache should add another window.
The app shares concurrent availability probes and may reuse a valid result for
another 30 seconds. Together these UI hints can lag by up to 60 seconds beyond
existing KV propagation/cache delays (limits and minimum version use 60-second
KV edge caching). This is a reuse window, not automatic client polling.

Import enforcement bypasses the public-response cache and still checks the
kill-switch and authoritative allowances. The OpenRouter metadata probe has a
2-second deadline covering both headers and body consumption. Worker requests
do not share pending I/O promises; simultaneous cold misses may probe separately.

Sentry traces retain 100% of development and Notes Import operation traffic.
Production status, HERE proxy, health, contact-link and other routine routes use
10% trace sampling, overriding propagated parent sampling decisions. Error
capture and contact-data redaction remain unchanged; Cloudflare logging retains
its existing sampling configuration.

## Buddies

`POST /buddies/v1/{op}` is the Buddies relay, built to the wire contract in
[`docs/buddies-protocol.md`](docs/buddies-protocol.md) (the witness-work repo
holds the canonical copy). Code lives in `src/buddies/`. `GET /b` is the
no-app fallback page for invite links, and the AASA matches `/b#1…`.

- **Bindings** (repeated under `[env.dev]`): `BUDDY_INBOX` (`BuddyInbox`, one
  SQLite DO per `inboxId`), `BUDDY_INVITE` (`BuddyInvite`, one per `inviteId`),
  migration `v3`, `BUDDIES_RATE_LIMITER` (30/min per IP for `invite/fetch` and
  `invite/claim`; namespace 1002 prod, 2002 dev), and the `BUDDIES_ENABLED` var
  (`"false"` prod, `"true"` dev).
- **Secrets** (per environment): `APNS_KEY_ID` and `APNS_PRIVATE_KEY` (the
  `.p8` PEM). `APPLE_TEAM_ID` is the JWT issuer and `IOS_BUNDLE_ID` the APNs
  topic. Without the two APNs secrets the relay still works but skips pushes,
  logging once per isolate.
- **Kill switch**: KV `buddies:enabled` in `NOTES_KV`. `"true"` enables, any
  other value disables, and an absent key falls back to `BUDDIES_ENABLED`. The
  read is edge-cached for 60 seconds. `inbox/delete`, `slot/remove`, and
  `slot/leave` work even when disabled.
- **Push**: `src/apns.ts` is the feature-neutral APNs sender (provider token
  cached in KV `apns:provider-token`, one outcome per notification, one
  retry for network errors, 429, 5xx, and rejected provider tokens).
  `src/buddies/push.ts` builds the Buddies payload and deletes unregistered
  devices. Other features should build on `sendApnsNotifications`, not on the
  Buddies layer.
- **Privacy**: every id travels in the body. Never log or report bodies, blobs,
  ids, or tokens. APNs requests use the `fetch` captured before Sentry wraps
  the global, so device tokens in APNs URLs stay out of Sentry spans. The dev
  worker's 100% Workers traces do record subrequest URLs, APNs included.
- **Not yet built** (required before any production rollout): App Attest on
  `inbox/register` and `invite/*` (`attest` is accepted and ignored), and
  Notification Service Extension payloads.

Dev deploy (first time):

```bash
wrangler secret put APNS_KEY_ID --env dev
wrangler secret put APNS_PRIVATE_KEY --env dev < AuthKey_XXXXXXXXXX.p8
pnpm run deploy:dev   # applies the v3 migration to ww-proxy-dev
# Optional; dev is already on via BUDDIES_ENABLED:
wrangler kv key put --binding NOTES_KV buddies:enabled true --env dev
```

Production takes the same two secrets without `--env dev`, and the `v3`
migration applies on the next `pnpm run deploy`. Buddies stays off there
(`BUDDIES_ENABLED = "false"`) until the KV key flips it. The AASA `/b` entry
only goes live with a prod deploy. iOS caches the AASA, so ship it at least one
app version before the invite UI.

## App Store ratings (paywall social proof)

`GET /app-store/ratings` returns `{averageRating, ratingCount, countryCount,
updatedAt}` for the app's paywall. App Store Connect's API only exposes written
reviews, so totals come from Apple's public iTunes lookup, summed across all
175 storefronts (`src/appStoreRatings/storefronts.ts`, from ASC
`/v1/territories`). The hourly cron (`[triggers]`) sweeps 40 storefronts per run
into `NOTES_KV` (`app-store-ratings:state`), publishes
`app-store-ratings:summary` when a full sweep finishes, then rests until that
sweep is 24 hours old. A failed storefront lookup keeps its previous value.

The route serves from the colo Cache API (`s-maxage` 6h) with a 1h edge-cached
KV read on a miss, and returns `503 no-store` until the first sweep completes
(~5 hours after the first deploy). The app persists the body for 7 days and
falls back to a bundled snapshot until then.

## Checks before deploy

```bash
pnpm test
pnpm exec tsc --noEmit
wrangler deploy --dry-run            # prod build
wrangler deploy --env dev --dry-run  # dev build
```

## Sentry source maps

Errors are reported with `release: SENTRY_RELEASE` (the git commit sha,
injected as a deploy-time var). The `pnpm run deploy` / `deploy:dev` scripts
build with `--outdir dist` and then run `pnpm run sentry:sourcemaps`, which
uploads `dist/` to Sentry tagged with that release so stack traces show
original TypeScript. Org/project defaults live in `.sentryclirc` (org
`levi-wilkerson`, project `ww-proxy`).

Auth: `sentry-cli` needs `SENTRY_AUTH_TOKEN` in the environment — an org auth
token with source map upload (`project:releases`) scope, created at
https://levi-wilkerson.sentry.io/settings/auth-tokens/. Locally export it in
your shell (or put it in `~/.sentryclirc`); in CI it is the `SENTRY_AUTH_TOKEN`
repo secret. Never commit it.

`wrangler.toml` also sets `upload_source_maps = true` (inherited by
`[env.dev]`), so Cloudflare's own dashboard/tail stack traces are mapped even
on raw `wrangler deploy`.

## Backlog

- **Notes Import streaming / Durable Objects migration** — DONE (2026-06-23).
  The model run now streams from two SQLite Durable Objects (`NotesImportRun`
  per import, `NotesImportIndex` per user for the concurrency cap), via AI SDK
  v6 `streamText` + `Output.object`. Attested kickoff (`POST
  /notes-import/kickoff`) → SSE progress stream (`GET /notes-import/:id/events`)
  → result snapshot (`/result`); the legacy `POST /notes-import` remains as a
  fallback. First deploy applies the `v1` DO migration automatically (prod +
  `--env dev`). Reasoning is ON by default at `xhigh`
  (`NOTES_IMPORT_REASONING_EFFORT`) — on OpenRouter `deepseek-v4-flash` accepts
  only `high`/`xhigh`, and `xhigh` IS its max ("Think Max"); `max` is invalid
  there and coerced to `xhigh`. The model co-emits reasoning and strict
  structured output. A buggy ZDR-host parser can misroute the JSON into the
  reasoning channel (blank completion); the run DO recovers it, so reasoning
  stays on. `usage.reasoningTokens` is logged per run. Architecture + resolved
  decisions:
  [`docs/notes-import-streaming-durable-objects.md`](docs/notes-import-streaming-durable-objects.md).
