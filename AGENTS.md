# Agent guide — ww-proxy

This codebase is the backend API that powers the WitnessWork expo (react native) application found at ~/dev/witness-work.

A Cloudflare Workers API/proxy (HERE API, iOS universal links, Notes Import). See
`README.md` for general setup; this file documents agent-relevant operational
details, primarily the **environments**.

## Environments

There are two deployed API Workers, defined in `wrangler.toml`:

| Env  | Worker name    | URL                                          | Deploy command        |
| ---- | -------------- | -------------------------------------------- | --------------------- |
| prod | `ww-proxy`     | `https://ww-proxy.leviwilkerson.com`         | `pnpm run deploy`     |
| dev  | `ww-proxy-dev` | `https://ww-proxy-dev.<subdomain>.workers.dev` | `pnpm run deploy:dev` |

Three app-update Workers (Hot Updater) are defined separately in
`wrangler-updates.json`, one per app channel, each with its own D1 database and
private R2 bucket of the same name:

| Env  | Worker / D1 / R2  | URL                                                  | Deploy command                                          |
| ---- | ----------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| dev  | `ww-updates-dev`  | `https://ww-updates-dev.levi-wilkerson.workers.dev`  | `pnpm updates:migrate:dev && pnpm updates:deploy:dev`   |
| beta | `ww-updates-beta` | `https://ww-updates-beta.levi-wilkerson.workers.dev` | `pnpm updates:migrate:beta && pnpm updates:deploy:beta` |
| prod | `ww-updates-prod` | `https://ww-updates-prod.levi-wilkerson.workers.dev` | `pnpm updates:migrate:prod && pnpm updates:deploy:prod` |

They share no bindings with ww-proxy, and plain `wrangler deploy` never touches
them. The tag deploy migrates and deploys all three alongside ww-proxy. Setup,
credentials and verification are in [`docs/ota-updates.md`](./docs/ota-updates.md).

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

### Android Notes Import (Play Integrity)

Android authenticates Notes Import with Google Play Integrity standard requests
instead of App Attest (witness-work ADR 0017; code in `src/playIntegrity/`). A
request opts in with `attestationProvider: "play-integrity"` on
`/attestation/v1/challenge`, `/attestation/v1/verify`, and
`/notes-import/kickoff` (and `/transcribe`); bodies without it take the
unchanged App Attest paths. Challenges live in the
`PLAY_INTEGRITY_CHALLENGES` Durable Object (migration `v4`), never in
`AppAttestIdentity`. The worker decodes each token through Google's
`decodeIntegrityToken` with a service account, then requires the request
binding, `PLAY_RECOGNIZED`, and `MEETS_DEVICE_INTEGRITY`. Licensing is not
required.

Both environments are configured. Android is on only while all three
required settings are present; only then does `GET /notes-import/status`
advertise `capabilities.playIntegrity`:

| Setting | Kind | Value |
| --- | --- | --- |
| `ANDROID_PACKAGE_NAME` | var | `com.leviwilkerson.jwtime` |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | var | Google Cloud project number (not the id) |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | secret | Service-account JSON key |
| `ANDROID_CERT_SHA256_DIGESTS` | var, optional | base64url SHA-256 of the Play app-signing certificate |
| `PLAY_INTEGRITY_REQUIRED_DEVICE_VERDICT` | var, optional | `MEETS_DEVICE_INTEGRITY` (default), `MEETS_BASIC_INTEGRITY`, `MEETS_STRONG_INTEGRITY` |

To rotate the key, create a new JSON key for the service account in the
linked Cloud project, `wrangler secret put PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON
< key.json` (and `--env dev`), then delete the downloaded file. Basic/strong
verdicts need an opt-in in Play Console under Play Integrity API → Change
responses.

Development builds (`com.leviwilkerson.jwtimedev`) aren't on Play and
emulators fail device integrity, so exercise real tokens with a
Play-installed `com.leviwilkerson.jwtime` build (an internal testing track);
use the dev bypass otherwise. Failures return `attestation_failed` with a
stable `reason`: `device_integrity_failed`, `app_not_recognized`,
`integrity_token_invalid`, `integrity_unavailable` (Google, credentials, or
quota; reported to Sentry), or a challenge reason. The default quota is 10,000
decodes per day; request more through Google's quota form before it matters.

## Attestation

Device attestation is API-wide, under `/attestation/v1/` (code in
`src/attestation/`): App Attest on iOS, Play Integrity on Android.

| Route | What |
| --- | --- |
| `POST /attestation/v1/challenge` | One-time challenge (App Attest v1/v2, Play Integrity) |
| `POST /attestation/v1/register` | Bind an App Attest key, or enroll a v2 recovery token |
| `POST /attestation/v1/verify` | Attested no-op for the app's developer tools |
| `GET /attestation/v1/status` | Accepted providers (Play Integrity once configured) |

