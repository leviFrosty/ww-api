import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './types'

/**
 * Which host a link page or association file was requested on (witness-work
 * ADR 0042). New links use the website apex (`witnesswork.app`, and
 * `dev.witnesswork.app` for dev), where wrangler routes only the paths in
 * `APEX_LINK_PATHS` to this Worker; the site Worker serves the rest. Every
 * other host (`ww-proxy.leviwilkerson.com`, `api.`, `api-dev.`, workers.dev)
 * serves what the old host always has. Nothing else in the API depends on
 * the host. Contract: docs/link-pages.md.
 */

const APEX_LINK_HOSTS = new Set(['witnesswork.app', 'dev.witnesswork.app'])

/**
 * The host every shipped build claims (and parses, by its short paths), dev
 * builds included. Links to it from an apex page open any installed version.
 */
export const LEGACY_LINK_ORIGIN = 'https://ww-proxy.leviwilkerson.com'

/** Exactly the paths the apex routes in wrangler.toml send here. */
export const APEX_LINK_PATHS = [
  '/.well-known/apple-app-site-association',
  '/.well-known/assetlinks.json',
  '/accounts/handoff',
  '/contacts',
  '/buddies/invite',
] as const

export const isApexLinkHost = (url: string): boolean =>
  APEX_LINK_HOSTS.has(new URL(url).hostname)

/** The API host on the same Worker as each apex host. */
const APEX_ASSET_ORIGINS = new Map([
  ['witnesswork.app', 'https://api.witnesswork.app'],
  ['dev.witnesswork.app', 'https://api-dev.witnesswork.app'],
])

/**
 * Where a link page's images (`/assets/…`) come from: on the apex the site
 * owns every path but `APEX_LINK_PATHS`, so the matching API host (this same
 * Worker) serves them; on every other host, the page's own origin.
 */
export const apexAssetOrigin = (url: string): string | undefined =>
  APEX_ASSET_ORIGINS.get(new URL(url).hostname)

/** CSP `img-src` for a link page: its own host, plus the API host on the apex. */
export const imageSources = (url: string): string => {
  const assets = apexAssetOrigin(url)
  return assets ? `'self' ${assets}` : "'self'"
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The origin a page was served on, for its `og:url`, `og:image` and icons.
 * Always https, as Cloudflare serves it, except on a local `wrangler dev`.
 */
export const pageOrigin = (url: string): string => {
  const parsed = new URL(url)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) parsed.protocol = 'https:'
  return parsed.origin
}

/**
 * The web app's origin (`WEB_APP_ORIGIN`) for "Continue on the web", or
 * undefined when it's unset or not an https origin.
 */
export const webAppOrigin = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/**
 * The link-page routes on the apex end in `*`, because a pattern without one
 * doesn't match a URL with a query string (`/contacts?lang=es`, or a
 * messenger's `?fbclid=`). So the routes also catch `/contacts/…` and
 * `/contactsX`; those go on to the site Worker, which owns every path but the
 * five exact ones. A route Worker's `fetch` reaches the Custom Domain Worker
 * on the same hostname. If the site can't be reached, the visitor gets a
 * plain 502, not an API error.
 */
export const apexPassthrough = (): MiddlewareHandler<AppEnv> => {
  const paths = new Set<string>(APEX_LINK_PATHS)
  return async (context, next) => {
    if (!isApexLinkHost(context.req.url) || paths.has(context.req.path)) {
      return next()
    }
    try {
      return await fetch(context.req.raw)
    } catch {
      return new Response(null, { status: 502 })
    }
  }
}

/**
 * Reveals the page's hidden `open-app` and `continue-web` links, each its
 * `data-base` plus the page's fragment. Every link format's fragment is
 * base64url (after a version digit), so anything else leaves them hidden.
 * The fragment never reaches a server, so only the browser can build these.
 */
export const FRAGMENT_LINKS_SCRIPT = `
(function () {
  var fragment = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) return;
  ['open-app', 'continue-web'].forEach(function (id) {
    var link = document.getElementById(id);
    if (!link) return;
    link.href = link.getAttribute('data-base') + '#' + fragment;
    link.hidden = false;
  });
})();
`

const scriptHashes = new Map<string, Promise<string>>()

/** CSP source for an inline script, computed once per isolate. */
export const scriptSource = (script: string): Promise<string> => {
  let hash = scriptHashes.get(script)
  if (!hash) {
    hash = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(script))
      .then((digest) => {
        let binary = ''
        for (const byte of new Uint8Array(digest))
          binary += String.fromCharCode(byte)
        return `'sha256-${btoa(binary)}'`
      })
    scriptHashes.set(script, hash)
  }
  return hash
}
