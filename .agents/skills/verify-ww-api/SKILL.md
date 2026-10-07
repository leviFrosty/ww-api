---
name: verify-ww-api
description: Start an isolated local ww-api (Hono on Cloudflare Workers via wrangler dev), prove routes work end to end over real HTTP, fuzz the Buddies relay protocol, and tear down with evidence kept. Use before claiming any backend change is done (routes, Notes Import, Buddies relay, universal-link pages, admin, KV switches), when asked to verify, smoke test, reproduce, or fuzz ww-api, or when the WitnessWork app's verify loop needs a local backend URL.
---

# Verify ww-api

`scripts/verify/dev.mjs` runs this checkout's worker with `wrangler dev --env dev --local` on a free port in 8790-8799, its own inspector port (9240-9259), its own persistence dir, and a generated vars file of synthetic tokens. It never uses port 8787 or 9229 (the user's own `wrangler dev`), `.wrangler/state`, or `.dev.vars`. All commands run from the repo root.

## Launch

```bash
node scripts/verify/dev.mjs up                       # prints the base URL as its last line
node scripts/verify/dev.mjs up --persist-to /tmp/ww-verify-$RUN_ID   # separate state per run
node scripts/verify/dev.mjs up --secrets-from ~/dev/ww-api/.dev.vars # opt in to real optional keys
```

- Ready when `up` prints `verify: worker ready (pid N, …)` and then the URL. It polls `GET /health` for up to 90 s and exits nonzero with the last log lines if wrangler dies.
- `up` is idempotent. If `.verify/state.json` names a live, healthy worker, `up` reuses it. If the recorded worker is alive but unhealthy, `up` restarts it.
- Env `dev` gives `APP_ATTEST_ENVIRONMENT=development` and `BUDDIES_ENABLED=true`. The fresh KV has no `buddies:enabled` key, so the relay is on with no switch to flip.
- `.verify/dev.vars.env` (mode 600) holds a random `NOTES_IMPORT_DEV_BYPASS_TOKEN` and `ADMIN_API_TOKEN`, plus `APPLE_TEAM_ID=VERIFY0000` unless a real one is passed. The tokens are reused across restarts and recorded in `state.json` so tests can read them.
- The WitnessWork app's verify loop consumes this as `node <ww-api>/scripts/verify/dev.mjs up` followed by `… url`.

## Doctor

```bash
node scripts/verify/dev.mjs doctor
```

Read-only. Each check prints an `ok` or `FAIL` line, and the command exits 1 on any failure. The checks:

- the state file exists and belongs to this checkout;
- the recorded pid is alive;
- the port's listener is in our process tree (`lsof`);
- `/health` answers `ok`;
- the git HEAD matches the one recorded at `up` (a mismatch only warns, because wrangler hot-reloads `src/`);
- Buddies is enabled (an unknown `invite/fetch` returns `not_found`, not `disabled`);
- the dev bypass works (the value is never printed);
- which optional credentials are set.

Run it first whenever anything looks off.

## Drive

Plain HTTP against `URL=$(node scripts/verify/dev.mjs url)`. Per feature recipes live in [`features/`](features/README.md); read the index first.

```bash
pnpm test:e2e                                  # every src/e2e/*.e2e.test.ts against the running worker
pnpm test:e2e src/e2e/buddies.e2e.test.ts      # one surface
WW_API_URL=https://… pnpm test:e2e             # another deployment (token-gated tests skip)
node scripts/verify/dev.mjs kv put buddies:enabled false   # edit the isolated local NOTES_KV
node scripts/verify/dev.mjs kv get app-store-ratings:summary
node scripts/verify/dev.mjs kv delete buddies:enabled
```

- Send a unique `cf-connecting-ip` per request (`198.18.x.y` or similar). Without one, every request shares the same per-IP key, and you hit the local rate limiters: 60/min on `/notes-import*`, `/geocode`, `/autocomplete`, `/admin/*`, and the Buddies per-caller tiers (IPv6 grouped by /64): 120/min for `invite/fetch` + `invite/claim`, 60/min for `inbox/register`, 600/min for `inbox/sync` + `inbox/live`, 600/min for other signed ops. The e2e helpers and the fuzzer already do this.
- Signed Buddies ops need Ed25519 envelopes. Use `RelayOwner` and `RelayWriter` in `src/test/e2e.ts` (built on `src/test/buddiesClient.ts`) rather than hand-rolling curl.
- KV edits take effect on the next request (no 60 s edge cache locally).

## Fuzz

```bash
pnpm fuzz:buddies                       # 300 seeded cases, random seed printed
pnpm fuzz:buddies --runs 300 --seed 42  # reproducible run
pnpm fuzz:buddies --seed 42 --case 17   # replay one failing case
```

The seed decides each case's mutation and its parameters. Ids, keys, and nonces are fresh every run, so you can replay a seed against the same persisted state.

There are 18 generators:

