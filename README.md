# WW API

A lightweight Cloudflare Workers api and proxy service for HERE API endpoints, iOS universal links, etc. with Sentry monitoring.

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

Serves the AASA JSON used by iOS to validate universal links for contact
sharing. Lists both dev (`com.leviwilkerson.jwtimedev`) and prod
(`com.leviwilkerson.jwtime`) bundle IDs, prefixed with `APPLE_TEAM_ID`.

Matches `/c` with a non-empty fragment (`/c#<payload>`) and, for links shared
by older app versions, any URL under `/c/*`.

### `/c`

Universal-link landing page for shared WitnessWork contacts
(`/c#<payload>`). iOS hands the link off to the WitnessWork app when
installed; otherwise this endpoint serves a fallback HTML page with an App
Store CTA.

The payload is an opaque gzip + base64url–encoded contact export produced by
the app. It rides in the URL fragment, which clients never send, so the worker
never sees it; the page's inline script builds the
`witnesswork://import-contact/<payload>` "Open app" link in the browser.

### `/c/:payload`

Legacy links from older app versions, with the payload in the path. Serves the
same page with a server-rendered "Open app" link; the payload stays out of
`og:url` and the other meta tags, and Sentry events redact it to
`/c/[redacted]`. The worker never decodes it.

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

Core routes (all rate-limited):

- **`POST /notes-import/challenge`** → `{ challenge }`. One-time App Attest nonce.
- **`POST /notes-import/attest`** performs the App Attest handshake.
- **`POST /notes-import/kickoff`** starts a streaming run and returns its handle,
  capability token, and strict `credits` preview; `GET .../events` / `.../result`
  carry the terminal result and authoritative `credits` snapshot.
- **`POST /notes-import`** is the synchronous fallback under identical rules.
- **`GET /notes-import/status`** is public and supplies a fresh allowance
  schedule only when availability is confirmed.

Auth is enforced by Apple **App Attest** on every inference kickoff. A dev worker
may set `NOTES_IMPORT_DEV_BYPASS_TOKEN` so the simulator can send
`x-ww-dev-bypass: <token>` to skip attestation. It overrides both effective usage
allowances to unlimited while keeping real Supporter status false and retaining
hash/refinement accounting. Existing active-concurrency behavior is unchanged.
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
{"importsFree":5,"importsSupporter":-1,"refinementsFree":5,"refinementsSupporter":-1,"windowDays":30}
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

The secret route clears only the aggregate import window and Empty Import rows;
permanent hash replay and refinement records survive. Missing configuration or
bad auth returns 404. Data Studio remains the manual emergency fallback. Never
reuse `NOTES_IMPORT_DEV_BYPASS_TOKEN` as the admin secret.

### `/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-11-27T12:34:56.789Z"
}
```

## Error Responses

All errors return JSON with an `error` field:

```json
{
  "error": "Error message"
}
```

All errors are automatically reported to Sentry with full context.

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