- **Purposes**: every App Attest v2 / Play Integrity assertion signs a
  `purpose`, and each protected route accepts only its own. The registry is
  `ATTESTATION_PURPOSES` in `src/attestation/purposes.ts`. Installed apps sign
  these strings, so **never rename a shipped purpose**. `attestation-verify`
  is verify's purpose; `notes-import-verify` (what deployed apps sign) is
  accepted on verify too. `account-session` opens an account session
  ([Sessions](#sessions-and-bearer-tokens)).
- **Protecting a new route**: add a purpose, have the route recompute its
  `contentHash`/`requestHash` from the payload and reject a mismatch, then
  call `requireAttestation(ctx, body, purpose)` (`src/attestation/http.ts`;
  App Attest v2 or Play Integrity, never v1). A route with its own error
  format calls `verifyAttestation` instead, which resolves with the platform
  (`ios`, `android`) or throws the provider's error with its `reason`.
  Notes Import kickoff keeps its own gate because it still accepts v1. A
  user-scoped route shouldn't attest at all: it takes the session's bearer
  token (see Accounts).
- **Old paths**: `POST /notes-import/challenge`, `/notes-import/attest`, and
  `/notes-import/verify` serve the same handlers for deployed apps. They add
  `Deprecation: @1792022400` (2026-10-15) and
  `Link: </attestation/v1/…>; rel="successor-version"`, are documented as
  deprecated, still count in the `notes-import` rate-limit bucket, and log
  `deprecated path: <old> -> <new>`. Remove them only after the minimum app
  version uses the new paths and those Workers Logs lines stop.
- New paths count in their own `attestation` per-IP bucket and keep 100%
  Sentry trace sampling (status excepted), as they had under Notes Import.

## Link pages

Universal links (and their no-app fallback pages) use readable paths under
their feature: `/contacts#<payload>`, `/buddies/invite#1…`,
`/accounts/handoff#1…`. Older app versions shared the short `/c#…` (and
`/c/<payload>`), `/b#1…`, and `/h#1…`. Those links live on in people's
messages and screenshots, so **the short paths stay routed and in the AASA for
good**; a redirect wouldn't do, because iOS decides from the AASA whether a
tapped URL opens the app. Each page's `og:url` is the path it was served on
(never a payload).

The app must parse the readable paths (and Android's intent filters must list
them) for at least one release before it starts generating them, or people on
older builds get the web page instead of the app.

## Deploying to dev

```bash
pnpm run deploy:dev
```

Secrets are per environment: add `--env dev` to `wrangler secret put` to keep
them off prod (the full list is at the bottom of `wrangler.toml`).
`NOTES_IMPORT_DEV_BYPASS_TOKEN` is dev only, and `ADMIN_API_TOKEN` and
`ACCOUNT_TOKEN_SECRET` differ between the two workers.

## Local iteration (no deploy)

```bash
wrangler dev                 # local runtime
wrangler dev --remote --env dev   # Cloudflare edge with dev bindings
```

For verification, agents use the `verify-ww-api` loop below instead: it runs an
isolated worker on 8790-8799, and 8787 belongs to the user's own `wrangler dev`.

Neither gives a stable public URL for an iOS device — use the deployed
`--env dev` worker (or a `cloudflared` tunnel) for real-device App Attest tests.

## Scribe AI

Scribe AI (witness-work ADR 0032) is one model step per request: the app sends
the conversation, its tool definitions, and an app context; the worker adds the
static system prompt (`src/scribe/prompt.ts`), streams the model's text and
tool calls back as SSE, and charges the step's units to the account's
`ScribeMeter` Durable Object. The device runs every tool. The wire contract is
witness-work's
[`docs/scribe-ai-protocol.md`](https://github.com/leviFrosty/witness-work/blob/main/docs/scribe-ai-protocol.md);
implement it as written and list any deviation in the PR. Code: `src/scribe/`
(`route.ts` handlers, `validate.ts` request rules, `render.ts` wire → model
input, `step.ts` the model call, `meter.ts` + `meterDO.ts` metering,
`status.ts` kill switch and provider health, `legacy.ts` the Notes Import
cutover).

A Cancel or a dropped connection stops the model call through
`c.req.raw.signal`, which aborts only under the `enable_request_signal`
compatibility flag in `wrangler.toml`; keep it. The step is then charged as an
abort (`error_code: "cancelled"`, `usage_estimated`). Under `wrangler dev` the
signal fires on the stream's next write (model output or the 15 s heartbeat),
not at the disconnect itself.

### Configuration (KV and vars)

Every switch lives in `NOTES_KV` and is edge-cached for 60 seconds. Each limit
and model field resolves on its own: KV → environment variable → the code
default (`src/scribe/config.ts`), so one bad KV field falls through without
taking the others with it. A failed KV read counts as absent (fail open).

| Key | Value | Effect |
| --- | --- | --- |
| `scribe:enabled` | `off`/`false`/`0`/`no`/`disabled`, JSON `false`, or `{"available":false}`; absent is on | Kill switch: status says `enabled: false, reason: "disabled"`; step and transcribe answer 503 `disabled` |
| `scribe:disabled-tools` | JSON array or comma list of tool names | Denylist: those tools leave the offered set (`start.dropped`, reason `disabled`) |
| `scribe:protocol-min` | integer ≥ 1 | Steps below it get 426 `upgrade_required` |
| `scribe:min-version` | `{"minVersion":"x.y.z"}` or `x.y.z` | Advisory floor in status (`SCRIBE_MIN_APP_VERSION` otherwise); the worker refuses nothing by version |
| `scribe:limits` | JSON, any subset of the protocol's limits | Windows, weights, grace, caps, sizes, `stepTimeoutMs`, `transcribePagesPerDay` |
| `scribe:model` | JSON `{ model, providers, reasoningEffort, maxOutputTokens, strictTools, cacheKeyBuckets, fallback: { model, providers }, transcribeModel }` | Model and hosts. `reasoningEffort` is `low`, `medium`, `high`, `xhigh`, `max` or `off` (Luna has no `minimal`). `strictTools` and `cacheKeyBuckets` are KV only |
| `scribe:provider-health` | written by the worker | Provider-health cache (300 s TTL, fresh for 60 s); delete it to re-probe now |
| `scribe:legacy-notes-import` | `on` | Re-opens the Notes Import routes (below) |
| `scribe:dev-session` | JSON `{"limits":"real","plan":"supporter"}`, either field | Dev sessions only (no effect in prod, which has none): keep the real limits instead of unlimited, and meter as that plan. For verifying the limit card and Supporter windows |

Environment variables are `SCRIBE_` plus the field path in snake case:
`SCRIBE_FREE_MONTHLY`, `SCRIBE_SUPPORTER_SESSION`, `SCRIBE_SUPPORTER_WEEKLY`,
`SCRIBE_WINDOW_LENGTHS_SESSION_HOURS`, `SCRIBE_GRACE_UNITS`,
`SCRIBE_MAX_INPUT_TOKENS`, `SCRIBE_STEP_TIMEOUT_MS`,
`SCRIBE_TRANSCRIBE_PAGES_PER_DAY_FREE`, and so on, plus `SCRIBE_MODEL`,
`SCRIBE_PROVIDERS` (comma list), `SCRIBE_REASONING_EFFORT` (`off` for none),
`SCRIBE_MAX_OUTPUT_TOKENS`, `SCRIBE_FALLBACK_MODEL`,
`SCRIBE_FALLBACK_PROVIDERS`, and `SCRIBE_TRANSCRIBE_MODEL`.

```bash
# Kill switch (on again: delete the key)
wrangler kv key put --binding NOTES_KV scribe:enabled off
# Withdraw a tool the app defines
wrangler kv key put --binding NOTES_KV scribe:disabled-tools '["visits_log"]'
# Change limits (fields not named keep their var or default)
wrangler kv key put --binding NOTES_KV scribe:limits '{"free":{"monthly":120000}}'
# Less reasoning (faster and cheaper, but drops actions more often; see below)
wrangler kv key put --binding NOTES_KV scribe:model '{"reasoningEffort":"low"}'
# Spread prompt-cache traffic over 4 keys (see Model notes before turning it on)
wrangler kv key put --binding NOTES_KV scribe:model '{"cacheKeyBuckets":4}'
# A fallback for when no allowlisted host serves tool calls for the model
wrangler kv key put --binding NOTES_KV scribe:model '{"fallback":{"model":"openai/<model>","providers":["azure"]}}'
```

Add `--env dev` for the dev worker. `providers` is the ZDR allowlist (ADR
0008): only Western zero-retention hosts, and it's never widened
automatically. A dev session (opened with the dev bypass on the dev worker)
gets unlimited windows and pages, metered as free, unless
`scribe:dev-session` keeps the real limits or names the Supporter plan;
request caps still apply. Locally: `node scripts/verify/dev.mjs kv put
scribe:dev-session '{"limits":"real","plan":"supporter"}'` plus a small
`scribe:limits` reaches the limit card in a minute.

### Model notes (measured)

- Azure serves `openai/gpt-6-luna` without `parallel_tool_calls`, so the
  worker doesn't send it (with `require_parameters` OpenRouter would find no
  host). The model makes parallel calls anyway.
- Every step and page read sends OpenRouter's `user`: `providerUserId`, a
  SHA-256 of the account id under its own label (`ww_` + 32 hex), never the
  id itself and not the analytics id. Without it OpenRouter sends the whole
  key's identity upstream, so one User's provider policy block (GPT-6's
  `bio_policy`/`cyber_policy` 403s) would block every User. Azure still
  routes with `require_parameters` (checked 2026-10-22).
- The app context goes in a user-role message ahead of the conversation, not a
  second system message: system messages are merged ahead of the tool
  definitions, so a per-User context there split the prompt + tools prefix
  every User shares, and step 0 got no cache hit. As a user message, step 0
  caches about 3,500 of its 4,900 input tokens.
- At `low` reasoning the model sometimes leaves out the second of two actions
  in one message (9–10 of 12 multi-action utterances complete, 1.4–3.8 s a
  step); `medium` completed 12 of 12 at 3.6–10 s a step and about 500–1,000
  more units a step. The default is `medium` because a dropped action is worse
  than a slower step; `scribe:model` `{"reasoningEffort":"low"}` trades back.
- OpenRouter's account guardrail answers 403 "Request blocked: prompt
  injection patterns detected" (nothing charged) when the input contains text
  like "ignore previous instructions". A Visit note is enough, and since the
  app resends the whole conversation, every later step would be blocked too.
  So a blocked step is sent once more with every untrusted tool result
  withheld (`render.ts` `WITHHELD_NOTICE`; the model says it couldn't read
  it), and a step blocked again, or with no untrusted text to withhold, ends
  as `done` `refused` instead of a retryable `model_error`. `injection_block`
  in `api_scribe_step` counts both.
- Prompt caching (measured October 2026; `cost` matched to the micro-dollar):
  - GPT-6 Luna on Azure caches implicitly and **writes every uncached token**
    of a prompt of 1,024 tokens or more (all but ≈ 3), billed at 1.25× input.
    Usage reports them (`cache_write_tokens`), and the meter charges them at
    `weights.cacheWrite` (1.25), so 1 unit ≈ $0.0000001 of real cost.
  - The system prompt + tools prefix (≈ 3,860 tokens) is shared across Users
    and conversations without any breakpoint: a new conversation's step 0
    reads it and writes only its context and message.
  - A page is read with caching off (`prompt_cache_options: { mode:
    'explicit' }`, no breakpoints): nothing written or read, 17.6 % cheaper a
    page. A 2,000 px page is ≈ 4,450 input tokens.
  - OpenRouter sends a `prompt_cache_key` of its own when we send none, so
    every step shares one key. Ours (`cacheKeyBuckets`) reaches Azure and
    partitions the cache: each bucket keeps its own copy of the shared prefix
    (one cold write, ≈ 4,800 units, per bucket idle 30 minutes), and turning
    it on costs every User one cold step. Leave it at 0 until Azure's
    overflow applies: sustained traffic above ≈ 15 requests a minute on one
    key (watch step-0 `cached_input_tokens` and `turn_gap` in
    `api_scribe_step`); then set it to about peak Scribe requests a minute ÷
    10.
- Limits are sized from these measurements at medium reasoning and a 50 %
  cache hit rate (real sessions pause between turns, so the prefix cache often
  goes cold), with cache writes at 1.25×: a 7-turn conversation ≈ 54.6k units
  and a quick edit ≈ 7.2k, so the free 150k month fits two longer
  conversations and three quick edits (130.8k) with headroom. Supporter: 540k
  per 5 hours (≈ 9 longer conversations), 1.55M per week (≈ 28). Metering
  writes raised every limit by ≈ 1.19×, which keeps each one's real cost
  where it was.
- Steps and pages read the account's plan through a 30-second per-isolate
  cache (`src/scribe/plan.ts`), started alongside the body read. `GET
  /scribe/v1/usage` always asks afresh, and a refusal never rests on a cached
  plan (it's asked again first), so a new Supporter is never held back.
- `done` is sent only after `settleStep` returns: the next step's admission
  must see this step's charge, and a failed settle must end the step as an
  error rather than leave an answered step uncharged.

### Release and cutover

**Before** a deploy carrying Scribe AI reaches prod or dev, set
`scribe:legacy-notes-import` to `on` in that namespace, or every installed app
on a Notes Import version gets 426 for imports:

```bash
wrangler kv key put --binding NOTES_KV scribe:legacy-notes-import on
wrangler kv key put --binding NOTES_KV scribe:legacy-notes-import on --env dev
```

With it off (or absent), every `/notes-import/*` route except
`GET /notes-import/status` answers 426 `upgrade_required` before its rate
limit, auth, or kill switch, and `/admin/notes-import/reset` is 404. `GET
/notes-import/usage` is 404 too: older composers read it on every open
through the session client, which shows Update Required over the whole app
on a 426, so they'd lose the app instead of seeing the composer's own update
message. A failed
KV read lets the request through. The cutover, once the user decides to run
it, in order:

1. The Scribe AI app version is live on both stores.
2. Older composers show their update message:
   `wrangler kv key put --binding NOTES_KV notes-import:min-version '{"minVersion":"X.Y.Z"}'`
   (that version).
3. Close the old routes:
   `wrangler kv key put --binding NOTES_KV scribe:legacy-notes-import off`.
4. Watch `api_scribe_step` errors and Notes Import 426 counts for a week; then
   a follow-up deletes the Notes Import code.

Undo step 3 with `scribe:legacy-notes-import on`. Each step takes up to 60
seconds to reach every colo.

### Usage reset

`pnpm run admin:reset-usage [--dev] <accountId>` calls `POST
/admin/scribe/reset`: every window of the account back to unused, and its
pages for the day (the log line carries only the previous totals).
`--notes-import` calls the old `POST /admin/notes-import/reset` instead, which
answers only while `scribe:legacy-notes-import` is on.

### Logging and analytics

One JSON line per step (`console.info`) and the same properties to PostHog as
`api_scribe_step` (and `api_scribe_transcribe` per page), with `distinct_id`
the hashed account id and no person profile. Properties: `protocol`, `step`,
`plan`, `platform`, `app_version`, `conversation_id`, `turn_id`, `offered`
(tool names), `offered_count`, `dropped`, `tool_calls` (names), counts of
unknown-tool and bad-args calls, `finish`, token counts (including
`cache_write_tokens`), `units`, `usage_estimated`, `cost_usd` (OpenRouter's
billed USD), `turn_gap` (step 0 of a later turn: minutes since the previous
user message, `<5`, `5-30`, `30-120` or `>120`), `model`, `provider`,
`latency_ms`, `ttft_ms`, `tainted`,
`grace`, `retried_without_reasoning`, `injection_block` (`withheld` or
`refused`, below), `rule` (the validation rule that refused the request), and
`error_code`. **Never** add message text, the context, tool
descriptions or schemas, call arguments, tool results, Refs, names, or
provider error bodies: Sentry gets `ScribeModelError` (error class, HTTP
status, provider code) instead of the AI SDK's error, and `streamText`'s
`onError` is silenced because its default logs the whole provider response.

### Verifying with a real model

The free e2e (`src/e2e/scribe.e2e.test.ts`) covers every refusal without the
model. The real-model suite costs a few cents:

```bash
# A file holding only OPENROUTER_API_KEY=… (mode 600, outside the repo)
node scripts/verify/dev.mjs up --secrets-from /path/to/openrouter.env
WW_API_E2E_ALLOW_PAID=1 pnpm exec vitest run --config vitest.e2e.config.ts src/e2e/scribeModel.e2e.test.ts
node scripts/verify/dev.mjs down
```

It drives a 16-tool manifest (`src/test/scribeFixture.ts`) through tool
calls, read → write, parallel calls, caching, units against the window,
`limit_reached` with turn grace, `strictTools`, the legacy 426, and a 7-turn
conversation, and writes `.verify/artifacts/scribe-model-<timestamp>.json`.

Model quality (does each message become the right calls and reply) is
measured from the app instead, with its real tools, context and turn loop: the
app's `src/features/scribe/evals` runs about 60 spoken-style scenarios against
this worker (`SCRIBE_EVAL_WORKER=<this checkout> pnpm exec vitest run
src/features/scribe/evals` in the app; its README-style header has the
options). Run it after any change to `prompt.ts`.

## Notes Import runtime limits and admin reset

Allowance policy lives in each environment's `NOTES_KV` under
`notes-import:limits` and is edge-cached for 60 seconds. Its JSON shape is:

```json
{"importsFree":3,"importsSupporter":-1,"refinementsFree":5,"refinementsSupporter":-1,"windowDays":30}
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

To reset one Notes Import meter's rolling aggregate and Empty Import rows
while preserving permanent replay/refinement records (only while
`scribe:legacy-notes-import` is on), copy `.env.example` to the gitignored
`.env`, set the environment-specific token/URL, then run:

```bash
pnpm run admin:reset-usage --notes-import <meterId>         # production
pnpm run admin:reset-usage --dev --notes-import <meterId>   # development
```

The meter id is the account id for app versions with sessions (from an inbox
id: `POST /admin/accounts/lookup`), else the shared account id or install uuid.

`ADMIN_API_TOKEN` and `ADMIN_API_TOKEN_DEV` must match separate Wrangler
`ADMIN_API_TOKEN` secrets in prod/dev. Never reuse the development bypass token.

## Notes Import on account sessions

Notes Import identifies the caller by the session's account (witness-work ADR
0027). The wire contract is in README.md ("Who's calling") and `/docs`.

- **Bearer**: kickoff, the synchronous `POST /notes-import`, and transcribe
  take `Authorization: Bearer` and plain fields (no attestation, no hashes);
  `meterId` is the token's account id. They refuse a suspended account
  (`requireActive`, 403). Run routes (`events`, `result`, `cancel`, `destroy`)
  take the token instead of `?token=` and serve only that account's imports:
  anything else is 404 `not_found`, unknown and foreign alike. Kickoff mints no
  subscribe token.
- **Ownership**: a bearer run stores `owner` =
  `importOwnerKey(accountId)` (a SHA-256, not the id) in its `meta` table at
  `start()`; `NotesImportRun.isOwnedBy` compares it and stores nothing for an
  unknown id (tables are created on the first write). Bearer import ids hash
  `account:<accountId>:<contentHash>[:r:<SHA-256 of the instruction>]`, which
  has no `|`, so no legacy basis (`<meter>|<contentHash>…`, any uuid) can
  produce one: a legacy kickoff can never get a subscribe token for an
  account's run.
- **Supporter**: one seam, `isAccountSupporter`
  (`src/accounts/supporter.ts`), at kickoff and settlement: the account's
  own status (see [Supporter status](#supporter-status-revenuecat)). An
  account with no linked RevenueCat customer is free. A
  `revenueCatAppUserId` from builds before ADR 0029 is ignored.
- **Dev**: a `dev` session gets the dev bypass's allowances only where
  `NOTES_IMPORT_DEV_BYPASS_TOKEN` is set (dev worker); the bypass header is
  ignored on bearer requests.
- **Errors**: Notes Import's shape (message in `error`) for every refusal,
  bearer and legacy: 401 `unauthorized` with `WWW-Authenticate`, 403
  `suspended`, 503 `disabled`, and 426 `upgrade_required` (no `Retry-After`)
  for a legacy request once `auth:legacy` is off.
- **Allowances don't carry over**: usage under an install uuid or shared
  account id stays on that meter; each account starts a fresh window.
- `GET /notes-import/status` is unchanged: public, the same for everyone, and
  cached per isolate as below. It never reads `Authorization`.
- **Usage**: `GET /notes-import/usage` (bearer only, read-only) is the
  account's allowance for the app's composer and credits sheet: `imports`
  (`limit`, `used`, `remaining`, `resetsAt`), `refinements.limitPerImport`,
  `windowDays`, `supporter`, `supporterCheckFailed`, and `accountStatus`.
  It runs kickoff's own code (`resolveAccountSupporter`,
  `resolveMeterAllowances`, then `NotesImportIndex.usage`, built on the
  same `normalizeImportWindow`/`computeCreditsSnapshot`), so it can't
  disagree with kickoff; change those together. It charges nothing, holds
  no slot, and emits no operational event. RevenueCat unreachable answers
  free with `supporterCheckFailed: true` (kickoff meters it free too), never
  a 5xx. A suspended account still reads it (`accountStatus: "suspended"`).
  It counts in the read edge tier per IP (`BUDDIES_READ_LIMITER`, 600/min),
  not the `notes-import` bucket (`rateLimit`'s `except`), so every device
  opening the composer never spends the imports' budget. Refinements are
  per notes text, so there's no account-wide refinement balance.

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

Its result lives in KV `notes-import:provider-health` as `{healthy, checkedAt}`
for 5 minutes. Under a minute old it is served as is; older, it is still served
while `waitUntil` re-probes and rewrites it, so a request only waits on
OpenRouter when no result is stored. A provider outage can therefore take a
minute plus one request to show. The kill-switch, provider, allowance, and
minimum-version KV reads all start at once.

Sentry traces retain 100% of development and Notes Import operation traffic.
Production status, HERE proxy, health, contact-link and other routine routes use
10% trace sampling, overriding propagated parent sampling decisions. Error
capture and contact-data redaction remain unchanged; Cloudflare logging retains
its existing sampling configuration.

Because those traces record request URLs whole, `src/sentry.ts` cuts the value
of every `token` query parameter (legacy run routes' subscribe token, `?token=`)
and `apiKey` (a client-sent HERE key) from every string in an event,
transaction, span, and breadcrumb (`token=[redacted]`), and from an object or
pair-list `request.query_string`. It cuts the HERE proxy's `q` and `qq` (what
the user typed, often a contact's address) and `at` and `in` (the user's
location) the same way, since `/geocode` and `/autocomplete` trace at 10%.
Names match as the worker reads them, percent-escapes decoded (`?to%6Ben=` is
`token` to Hono), and without regard to case. A new route that takes a
credential or user data in its query string adds its name to
`SECRET_QUERY_PARAMETERS` (better: take it in a header or body).

## Buddies

`POST /buddies/v1/{op}` is the Buddies relay, built to the wire contract in
[`docs/buddies-protocol.md`](docs/buddies-protocol.md) (the witness-work repo
holds the canonical copy). Code lives in `src/buddies/`.
`GET /buddies/invite` is the no-app fallback page for invite links (App Store
and Google Play buttons), and the short `/b` serves it for invites already
sent. The AASA matches `/buddies/invite#1…` and `/b#1…`, and
`public/.well-known/assetlinks.json` verifies the whole host for Android App
Links. Clients are iOS and Android
(witness-work ADR 0020).

- **Authentication** (witness-work ADR 0027; "Authentication (sessions)" in
  the protocol): a request with an `Authorization` header is a bearer
  request, and its access token must verify (401 `unauthorized`, never a
  fallback). `inbox/register` sends the token plus its self-signed
  envelope, whose `account` proof is then required (400) and must name the
  token's account (403 `forbidden`). Owner ops send their fields as plain
  JSON, no envelope, `ts`, or `nonce` (`inbox/live` and `blob/put` in
  `x-buddies-payload`, no signature header); the inbox DO compares the
  token's account with its `owner_account` row: another account is 403
  `forbidden`, none 409 `not_linked` (an inbox registered before accounts,
  or whose link isn't confirmed; the app links it with `inbox/register`
  and retries). The row counts only once `confirmed`, meaning D1's
  `account_inboxes` holds the same link, where moderation finds it: the
  Worker passes an existing D1 link along with the registration, and
  confirms a new one (D1's winner, so concurrent claims agree; the loser
  gets 409 `conflict`) only after D1 wrote it. A registration that fails
  between the two leaves the inbox `not_linked` until a retry gets
  through. Rows from before the column (added in place as 0) count as
  unconfirmed: their owner's first bearer owner op gets `not_linked`, and
  the relink confirms it. Writer ops send the
  token plus the writer-signed envelope, still the slot's capability; the
  token's account is never compared with the slot or stored. Invite and
  blob reads send the token plus today's body. Without the header it's a
  legacy request, served byte for byte as before while `auth:legacy` is on,
  and 426 `upgrade_required` once it's off, leaving ops included. One
  exception outlives the switch: the iOS Notification Service Extension
  fetches events too big for a push with an owner-signed `inbox/sync`
  (it can't hold the session's rotating refresh token without racing the
  app) and sends `x-buddies-client: notification-service`. With the switch
  off, the Worker admits that one legacy request (`admitCaller`, as
  `linkedOnly`), and the inbox DO checks the signature, `ts`, nonce, and
  suspension as ever, then serves it only for an inbox with a **confirmed**
  `owner_account` link, else 426. Any other op with the header, or a wrong
  value, is 426 as before; the header changes nothing while the switch is
  on or on a bearer request. Nothing logs it. The live
  upgrade reaches the inbox DO with the token's account in the internal
  `x-buddies-session-account` header, which the Worker always strips from
  client requests (the DO trusts it). Both switches work as before in both
  forms, and so does suspension of the account's own inbox (its owner ops).
  A bearer op that reaches someone else's inbox (`card/put`, `event/put`,
  `invite/claim`: `BUDDIES_SUSPENDED_REFUSED_OPS`) is also refused with 403
  `suspended` when the token's account is suspended, in `admitCaller` after
  the edge limit, from the cached `requireActive` status
  (`refuseInactiveAccount`, 30 s per isolate; the admin route drops its own
  isolate's entry). The target inbox never sees which account wrote, and
  nothing logs or stores it. `slot/leave` and reads stay open. A legacy
  writer op names no account, so a suspended User's legacy writes still get
  through: one more reason to turn `auth:legacy` off before relying on
  suspension. `owner_account` needs no migration (created in
  place at registration, `confirmed` added in place).
- **Bindings** (repeated under `[env.dev]`): `BUDDY_INBOX` (`BuddyInbox`, one
  SQLite DO per `inboxId`), `BUDDY_INVITE` (`BuddyInvite`, one per `inviteId`),
  migration `v3`, `BUDDY_REGISTRATION_QUOTA` (`BuddyRegistrationQuota`, one per
  caller), migration `v6`, six per-caller rate limiters (below), the
  `BUDDY_BLOBS` R2 bucket (photo blobs: `ww-buddy-blobs` prod,
  `ww-buddy-blobs-dev` dev), and the `BUDDIES_ENABLED` var (`"false"` prod,
  `"true"` dev) and `BUDDIES_PHOTOS` var (dev `"on"` only).
- **Abuse limits**: all in `BUDDIES_ABUSE_LIMITS` (`src/buddies/limits.ts`),
  each with its sizing rationale. They only stop scripted abuse; size them
  from the heaviest real use with at least 10× headroom. Hits log
  `buddies: limit hit {op, limit}` (nothing else), so tune from Workers Logs.
  - Per caller, in the Worker before any DO wakes: for a bearer request the
    session's account (`account:` + a SHA-256 of its id, so the limiter never
    sees the id and people behind one NAT stop sharing a budget), else the
    client IP (IPv6 by /64); never the target inbox. The budgets were sized
    per IP, so one account gets the same. `BUDDIES_RATE_LIMITER` 120/min for
    `invite/fetch` + `invite/claim`, `BUDDIES_REGISTER_LIMITER` 60/min for
    `inbox/register`, `BUDDIES_READ_LIMITER` 600/min for `inbox/sync` +
    `inbox/live`, `BUDDIES_BLOB_PUT_LIMITER` 60/min for `blob/put`,
    `BUDDIES_BLOB_GET_LIMITER` 600/min for `blob/get`,
    `BUDDIES_WRITE_LIMITER` 600/min for every other op (namespaces 1002-1007
    prod, 2002-2007 dev; `limits.test.ts` keeps `wrangler.toml` equal to the
    constants). Refusals are 429 `rate_limited`
    with `Retry-After: 60`. Every relay error is `{ok: false, error, code}`
    (`src/buddies/errorResponse.ts`); `rate_limited` and `disabled` always
    carry `Retry-After`/`retryAfter`, computed from the limit's window inside
    the Durable Objects, and `stale` carries `serverTime` and `Date`. The Worker also refuses stale `ts` and badly
    signed `inbox/register` before any DO. A limiter outage lets requests
    through.
  - `inbox/register`: 2,000 validly signed calls per caller (account or IP,
    as above) per rolling day (`BuddyRegistrationQuota`, hourly counts under
    a hashed caller key).
  - Per inbox, after the signature check: stored events per slot (10,000,
    16 MiB) and per inbox (128 MiB). `event/put` past them is 429
    `rate_limited`; nothing stored is dropped. `slot_usage` keeps the running
    totals. Each signer (the owner, or a writer slot) gets 10,000 / 1,000
    requests that take effect per 10 minutes (in memory). Sync pages stop at
    10,000 events as well as 4 MiB.
  - Per inbox, photo blobs: 300 live blobs and 150 MiB live, and 100
    uploads (object writes) per rolling day; `blob/put` past them is 429
    `rate_limited` with `Retry-After` until the soonest blob expires or the
    oldest upload ages out.
  - Only requests that take effect record a nonce, so refused ones add no
    rows; replay protection is unchanged.
- **Secrets** (per environment): `APNS_KEY_ID` and `APNS_PRIVATE_KEY` (the
  `.p8` PEM). `APPLE_TEAM_ID` is the JWT issuer and `IOS_BUNDLE_ID` the
  default APNs topic (a device may register `apnsTopic`, any of
  `IOS_BUNDLE_ID` or `IOS_ADDITIONAL_BUNDLE_IDS`). `FCM_SERVICE_ACCOUNT_JSON`
  is the key of `buddies-fcm-sender@turing-striker-403102`, whose custom role
  `fcmSender` holds only `cloudmessaging.messages.create`; its `project_id` is
  the Firebase project. A copy is in the 1Password Agents vault ("Buddies FCM
  sender service account key (ww-api)"). Without the APNs secrets or the FCM
  key the relay still works but skips that service's pushes, logging once per
  isolate.
- **Kill switch**: KV `buddies:enabled` in `NOTES_KV`. `"true"` enables, any
  other value disables, and an absent key falls back to `BUDDIES_ENABLED`. The
  read is edge-cached for 60 seconds. `inbox/delete`, `slot/remove`, and
  `slot/leave` work even when disabled.
- **Photo blobs** (photos in Plan notes; contract in the protocol's "Photo
  blobs"): `POST /buddies/v1/blob/put` takes the raw sealed bytes as its body
  with the owner-signed envelope (op `blob/put`) in `x-buddies-payload` /
  `x-buddies-signature`; the Worker reads at most 1 MiB, recomputes
  `blobId = b64u(SHA-256(body))`, and hands the bytes to the sender's inbox
  DO, which checks the signature, nonce, and caps and writes R2 object
  `v1/<inboxId>/<blobId>`. `blob/get` (unsigned; the read token is the
  capability, only its hash is stored) streams the object back with
  `Cache-Control: no-store`; every miss is the same 404. `blob/delete` is an
  owner op, and only an inbox with a slot (a buddy) can put (`no_buddies`).
  Bookkeeping is the inbox's `blob`, `blob_upload`, `pending_blob_delete`,
  `blob_delete_backoff`, and `blob_sweep` tables (created in place on first
  use, no wrangler migration). The inbox alarm deletes blobs at `expiresAt`,
  retries failed R2 deletes after 1 min doubling to 6 h, and sweeps the
  inbox's `v1/<inboxId>/` prefix weekly for objects with no row; a failed put
  keeps its unwritten row 10 min so its expiry deletes an object that landed
  anyway. `inbox/delete` and the 180-day wipe delete every blob and list the
  prefix for leftovers. `expiresAt` is at most 90 days out and a re-put that
  moves it rewrites the object, so no live object is older than 90 days and
  the bucket's 91-day lifecycle rule (`scripts/r2-lifecycle.mjs`, run by every
  deploy) is only a backstop. Switch: KV `buddies:photos` in `NOTES_KV`, `"on"` (or `"true"`)
  enables, any other value disables, absent falls back to `BUDDIES_PHOTOS`
  (dev `"on"`, prod unset = off); edge-cached 60 s. Off (or no bucket bound),
  all three return 503 `photos_disabled` and `inbox/sync` reports
  `capabilities.photos: false`, the flag the app gates its photo picker on.
  Buddies' own switch wins (`disabled`).
- **Push**: each device registers `pushService` `apns` (iOS; the default) or
  `fcm` (Android), stored in the inbox's `push_device` table (inboxes from
  before FCM move their `device` rows there on first use). `src/apns.ts` is
  the feature-neutral APNs sender (provider token cached in KV
  `apns:provider-token`, per-device topic, one outcome per notification, one
  retry for network errors, 429, 5xx, and rejected provider tokens).
  `src/fcm.ts` is its FCM HTTP v1 counterpart (OAuth token from
  `src/googleAuth.ts`, cached per isolate; one retry for network errors, 429,
  5xx, and a rejected token). `src/buddies/push.ts` builds both payloads,
  routes each device to its service, and deletes devices either reports as
  unregistered. Other features should build on `sendApnsNotifications` and
  `sendFcmNotifications`, not on the Buddies layer. Every alert's `ww`
  marker carries the event's `seq` and, when it fits (APNs 4 KB, FCM 4,000
  bytes of data), the still-sealed event (`eventId`, `blob`), so the app can
  name the sender without the relay seeing a name. APNs alerts carry the
  device's generic template with `mutable-content: 1` (the app's Notification
  Service Extension rewrites it) and `content-available: 1` so iOS can wake
  the app to sync; badge news (`BUDDIES_PASSIVE_PUSH_KINDS`) is passive, with
  no sound. FCM messages are data-only and high priority. A device registered with
  `appAlerts: true` (builds with named alerts) gets the template as
  `fallbackTitle`/`fallbackBody` and no `title`/`message`, so
  expo-notifications shows nothing itself and the app's background task posts
  the alert; any other device gets `title`/`message`, which expo-notifications
  shows, so the relay can ship ahead of the app (`push_device.app_alerts`,
  added in place to older inboxes). Invitations and answers (`isImmediatePushKind` in `contracts.ts`)
  skip the 60 s per-slot spacing but still count toward the daily cap.
