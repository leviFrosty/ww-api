# Admin reset

Maintainers reset one Notes Import meter's rolling usage with `pnpm run admin:reset-usage`. The route behind it is secret-protected and fails closed: a missing token, a wrong token, and missing server configuration all return the same 404 as an unknown route.

## Sub-features

- `no-token` returns 404 `{"error":"Not found"}`.
- `wrong-token` returns the same 404, with nothing that tells it apart from `no-token`.
- `bad-meter` returns 400 `{"error":"Invalid meterId"}` when the token is valid.
- `reset` returns 200 `{"ok":true}` for a valid token and a valid `meterId` (8-64 chars of `[A-Za-z0-9_-]`).

## How to get to it (user POV)

- A maintainer runs `pnpm run admin:reset-usage [--dev] <meterId>` with `ADMIN_API_TOKEN` or `ADMIN_API_TOKEN_DEV` in `.env`.
- No app screen calls this route.

## Driving it with verify-ww-api

Preconditions:

- `doctor` passes, and `URL` and `ADMIN` are exported (see README).

- **No token.** Run `curl -si -X POST $URL/admin/notes-import/reset -H "cf-connecting-ip: 198.18.4.1" -d '{"meterId":"verifyMeter01"}'`. You get 404 `{"error":"Not found"}`.
- **Wrong token.** Add `-H "x-ww-admin-token: wrong"` to the same command. The status and body are identical.
- **Bad meter.** Run `curl -s -X POST $URL/admin/notes-import/reset -H "x-ww-admin-token: $ADMIN" -H "cf-connecting-ip: 198.18.4.2" -d '{"meterId":"bad id!"}'`. The body is `{"error":"Invalid meterId"}`.
- **Reset.** Run the same command with `-d '{"meterId":"verifyMeter01"}'`. The body is `{"ok":true}`.
- **Through the maintainer script.** Run `ADMIN_API_TOKEN_DEV=$ADMIN WW_API_DEV_URL=$URL node scripts/reset-notes-import-usage.mjs --dev verifyMeter01`. It exits 0.
- **Proof.** Run `pnpm test:e2e src/e2e/admin.e2e.test.ts`. Five tests pass, with the transcript in `.verify/artifacts/e2e-admin-*.json`. Header values are not recorded.

## Gotchas

- The route is rate limited at 60/min per `cf-connecting-ip`.
- A 404 here doesn't tell you whether the token was wrong or never configured. Check `doctor` first.
- Never point these commands at production URLs. The local `ADMIN` token is synthetic and only valid for the launcher's worker.
