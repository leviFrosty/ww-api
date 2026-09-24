import type { AppContext } from './types'
import { HTTP_STATUS } from './config'
import { nameTransactionAfterRoute } from './sentry'

/**
 * Contact-share universal link handlers.
 *
 * Flow: the WitnessWork app encodes a contact (gzip + base64url) into the URL
 * fragment and shares a URL like:
 *
 *   https://ww-proxy.leviwilkerson.com/c#<payload>
 *
 * Clients never send a fragment to a server, so link previews and the
 * fallback page only ever request the bare `/c` — the contact stays out of
 * this worker's requests, logs and Sentry.
 *
 * - iOS with the app installed: the OS intercepts the tap via the AASA file
 *   this worker serves and hands the URL to the app, which decodes and imports.
 * - iOS without the app / other platforms: the fallback HTML renders with a
 *   "Get WitnessWork" CTA linking to the App Store.
 *
 * Older app versions put the payload in the path (`/c/<payload>`). Those links
 * are already out in the wild, so they keep working.
 *
 * The AASA lists the prod, beta (internal TestFlight), and dev bundle IDs so
 * beta and development builds also intercept these links on devices where
 * they're installed.
 */

const PROD_BUNDLE_ID = 'com.leviwilkerson.jwtime'
const BETA_BUNDLE_ID = 'com.leviwilkerson.jwtimebeta'
const DEV_BUNDLE_ID = 'com.leviwilkerson.jwtimedev'
const APP_STORE_URL = 'https://apps.apple.com/us/app/jw-time/id6469723047'
const CONTACT_LINK_PATH = '/c'
const LEGACY_CONTACT_LINK_PATH_PREFIX = `${CONTACT_LINK_PATH}/`
const SITE_ORIGIN = 'https://ww-proxy.leviwilkerson.com'
const CANONICAL_URL = `${SITE_ORIGIN}${CONTACT_LINK_PATH}`
const OG_IMAGE_URL = `${SITE_ORIGIN}/assets/og-image.png`
const APPLE_TOUCH_ICON_URL = `${SITE_ORIGIN}/assets/apple-touch-icon.png`
const IMPORT_DEEP_LINK_PREFIX = 'witnesswork://import-contact/'
/** The app's payload encoding: unpadded base64url. */
const BASE64URL = /^[A-Za-z0-9_-]+$/
const OPEN_APP_LINK_ID = 'open-app'
const OPEN_APP_LABEL = 'Open app (already installed)'

/**
 * WitnessWork brand palette — mirrors `lightModeColors` in
 * `witness-work/src/constants/theme.ts`. Keep in sync if the app theme
 * changes.
 */
const BRAND = {
  accent: '#08cc50',
  accentBackground: '#4BD27C',
  accent3: '#003D46',
  text: '#373737',
  textInverse: '#FFFFFF',
  backgroundLightest: '#F0F0F0',
  card: '#FFFFFF',
  border: '#dbdbdb',
} as const

const OG_TITLE = 'Open this contact in WitnessWork'
const OG_DESCRIPTION =
  'A contact was shared with you from WitnessWork — the service time and contact management app for Jehovah\u2019s Witnesses.'

/**
 * Builds the "Open app" deep link in the browser from the fragment. Only a
 * base64url payload makes it into the href; anything else leaves the link
 * hidden.
 */
const OPEN_APP_FROM_FRAGMENT_SCRIPT = `(function () {
  var payload = location.hash.slice(1);
  if (!${BASE64URL}.test(payload)) return;
  var link = document.getElementById('${OPEN_APP_LINK_ID}');
  link.href = '${IMPORT_DEEP_LINK_PREFIX}' + payload;
  link.hidden = false;
})();`

/**
 * Apple strongly recommends `components` over the legacy `paths` array. Both
 * still work, but `components` supports per-pattern exclusions and query and
 * fragment matchers. We match `/c` with a non-empty fragment (`?*` = at least
 * one character), plus any path under `/c/` for links from older app versions.
 */
function buildAasaPayload(teamId: string): object {
  const appIDs = [
    `${teamId}.${PROD_BUNDLE_ID}`,
    `${teamId}.${BETA_BUNDLE_ID}`,
    `${teamId}.${DEV_BUNDLE_ID}`,
  ]
  return {
    applinks: {
      details: [
        {
          appIDs,
          components: [
            { '/': CONTACT_LINK_PATH, '#': '?*' },
            { '/': `${LEGACY_CONTACT_LINK_PATH_PREFIX}*` },
            // Buddy invite `/b#1<secret>`: the secret stays in the fragment.
            { '/': '/b', '#': '1?*' },
          ],
        },
      ],
    },
  }
}