- **Live socket**: `GET /buddies/v1/inbox/live` upgrades to a WebSocket. The
  owner-signed envelope (op `inbox/live`) rides in the `x-buddies-payload`
  and `x-buddies-signature` headers. The inbox DO accepts it with the Hibernation API
  (`ping` gets `pong` without waking it, at most 10 sockets per inbox) and
  sends `{"type":"changed","seq":…}` after each write that changes
  `inbox/sync`. Sentry events drop `x-buddies-*` headers. Under `wrangler
  dev`, the TCP connection lingers about 10 s after a server-sent close frame;
  the frame itself arrives at once.
- **Privacy**: every id travels in the body (for the live socket, in headers;
  never the URL). Never log or report bodies, headers, blobs,
  ids, account ids, or tokens (access tokens included; Sentry drops
  `Authorization` and `x-buddies-*`). APNs and FCM requests use the `fetch` captured before
  Sentry wraps the global, so device tokens in APNs URLs stay out of Sentry
  spans (FCM tokens travel only in request bodies). The dev worker's 100%
  Workers traces do record subrequest URLs, APNs included.
- **Not yet built** (required before any production rollout): bearer
  requests are attested once, when their session opens (App Attest or Play
  Integrity), so nothing per request is needed for them; legacy requests
  stay unattested until the legacy switch is off (`attest` is accepted and
  ignored), which is the remaining step before production. The protocol's durable push outbox (retries for
  6 h, outcome history, deferred instead of dropped alerts inside the 60 s
  spacing, `apns-expiration`) is specified but not built either;
  today each push gets one immediate attempt plus one retry.

