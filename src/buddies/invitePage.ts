import type { AppContext } from '../types'

/**
 * `GET /b` — no-app fallback for Buddy invite links
 * (`https://ww-proxy.leviwilkerson.com/b#1<secret>`).
 *
 * The secret lives in the fragment, which browsers never send to a server.
 * This handler reads nothing from the request and the page is fully static and
 * generic (no names, no ids). Its one inline script copies `location.href` to
 * the clipboard on tap; the CSP (`connect-src` falls back to `'none'`) keeps the
 * page from sending anything anywhere.
 */

const SITE_ORIGIN = 'https://ww-proxy.leviwilkerson.com'
const APP_STORE_URL = 'https://apps.apple.com/us/app/jw-time/id6469723047'
const OG_IMAGE_URL = `${SITE_ORIGIN}/assets/og-image.png`
const ICON_PATH = '/assets/apple-touch-icon.png'
const OG_TITLE = 'A WitnessWork buddy invite'
const OG_DESCRIPTION =
  'Open this invite in WitnessWork, the service time and contact management app for Jehovah’s Witnesses.'

const COPY_SCRIPT = `
(function () {
  var button = document.getElementById('copy');
  var status = document.getElementById('copy-status');
  function show(message) { status.textContent = message; }
  function fallback() {
    var field = document.createElement('textarea');
    field.value = location.href;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(field);
    show(copied ? 'Invite link copied.' : 'Copy the link from the address bar instead.');
  }
  button.hidden = false;
  button.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(function () {
        show('Invite link copied.');
      }, fallback);
    } else {
      fallback();
    }
  });
})();
`

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${OG_TITLE}</title>
  <meta name="description" content="${OG_DESCRIPTION}">
  <meta name="theme-color" content="#4BD27C">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WitnessWork">
  <meta property="og:title" content="${OG_TITLE}">
  <meta property="og:description" content="${OG_DESCRIPTION}">
  <meta property="og:url" content="${SITE_ORIGIN}/b">
  <meta property="og:image" content="${OG_IMAGE_URL}">
  <meta property="og:image:alt" content="WitnessWork app icon">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${OG_TITLE}">
  <meta name="twitter:description" content="${OG_DESCRIPTION}">

  <link rel="apple-touch-icon" href="${ICON_PATH}">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #4BD27C;
      color: #373737;
      margin: 0;
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid #dbdbdb;
      border-radius: 20px;
      padding: 2rem 1.75rem;
      max-width: 24rem;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0, 61, 70, 0.15);
    }
    .icon { width: 88px; height: 88px; margin: 0 auto 1.25rem; display: block; }
    h1 { margin: 0 0 0.5rem; font-size: 1.35rem; color: #003D46; }
    p { margin: 0 0 1.25rem; line-height: 1.45; font-size: 0.95rem; }
    .btn {
      display: inline-block;
      border: 0;
      background: #08cc50;
      color: #FFFFFF;
      text-decoration: none;
      padding: 0.85rem 1.75rem;
      border-radius: 999px;
      font: inherit;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
    }
    .btn.secondary { background: #F0F0F0; color: #003D46; margin-top: 0.75rem; }
    .status { min-height: 1.25rem; margin: 0.75rem 0 0; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main class="card">
    <img class="icon" src="${ICON_PATH}" alt="WitnessWork" width="88" height="88">
    <h1>Open this invite in WitnessWork</h1>
    <p>Install WitnessWork from the App Store. After installing, tap the invite link again to open it in the app.</p>
    <a class="btn" href="${APP_STORE_URL}">Get WitnessWork</a>
    <div><button id="copy" class="btn secondary" type="button" hidden>Copy invite link</button></div>
    <p id="copy-status" class="status" role="status"></p>
    <p>Already have the app? Copy the invite link and paste it in WitnessWork.</p>
  </main>
  <script>${COPY_SCRIPT}</script>
</body>
</html>`

let scriptHash: Promise<string> | null = null

/** CSP source for the inline script, computed once per isolate. */
const copyScriptSource = (): Promise<string> => {
  scriptHash ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(COPY_SCRIPT))
    .then((digest) => {
      let binary = ''
      for (const byte of new Uint8Array(digest))
        binary += String.fromCharCode(byte)
      return `'sha256-${btoa(binary)}'`
    })
  return scriptHash
}

export const handleBuddyInvitePage = async (
  context: AppContext
): Promise<Response> => {
  const policy = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'unsafe-inline'",
    `script-src ${await copyScriptSource()}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return context.html(PAGE_HTML, 200, {
    'Cache-Control': 'public, max-age=3600',
    'Content-Security-Policy': policy,
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  })
}
