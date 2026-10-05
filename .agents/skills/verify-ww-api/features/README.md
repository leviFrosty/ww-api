# ww-api verification map

This directory is the maintained source for verifying ww-api's user-facing behavior. The worker's users are the WitnessWork app, and people who open shared links in a browser. Read this index before driving the worker, then use the matching feature file as the recipe.

## Baseline preconditions

- Start the worker with `node scripts/verify/dev.mjs up`. It serves `wrangler dev --env dev --local` on a port in 8790-8799, with state in `.verify/wrangler-state`.
- Run `node scripts/verify/dev.mjs doctor` and require `verify: doctor ok`.
- Export `URL=$(node scripts/verify/dev.mjs url)` for curl recipes.
- Export `BYPASS=$(node -p "require('./.verify/state.json').tokens.devBypass")` and `ADMIN=$(node -p "require('./.verify/state.json').tokens.admin")` when a recipe needs them. Both are synthetic, local-only values.
- Never drive port 8787. That is the user's own `wrangler dev`.

## Driving conventions

- Send a unique `-H "cf-connecting-ip: 198.18.<n>.<m>"` per curl so per-IP rate limits don't couple steps.
- Treat every command as literal. Keep paths, headers, and JSON unchanged.
- Signed Buddies ops go through `pnpm test:e2e` (helpers in `src/test/e2e.ts`), not hand-built curl.
- Restore any KV switch you flip (`node scripts/verify/dev.mjs kv delete <key>`) before the next recipe.
- Never call `POST /notes-import/kickoff` with the bypass unless `WW_API_E2E_ALLOW_PAID=1` is part of the task. It spends OpenRouter credits.

## Proof and skip reporting

- Capture the request and the resulting state: status and body, plus a read-back through a second route for every mutation.
- E2E proof is the `.verify/artifacts/e2e-<surface>-*.json` transcript plus the vitest pass line.
- Fuzz proof is `.verify/artifacts/fuzz-*.json` with `failures: []` and `canary.intact: true`.
- Report an unreachable path with the attempted command and the unmet precondition (for example, `HERE_API_KEY unset`).
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-ww-api` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Health and status](./health-and-status.md) covers `/health`, `/notes-import/status`, App Store ratings, and the JSON 404.
- [Notes Import](./notes-import.md) covers the dev-bypass verify probe, the App Attest challenge, kickoff's auth gate, and the opt-in paid kickoff.
- [Buddies relay](./buddies-relay.md) covers pairing end to end, sync read-backs, auth failures, caps, the kill switch, and fuzzing.
- [Universal link pages](./universal-link-pages.md) covers the AASA, the `/c` and `/c/:payload` contact pages, and the `/b` invite page.
- [Admin reset](./admin.md) covers the maintainer usage reset and its 404 fail-closed auth.

Not mapped yet: supporter route planning (`/route-planning`, needs `HERE_API_KEY`). Map it with `maintain-verification-skill` before relying on it.