Secrets: `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (`< AuthKey_XXXXXXXXXX.p8`), and
`FCM_SERVICE_ACCOUNT_JSON` (`jq -c . buddies-fcm-sender.json | wrangler secret
put FCM_SERVICE_ACCOUNT_JSON`), each with `--env dev` for dev. Buddies stays
off in prod (`BUDDIES_ENABLED = "false"`) until the KV key flips it.

Every deploy runs `scripts/r2-lifecycle.mjs` first, which creates the photo
bucket if it's missing (a deploy naming a missing bucket fails) and sets its
rules (`v1/` objects deleted 91 days after their last write); the GitHub
deploy's `CLOUDFLARE_API_TOKEN` needs **Workers R2 Storage: Edit**.
`node scripts/r2-lifecycle.mjs <bucket> --check` only reads.

```bash
# Production photos stay off until:
wrangler kv key put --binding NOTES_KV buddies:photos on
# Off again (stored blobs stay until they expire):
wrangler kv key put --binding NOTES_KV buddies:photos off
```

## Accounts

Anonymous accounts (witness-work ADR 0024, `docs/accounts-protocol.md` there):
one row per User, with no name, email, or phone number. The server mints a
random `accountId` and stores only the public key of the account signing key,
which every device derives from the User's account key. Accounts let us
suspend someone for abuse; later phases add moving between iOS and Android.
Code in `src/accounts/`, schema in `src/accounts/schema.ts` (Drizzle on D1).

**The account is the source of truth for who a User is** (witness-work ADR
0027). Every user-scoped route identifies the caller by the `accountId` of an
attested session's bearer token, through the `requireAccount()` middleware,
and keys its authorization, metering, limits, and audit records on that id.
Don't add a route that trusts a client-sent install id, RevenueCat id, or
inbox id to say who the User is, or that builds its own signed envelope or
per-request attestation: attestation happens once, when a session opens
(`POST /accounts/v1/sessions`). Feature ids (inboxes, backup slots, imports)
belong to an account. The RevenueCat identity is being linked to the account
so Supporter status is kept in step from RevenueCat webhooks and answered from
the account, not from an id the app sends. The pre-session ways of
authenticating survive only behind the legacy switch (`auth:legacy`), for app
versions from before sessions.

- `GET /accounts/v1/account`: Bearer, read-only. Returns the token's
  account (`accountId`, `accountPub`, `status`, `createdAt`, `inboxIds`, and
  `statusChanges` without their reasons) for Settings → Account and the
  developer tools. Counts against the Buddies read edge tier.
- `POST /accounts/v1/account/register` (legacy): self-signed under the
  `ww-account/v1` context; idempotent per key. Counts against the Buddies
  register edge tier and the per-caller daily quota. Replaced by opening a
  session; 426 `upgrade_required` once the legacy switch is off.
- `POST /accounts/v1/account/info` (legacy): `GET /account`'s answer for
  builds before it. A bearer request with no body reads the token's account;
  while the legacy switch is on it also takes the old self-signed envelope
  (op `account/info`), where an unregistered key is 404 `unknown_account`.
- `inbox/register` takes an optional `account: { accountId, signature }`
  (required in a bearer request, for the token's account), the account
  key's signature over the inbox id and owner key. The link
  (`account_inboxes`) is written only after the inbox accepted the
  owner-signed registration, so it takes both keys (Option A in the ADR).
- A suspended account's inboxes refuse every owner op except `inbox/delete`
  and `slot/remove` with `403 suspended`, and its live sockets close with
  4003. The database is the authority (registration checks it); each inbox
  keeps a copy so its hot path never reads D1. Its bearer writes into
  buddies' inboxes and invite claims are refused too, by the Worker from the
  token's account (Buddies → Authentication); legacy ones can't be.

Without the `ACCOUNTS_DB` binding, accounts are off: every accounts route
answers `disabled` and proofs are ignored. Prod uses `ww-accounts`, dev
`ww-accounts-dev`.

```bash
# Schema change: edit src/accounts/schema.ts, then
pnpm db:generate --name <change>
wrangler d1 migrations apply ww-accounts-dev --env dev --remote   # dev
# Prod: the tag deploy (.github/workflows/deploy.yml) applies them before
# deploying. Dev deploys by hand, so apply them first.
```

Moderation, with `x-ww-admin-token: $ADMIN_API_TOKEN` (404 without it). The
tokens are in 1Password's Agents vault, "ww-api admin token (prod)" and
"(dev)":

```bash
# A report names the buddy's inboxId; find the account behind it.
curl -sX POST "$BASE/admin/accounts/lookup" -H "x-ww-admin-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"inboxId":"<22 chars>"}'
# Suspend (reason: report | automated | appeal | admin); "active" reinstates.
curl -sX POST "$BASE/admin/accounts/status" -H "x-ww-admin-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"accountId":"<22 chars>","status":"suspended","reason":"report"}'
```

`/status` records every change in `account_status_events` and updates each
of the account's inboxes. If `inboxesFailed` is above 0, send the same
request again. Routes that refuse suspended accounts through
`requireAccount({ requireActive: true })` (and Buddies' bearer writer ops)
see the change within 30 seconds (per-isolate cache), at once in the
isolate that served `/status`.

### Sessions and bearer tokens

Attest once, then bearer tokens (witness-work ADR 0027; "Sessions" in its
`docs/accounts-protocol.md`). Code in `src/accounts/session.ts` (handlers),
`attestation.ts`, `tokens.ts`, `sessionStore.ts`, and `auth.ts`.

| Route | What |
| --- | --- |
| `POST /accounts/v1/sessions` | Open a session: self-signed, attested; 201 |
| `POST /accounts/v1/sessions/refresh` | `{ refreshToken }` → new token pair |
| `DELETE /accounts/v1/sessions/current` | Bearer; end the token's session |
| `GET /accounts/v1/account` | Bearer; the token's account |
| `GET /accounts/v1/sessions`, `POST …/sessions/revoke` | Bearer; devices ([Activity and devices](#activity-and-devices)) |

- **Attesting**: `POST /attestation/v1/challenge` with purpose
  `account-session`, App Attest v2 `assert` (the install's key, bound
  through `/attestation/v1/register`) or Play Integrity v1, with
  `contentHash` = `requestHash` = `hex(SHA-256(UTF-8("ww-account/v1/session\n"
  + accountPub)))`. The answer rides in the open request's `attestation`.
- **Open**: an envelope (`{ payload, signature }`, op `session/open`)
  self-signed by the account key like `account/register`, carrying that
  attestation. Its hashes must name the envelope's own key and purpose (400
  `bad_request` otherwise); `verifyAttestation` checks the rest. Creates the
  account if needed, stores a session, and answers 201 with `Location:
  /accounts/v1/sessions/current` and `{ ok, accountId, status, sessionId,
  accessToken, accessExpiresAt, refreshToken, sessionExpiresAt }`. A refused
  attestation is 403 `attestation_failed` with the attestation routes'
  `reason` and `action`. Optional sealed `device` label (≤ 512 chars, else
  `too_large`), stored opaque. An eleventh live session ends the account's
  oldest. Limits: the register edge tier, and 20 a rolling day per account
  key (`BUDDY_REGISTRATION_QUOTA` under a hashed `session-open` name),
  counted before the attestation.
- **Refresh**: plain JSON `{ refreshToken }`. A refresh token is
  `<sessionId>.<secret>.<mac>` (b64u, 16, 32, and 32 bytes; opaque to the
  app), so the session is found by id. The MAC is HMAC-SHA256 over
  `<sessionId>.<secret>` under its own key from `ACCOUNT_TOKEN_SECRET` (or
  the previous secret), proving the worker issued it: the session id is no
  secret (every access token's `sid`), so a made-up token for it must not
  end the session. A malformed token, or one whose MAC doesn't verify
  (two-part tokens from before the MAC included), is 401 before any D1
  read and ends nothing. Each refresh replaces the token with one derived
  from it (HMAC under another key from the secret), with a compare-and-swap
  on the hash it read, so the row rotates once and every refresh presenting
  the same token gets the same next one. The one just replaced gets it
  again for 60 seconds from its rotation (a lost response, or two refreshes
  at once; retries don't extend it and write nothing), so a device's double
  refresh can't strand it with a dead token. Presenting it later, or any older token of a
  live session that carries a valid MAC, ends the session. An unknown,
  ended, or expired session is 401 `unauthorized`; a refresh that lost its
  rotation race to a session that has since moved on again is 401 without
  ending it. Sessions last 90 days from opening and refreshing never
  extends them. Read edge tier.
- **Close**: `DELETE /sessions/current`, Bearer, no body; ends the token's
  own session, idempotent. Read tier. Session ids never go in URLs.
- **Storage**: D1 `account_sessions` (migration
  `migrations/accounts/0001_account-sessions.sql`): id, account, platform
  (`ios`, `android`, `dev`), sealed device label, SHA-256 of the current
  and previous refresh token, and times. No install id, App Attest key,
  `accountPub`, or IP. The hourly cron deletes sessions a week after they
  were revoked or expired.
- **Access tokens**: HS256 JWTs, 15 minutes (never past the session's end),
  claims `sub` (account), `sid` (session), `platform`, `iss`
  `ww-api/<APP_ATTEST_ENVIRONMENT>`, `aud` `ww-account`, `iat`, `exp`.
  Nothing is stored; a token is valid until it expires, so closing a
  session stops its refresh token at once and its access token within 15
  minutes, except on the security surfaces (`requireLiveSession`, below),
  which refuse it at once. Without a usable `ACCOUNT_TOKEN_SECRET` (at least 32 characters)
  the session routes are 503 `disabled` and no bearer token passes.
- **Dev bypass**: on the dev worker, `x-ww-dev-bypass` with
  `NOTES_IMPORT_DEV_BYPASS_TOKEN` stands in for the attestation (platform
  `dev`; `src/devBypass.ts`). Production ignores it (and fails loudly if the
  token is set there), and a `dev` token never verifies there.

`ACCOUNT_TOKEN_SECRET` takes a different value per worker; keep a copy in
1Password's Agents vault, since a rotation needs the old value:

```bash
openssl rand -base64 32 | wrangler secret put ACCOUNT_TOKEN_SECRET   # add --env dev for dev
# Rotation: move the current value to the verify-only slot, then set a new
# one. Its kid is derived from the secret, so old tokens keep verifying.
wrangler secret put ACCOUNT_TOKEN_SECRET_PREVIOUS   # the old value
openssl rand -base64 32 | wrangler secret put ACCOUNT_TOKEN_SECRET
# Routine rotation: after 90 days (the longest a session lasts). After a
# leak: at once.
wrangler secret delete ACCOUNT_TOKEN_SECRET_PREVIOUS
```

The previous slot keeps access tokens verifying for their 15 minutes and,
because refresh tokens carry a MAC under the secret, keeps refresh tokens
issued under the old secret refreshing; each refresh signs its replacement
under the new one. Once the slot is gone, a device still holding an old
refresh token gets 401 and opens a new session (attesting again), so
deleting it before 90 days sends every device that hasn't refreshed since
the rotation through a new session, and skipping it sends every device.
After a leak that's what you want: the old secret could mint access tokens
and MACs. Local
`wrangler dev` reads `ACCOUNT_TOKEN_SECRET` from `.dev.vars`
(`.dev.vars.example`); the verify launcher and the test harness set their
own.

Building a route on accounts (`src/accounts/auth.ts`):

- `requireAccount(options?)`: Hono middleware for bearer-only routes. Sets
  `c.var.account = { accountId, sessionId, platform }` (read it with
  `accountOf(c)`). `{ requireActive: true }` also refuses a suspended
  account with 403 `suspended` (one D1 read, cached 30 s per isolate).
  `{ requireLiveSession: true }` also refuses a token whose session has
  ended (signed out, revoked, replaced, expired, or deleted) with the same
  401 `unauthorized` and `WWW-Authenticate` an expired token gets, so the
  app's refresh → 401 → open path signs it back in. One D1 read
  (`isSessionLive`), **never cached**: revocation bites at once. Use it on
  security surfaces a signed-out device must not act on in its token's last
  15 minutes: today `GET /sessions`, `POST /sessions/revoke`,
  `GET /activity`, `GET /account` (and `account/info`'s bearer form),
  `handoff/open` and `handoff/send`, and `backup/delete`. Leave it off hot
  paths (Buddies, Notes Import, route planning, backup put/list/get,
  Supporter, handoff status/cancel), where ADR 0027's 15 minutes stand, and
  off `DELETE /sessions/current`, which must always succeed.
- `authenticateAccount(c, options?)`: the same check as a call, for routes
  that order their own gates (`GET /account` counts its edge tier first).
  Returns `{ ok: true, account }` or `{ ok: false, error, response }`
  (`unauthorized`, `suspended`, `disabled`, `internal`), so routes with
  their own error format can map `error`.
- `bearerOrLegacy(c, { bearer, legacy }, options?)` (and `accountCall`'s
  last argument): for converted routes.
  A request with an `Authorization` header is a bearer request, always (a
  bad token is 401, never a fallback to the envelope). Without one, `legacy`
  runs while the legacy switch is on, else 426.
- `isLegacyAuthEnabled(env)` and `refuseLegacyAuth(env)`
  (`src/accounts/legacySwitch.ts`) for legacy-only paths.
- `unauthorized` (401, always with `WWW-Authenticate: Bearer
  error="invalid_token"`), `upgrade_required` (426, no `Retry-After`), and
  `attestation_failed` (403) are in the shared Buddies codes
  (`buddiesErrorResponse`).
- Name new routes as resources (REST), with ids out of URLs; document the
  bearer requirement with `security: [{ bearerAuth: [] }]` in the route's
  `openapi.ts`.
- Tests: `createHarness()` turns sessions on by default, `openTestSession()`
  in `src/test/accounts.ts` opens one with the bypass, and `requestJson()`
  sends any method.

**Privacy**: never log or report access or refresh tokens, account ids,
session ids, or device labels. Sentry drops `Authorization`. Drizzle's
query errors quote the query's parameters (ids, token hashes), so report a
caught error with `captureFailure(error, operation)` (`src/sentry.ts`),
never `Sentry.captureException`: a database error, or one it caused, goes
out as a `DatabaseError` naming the operation only. As a backstop,
`beforeSend` cuts `Failed query:`, `params:`, and `D1_…:` text from every
string and drops the exceptions chained under it.

### Activity and devices

The account's security history and its signed-in devices (witness-work ADR
0028; "Activity and devices" in its `docs/accounts-protocol.md`). Code in
`src/accounts/activity.ts` (recorder, list, prune), `activityRoute.ts`, and
`session.ts`/`sessionStore.ts` (devices). Table `account_activity`
(migration `migrations/accounts/0002_account-activity.sql`).

| Route | What |
| --- | --- |
| `GET /accounts/v1/activity?limit=&before=` | Bearer; newest first, `nextCursor` |
| `GET /accounts/v1/sessions` | Bearer; live sessions, `current` marks the caller's |
| `POST /accounts/v1/sessions/revoke` | Bearer, `{ sessionId }`; signs a device out |

All three count against the read edge tier and work for suspended accounts.
Revoke is a `POST` so the session id stays out of the URL; another account's
session (or none) is 404 `not_found`, and the caller's own is signed out.

- **Signed-out callers**: all three take `requireLiveSession`, so a session
  that was signed out (or revoked, replaced, or expired) is 401
  `unauthorized` at once, even with an unexpired access token: it can't sign
  the device that signed it out back out, or show a device list without
  itself. Revoke also ends another session only while the caller's own is
  live, in the same D1 statements (`endSession`'s `actorSessionId`), so of
  two devices revoking each other at once only the first wins; the loser
  gets 401 (`RevokeOutcome` `caller_ended`).
- **Ids and cursors** (`src/accounts/activityIds.ts`): `account_activity.id`
  is a global autoincrement, so it never leaves the worker; diffing one's
  own ids would measure everyone's activity. Each entry's `id` (also the
  cursor, `nextCursor`, and `before`) is the row id sealed for its account:
  AES-256-GCM with the account id as associated data and a synthetic nonce
  (HMAC-SHA256 of the account id and row id), 48 base64url characters. It's
  deterministic (an entry keeps its id across pages, which the app keys its
  list on) and unlinkable across accounts. Another account's cursor, a
  forged or altered one, or a bare row id is 400 `bad_request`. The keys
  derive from `ACCOUNT_TOKEN_SECRET` (`activityIds` in `tokens.ts`): ids
  are sealed under the current secret and cursors open under it or
  `ACCOUNT_TOKEN_SECRET_PREVIOUS`, so a rotation changes every id (the app
  reloads its list) and cursors from before it page on while the previous
  slot is set.

- **Kinds**: `account.created`, `session.opened`, `session.signed_out`,
  `session.revoked`, `session.replaced` (the 10-session cap),
  `session.refresh_reused` (a replaced refresh token after its grace minute;
  the app flags it), `handoff.sent`, `backup.deleted` (no `slotId` = all),
  `backup.downloaded` (once per slot, session, and day),
  `account.suspended`/`.reinstated` (never the reason),
  `buddies.inbox_linked` (a new link, in `linkInbox`'s batch),
  `buddies.deleted` (the Worker, after the inbox DO accepted `inbox/delete`;
  never in the DO). Writer ops log nothing, so nothing ties a writing
  account to another account's inbox. Expiry, refreshes,
  reads, and uploads aren't logged. Clients skip unknown kinds, so adding
  one is safe.
- **Recording a new action**: add the kind to `ACTIVITY_KINDS`
  (`schema.ts`; no migration, it's a text column), then put
  `activityInsert(db, { accountId, kind, sessionId })` in the action's own
  D1 batch, with `onlyIf` when it should only log a real change. Actions
  outside D1 call `recordActivity`: before an R2 change (backup), or after
  a Durable Object accepted it, reporting a failed write (handoff). Pass the
  bearer session (`c.get('account')?.sessionId`); the platform and sealed
  device label are copied from that session's row, only within the same
  account. Document the kind in `activityListDocs` and the protocol.
- **Retention**: the hourly cron deletes entries over 400 days old
  (`pruneActivity`, beside `pruneEndedSessions`).
- **Privacy**: no IP, location, user agent, content, or anything about
  buddies. Device names stay inside the sealed labels. Never log entries,
  session ids, or slot ids.

### Updates and the legacy switch

`GET /app/v1/config` (no auth, `src/appConfig.ts`) returns `{ ok,
minAppVersion? }`. The value comes from KV `app:min-version`
(`{"minVersion":"x.y.z"}`), then the `APP_MIN_VERSION` var, else it's
absent. Invalid values are logged and ignored, and the KV read is
edge-cached for 60 seconds. It has its own per-IP bucket (`app`). App
versions from sessions on read it at launch and on returning to the
foreground, and show Update Required below it.

KV `auth:legacy` (`"off"` or `"on"`; absent falls back to the `AUTH_LEGACY`
var, then on; edge-cached 60 s). While it's on, converted routes also take
the way they authenticated before sessions. Off, those requests get 426
`upgrade_required`, `account/register` included, except the iOS
Notification Service Extension's owner-signed Buddies `inbox/sync`
(`x-buddies-client: notification-service`) for an inbox with a confirmed
account link (see Buddies → Authentication).

#### Turning off backward compatibility

Do these in order. Each step takes up to 60 seconds to reach every colo.

Pick `X.Y.Z` as the first version that opens sessions **and** whose
Notification Service Extension sends `x-buddies-client: notification-service`
on its `inbox/sync`. An older extension's fetch gets 426, so its named
Buddies alerts for events too big for the push fall back to the template.

```bash
# 1. Raise the app-wide floor to the first version that opens sessions, so
#    current apps show Update Required before anything is refused.
wrangler kv key put --binding NOTES_KV app:min-version '{"minVersion":"X.Y.Z"}'
# 2. Raise Notes Import's floor too: versions before sessions never read
#    app:min-version, but their composer honors this one.
wrangler kv key put --binding NOTES_KV notes-import:min-version '{"minVersion":"X.Y.Z"}'
# 3. Refuse the old ways of authenticating (426 upgrade_required).
wrangler kv key put --binding NOTES_KV auth:legacy off
```

Add `--env dev` to each for the dev worker. To undo, take them back in
reverse: `wrangler kv key delete --binding NOTES_KV auth:legacy` (back to
`AUTH_LEGACY`, on), then put the previous floors back, or delete
`app:min-version` and `notes-import:min-version` to remove them.

### Supporter status (RevenueCat)

The account is the authority on whether a User is a Supporter (witness-work
ADR 0029). Code in `src/accounts/supporter.ts` (store and `isAccountSupporter`),
`supporterRoute.ts`, and `revenueCatWebhook.ts`; the rule is still ADR 0014's
(`fetchSupporterStatus` in `src/revenuecat.ts`).

| Route | What |
| --- | --- |
| `POST /accounts/v1/revenuecat-customers` | Bearer; `{ appUserId }` → link it, `{ ok, supporter, expiresAt }` |
| `GET /accounts/v1/supporter` | Bearer; `{ ok, supporter, expiresAt, customers }` |
| `POST /revenuecat/v1/webhook` | RevenueCat's servers; `Authorization: Bearer <REVENUECAT_WEBHOOK_AUTHORIZATION>` |

- **Linking**: the app sends the RevenueCat app user id it's logged in as
  (ADR 0011's shared id, or the install id). The server reads that customer
  from RevenueCat's REST API and stores only what RevenueCat says; a client's
  claim never sets status. A customer RevenueCat doesn't know isn't linked.
  Repeating a link reads RevenueCat again (the app does after purchases and
  restores). At most 5 customers an account, 5 accounts a customer
  (`SUPPORTER_LINK_LIMITS`); past either, the least recently linked goes.
  Read edge tier per IP, plus the register tier (60 a minute) per account,
  since every link reads RevenueCat and the worker's RevenueCat key has one
  rate limit for everyone; works for a suspended account; RevenueCat
  unreachable is 503 `unavailable` (`Retry-After: 30`).
- **Threat model**: RevenueCat's SDK treats the app user id as the
  customer's capability (anyone with it can log in as it), so ours does too.
  Claiming someone else's purchases takes their id (122 random bits, never
  shown or logged) plus an attested session. Store-signed proof is deferred
  (ADR 0029 §2).
- **Answering** (`isAccountSupporter`): any linked customer active. A record
  read within 24 hours is the answer until its expiry; an older one is read
  again first, and so is a Supporter whose expiry passed since its read (a
  subscription renews at its end, and the webhook can be late), once. Reads
  run together; one that finds a Supporter answers, else a failed read throws
  `RevenueCatError` (route planning 503, Notes Import free). No link: false,
  no RevenueCat call. Every RevenueCat read has a 5-second deadline
  (`REVENUECAT_TIMEOUT_MS`), legacy checks included.
- **Webhook**: constant-time compare of the whole Authorization header (401
  otherwise; 503 `disabled` without the secret). The body is read only for
  `event.id` and the customers it names (`app_user_id`,
  `original_app_user_id`, `aliases`, `transferred_from`, `transferred_to`);
  each one some account links is read again from RevenueCat, all at once, so
  order and type don't matter, and a read only overwrites an older one
  (`checked_at`).
  Unlinked customers are ignored and never stored. Event ids are recorded
  after the reads (30 days) and a repeat is 200 `duplicate`. RevenueCat
  trouble is 503, so RevenueCat retries (5 times over ~80 minutes).
- **Storage**: D1 `revenuecat_customers`, `account_revenuecat_customers`,
  `revenuecat_webhook_events` (migration
  `migrations/accounts/0003_revenuecat-customers.sql`). The hourly cron prunes
  event ids past 30 days and customers no account links.
- **Not logged** in the activity log: Supporter start and end are billing
  state (ADR 0029 §7).
- **Verify loop**: `REVENUECAT_API_URL` (development workers only; production
  ignores it) points account reads at a fake. `pnpm test:e2e` serves one when
  the worker was started with
  `REVENUECAT_API_URL=http://127.0.0.1:18790 node scripts/verify/dev.mjs up`;
  the launcher sets a synthetic webhook secret.