export function handleAasaRequest(context: AppContext) {
  const teamId = context.env.APPLE_TEAM_ID
  if (!teamId) {
    // Fail loud so misconfigured deploys show up immediately instead of
    // silently breaking universal links.
    return context.json(
      { error: 'APPLE_TEAM_ID not configured' },
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  }
  // Apple requires Content-Type: application/json and no redirects. Hono's
  // c.json() sets the right header.
  return context.json(buildAasaPayload(teamId))
}

/**
 * `/c` — the fallback page for fragment links. The payload never reaches the
 * worker, so the page's inline script builds the "Open app" link instead.
 */
export function handleContactLinkRequest(context: AppContext) {
  nameTransactionAfterRoute(context)
  return context.html(
    renderFallbackPage(`<a class="secondary" id="${OPEN_APP_LINK_ID}" hidden>${OPEN_APP_LABEL}</a>
    <script>${OPEN_APP_FROM_FRAGMENT_SCRIPT}</script>`)
  )
}

/**
 * `/c/<payload>` — links shared by older app versions. The payload is already
 * in the request, so the "Open app" link is rendered here, but it never goes
 * into meta tags, which link-preview services store.
 */
export function handleLegacyContactLinkRequest(context: AppContext) {
  nameTransactionAfterRoute(context)
  const payload = context.req.param('payload') ?? ''
  const openAppLink = BASE64URL.test(payload)
    ? `<a class="secondary" href="${IMPORT_DEEP_LINK_PREFIX}${payload}">${OPEN_APP_LABEL}</a>`
    : ''
  return context.html(renderFallbackPage(openAppLink))
}

/**
 * Fallback HTML for taps that reach the worker (app not installed, non-iOS,
 * or Safari address-bar hit). Kept self-contained — no external fonts — so
 * iMessage's rich-link sniffer can render a fast preview. `og:url` is always
 * the bare canonical URL, and `no-referrer` keeps legacy page URLs out of the
 * Referer header of follow-up requests.
 */
function renderFallbackPage(openAppLink: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="referrer" content="no-referrer">
  <title>${OG_TITLE}</title>
  <meta name="description" content="${OG_DESCRIPTION}">
  <meta name="theme-color" content="${BRAND.accentBackground}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WitnessWork">
  <meta property="og:title" content="${OG_TITLE}">
  <meta property="og:description" content="${OG_DESCRIPTION}">
  <meta property="og:url" content="${CANONICAL_URL}">
  <meta property="og:image" content="${OG_IMAGE_URL}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">
  <meta property="og:image:alt" content="WitnessWork app icon">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${OG_TITLE}">
  <meta name="twitter:description" content="${OG_DESCRIPTION}">
  <meta name="twitter:image" content="${OG_IMAGE_URL}">

  <link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_URL}">
  <link rel="icon" type="image/png" href="${APPLE_TOUCH_ICON_URL}">

  <style>
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: ${BRAND.accentBackground};
      color: ${BRAND.text};
      margin: 0;
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: ${BRAND.card};
      border: 1px solid ${BRAND.border};
      border-radius: 20px;
      padding: 2rem 1.75rem;
      max-width: 24rem;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0, 61, 70, 0.15);
    }
    .icon {
      width: 88px;
      height: 88px;
      margin: 0 auto 1.25rem;
      display: block;
      /* drop-shadow follows the PNG alpha channel, so the shadow hugs the
         icon's rounded corners instead of sitting behind its transparent
         bounding box like box-shadow would. */
      filter: drop-shadow(0 4px 14px rgba(0, 61, 70, 0.2));
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.35rem;
      color: ${BRAND.accent3};
    }
    p {
      margin: 0 0 1.5rem;
      color: ${BRAND.text};
      line-height: 1.45;
      font-size: 0.95rem;
    }
    a.btn {
      display: inline-block;
      background: ${BRAND.accent};
      color: ${BRAND.textInverse};
      text-decoration: none;
      padding: 0.85rem 1.75rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 1rem;
    }
    a.btn:hover { filter: brightness(1.05); }
    a.secondary {
      display: block;
      margin-top: 1rem;
      color: ${BRAND.accent3};
      text-decoration: none;
      font-size: 0.85rem;
      opacity: 0.75;
    }
    a.secondary:hover { opacity: 1; }
  </style>
</head>
<body>
  <div class="card">
    <img class="icon" src="${APPLE_TOUCH_ICON_URL}" alt="WitnessWork" width="88" height="88">
    <h1>${OG_TITLE}</h1>
    <p>Install WitnessWork to import the shared contact. If you already have the app, it should have opened automatically.</p>
    <a class="btn" href="${APP_STORE_URL}">Get WitnessWork</a>
    ${openAppLink}
  </div>
</body>
</html>`
}
