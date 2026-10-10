# Notes Import

Notes Import turns a publisher's free-form notes into contacts, visits, and time entries through an LLM. Every metered call is gated by App Attest on iOS and Play Integrity on Android; simulators, emulators and agents use the development-only bypass header instead. The safe verification surface is the attested no-op `verify` probe and the auth gate in front of `kickoff`. A real kickoff spends model credits (Claude Platform when the `notes-import-claude` PostHog flag is on, else OpenRouter) and is opt-in only.

## Sub-features

- `verify-v1` accepts `{}` with a valid `x-ww-dev-bypass` and returns `{"ok":true}`.
- `verify-v2` echoes `operationId` for a v2 probe whose `requestHash` equals `contentHash`.
- `verify-v2-mismatch` returns 400 when the two hashes differ.
- `verify-wrong-bypass` treats a wrong token as unattested and returns 400 `Missing uuid, …`.
- `challenge` issues an App Attest challenge.
- `kickoff-gate` returns 401 `attestation_required` for kickoff without credentials (503 when no provider is healthy). No inference runs.
- `kickoff-paid` runs kickoff with the bypass, then polls `/notes-import/:id/result` until it reaches `done`. This spends money and is opt-in.

## How to get to it (user POV)

- In the app: Tools → Notes Import, paste notes, and import. The app calls `challenge`, `attest`, `kickoff`, `events`, then `result`.
- The app's dev-tools diagnostics screen calls `POST /notes-import/verify` to prove the attestation path.
- Simulators and emulators can't attest, so dev builds on both platforms send the `x-ww-dev-bypass` header to the dev worker.

## Driving it with verify-ww-api

Preconditions:

- `doctor` passes, including `ok    dev bypass configured (value hidden)`.
- `URL` and `BYPASS` are exported (see README).

- **v1 probe.** Run `curl -s -X POST $URL/notes-import/verify -H "x-ww-dev-bypass: $BYPASS" -H "cf-connecting-ip: 198.18.2.1" -d '{}'`. The body is `{"ok":true}`.
- **v2 probe.** Run `H=$(printf verify | shasum -a 256 | cut -d' ' -f1); curl -s -X POST $URL/notes-import/verify -H "x-ww-dev-bypass: $BYPASS" -H "cf-connecting-ip: 198.18.2.2" -d "{\"protocolVersion\":2,\"operation\":\"assert\",\"operationId\":\"op_verify01\",\"purpose\":\"notes-import-verify\",\"contentHash\":\"$H\",\"requestHash\":\"$H\"}"`. The body is `{"ok":true,"protocolVersion":2,"operationId":"op_verify01"}`.
- **Wrong token.** Repeat the v1 probe with `-H "x-ww-dev-bypass: nope"`. You get 400 with `Missing uuid, keyId, challenge, assertion, or contentHash`.
- **Challenge.** Run `curl -s -X POST $URL/notes-import/challenge -H "cf-connecting-ip: 198.18.2.3" -d '{}'`. The body includes a `challenge` string.
- **Kickoff gate.** Run `curl -s -X POST $URL/notes-import/kickoff -H "cf-connecting-ip: 198.18.2.4" -d '{"uuid":"u1","notesText":"x","context":{"now":"2026-10-01T00:00:00Z","timeZone":"UTC","existingContacts":[],"existingCategories":[]}}'`. You get 401 `attestation_required`, and `.verify/wrangler.log` shows no model call.
- **Paid kickoff (opt-in only).** Run `WW_API_E2E_ALLOW_PAID=1 pnpm test:e2e src/e2e/notesImport.e2e.test.ts` after `up --secrets-from <file with ANTHROPIC_API_KEY and/or OPENROUTER_API_KEY>`. The worker logs `notes-import model provider=…` with cache token counts. The `PAID:` test passes with result `status:"done"`.
- **Proof.** Run `pnpm test:e2e src/e2e/notesImport.e2e.test.ts`. The free tests pass, the `PAID:` test shows as skipped unless opted in, and the transcript is in `.verify/artifacts/e2e-notes-import-*.json`.

## Gotchas

- The bypass works only with `APP_ATTEST_ENVIRONMENT=development` (`--env dev`). Plain `pnpm dev` uses prod vars, and Notes Import routes then return 500 when a bypass token is present.
- `/notes-import*` is rate limited at 60/min per `cf-connecting-ip` (its own bucket, apart from place search). Reusing one IP across a long run produces 429s (`rate_limited`, `Retry-After: 60`) that look like bugs.
- While a run is live, the SSE stream sends a `:` comment line every 15 s; finished, cancelled, and unknown runs close right after the replay.
- `/notes-import/:id/events` is SSE. Use `/result` for assertions.
- The bypass skips attestation only. Real App Attest and Play Integrity flows need a physical device against the deployed dev worker (see AGENTS.md); don't claim them from this loop.