- **Privacy**: never log or report app user ids, account ids, tokens, the
  webhook's Authorization header, or webhook bodies. The webhook logs only the
  event type and how many linked customers it read. Sentry drops
  `Authorization` from every event (`SECRET_HEADER` in `src/sentry.ts`), the
  webhook's included, and RevenueCat reads use the pre-Sentry `fetch`, so the
  app user id in RevenueCat's URL stays out of spans.

Each worker has its own webhook secret; keep copies in 1Password's Agents
vault ("ww-api RevenueCat webhook secret (prod)" and "(dev)"). RevenueCat's
integration sends the header value exactly as entered, so enter `Bearer `
plus the secret.

```bash
openssl rand -hex 32   # the secret; store it in the Agents vault first
wrangler secret put REVENUECAT_WEBHOOK_AUTHORIZATION --env dev   # dev
wrangler secret put REVENUECAT_WEBHOOK_AUTHORIZATION             # prod
```

RevenueCat dashboard → Integrations → Webhooks, one integration per worker,
in the project whose secret key the worker holds (`REVENUECAT_API_KEY`):

| Worker | RevenueCat project | URL | Environment |
| --- | --- | --- | --- |
| dev | **WitnessWork Dev** (`67824560`, Test Store only; key "ww-proxy-dev") | `https://ww-proxy-dev.levi-wilkerson.workers.dev/revenuecat/v1/webhook` | Both (dashboard promo grants arrive as production events) |
| prod | **WitnessWork** (`4c282809`; key "ww-proxy") | `https://ww-proxy.leviwilkerson.com/revenuecat/v1/webhook` | Both (TestFlight Beta and Play test tracks buy in sandbox and talk to prod) |

