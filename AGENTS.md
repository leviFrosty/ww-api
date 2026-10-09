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

### Android Notes Import (Play Integrity)

Android authenticates Notes Import with Google Play Integrity standard requests
instead of App Attest (witness-work ADR 0017; code in `src/playIntegrity/`). A
request opts in with `attestationProvider: "play-integrity"` on the existing
`/notes-import/challenge`, `/kickoff`, and `/verify` routes; bodies without it
take the unchanged App Attest paths. Challenges live in the
`PLAY_INTEGRITY_CHALLENGES` Durable Object (migration `v4`), never in
`AppAttestIdentity`. The worker decodes each token through Google's
`decodeIntegrityToken` with a service account, then requires the request
binding, `PLAY_RECOGNIZED`, and `MEETS_DEVICE_INTEGRITY`. Licensing is not
required.

Android stays off until all three are set per environment; only then does
`GET /notes-import/status` advertise `capabilities.playIntegrity`:

| Setting | Kind | Value |
| --- | --- | --- |
| `ANDROID_PACKAGE_NAME` | var | `com.leviwilkerson.jwtime` |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | var | Google Cloud project number (not the id) |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | secret | Service-account JSON key |
| `ANDROID_CERT_SHA256_DIGESTS` | var, optional | base64url SHA-256 of the Play app-signing certificate |
| `PLAY_INTEGRITY_REQUIRED_DEVICE_VERDICT` | var, optional | `MEETS_DEVICE_INTEGRITY` (default), `MEETS_BASIC_INTEGRITY`, `MEETS_STRONG_INTEGRITY` |

One-time setup:

1. Google Cloud: enable **Google Play Integrity API** in a project and note
   its project number.
2. Play Console → WitnessWork → **Protected with Play** → Play Integrity API →
   **Link Cloud project** (that project). The default responses already
   include `MEETS_DEVICE_INTEGRITY`; basic/strong need an opt-in under Change
   responses.
3. Same project: IAM & Admin → Service Accounts → create one (no role needed)
   → Keys → Add key → JSON.
4. `wrangler secret put PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON < key.json` (and
   `--env dev`), then delete the downloaded key.
5. Uncomment and fill the two vars in `wrangler.toml` under `[vars]` and
   `[env.dev.vars]`. Optionally pin the certificate from Play Console → App
   integrity → App signing:
   `echo "<SHA-256 with colons>" | tr -d ':' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='`.
6. `pnpm run deploy:dev`, then `pnpm run deploy` (applies `v4`).

Development builds (`com.leviwilkerson.jwtimedev`) aren't on Play and
emulators fail device integrity, so exercise real tokens with a
Play-installed `com.leviwilkerson.jwtime` build (an internal testing track);
use the dev bypass otherwise. Failures return `attestation_failed` with a
stable `reason`: `device_integrity_failed`, `app_not_recognized`,
`integrity_token_invalid`, `integrity_unavailable` (Google, credentials, or
quota; reported to Sentry), or a challenge reason. The default quota is 10,000
decodes per day; request more through Google's quota form before it matters.

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

For verification, agents use the `verify-ww-api` loop below instead: it runs an
isolated worker on 8790-8799, and 8787 belongs to the user's own `wrangler dev`.

Neither gives a stable public URL for an iOS device — use the deployed
`--env dev` worker (or a `cloudflared` tunnel) for real-device App Attest tests.

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
no-app fallback page for invite links (App Store and Google Play buttons), the
AASA matches `/b#1…`, and `public/.well-known/assetlinks.json` verifies the
whole host, `/b` included, for Android App Links. Clients are iOS and Android
(witness-work ADR 0020).

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
  - Per caller, in the Worker before any DO wakes: the client IP (IPv6 by
    /64), never the target inbox. `BUDDIES_RATE_LIMITER` 120/min for
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
  - `inbox/register`: 2,000 validly signed calls per caller per rolling day
    (`BuddyRegistrationQuota`, hourly counts under a hashed caller key).
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
  with the owner-signed envelope (op `blob/put`) in `x-buddies-p` /
  `x-buddies-s`; the Worker reads at most 1 MiB, recomputes
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
  owner-signed envelope (op `inbox/live`) rides in the `x-buddies-p` and
  `x-buddies-s` headers. The inbox DO accepts it with the Hibernation API
  (`ping` gets `pong` without waking it, at most 10 sockets per inbox) and
  sends `{"type":"changed","seq":…}` after each write that changes
  `inbox/sync`. Sentry events drop `x-buddies-*` headers. Under `wrangler
  dev`, the TCP connection lingers about 10 s after a server-sent close frame;
  the frame itself arrives at once.
- **Privacy**: every id travels in the body (for the live socket, in headers;
  never the URL). Never log or report bodies, headers, blobs,
  ids, or tokens. APNs and FCM requests use the `fetch` captured before
  Sentry wraps the global, so device tokens in APNs URLs stay out of Sentry
  spans (FCM tokens travel only in request bodies). The dev worker's 100%
  Workers traces do record subrequest URLs, APNs included.
