# Health and status

The app and operators probe the worker for liveness, Notes Import availability, and paywall social proof. A healthy worker answers `/health` with its build, tells the app whether Notes Import is usable and what the allowances are, and serves cached App Store ratings once the cron has published a summary.

## Sub-features

- `health` returns `{status:"ok", timestamp, versionId, deployedAt}`.
- `notes-status` returns `available`, optional `limits`, `capabilities.appAttest.protocolVersions`, and `Cache-Control: no-store`.
- `notes-status-killswitch` reports `available:false` when KV `notes-import:enabled` is `{"available":false}`.
- `ratings-empty` returns 503 `{"error":"Ratings unavailable"}` with `no-store` before any sweep.
- `ratings-served` returns the published summary with `s-maxage=21600`.
- `not-found` returns a JSON 404 for unknown routes.

## How to get to it (user POV)

- The app's Notes Import entry points call `GET /notes-import/status` before showing the composer.
- The paywall calls `GET /app-store/ratings` for its rating badge.
- Uptime checks and the app's dev tools call `GET /health`.

## Driving it with verify-ww-api

Preconditions:

- `node scripts/verify/dev.mjs doctor` passes and `URL` is exported.

- **Liveness.** Probe health. Run `curl -s $URL/health`. The body has `"status":"ok"` and a `versionId`.
- **Availability.** Ask whether imports work. Run `curl -si $URL/notes-import/status -H "cf-connecting-ip: 198.18.1.1"`. You get 200 with `cache-control: no-store` and `"capabilities":{"appAttest":{"protocolVersions":[1,2]}}`. `available` is a boolean.
- **Kill switch.** Turn Notes Import off. Run `node scripts/verify/dev.mjs kv put notes-import:enabled '{"available":false,"reason":"verify"}'`, then re-run the availability curl. Poll for up to 30 s if status was read recently. The body reads `"available":false,"reason":"verify"`. Restore it with `node scripts/verify/dev.mjs kv delete notes-import:enabled`. Status can stay off for another 30 s after that.
- **Ratings before sweep.** Run `curl -si $URL/app-store/ratings` on fresh state. You get 503 with `cache-control: no-store`.
- **Ratings served.** Publish a summary the way the cron would. Run `node scripts/verify/dev.mjs kv put app-store-ratings:summary '{"averageRating":4.87,"ratingCount":1234,"countryCount":42,"updatedAt":"2026-10-01T00:00:00.000Z"}'`, then repeat the curl. You get 200 with the same JSON and `s-maxage=21600`.
- **Unknown route.** Run `curl -s $URL/nope`. The body is `{"error":"Not found"}` with status 404.
- **Proof.** Run `pnpm test:e2e src/e2e/public.e2e.test.ts`. Vitest reports the health, status, ratings, and 404 tests as passed, and `.verify/artifacts/e2e-public-*.json` holds the exchanges.

## Gotchas

- `/notes-import/status` caches completed responses per isolate for 30 s. A KV flip shows up only after that window, or after `down` and `up`.
- With no `OPENROUTER_API_KEY`, the provider probe fails open (`available:true`). Don't treat that as proof that providers are healthy.
- Once ratings are served, the local Cache API keeps the 200 for 6 h. To see the 503 again, run `down --wipe` and then `up`.
- Crons don't run under `wrangler dev`. Seed `app-store-ratings:summary` instead of waiting for the sweep, and never curl `/cdn-cgi/handler/scheduled`, which calls Apple's iTunes lookup.