Authorization header value: `Bearer ` plus that worker's secret. Leave HMAC
signing off (the worker checks the Authorization header). "Send test event"
on the integration should answer 200 `customers: 0` (a test customer is
never linked).

### Handoff and backup

Moving the account to another phone and backing it up (witness-work ADR 0026;
"Handoff", "Backup", and "Recovery key" in its `docs/accounts-protocol.md`).
Shared helpers for the self-signed ops, and `accountCall` (bearer or legacy
envelope, then the account), are in `src/accounts/signed.ts`. Both stay
`POST /accounts/v1/{op}` like Buddies, so channel and slot ids travel in
bodies and headers, never URLs.

- **Handoff** (Set Up Another Device): `POST /accounts/v1/handoff/open|claim|
  status|send|receive|done|cancel`, code in `src/accounts/handoff.ts`. The old
  phone's ops (`open`, `status`, `send`, and `cancel` without `claimToken`)
  are Bearer with their fields as plain JSON; while the legacy switch is on
  they also take envelopes (`payload`/`signature`) signed by the account key
  like `account/register`, which need a registered account
  (`unknown_account` otherwise). A suspended account may still hand off.
  `open` and `send` (which move the account) need a live session
  (`requireLiveSession`; a signed-out phone is 401 and signs in again). The
  new phone's (`claim`, `receive`, `done`, and `cancel` with `claimToken`)
  are plain JSON carrying `claimToken`, with or without an `Authorization`
  header. One `AccountHandoff` SQLite DO per `channelId`
  (binding `ACCOUNT_HANDOFF`, migration `v7`, `src/accounts/handoffDO.ts`)
  holds the opening account, `verifier = b64u(SHA-256(claimToken))`, the new
  phone's temporary key, and the sealed hello (≤ 2,048 chars) and key
  (≤ 1,024; over either is `too_large`). Status runs `open → claimed → sent →
  done`, or `cancelled` from any of them. The first valid claim wins and an
  identical repeat gets `ok`; five wrong tokens (on any new-phone op) burn the
  channel to `cancelled`. `done` and `cancel` clear the blobs at once, and the
  alarm deletes everything 10 minutes after `open`; expired and unknown
  channels are `not_found`. Another account as the old phone is 403
  `forbidden`. A wrong token is 401 `bad_signature`, and an op out of order is
  `conflict`. Limits: `open` uses the Buddies register edge tier plus 20 per
  account a rolling day (`BUDDY_REGISTRATION_QUOTA` under a hashed
  `handoff-open` name; `admit` takes the limit), and every other op the read
  tier.
- **Backup**: `POST /accounts/v1/backup/put|list|get|delete`, code in
  `src/accounts/backup.ts`. `put`, `list`, and `get` are Bearer. `put`
  sends the blob as the raw body, with `x-ww-slot-id`, `x-ww-sha256`, and
  `Content-Length` as its size. `delete` is Bearer **and** the account key's
  envelope; its key must be the token's account (403 `forbidden`), so a
  leaked token can't delete backups; it also needs a live session
  (`requireLiveSession`). While the legacy switch is on, all four
  also take the envelope alone; the old `put` sends it in
  `x-ww-payload`/`x-ww-signature` (or the short `x-ww-p`/`x-ww-s`). Sentry
  drops all four envelope headers and `x-ww-slot-id`. R2
  bucket `ACCOUNT_BACKUPS` (`ww-account-backups` prod,
  `ww-account-backups-dev` dev), one object per device slot at
  `v1/<accountId>/<slotId>` with `customMetadata.uploadedAt` (epoch ms). `put`
  refuses a declared `Content-Length` or signed `size` over 20 MiB (413
  `too_large`) before reading the body, then reads at most `size` bytes and
  checks length and SHA-256 (`bad_request`). 8 slots an account (429 `limit`)
  and one `put` a slot a minute (429 `rate_limited` with `Retry-After`), both
  read from an R2 prefix listing, so two racing puts can each pass. `put`
  counts against the Buddies photo-upload edge tier, the rest the read tier.
  `delete` without `slotId` deletes every slot. Suspended accounts can still
  back up. Without the bucket or `ACCOUNTS_DB`, every op is 503 `disabled`.
- **`GET /accounts/handoff`** (and the short `/h`) is the page a camera
  opens for a handoff QR code (`/accounts/handoff#1<…>`): install or open
  WitnessWork on the new phone and scan from inside the app. Localized like
  `/contacts` (`?lang=`, then `Accept-Language`; strings in
  `src/accounts/handoffPageLocales.ts`), no script. The AASA matches both
  paths with `#1…`; `assetlinks.json` already covers the whole host.
- **Privacy**: handoff and backup log only the op name. Never log or report
  bodies, headers, keys, tokens, account ids, channel ids, or slot ids.

Every deploy (`pnpm run deploy`, `deploy:dev`,
and the tag deploy) runs `scripts/r2-lifecycle.mjs` for both buckets first,
which creates a missing bucket and sets its rules: `v1/` objects deleted 400
days after their last upload (each `put` rewrites the object, restarting its
age), plus R2's default multipart-abort rule. By hand:

```bash
node scripts/r2-lifecycle.mjs ww-account-backups-dev          # dev: create + 400-day rule
node scripts/r2-lifecycle.mjs ww-account-backups              # prod
node scripts/r2-lifecycle.mjs ww-account-backups --check      # read-only
# The same with wrangler alone:
wrangler r2 bucket create ww-account-backups
wrangler r2 bucket lifecycle add ww-account-backups account-backups-expiry v1/ --expire-days 400
```

### Cloud Sync

End-to-end encrypted, realtime sync of every device's data through this
worker, across iPhone and Android (witness-work ADR 0030; "Sync" in its
`docs/accounts-protocol.md`). It's one of the app's sync options, beside
iCloud and Google Drive; each device uses exactly one. Code in
`src/accounts/sync.ts` (routes), `syncDO.ts` (`AccountSync`),
`syncContracts.ts` (limits, headers), and `syncSwitch.ts` (switches).

| Route | What |
| --- | --- |
| `GET /accounts/v1/sync` | Bearer; `{ ok, enabled, entitled, entitlement, supporter, supporterCheckFailed? }` |
| `POST /accounts/v1/sync/put` | Bearer; raw blob, `x-ww-slot-id`, `x-ww-sha256`, `Content-Length`, `If-Match`? → `{ ok, etag, size, updatedAt, seq }` |
| `POST /accounts/v1/sync/list` | Bearer, `{}` → `{ ok, seq, slots: [{ slotId, etag, size, updatedAt }] }` |
| `POST /accounts/v1/sync/get` | Bearer, `{ slotId }` → the blob, `ETag`, `x-ww-updated-at` |
| `POST /accounts/v1/sync/delete` | Bearer, `{ slotId }` or `{}` (every slot; needs a live session) → `{ ok, seq }` |
| `GET /accounts/v1/sync/live` | Bearer WebSocket, `x-ww-slot-id`: `hello`, then `changed` |

- **Storage**: one `AccountSync` SQLite DO per account (binding
  `ACCOUNT_SYNC_INDEX`, `idFromName(accountId)`, migration `v8`) holds each
  slot's metadata (slot id = the device's sync id, ETag = b64u SHA-256 of
  the blob, size, server time, writing session id), the account's change
  `seq`, the put limits, and the live sockets. The ciphertext is in R2
  `ACCOUNT_SYNC` (`ww-account-sync` prod, `ww-account-sync-dev` dev) at
  `v1/<accountId>/<slotId>`, with the ETag and time in `customMetadata`.
- **Puts** run in three steps so the metadata never names missing bytes:
  the Worker reads and checks the body (size, SHA-256), the DO's
  `beginPut` checks the limits and `If-Match` (`"<etag>"`, or `*` for an
  existing slot; 412 `precondition_failed`) and reserves the slot, the
  Worker writes R2, and `commitPut` records it, advances `seq`, and sends
  `{"type":"changed","seq"}` to every socket but the writer's own slot. A
  failed R2 write frees the reservation (`abortPut`); one whose commit never
  comes frees it after 2 minutes, and the daily alarm deletes any object no
  slot names. A delete (one slot or all) deletes the objects, then the rows,
  and tells every socket.
- **Switches** (KV in `NOTES_KV`, edge-cached 60 s): `sync:enabled`
  (`true`/`on`, absent → `SYNC_ENABLED`: dev `"true"`, prod `"false"`) and
  `sync:entitlement` (`everyone` | `supporter`, absent → `SYNC_ENTITLEMENT`,
  else `supporter`). Off: put, list, get, and live are 503 `disabled`. Not
  entitled: 403 `supporter_required`, from `accountSupporterStatus` (the
  account's own status), cached 60 s per isolate per account; RevenueCat
  unreachable is 503 `unavailable`, never "not a Supporter". Delete and the
  status always work. `GET /app/v1/config` carries both as `sync: { enabled,
  entitlement }` for devices without a session. Turning it off refuses new
  sockets and doesn't close open ones.
- **Limits** (`SYNC_LIMITS`, each with its sizing): 20 MiB a blob (413
  `too_large` from `Content-Length` before the body is read), 20 slots an
  account (429 `limit`, new slots only), one put a slot every 2 seconds and
  one at a time, 1,000 puts and 2 GiB an account a rolling day (429
  `rate_limited` with `Retry-After`), 20 live sockets an account (the oldest
  closes with `4000 "replaced"`). Put counts in the Buddies write edge tier,
  the rest in the read tier. Hits log `buddies: limit hit {op: 'sync/put',
  limit}`.
- **Retention** (the DO's daily alarm, while it has slots): a slot not
  written for 30 days whose writing session isn't live (`isSessionLive`; a
  deleted session row counts as ended) is deleted, and any slot not written
  for 400 days. R2's lifecycle rule (400 days on `v1/`, set by
  `scripts/r2-lifecycle.mjs` on every deploy) is the backstop. A failed
  session read keeps the slot until the next run.
