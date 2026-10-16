# WW API

A lightweight Cloudflare Workers api and proxy service for HERE API endpoints, iOS universal links, etc. with Sentry monitoring.

## Open source, open API

WW API is open source, like the [WitnessWork app](https://github.com/leviFrosty/witness-work)
it serves. Anyone can read the code, the protocol docs in [`docs/`](docs/),
and the generated API reference at [`/docs`](https://ww-proxy.leviwilkerson.com/docs).
Since the whole contract is public, there's nothing to gain by obscuring it:
short or cryptic field names, headers, or paths would only make the API harder
to read, debug, and build on.

So the API aims to be standard REST, carefully maintained, and easy for people
to read:

- **Plain names.** Fields, headers, and query parameters are spelled out in
  full (`payload` and `signature`, not `p` and `s`). Units go in the name or
  the description (`durationSeconds`, `expiresAt` in epoch ms).
- **Standard HTTP.** The right methods and status codes, JSON bodies, one
  error envelope (`{ "ok": false, "error", "code" }`), and `Retry-After` on
  every 429 and 503. Where a route departs from REST on purpose, its docs say
  why. For example, the Buddies relay and the accounts handoff and backup
  ops use `POST /{op}` so ids stay out of URLs, which production logs, while
  account sessions are plain resources (`POST /accounts/v1/sessions`,
  `DELETE /accounts/v1/sessions/current`).
- **Documented.** Every route and field is described in `/docs`, generated
  from the routes, so you can call the API without reading the source.

Security never depends on the API being hard to read. It comes from Ed25519
signatures, App Attest / Play Integrity, capability secrets, rate limits, and
end-to-end encryption (the Buddies relay only ever sees ciphertext).

Some names shipped before this rule. Those still work as legacy aliases (for
example, signed envelopes still accept `p`/`s` and the `x-buddies-p`/`-s` and
`x-ww-p`/`-s` headers from older app builds), but new code and docs use only
the full names.

## Prerequisites

- [pnpm](https://pnpm.io/) installed
- [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)
- [HERE API key](https://developer.here.com/)
- [Sentry account](https://sentry.io/) (optional but recommended for error logging)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy the example file and fill in your credentials:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your actual values:

```bash
HERE_API_KEY=your_here_api_key
SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
```

## Development

Run the development server:

```bash
pnpm run dev
```

The service will be available at `http://localhost:8787`

### Test endpoints

```bash
# Autocomplete
curl "http://localhost:8787/autocomplete?q=cincinnati&limit=5"

# Geocode
curl "http://localhost:8787/geocode?q=48 Muir+Rd,+Rogers,+KY+41365"

# Health check
curl "http://localhost:8787/health"
```

## Deployment

### Manual deployment

Set secrets (one-time setup):

```bash
pnpm exec wrangler secret put HERE_API_KEY
# Paste your HERE API key when prompted

pnpm exec wrangler secret put SENTRY_DSN
# Paste your Sentry DSN when prompted
```

Verify secrets are set:

```bash
pnpm exec wrangler secret list
```

Deploy to Cloudflare Workers:

```bash
pnpm run deploy
```

### Automatic deployment via GitHub Actions

The project includes CI/CD that deploys automatically on git tags.

#### 1. Add GitHub secrets

Go to your repo → Settings → Secrets and variables → Actions

Add these secrets:

- `CLOUDFLARE_API_TOKEN` - [Get from Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
- `HERE_API_KEY` - Your HERE API key
- `SENTRY_DSN` - Your Sentry DSN

#### 2. Get Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use "Edit Cloudflare Workers" template
4. Copy the token and add it to GitHub secrets as `CLOUDFLARE_API_TOKEN`

#### 3. Deploy by pushing a tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will automatically deploy to Cloudflare Workers. Monitor deployment in the Actions tab.

## API Endpoints

Full API reference: [`/docs`](https://ww-proxy.leviwilkerson.com/docs) (Scalar), generated from the routes; the raw OpenAPI 3.1 document is at [`/openapi.json`](https://ww-proxy.leviwilkerson.com/openapi.json). Locally: `http://localhost:8787/docs`.

### Signed requests (Buddies and accounts)

Signed ops send a JSON envelope:

```json
{ "payload": "<base64url of the UTF-8 JSON request fields>", "signature": "<base64url Ed25519 signature>" }
```

`signature` covers the op's context line (`ww-buddies/v1\n<op>\n` or
`ww-account/v1\n<op>\n`) followed by the exact decoded `payload` bytes. Routes
whose body is raw bytes, or that have no body (`blob/put`, `backup/put`, the
live WebSocket), send the same two values in `x-buddies-payload` /
`x-buddies-signature` or `x-ww-payload` / `x-ww-signature`. Each op in `/docs`
lists its decoded `payload` fields. The wire contract is
[`docs/buddies-protocol.md`](docs/buddies-protocol.md).

App versions with account sessions sign far less: they sign only to open a
session (and to delete backups), and call every other accounts route with
`Authorization: Bearer <accessToken>` (below).

### Accounts and sessions (`/accounts/v1/*`)

Anonymous accounts (a random id and a public key). An app proves it's
WitnessWork once per session and then calls with short-lived bearer tokens:

- **`POST /accounts/v1/sessions`** opens a session: an envelope self-signed
  by the account key (op `session/open`) carrying an attestation from
  `POST /attestation/v1/challenge` (purpose `account-session`, both hashes
  `hex(SHA-256("ww-account/v1/session\n" + accountPub))`). Answers 201 with
  an access token (a 15-minute JWT), a refresh token, and `Location:
  /accounts/v1/sessions/current`. Sessions last 90 days.
- **`POST /accounts/v1/sessions/refresh`** trades `{ refreshToken }` for a
  new pair; each refresh token works once (plus a 60-second grace for a lost
  response), and presenting an older one ends the session. Refresh tokens are opaque strings
  (`<sessionId>.<secret>`).
- **`DELETE /accounts/v1/sessions/current`** ends the token's session.
- **`GET /accounts/v1/account`** reads the token's account.
- Handoff (`/accounts/v1/handoff/*`) and backup (`/accounts/v1/backup/*`)
  take the bearer token too, as `POST /{op}` with ids in bodies.

Older app versions authenticate the pre-session way (signed envelopes,
`account/register`, `account/info`) while the legacy switch (KV
`auth:legacy`) is on; once it's off they get 426 `upgrade_required`.
`GET /app/v1/config` (no auth) tells the app its minimum version, so it can
show Update Required first. The runbook is in `AGENTS.md`, "Turning off
backward compatibility".

### `/autocomplete`

Proxies to HERE Autocomplete API.

**Example request:**

```bash
curl "https://your-worker.workers.dev/autocomplete?q=Seattle&limit=5"
```

**Query parameters:**

- `q`: Search query (required)
- `limit`: Max number of suggestions
- `in`: Geographic filter (e.g., `circle:47.6,-122.3;r=50000`)
- All other [HERE Autocomplete API parameters and docs](https://www.here.com/docs/bundle/geocoding-and-search-api-developer-guide/page/topics/endpoint-autocomplete-brief.html)

**Note:** The `apiKey` parameter is automatically injected by the proxy. Any `apiKey` sent by the client will be removed.

### `/geocode`

Proxies to HERE Geocode API.

**Example request:**

```bash
curl "https://your-worker.workers.dev/geocode?q=1600+Amphitheatre+Parkway"
```

**Query parameters:**

- `q`: Address to geocode (required)
- All other [HERE Geocode API parameters and docs](https://www.here.com/docs/bundle/geocoding-and-search-api-developer-guide/page/topics-api/code-geocode-address.html)

**Note:** The `apiKey` parameter is automatically injected by the proxy. Any `apiKey` sent by the client will be removed.

### `/.well-known/apple-app-site-association`

Serves the AASA JSON used by iOS to validate universal links. Lists the prod
(`com.leviwilkerson.jwtime`), beta (`com.leviwilkerson.jwtimebeta`), and dev
(`com.leviwilkerson.jwtimedev`) bundle IDs, prefixed with `APPLE_TEAM_ID`.

Matches `/contacts#<payload>`, `/buddies/invite#1…`, and
`/accounts/handoff#1…`, plus the short paths older app versions put in links
(`/c#<payload>`, any URL under `/c/*`, `/b#1…`, `/h#1…`). Those links are
already in people's messages, so the short paths stay listed and served for
good; dropping one would open its links in Safari instead of the app.

### `/contacts` (and the short `/c`)

Universal-link landing page for shared WitnessWork contacts
(`/contacts#<payload>`). iOS hands the link off to the WitnessWork app when
installed; otherwise this endpoint serves a fallback HTML page with an App
Store CTA. `/c` serves the same page for links older app versions shared.

The page, accessibility labels, and Open Graph/Twitter preview strings support
the same 18 locales as `witness-work/src/lib/locales.ts`. Pass `?lang=pt-pt`
before the fragment (`/contacts?lang=pt-pt#<payload>`) to choose a language explicitly;
otherwise the worker uses `Accept-Language` preferences, including quality
weights, and defaults to English (`en-us`). Unsupported or malformed `lang`
values fall back to browser preferences. Regional variants fall back to the
same language; Portuguese defaults to `pt-br`, and Chinese uses Simplified
unless Traditional script or a Taiwan/Hong Kong/Macau region is requested.
Responses include `Content-Language` and `Vary: Accept-Language`. Preview
crawlers without a language preference receive English unless `lang` is set.
The `og:url` is the bare page path (`/contacts` or `/c`), without language or
contact data.
The same localization rules apply to legacy `/c/:payload` links.

The payload is an opaque gzip + base64url–encoded contact export produced by
the app. It rides in the URL fragment, which clients never send, so the worker
never sees it; the page's inline script builds the
`witnesswork://import-contact/<payload>` "Open app" link in the browser.

### `/c/:payload`

Legacy links from older app versions, with the payload in the path. Serves the
same page with a server-rendered "Open app" link; the payload stays out of
`og:url` and the other meta tags, and Sentry events redact it to
`/c/[redacted]`. The worker never decodes it.

### Attestation (`/attestation/v1/*`)

Device attestation for the whole API: App Attest on iOS, Play Integrity on
Android. Code in `src/attestation/`.

- **`POST /attestation/v1/challenge`** issues a one-time challenge: App Attest
  v1 (empty body), App Attest v2 (`bind`, `enroll`, or `assert`), or Play
  Integrity. v2 and Play Integrity challenges are bound to one protected
  request: its `purpose`, ids, and hashes.
- **`POST /attestation/v1/register`** binds an App Attest key to the install
  id, or enrolls a v2 recovery token. Play Integrity has no registration step.
- **`POST /attestation/v1/verify`** is an attested no-op for the app's
  developer tools (purpose `attestation-verify`; the older
  `notes-import-verify` is accepted too).
- **`GET /attestation/v1/status`** lists the accepted providers (App Attest
  always; Play Integrity once configured).

Each protected route verifies an assertion signed for its own `purpose`
(registry: `src/attestation/purposes.ts`). New routes call
`requireAttestation` (`src/attestation/http.ts`), which takes App Attest v2 or
Play Integrity. Purposes are signed by installed apps, so a shipped one is
never renamed.

The old paths `POST /notes-import/challenge`, `/notes-import/attest`, and
`/notes-import/verify` run the same handlers for deployed apps, adding
`Deprecation: @1792022400` (2026-10-15) and
`Link: </attestation/v1/…>; rel="successor-version"`. Each hit logs
`deprecated path: <old> -> <new>` (route names only). Remove them once the
minimum app version uses the new paths and those logs go quiet.

### Notes Import (`/notes-import*`)

LLM-backed parsing of free-form ministry notes into structured WitnessWork
records. The proxy owns the prompt + JSON schema, calls the model through
OpenRouter with routing pinned ZDR-only (`zdr: true` + `data_collection: 'deny'`,
restricted to a vetted Western provider allowlist) so the request can only reach
a zero-data-retention host that never trains on or stores it — failing rather
than ever downgrading to a data-retaining provider (ADR 0008). It persists
non-content authentication/runtime metadata in KV and aggregate usage plus
permanent replay/refinement records in a per-user Durable Object—never imported
text or model output in either meter store.

Both production and development use `openai/gpt-6-luna` through
OpenRouter. The fixed extraction instructions precede user context and tagged
notes; refinements keep that notes prefix and append the previous result and
correction. Strict JSON-schema output is validated locally before delivery,
including recovery from a completed response with misrouted reasoning-channel
JSON. Monthly totals become one dated time entry without an automatic warning.
The default uses `low` reasoning with a 32,000-token combined reasoning/JSON
budget. Higher efforts exhausted that budget in historical replay tests. A
blank completion that spent its full budget on reasoning gets one retry with
thinking explicitly disabled; partial/invalid JSON is never accepted, and
both attempts count toward the run's token usage.
Ambiguous dates are resolved once with a warning; conflicting house numbers
prevent fuzzy-name merges, and unnamed people identified by address retain
their visits. Model logs include only routing, finish reason, and token/cache
counts.

Core routes (all rate-limited). Attestation (challenge, App Attest key
registration, the verify probe) lives under `/attestation/v1/` (below); the
old `POST /notes-import/challenge`, `/attest`, and `/verify` still serve the
same handlers for deployed apps.

- **`POST /notes-import/kickoff`** starts a streaming run and returns its handle
  (and, for legacy requests, a capability token) and strict `credits` preview;
  `GET .../events` / `.../result` carry the terminal result and authoritative
  `credits` snapshot.
- **`POST /notes-import/transcribe`** (Import from Paper) reads one page image
  (base64 JPEG or PNG, ≤ `NOTES_IMPORT_TRANSCRIBE_MAX_BYTES`) into plain text
  with `NOTES_IMPORT_TRANSCRIBE_MODEL` on the same ZDR allowlist, and returns
  `{ text, truncated, pagesRemaining }`. Legacy requests are attested with
  App Attest v2 or Play Integrity under purpose `notes-import-transcribe`: the
  content hash is the SHA-256 of the base64 string, and the request hash
  covers `{ imageHash, mimeType }`. The image is never stored or logged.
  Pages spend no credit (the app sends the edited text through kickoff), but a
  free user with no imports left is refused, and each identity gets
  `NOTES_IMPORT_TRANSCRIBE_PAGES_PER_DAY` pages per rolling day (`…_SUPPORTER`
  for Supporters); over it → 429 `transcribe_limit` with `Retry-After`.
  `GET /notes-import/status` advertises `capabilities.transcribe`.
- **`POST /notes-import`** is the synchronous fallback under identical rules.
- **`GET /notes-import/status`** is public and supplies a fresh allowance
  schedule only when availability is confirmed.

#### Who's calling: account sessions (bearer) or legacy

App versions with account sessions call every Notes Import route with
`Authorization: Bearer <accessToken>` (from `POST /accounts/v1/sessions`, see
[Accounts and sessions](#accounts-and-sessions-accountsv1)). The session
attested once, so these requests carry no attestation fields and no hashes, and
the token's account is the meter: allowances, replays, the concurrency cap, and
Import from Paper's page limit all key on it. A request with an `Authorization`
header is always a bearer request; a bad token is never a fallback to the old
way. Older app versions send no `Authorization` header and authenticate per
request (below) while the legacy switch (KV `auth:legacy`) is on.

**Bearer contract.** JSON bodies; any field not listed is ignored (`uuid`,
`accountId`, `contentHash`, `requestHash`, and every attestation field
included).

| Route | Body | 200 |
| --- | --- | --- |
| `POST /notes-import/kickoff` | `{ notesText, context, refinement?, revenueCatAppUserId? }` | `{ importId, refinement, credits }` (no `subscribeToken`) |
| `POST /notes-import` (synchronous fallback) | the same | `{ result, contentHash, refinement, emptyCharged, credits }` |
| `POST /notes-import/transcribe` | `{ image, mimeType, revenueCatAppUserId? }` | `{ ok, text, truncated, pagesRemaining }` |
| `GET /notes-import/{importId}/events` | none; `Last-Event-ID` header to resume | the SSE stream |
| `GET /notes-import/{importId}/result` | none | `{ status, payload?, error? }` |
| `POST /notes-import/{importId}/cancel` | none | `{ status, payload?, error? }` |
| `POST /notes-import/{importId}/destroy` | none | `{ ok: true }` |

- `revenueCatAppUserId` (optional, 8-64 of `A-Z a-z 0-9 _ -`): the app's
  RevenueCat app user id. The server asks RevenueCat whether it's a Supporter,
  at kickoff and again when the run settles; absent means not a Supporter.
  It's a stopgap until RevenueCat is linked to the account, when the server
  will use the account's own id and ignore this field.
- **Run routes** take the access token instead of `?token=` (a bearer request
  never reads it) and serve only imports the token's account kicked off.
  Another account's import, an unknown id, and one deleted or past its 1-hour
  retention are all 404 `not_found`, so a response never says whether an
  import exists. A destroy of an import already deleted is that same 404.
- **Errors** keep Notes Import's shape, `{ ok: false, error: <message>, code }`,
  on both kinds of request: 401 `unauthorized` (missing, expired, or invalid
  token, with `WWW-Authenticate: Bearer error="invalid_token"`: refresh once
  and retry), 403 `suspended` on the metered routes (a suspended account can
  still read and delete its runs), 404 `not_found` (run routes), 503 `disabled`
  (sessions off on this worker), and every existing code (`limit_reached`,
  `refinement_limit`, `active_cap`, `transcribe_limit`, `unavailable`,
  `too_large`, `bad_request`, `model_error`, `server_error`).
- **Allowances start fresh.** Usage recorded under an install id or shared
  account id doesn't carry over to the account: each account gets a new
  window (decided in witness-work ADR 0027).
- **Dev sessions** (opened with the dev bypass on the dev worker) get the
  bypass's unlimited allowances and never Supporter status; production never
  verifies a `dev` token.
- `GET /notes-import/status` stays public and the same for everyone; it
  ignores `Authorization`. The account's balance is in kickoff's `credits`.

**Legacy** (no `Authorization` header). Inference is attested per request:
App Attest on iOS, Play Integrity on Android, with the body fields in `/docs`.
Run routes take the kickoff's `subscribeToken` as `?token=`. Once the legacy
switch is off, every legacy Notes Import request is 426 `upgrade_required` in
Notes Import's shape (message in `error`), with no `Retry-After`. A dev worker
may set `NOTES_IMPORT_DEV_BYPASS_TOKEN` so the simulator can send
`x-ww-dev-bypass: <token>` to skip attestation. It overrides both effective usage
allowances to unlimited while keeping real Supporter status false and retaining
hash/refinement accounting. Existing active-concurrency behavior is unchanged.
On a bearer request the header is ignored: the session's platform decides.
**Never set this token in production.**

**One-time setup** (beyond HERE/Sentry):

```bash
pnpm exec wrangler kv namespace create NOTES_KV
# → paste the printed id into wrangler.toml [[kv_namespaces]] id

pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put REVENUECAT_API_KEY
pnpm exec wrangler secret put ADMIN_API_TOKEN
pnpm exec wrangler secret put ADMIN_API_TOKEN --env dev  # use a DIFFERENT value
```

#### Runtime allowance configuration

Each environment's `NOTES_KV` may contain `notes-import:limits`:

```json
{"importsFree":3,"importsSupporter":-1,"refinementsFree":5,"refinementsSupporter":-1,"windowDays":30}
```

Allowance values are integer `-1` (unlimited), `0` (none), or positive finite;
`windowDays` is any positive finite number and may be fractional in development.
Each field independently resolves KV → environment variable → code default. KV
reads use a 60-second edge cache. Model/provider, concurrency, and Empty Import
grace controls remain environment-only; see `src/notesImport/config.ts` and
`wrangler.toml`.

#### Admin usage reset

Generate distinct prod/dev tokens with `openssl rand -base64 32`, configure the
Wrangler secrets above, copy `.env.example` to the gitignored `.env`, and set the
matching local tokens plus the dev Worker URL. Then run:

```bash
pnpm run admin:reset-usage <meterId>         # production
pnpm run admin:reset-usage --dev <meterId>   # development
```

The meter id is the account id for app versions with account sessions (find it
from a Buddies inbox with `POST /admin/accounts/lookup`), and the shared
account id or install uuid for older ones.

The secret route clears only the aggregate import window and Empty Import rows;
permanent hash replay and refinement records survive. Missing configuration or
bad auth returns 404. Data Studio remains the manual emergency fallback. Never
reuse `NOTES_IMPORT_DEV_BYPASS_TOKEN` as the admin secret.

### `POST /route-planning/optimize`

Supporter-only shortest driving order for the app's "Plan today's route". Sends
the stops to HERE Waypoints Sequence v8 (`findsequence2`), which returns the
fastest visiting order (live traffic, open path ending at the last stop) for one
transaction per request.

**Request** (JSON; any other field is rejected):

```json
{
  "accountId": "<app account id>",
  "start": { "lat": 39.1031, "lng": -84.512 },
  "stops": [{ "lat": 39.11, "lng": -84.5 }, { "lat": 39.12, "lng": -84.49 }]
}
```

1–10 stops. HERE receives only the coordinates, under opaque ids (`start`,
`s0`…), in a form POST body. The account id is used only for the RevenueCat
Supporter check and the per-account limits; neither it nor the coordinates are
logged or stored.

**Response:**

```json
{ "order": [1, 0], "distanceMeters": 4321, "durationSeconds": 601, "remainingToday": 9 }
```

`order` lists indices into `stops` in visiting order.

**Errors** carry `{ "ok": false, "error", "code" }` (`error` is a message;
branch on `code`): `bad_request` (400), `payload_too_large` (413),
`supporter_required` (403), `supporter_check_failed` (503 — RevenueCat
unreachable; fails closed), `unavailable` (503 — kill switch), `daily_limit` /
`rate_limited` (429), `no_route` (422), `upstream_error` (502). Every 429 and
503 sends `Retry-After` and repeats it as `retryAfter` (and, for older builds,
`retryAfterSeconds`).

### `/health`

Health check endpoint, and the clock clients calibrate against: it sends
`Cache-Control: no-store` and a `Date` header, and does no I/O.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-11-27T12:34:56.789Z",
  "serverTime": 1732710896789,
  "versionId": "…",
  "deployedAt": "…"
}
```

## Error Responses

Every JSON route answers errors with one envelope (`src/errors.ts`):

```json
{ "ok": false, "error": "rate_limited", "code": "rate_limited", "retryAfter": 60 }
```

- `code` is always the stable, machine-readable code; read it first.
- `error` is the same code everywhere except attestation, Notes Import, and
  route planning, where it stays a human-readable message for shipped builds.
- Every 429 and 503 sends `Retry-After` (seconds) and repeats it as
  `retryAfter`, except quotas no wait can free (Notes Import's
  `limit_reached` and `refinement_limit`, Buddies' `limit`).
- Routes add their own fields beside these (`reason`, `action`, `credits`,
  `serverTime`, HERE's own error fields on the place-search proxy).
- A bearer route's missing, expired, or invalid token is 401 `unauthorized`
  with `WWW-Authenticate: Bearer error="invalid_token"`: refresh once and
  retry. A request authenticated the pre-session way after the legacy switch
  is off is 426 `upgrade_required`, without `Retry-After`.
- `/geocode` and `/autocomplete` pass HERE's status through; a HERE error body
  keeps its fields and gains the envelope (`bad_request`, `not_found`,
  `rate_limited`, `upstream_error`). HERE unreachable or answering non-JSON is
  502 `upstream_error`.
- The HTML pages (`/contacts`, `/buddies/invite`, `/accounts/handoff`, and
  the short `/c`, `/c/:payload`, `/b`, `/h`) are for browsers and always
  answer 200.
- `POST /buddies/v1/blob/get` answers a Buddies photo blob's raw bytes
  (`application/octet-stream`) on success; its errors use the envelope.

Per-IP limits (`RATE_LIMITER`, 60/min) count each route family in its own
bucket: `places` (`/geocode`, `/autocomplete`), `notes-import`,
`attestation`, `route-planning`, `admin`, and `app` (`/app/v1/*`)
(`src/rateLimit.ts`). The old `/notes-import/*` attestation paths still
count in `notes-import`. Refusals are 429 `rate_limited` with
`Retry-After: 60`. Buddies and accounts have their own per-caller tiers.

Unexpected errors are 500 `server_error` and are reported to Sentry.

## Architecture

```
Client Request
    ↓
Cloudflare Workers (Global Edge)
    ↓
Hono Router
    ↓
API Key Injection & Sanitization
    ↓
HERE API
    ↓
Response to Client

(Sentry monitors all errors)
```

## Stack

- **Runtime**: Cloudflare Workers with `nodejs_compat`
- **Framework**: [Hono](https://hono.dev/)
- **Language**: TypeScript
- **Package Manager**: pnpm
- **Monitoring**: Sentry
- **Wrangler**: v4.42.2

## App OTA updates

Hot Updater runs in separate dev, beta and prod Workers, each with its own D1
catalog and private R2 bucket. See [the OTA runbook](docs/ota-updates.md) for
resource identities, migration/deployment commands and credential setup.