- **Bad signatures:** tampered signature, tampered payload, wrong key or wrong role, a signature reused on another op, malformed `s`.
- **Replay and time:** sequential and parallel replay, stale `ts`.
- **Bad payloads:** a wrong-typed field, a missing field, malformed envelopes (bad JSON, base64, UTF-8), unicode and huge strings.
- **Size and caps:** blob sizes at and one byte over every limit, envelopes over 256 KiB (declared and chunked), slot, invite, template, kind, and expiry caps.
- **Other:** unknown routes and methods, invite claim burn after 5 wrong secrets, parallel `event/put` dedupe, per-caller edge limits (one IPv4, or rotating addresses in one IPv6 /64, until 429 `rate_limited` with `Retry-After: 60`).

The oracle checks every request:

- no 5xx;
- no response slower than 5 s (`--timeout-ms`);
- Buddies errors are `{error}` JSON;
- each mutation gets its documented status (for example, a bad signature is 401 `bad_signature`).

After the run, a canary inbox's full `inbox/sync` must equal its pre-fuzz snapshot, and `/health` must still be ok. When a case fails, the fuzzer prints the seed, a `--case` repro command, and the exact failing request, then exits 1.

## Evidence

- Everything goes in `.verify/artifacts/` (gitignored). That folder and `.verify/wrangler.log` survive `down`.
  - `e2e-<surface>-<timestamp>.json`: every request and response of an e2e file. Bodies are clipped to 600 chars, and secret-bearing headers are recorded by name only.
  - `fuzz-<timestamp>.json`: seed, runs, status histogram, p50, p95, and max latency, per-generator counts, canary result, and every failure with its full case transcript.
  - `.verify/wrangler.log`: the worker's request log (`[wrangler:info] POST /buddies/v1/… 200`) and any stack traces.
- **Proof standards:**
  - Drive the real HTTP routes, not Durable Object methods or internal setters.
  - For every mutation, read the result back through a second route: `inbox/sync` after `card/put`/`event/put`/`roster/put`, `invite/fetch` after `invite/create`/`claim`/`delete`, `GET /app-store/ratings` after the KV seed.
  - Assert status and body, not just status.
- **The dev bypass is a test mode.** It skips App Attest only; rate limits, the kill switch, and the Notes Import gate still run. Real assertions need a device and the deployed dev worker; see AGENTS.md.
- **Report skipped paths as skipped.** HERE and the paid kickoff are skipped unless explicitly enabled (see Credentials). Never claim them as verified from a different path.

## Cleanup

```bash
node scripts/verify/dev.mjs down          # kill our recorded process group + children, remove state.json and the vars file
node scripts/verify/dev.mjs down --wipe   # also delete the persisted DO/KV state dir
```

`down` kills only the pid recorded in `.verify/state.json`, its detached process group, and its descendants. It never kills by name. Logs and `.verify/artifacts/` stay. Delete old artifacts yourself when they're no longer needed, because disk space is limited. Run `down` after every failed attempt too, so no ports are stranded.

## Credentials

Only names are listed here; never print values.

| Name | Needed for | Default |
| --- | --- | --- |
| `NOTES_IMPORT_DEV_BYPASS_TOKEN` | Notes Import bypass tests | generated per state dir |
| `ADMIN_API_TOKEN` | admin reset positive tests | generated per state dir |
| `APPLE_TEAM_ID` | AASA app ids | `VERIFY0000` (synthetic) |
| `HERE_API_KEY` | `/geocode` + `/autocomplete` smoke (one call each) | unset, so skipped; set `WW_API_E2E_SKIP_HERE=1` to skip even when set |
| `OPENROUTER_API_KEY` | real provider health and the paid kickoff | unset; the status probe fails open |
| `REVENUECAT_API_KEY` | Supporter lookups during a paid kickoff | unset |
| `WW_API_E2E_ALLOW_PAID=1` | opt-in to one real Notes Import kickoff (OpenRouter spend) | off |
| `WW_API_URL`, `WW_API_DEV_BYPASS_TOKEN`, `WW_API_ADMIN_TOKEN` | point e2e at another worker | from `.verify/state.json` |

- Optional keys come from the process env or `up --secrets-from <env file>`. Only the four allowlisted names are read: HERE, OpenRouter, RevenueCat, and the Apple team id.
- `SENTRY_DSN` and the APNs keys are never passed, so local fuzzing can't reach Sentry or Apple.
- CI needs no secrets: `wrangler dev --local` runs without Cloudflare credentials.

## Helpers

- `scripts/verify/dev.mjs`: `up`, `doctor`, `url`, `kv <get|put|delete> <key> [value]`, `down [--wipe]`. Also available as `pnpm verify <cmd>`.
- `pnpm test:e2e` uses `vitest.e2e.config.ts`. It runs files serially because the kill-switch test flips shared KV. Helpers are in `src/test/e2e.ts`: `http`, `RelayOwner`, `RelayWriter`, `localKv`, `writeTranscript`.
- `pnpm fuzz:buddies` runs `scripts/verify/fuzz-buddies.mjs`. It uses the plain-Node wire client `scripts/verify/buddies-wire.mjs`, which `scripts/verify/buddies-wire.test.ts` (part of `pnpm test`) keeps in sync with `src/buddies/contracts.ts` and `envelope.ts`.
- CI is `.github/workflows/test.yml`: typecheck, unit tests, `up`, `doctor`, e2e, `fuzz --runs 100`, then `down`. Evidence is uploaded as the `verify-evidence` artifact.
- To keep the feature map honest as routes change, use `/maintain-verification-skill`.