- **Not yet built** (required before any production rollout): App Attest on
  `inbox/register` and `invite/*` (`attest` is accepted and ignored; Android
  will use Play Integrity). `blob/put` isn't attested either; the plan is to
  attest an inbox once per few days through a Notes Import purpose and have
  `blob/put` require a recent one, rather than attesting each upload. The protocol's durable push outbox (retries for
  6 h, outcome history, deferred instead of dropped alerts inside the 60 s
  spacing, `apns-expiration`) is specified but not built either;
  today each push gets one immediate attempt plus one retry.

Dev deploy (first time):

```bash
wrangler secret put APNS_KEY_ID --env dev
wrangler secret put APNS_PRIVATE_KEY --env dev < AuthKey_XXXXXXXXXX.p8
# Android (FCM): one line of JSON from the 1Password item above.
jq -c . buddies-fcm-sender.json | wrangler secret put FCM_SERVICE_ACCOUNT_JSON --env dev
pnpm run deploy:dev   # applies the v3 migration to ww-proxy-dev
# Optional; dev is already on via BUDDIES_ENABLED:
wrangler kv key put --binding NOTES_KV buddies:enabled true --env dev
```

Production takes the same three secrets without `--env dev`, and the `v3`
migration applies on the next `pnpm run deploy`. Buddies stays off there
(`BUDDIES_ENABLED = "false"`) until the KV key flips it. The AASA `/b` entry
only goes live with a prod deploy. iOS caches the AASA, so ship it at least one
app version before the invite UI.

Photo blobs need their R2 buckets **before the first deploy that carries the
`BUDDY_BLOBS` binding** (a deploy naming a missing bucket fails), plus a
lifecycle rule as a backstop (blobs are deleted by the inbox at `expiresAt`;
the rule only catches objects the relay lost track of). Every deploy runs
`scripts/r2-lifecycle.mjs` first, which creates the bucket if it's missing and
sets its rules (`v1/` objects deleted 91 days after their last write); the
GitHub deploy's `CLOUDFLARE_API_TOKEN` needs **Workers R2 Storage: Edit**.
`node scripts/r2-lifecycle.mjs <bucket> --check` only reads.

```bash
pnpm run deploy:dev   # photos are on in dev through BUDDIES_PHOTOS = "on"
pnpm run deploy       # or push a v* tag (GitHub deploy)
# Production photos stay off until:
wrangler kv key put --binding NOTES_KV buddies:photos on
# Off again (stored blobs stay until they expire):
wrangler kv key put --binding NOTES_KV buddies:photos off
```

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

## Notes Import analytics (PostHog)

The worker sends anonymous Notes Import usage events to the WitnessWork
PostHog project (US cloud), so adoption is measured over every import, not
only installs with app analytics on. Code: `src/analytics.ts` (feature-neutral
sender) and `src/notesImport/analytics.ts` (events). On when
`POSTHOG_PROJECT_TOKEN` is set: prod `[vars]` has it, `[env.dev.vars]` leaves
it commented out.

| Event | When | Properties beyond the shared ones |
| --- | --- | --- |
| `api_notes_import_started` | An attested import starts a fresh model run (kickoff or legacy; not reconnects) | `notes_chars`, `new_content`, `imports_remaining` |
| `api_notes_import_finished` | Once per started run | `outcome` (`success`, `model_error`, `cancelled`, `interrupted`), `duration_ms`, `notes_chars`; on success: `empty`, `empty_charged`, record counts (`contacts`, `visits`, `time_entries`, `categories`, `warnings`, `publisher_detected`), `imports_remaining`, `model`, `provider`, `input_tokens`, `output_tokens`, `reasoning_tokens` |
| `api_notes_import_limit_reached` | An authenticated request is refused by an allowance or the concurrency cap | `limit` (`imports`, `refinements`, `active_cap`) |

Every event carries `platform` (`ios`, `android`, `dev` for the bypass),
`transport` (`stream`, `legacy`), `refinement`, `supporter`, `has_account`, and
`environment`. The internal-TestFlight Beta app talks to prod, so its imports
are counted as `ios`.

- **Identity**: `distinct_id` is `ww_` plus a truncated SHA-256 of the meter id
  (account id, else install uuid), so unique users, DAU/WAU/MAU and retention
  work without the id itself reaching PostHog. It can't be joined to the app's
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
- **Gate**: `isSupporter()` against the request's `accountId` (the RevenueCat
  app user id). Fails closed: a RevenueCat error returns 503
  `supporter_check_failed`, never a route. No App Attest, so Android works too;
  the account id is an unguessable UUID, and the per-account limits bound what
  a leaked one could spend. On the dev worker the shared `x-ww-dev-bypass`
  token (`NOTES_IMPORT_DEV_BYPASS_TOKEN`) skips the RevenueCat check; production
  ignores it.
- **Limits** (`ROUTE_PLANNING_LIMITS` in `src/routePlanning/config.ts`): 10
  stops per request, and per account 10 optimizations in any rolling 24 hours
  and 3 per minute. Enforced by the `RoutePlanningQuota` SQLite DO (binding
  `ROUTE_PLANNING_QUOTA`, migration `v5`, one instance per account id, which
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

The first deploy applies the `v5` migration (prod and `--env dev`).

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
