# Universal link pages

Shared contacts (`/c#<payload>`) and buddy invites (`/b#1<secret>`) are universal links. On iOS, the AASA file routes them into the app. Without the app, the worker serves localized fallback pages that build the "Open app" link client-side, so the payload never reaches the server or link previews.

## Sub-features

- `aasa` returns JSON with three app ids (`<team>.com.leviwilkerson.jwtime`, `…jwtimebeta`, `…jwtimedev`) and the components `/c#?*`, `/c/*`, and `/b#1?*`.
- `contact-page` serves the `/c` HTML with a hidden `#open-app` link and the `witnesswork://import-contact/` script.
- `contact-locale` localizes `/c?lang=es` and `Accept-Language` (`Content-Language` header, `<html lang>`).
- `contact-legacy` makes `/c/<payload>` render an `href="witnesswork://import-contact/<payload>"` that never appears in a meta tag, and escapes non-base64url payloads.
- `invite-page` serves `/b` with a strict CSP (`default-src 'none'`), `X-Robots-Tag: noindex, nofollow`, and `Referrer-Policy: no-referrer`.

## How to get to it (user POV)

- Someone taps a shared contact link in Messages. With the app installed, iOS opens it. Without the app, the browser shows the `/c` page.
- A buddy invite link opens the app, or the `/b` page in a browser.
- iOS downloads `/.well-known/apple-app-site-association` when the app is installed or updated.

## Driving it with verify-ww-api

Preconditions:

- `doctor` passes and `URL` is exported.

- **AASA.** Run `curl -si $URL/.well-known/apple-app-site-association`. You get 200 with `content-type: application/json`, the app ids prefixed `VERIFY0000.` (or the real team id when passed), and the three components.
- **Contact page.** Run `curl -s $URL/c | grep -c 'id="open-app"'`. It prints `1`.
- **Locale.** Run `curl -si "$URL/c?lang=es" | grep -i content-language`. The header starts with `es`.
- **Legacy link.** Run `curl -s $URL/c/abc_DEF-123 | grep -o 'witnesswork://import-contact/abc_DEF-123'`. The deep link is printed.
- **Hostile payload.** Run `curl -s "$URL/c/%22%3E%3Cscript%3Ex%3C%2Fscript%3E" | grep -c '<script>x</script>'`. It prints `0`.
- **Invite page.** Run `curl -si $URL/b`. You get 200 with a `content-security-policy` that starts `default-src 'none'` and the title `A WitnessWork buddy invite`.
- **Proof.** Run `pnpm test:e2e src/e2e/public.e2e.test.ts -t "universal links"`. All four tests pass, with the transcript in `.verify/artifacts/e2e-public-*.json`.

## Gotchas

- Fragments (`#…`) never reach the server, so curl can't exercise the in-page script. Prove the script path with a browser (or the app's verify loop), not curl.
- Without a real `APPLE_TEAM_ID`, the AASA uses the synthetic `VERIFY0000`. It proves shape, not that Apple will accept it.
- Static assets under `public/` (`/assets/*`) are served by the assets binding and bypass the worker.