- **Suspended** accounts keep syncing (nothing reaches another person).
- **Privacy**: ciphertext only; the server can't read a device name or any
  data. Never log or report slot ids, account ids, session ids, sizes,
  bodies, or tokens. The socket carries only change notices.

```bash
# Turn Cloud Sync on (prod starts off; before the app release that defaults to it)
wrangler kv key put --binding NOTES_KV sync:enabled true
# Off (kill switch): refuses put/list/get/live with 503 disabled
wrangler kv key put --binding NOTES_KV sync:enabled false
# Make it free for everyone, or a Supporter benefit again
wrangler kv key put --binding NOTES_KV sync:entitlement everyone
wrangler kv key put --binding NOTES_KV sync:entitlement supporter
# Fall back to the SYNC_ENABLED / SYNC_ENTITLEMENT vars
wrangler kv key delete --binding NOTES_KV sync:enabled
wrangler kv key delete --binding NOTES_KV sync:entitlement
# Add --env dev to each for the dev worker.
node scripts/r2-lifecycle.mjs ww-account-sync --check   # read-only bucket check
```

## Shared Spaces

A blind, end-to-end encrypted record store shared by up to 10 members, one
space per shared car (witness-work ADR 0037; wire contract
`docs/shared-cars-protocol.md` there; Shared Cars is the app feature). Code
in `src/spaces/`: `route.ts` (routes, gates), `spaceDO.ts` (`SharedSpace`),
`contracts.ts` (limits, parsers, headers, and `SPACES_ERROR_STATUS`: the
shared envelope's codes plus Spaces' own `stale_key`), `switches.ts`,
`openapi.ts`.

| Route | What |
| --- | --- |
| `POST /spaces/v1/create` | `{ spaceId, memberId, dhPub, tokenHash, wrap }` → `{ ok, seq, joinedAt }` |
| `POST /spaces/v1/sync` | member, `since`, `limit?` → records, members (`memberId`, `dhPub`, `joinedAt`), invites, owner, epoch, own wrap, `rekeyNeeded`, `more` |
| `POST /spaces/v1/put` | member, `records` (1-100) → `{ ok, seq, results }` |
| `POST /spaces/v1/invite/create`, `invite/delete` | member, `inviteId` (+ `joinVerifier`, `expiresAt`, `epoch`) → `{ ok }` |
| `POST /spaces/v1/join` | `{ spaceId, inviteId, joinSecret, epoch, memberId, dhPub, tokenHash, wrap }` → `{ ok, seq, epoch, joinedAt }` |
| `POST /spaces/v1/leave`, `member/remove`, `rekey`, `delete` | member (+ `removeId`; `epoch`, `wraps`, `link`) |
| `GET /spaces/v1/live` | Bearer WebSocket, `x-ww-space-auth` + `x-ww-space-token`: `hello`, then `changed` |

- **Authentication**: every route is bearer (the session proves an attested
  app and drives suspension and rate limits) but the session is never
  recorded against the space. Member ops carry `spaceId`, `memberId`, and
  `token` in the body; the Worker hashes the token and only the hash reaches
  the DO, which compares it with the member's stored hash in constant time
  (`join`'s secret likewise). A `memberId` not on an existing space is 410
  `gone`; a wrong token for one that is, 403 `forbidden`. `create` and
  `join` carry the member's X25519 `dhPub`, and the Worker refuses a
  `memberId` other than `b64u(SHA-256("ww-spaces/v1/member-id|" + spaceId +
  "|" + dhPub)[0..16])` (400 `bad_request`), so nobody can swap in a key.
  The live upgrade's ids ride in `x-ww-space-auth` (`b64u(JSON { spaceId,
  memberId })`, ≤ 1,024 characters) and the token in `x-ww-space-token`
  (`b64u(token)`); the names hold "auth" and "token" so Cloudflare's logs
  redact them.
  The Worker forwards the verified member and the member cap to the DO in
  `x-ww-space-member-token` (it carries the token's hash, so its name holds
  "token" too), without `Authorization` or either client header, replacing
  any client copy. Sentry drops all three headers.
- **Storage**: one `SharedSpace` SQLite DO per space (binding
  `SHARED_SPACE`, `idFromName(spaceId)`, migration `v10`): the current
  version of each sealed record with the `seq` it was stored at, members
  (token hash, `dhPub`, current wrap, `joinedAt`), invites (verifier,
  inviter, expiry; a used one is kept until it expires so a retried `join`
  gets its answer), the ids of invites closed before they were used
  (`closed_invite`, until they'd have expired), the change `seq`, running
  record and decoded-byte counts, hourly put counts, each member's puts
  over the last minute, the retention alarm, and the live sockets. No R2.
  Every change advances `seq`: each stored record takes the next one, and
  joins, leaves, removals, invite changes, and rekeys take one each (a
  rekey's link one more). The last member's `leave`, the owner's `delete`,
  and retention drop every table and write a tombstone in the same
  transaction as the check that allowed it, so every later request
  (`create` included) is `gone`. Then `deleteAll()` frees the storage
  (Cloudflare bills dropped tables' storage until `deleteAll()`) and the
  tombstone is written back, inside `blockConcurrencyWhile`
  (`deleteAllThen` in `src/durableObjectStorage.ts`). If that fails,
  workerd resets the object and the request fails with 500 although the
  space is gone (its retry is `gone`). An alarm set 10 minutes out first,
  and set again right after `deleteAll()` (from compatibility date
  2026-02-24 `deleteAll()` drops it), retries. If the failure came after
  `deleteAll()`, the next instance's constructor sees no space, no
  tombstone, and an alarm, and writes the tombstone back before any
  request, so `create` and `join` stay `gone`; the alarm does the same as a
  backup. `sync` reads records in whole chunks (`readSeqPage`): a `for …
  of exec()` loop that stops early leaves its statement running, and the
  wipe's `DROP TABLE` then fails with `SQLITE_LOCKED` until the object is
  evicted (`deleteAll()` isn't blocked by it; measured on `wrangler dev`).
- **Creating**: an identical retry of `create` (same `memberId`, `dhPub`,
  `tokenHash`, `wrap`) on a space nothing has changed since (`seq` 1) gets
  the same `{ ok, seq: 1, joinedAt }`; any other reuse is 409 `conflict`. The
  Worker asks the DO first (`existingCreate`), so a retry, a `conflict`, or a
  `gone` never counts against the account's 20 creates a day. Two first
  tries racing can both count.
- **Invites**: made at the current epoch (`invite/create` with another
  `epoch` is 409 `stale_key`), so an open invite always carries the current
  key. They close when used, deleted, burned, or expired; when their
  inviter leaves (freeing their places, and keeping a gone member from
  rejoining through their own invite); all of them when anyone is removed
  (so the removed member can't rejoin through another member's invite
  before the rekey; inviters send theirs again after it); and all of them
  at a rekey. A closed id is kept (`closed_invite`) until it would have
  expired, so an identical `invite/create` landing after the close is 409
  `conflict`, as is any reuse of a used or burned id; an identical retry is
  `ok` only while the invite is open. Closed ones count toward no cap and
  aren't in `sync`'s `invites`, and `join` with one is 404 `not_found`.
  `join` also refuses an invite whose inviter isn't on the space (404
  `not_found`). `join` carries the invitation's `epoch`: a fresh join at
  any other than the current one is 409 `stale_key` (checked after the
  secret, so a wrong secret still counts). A retried `join` (same secret,
  `memberId`, `dhPub`, `tokenHash`, whatever its `epoch`) gets the head,
  the current epoch, and its original `joinedAt`; any other join by a
  current member is 409 `conflict`. `invite/delete` of an unknown, closed,
  used, or expired invite is `ok` for any member and changes nothing; an
  open one is its inviter's or the owner's to close (403 `forbidden`).
- **Records**: the newest `stamp` wins per `recordId`; on a tie a deletion,
  then the lower SHA-256 of the decoded blob. Resending the held version is
  `stored: true` and takes no `seq`. Reserved ids (`mayPutRecord`):
  `m.<memberId>` is that member's alone (any other `m.` id, one naming
  nobody yet included) and `k.<x>` the owner's, so a put naming someone
  else's is 403 `forbidden` and nothing in it is stored (deletions
  included). Any record off the current epoch is 409 `stale_key` and
  nothing is stored; a stamp more than 24 h ahead is 400.
- **Roles**: the creator owns the space; an owner who leaves passes it to
  the member who joined first. `member/remove` (never yourself), `rekey`,
  and `delete` are owner only. `rekey` must be to the current epoch + 1
  (below 2 is 400, anything else 409 `stale_key`) and give a wrap to every
  current member exactly: naming one twice is 400 `bad_request`, missing one
  (an empty list included) or naming a non-member 409 `conflict` (the
  owner's device syncs and tries again). It closes every open invite. Its
  required `link: { stamp, blob }` is stored in the same transaction as the
  record `k.<epoch>` at the new epoch, at a `seq` of its own after the
  rekey's, replacing any version of that id whatever its stamp (so a link
  planted ahead can't block it); it's checked as a put record (413
  `too_large`, 400 for a stamp more than 24 h ahead) and counted in the
  record and byte caps (429 `limit`) but not the put rates (`put_hour`,
  `member_put`). The link is the owner's by construction. The answer's
  `seq` is the head, the link's. `rekeyNeeded` is set by a leave or removal
  and cleared by a rekey.
- **Switches** (KV in `NOTES_KV`, edge-cached 60 s): `spaces:enabled`
  (`"true"`; absent → `SPACES_ENABLED`: dev `"true"`, prod `"false"`). Off,
  everything is 503 `disabled` with `Retry-After` except `leave`,
  `member/remove`, and `delete`; open sockets stay open. `spaces:maxMembers`:
  members plus open invites a space holds (1-100; absent or invalid → 10),
  checked at `invite/create` and `join`. No Supporter check: it's free.
- **Suspended** accounts get 403 `suspended` on `create`, `put`,
  `invite/create`, and `join` (the cached `requireActive` status, 30 s);
  reads, leaving, removing, rekeying, and deleting still work.
- **Limits** (`SPACES_LIMITS`, each with its sizing): per caller, the
  Buddies edge tiers keyed on the hashed account (`sync` and `live` read,
  `join` unsigned, the rest write); 20 creates per account a rolling day
  (`BuddyRegistrationQuota` under a hashed `space-create` name, counted
  before the DO, only for a `create` that would make a space); 60 puts a
  rolling minute per member (counted in the space's SQLite in the put's own
  transaction once it passes the `forbidden` and `stale_key` checks, so it
  holds across eviction; a put refused `forbidden` or `stale_key` writes
  nothing and costs nothing, as does one whose transaction throws, while
  one refused with `limit` or the daily `rate_limited` counts); 10,000
  records a rolling day per space (hourly counts); 100 records and 1 MiB a
  put, 16 KiB a blob (a rekey's link too), 256 KiB any other body, declared
  or streamed (413 `too_large`); 50,000 records and 256 MiB of decoded
  blobs a space, deletions and links included (429 `limit`; a replaced
  version gives its bytes back); members plus open invites (429 `limit`);
  invites at most 7 days plus 5 minutes; 5 wrong join secrets burn an
  invite; 4 live sockets per member the cap allows, 40 at 10 (past it,
  `4002 "replaced"` closes, one at a time, the opener's own oldest while
  they hold 4 or more, else the oldest of whichever member holds the most,
  until the space is at the cap, an excess left by a lowered
  `spaces:maxMembers` included; so a member rotating their sockets can't
  keep the others out). The rolling counts share `rollingWindowWaitMs`
  (`src/buddies/limits.ts`) with the Buddies quotas. Sync pages stop at
  `limit` (≤ 1,000) or 4 MiB of blobs, with `more`. Hits log `spaces:
  limit hit {op: 'spaces/…', limit}` (edge tiers as `edge.<tier>`).
- **Live socket**: `hello` with the head, then `changed` to every socket on
  the space after each change (the writing device's included: a member's
  devices share one member id). `ping` gets `pong` without waking the DO.
  `4001 "gone"` closes a leaver's or removed member's sockets, and every
  socket when the space is deleted.
- **Retention**: the alarm deletes a space 400 days after its last `sync` or
  `put` (set at `create`, moved forward each time it fires early). A `sync`
  records the activity only when the recorded one is over a day old, so most
  syncs write nothing; the alarm waits 401 days from the recorded one to
  make up for it.
- **Privacy**: ciphertext, random ids, and per-space public keys only; the
  server never learns what a space is or which accounts are on it. Never
  log or report space, member, or invite ids, tokens, keys, hashes, wraps,
  or blobs. A failure reaches Sentry as an `OperationError` naming
  `spaces/<op>` alone (`captureOperationFailure`), since the DO's SQLite
  errors can quote what they hold. The socket carries only change notices.

```bash
# Turn Shared Spaces on in prod (before the app release that shares cars)
wrangler kv key put --binding NOTES_KV spaces:enabled true
# Off (kill switch): leave, member/remove, and delete keep working
wrangler kv key put --binding NOTES_KV spaces:enabled false
# Raise the member cap (members plus open invites)
wrangler kv key put --binding NOTES_KV spaces:maxMembers 12
# Fall back to the SPACES_ENABLED var / the default cap
wrangler kv key delete --binding NOTES_KV spaces:enabled
wrangler kv key delete --binding NOTES_KV spaces:maxMembers
# Add --env dev to each for the dev worker.
```

## App Store ratings (paywall social proof)

`GET /app-store/ratings` returns `{complete: true, averageRating, ratingCount,
countryCount, updatedAt}` for the app's paywall. `countryCount` counts storefronts
with ratings, not publisher locations. App Store Connect's API only exposes written
reviews, so totals come from Apple's public iTunes lookup, summed across all
175 storefronts (`src/appStoreRatings/storefronts.ts`, from ASC
`/v1/territories`). The hourly cron (`[triggers]`) sweeps 40 storefronts per run
sequentially into `NOTES_KV` (`app-store-ratings:state:v2`), publishes
`app-store-ratings:summary:v2` only after every storefront has responded
successfully, then rests until that sweep is 24 hours old. Failed or malformed
lookups remain pending for the next hourly run. The previous complete summary
stays available until its replacement is complete. Sequential lookups prevent
timeouts from including time spent waiting for the Worker's outbound connections.

The route serves from the colo Cache API (`s-maxage` 6h) with a 1h edge-cached
KV read on a miss, and returns `503 no-store` until the first complete sweep
(at least 5 hourly runs, longer on failures). Its internal edge-cache key is
versioned to avoid serving the old partial totals. The app rejects legacy
unverified bodies, persists complete snapshots for 7 days, and falls back to a
dated bundled snapshot until then.

## Notes Import analytics (PostHog)

The worker sends anonymous Notes Import usage events to the WitnessWork
PostHog project (US cloud), so adoption is measured over every import, not
only installs with app analytics on. Code: `src/analytics.ts` (feature-neutral
sender) and `src/notesImport/analytics.ts` (events). On when
`POSTHOG_PROJECT_TOKEN` is set: prod `[vars]` has it, `[env.dev.vars]` leaves
it commented out.

| Event | When | Properties beyond the shared ones |
| --- | --- | --- |
| `api_notes_import_started` | An authenticated import starts a fresh model run (kickoff or legacy; not reconnects) | `notes_chars`, `new_content`, `imports_remaining` |
| `api_notes_import_finished` | Once per started run | `outcome` (`success`, `model_error`, `cancelled`, `interrupted`), `duration_ms`, `notes_chars`; on success: `empty`, `empty_charged`, record counts (`contacts`, `visits`, `time_entries`, `categories`, `warnings`, `publisher_detected`), `imports_remaining`, `model`, `provider`, `input_tokens`, `output_tokens`, `reasoning_tokens` |
| `api_notes_import_limit_reached` | An authenticated request is refused by an allowance or the concurrency cap | `limit` (`imports`, `refinements`, `active_cap`) |

Every event carries `platform` (`ios`, `android`, `dev`: the session's
platform on bearer requests, else App Attest, Play Integrity, or the bypass
header), `transport` (`stream`, `legacy`), `refinement`, `supporter`,
`has_account` (true on every bearer request), and `environment`. The internal-TestFlight Beta app talks to prod, so its imports
are counted as `ios`.

- **Identity**: `distinct_id` is `ww_` plus a truncated SHA-256 of the meter id
  (the session's account id on bearer requests; on legacy ones the shared
  account id, else the install uuid), so unique users, DAU/WAU/MAU and
  retention work without the id itself reaching PostHog. A User's bearer
  imports get a new `distinct_id`, not their legacy one. It can't be joined to the app's
  own anonymous PostHog ids. Events set `$process_person_profile: false` and
  `$geoip_disable: true`.
- **Privacy**: properties are structural only. Never add notes text, model
  output, names, ids, or tokens. Delivery uses the pre-Sentry `fetch`, runs in
  `waitUntil` with a 2-second timeout, and never fails a request; failures log
  `analytics: capture failed|rejected` with no payload.
- The app's in-app analytics switch does not reach the worker; these events
  are sent regardless of it.

## Route planning

`POST /route-planning/optimize` backs the app's Supporter-only "Plan today's
route". Code lives in `src/routePlanning/`; README documents the contract.

- **HERE product**: Waypoints Sequence v8 (`findsequence2`), one transaction per
  request up to 100 stops (2,500 free a month on the Base Plan, then about $5.83
  per 1,000). `mode=fastest;car;traffic:enabled`, `departure=now`, no `end` (the
  route finishes at the last stop). Matrix Routing would cost about 5 × N
  transactions plus our own solver, and Tour Planning bills every location.
- **Gate**: a bearer request (witness-work ADR 0029) is the token's
  account: `requireActive` (403 `suspended`), then `isAccountSupporter`, the
  account's own status. A legacy request (no `Authorization` header) still
  checks `isSupporter()` against the body's `accountId` (the RevenueCat app
  user id) while `auth:legacy` is on, and is 426 `upgrade_required` once it's
  off. Both fail closed: a RevenueCat error returns 503
  `supporter_check_failed`, never a route. On the dev worker a `dev` session
  (bearer) or the shared `x-ww-dev-bypass` token (legacy,
  `NOTES_IMPORT_DEV_BYPASS_TOKEN`) skips the Supporter check; production
  ignores both.
- **Limits** (`ROUTE_PLANNING_LIMITS` in `src/routePlanning/config.ts`): 10
  stops per request, and per account 10 optimizations in any rolling 24 hours
  and 3 per minute. Enforced by the `RoutePlanningQuota` SQLite DO (binding
  `ROUTE_PLANNING_QUOTA`, migration `v5`, one instance per caller:
  `account:<accountId>` for bearer, the app user id for legacy, which
  stores only optimization timestamps and deletes itself a day after the
  newest). Every call that reaches HERE counts, including `no_route` answers.
  The per-IP `RATE_LIMITER` also applies.
- **Kill switch**: KV `route-planning:enabled` in `NOTES_KV`. `"false"` turns
  optimizing off (503 `unavailable`; the app says it's temporarily unavailable);
  absent or anything else leaves it on. Edge-cached for 60 seconds.

  ```bash
  wrangler kv key put --binding NOTES_KV route-planning:enabled false   # off
  wrangler kv key delete --binding NOTES_KV route-planning:enabled      # on
  ```

- **Privacy**: HERE receives only coordinates under opaque ids, in a form POST
  body so they never appear in a URL. RevenueCat and HERE calls use the fetch
  captured before Sentry wraps the global, so the account id (in RevenueCat's
  URL) and the HERE key stay out of trace spans. Nothing logs bodies,
  coordinates, or account ids.

## API docs (OpenAPI + Scalar)

`GET /docs` is the Scalar API reference and `GET /openapi.json` its OpenAPI
3.1 document, on both workers (prod: https://ww-proxy.leviwilkerson.com/docs).
The repo is public, so the docs are too, admin routes included (they still
need the token).

- `hono-openapi` builds the document from the routes themselves: each route
  carries a `describeRoute(...)` middleware, kept in an `openapi.ts` beside its
  handlers (`src/attestation/`, `src/notesImport/`, `src/buddies/`,
  `src/accounts/`, `src/spaces/`, `src/routePlanning/`; routes registered in `src/app.ts` use
  `src/openapi/coreDocs.ts`). Shared helpers and the error envelope are in
  `src/openapi/schemas.ts`; tags, servers, and the Scalar config in
  `src/openapi/route.ts`.
- The schemas describe the wire format for readers; they don't validate.
  Handlers keep their own parsing, so **a contract change means updating the
  route's `openapi.ts` in the same PR**.
- `src/openapi/openapi.test.ts` fails on any route without docs, and on any
  operation without a tag, summary, or responses.
- Signed Buddies/accounts ops document the envelope `{payload, signature}`
  and list the decoded `payload` fields as a table (`signedBody`).
- The legacy short names `p`/`s` (and `x-buddies-p`/`-s`, `x-ww-p`/`-s`) are
  accepted for shipped builds but appear in the docs only as a note; never
  add a new short name.
- The document is built once per isolate. Scalar's UI loads from jsDelivr.

## API design: readable, standard REST

This project is open source. Anyone can read this repo, the app's repo, the
generated `/docs`, and `/openapi.json`, so hiding the API's shape buys no
security. Short or cryptic names (`p`, `s`, single letters, unexplained
abbreviations) only make the API harder to read, debug, and maintain.
Security comes from signatures, attestation, capability secrets, rate limits,
and end-to-end encryption, never from obscure names.

When adding or changing an endpoint:

- **Name things for a human reader.** Spell fields, headers, and query
  parameters out in full camelCase (`signature`, not `s`; `payload`, not
  `p`; `publicKey`, not `pub`). Abbreviate only where every developer knows
  the term (`id`, `url`, `nonce`), and give every number its unit in the
  name or its description (`durationSeconds`, `expiresAt` in epoch ms).
  Some shipped names predate this (`ts`, `*Pub`, `seq`); don't copy them
  into new routes.
- **Follow REST and HTTP conventions.** Resource-oriented paths, the right
  method and status code, `Content-Type` and `Retry-After` honoured, JSON
  bodies, errors in the shared `{ ok, error, code }` envelope. Where a route
  deliberately departs from REST (Buddies' and accounts' `POST /{op}` keeps
  ids out of URLs, which production logs), document why in its `openapi.ts`.
- **Document as you go.** Every field gets a description in the route's
  `openapi.ts`; `/docs` should be enough to call the API without reading the
  source.
- **Renaming a shipped field:** accept both names on the server, document
  only the new one (mention the old one as legacy), switch the app, and keep
  the alias as long as supported builds send it. Inside signed payloads the
  server verifies the exact bytes it got, so an alias there only needs the
  parser to read either name.

## Checks before deploy

```bash
pnpm test
pnpm exec tsc --noEmit
wrangler deploy --dry-run            # prod build
wrangler deploy --env dev --dry-run  # dev build
```

## Verification loop

Before claiming backend work is done, run the `verify-ww-api` loop
(`.agents/skills/verify-ww-api/SKILL.md`): `node scripts/verify/dev.mjs up`,
`doctor`, `pnpm test:e2e`, `pnpm fuzz:buddies` for relay changes, then `down`.

## Architecture diagram

The diagram of how the app, this Worker, its Durable Objects, R2 and KV, and
outside services connect lives in witness-work's
[`readme.md`](https://github.com/leviFrosty/witness-work/blob/main/readme.md#architecture).
When a change here adds, removes, or moves one of those connections, open a PR
in witness-work that updates the diagram, and link the two PRs. Examples: a new
route group the app calls; a new Durable Object, R2 bucket, KV namespace, or
cron job; or a new or different outside service, such as a model provider. A
new endpoint in an existing route group, or a change inside one service,
doesn't need it.

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

## Notes Import streaming

Each import runs in a `NotesImportRun` SQLite Durable Object (`NotesImportIndex`
per user holds the concurrency cap) via AI SDK v6 `streamText` +
`Output.object`: authenticated kickoff (`POST /notes-import/kickoff`) → SSE progress
(`GET /notes-import/:id/events`) → result snapshot (`/result`). The legacy
`POST /notes-import` remains as a fallback. Model, providers, reasoning effort,
and the output-token budget are `NOTES_IMPORT_*` vars in `wrangler.toml`
(defaults in `src/notesImport/config.ts`); the budget includes reasoning and
JSON. Strict structured output is validated locally against the same JSON
schema. Reasoning-only exhaustion gets one retry with thinking off; nonblank
invalid or truncated JSON never retries, cancellation prevents a retry, and
usage includes both attempts. Logs include model, host, finish reason, and
token/cache counts, never content. Architecture and decisions:
[`docs/notes-import-streaming-durable-objects.md`](docs/notes-import-streaming-durable-objects.md).
