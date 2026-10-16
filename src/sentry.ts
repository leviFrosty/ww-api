import * as Sentry from '@sentry/cloudflare';
import type { Breadcrumb, CloudflareOptions, Event } from '@sentry/cloudflare';
import type { Context } from 'hono';
import { routePath } from 'hono/route';
import type { Environment } from './types';

/**
 * Contact links shared by older app versions carry the whole contact
 * (gzip + base64url) in the path: `/c/<payload>`. The SDK copies request URLs
 * into many places (`event.request`, the Referer header, `url.full` span data,
 * transaction names, breadcrumbs), so rather than chase each field, every
 * string in an outgoing event is scrubbed. Route patterns (`/c/:payload`) are
 * left alone so parameterized transaction names survive.
 */
const CONTACT_LINK_PAYLOAD_PATH = /\/c\/(?!:)[^\s?#"'<>]+/g;
const REDACTED_CONTACT_LINK_PATH = '/c/[redacted]';

export function redactContactLinkPayloads(value: string): string {
  return value.replace(CONTACT_LINK_PAYLOAD_PATH, REDACTED_CONTACT_LINK_PATH);
}

/**
 * Rewrites strings in place through plain objects and arrays. Anything else
 * (SDK class instances such as scopes) is left alone.
 */
function scrubStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactContactLinkPayloads(value);
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const scrubbed = scrubStrings(record[key], seen);
    if (scrubbed !== record[key]) record[key] = scrubbed;
  }
  return value;
}

/**
 * The SDK copies request headers into events (with `sendDefaultPii: false`
 * it leaves out only cookies), so drop every header that carries a
 * credential or an id outright:
 * - `authorization`: bearer tokens.
 * - `x-ww-admin-token` and `x-ww-dev-bypass`: the admin and dev bypass tokens.
 * - `x-buddies-*`: the Buddies live socket's signed envelope (holds the inbox
 *   id).
 * - `x-ww-payload`/`x-ww-signature` (or the legacy `x-ww-p`/`x-ww-s`):
 *   accounts' legacy `backup/put` envelope (account key and slot id).
 * - `x-ww-slot-id`: the bearer `backup/put`'s slot id.
 */
const SECRET_HEADER =
  /^(authorization$|x-ww-admin-token$|x-ww-dev-bypass$|x-buddies-|x-ww-(p|s|payload|signature|slot-id)$)/i;

function dropSecretHeaders(event: Event): void {
  const headers = event.request?.headers;
  if (!headers) return;
  for (const name of Object.keys(headers)) {
    if (SECRET_HEADER.test(name)) delete headers[name];
  }
}

function scrubEvent<T extends Event>(event: T): T {
  dropSecretHeaders(event);
  return scrubStrings(event) as T;
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubStrings(breadcrumb) as Breadcrumb;
}

/**
 * The SDK names each transaction after the raw request path. Rename it to the
 * matched route (e.g. `GET /c/:payload`) for routes whose path carries user
 * data.
 */
export function nameTransactionAfterRoute(context: Context): void {
  const activeSpan = Sentry.getActiveSpan();
  const route = routePath(context);
  if (!activeSpan || !route) return;
  const rootSpan = Sentry.getRootSpan(activeSpan);
  rootSpan.updateName(`${context.req.method} ${route}`);
  rootSpan.setAttribute(Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, 'route');
}

export function createSentryConfig(environment: Environment): CloudflareOptions {
  return {
    dsn: environment.SENTRY_DSN,
    // Must match the release name used when uploading source maps
    // (`pnpm run sentry:sourcemaps` — the git commit sha). Sentry resolves
    // minified stack frames against the artifacts uploaded for this release.
    release: environment.SENTRY_RELEASE,
    // Use our route policy even when a caller propagates a sampling decision.
    // Error capture is independent of trace sampling and remains at 100%.
    tracesSampler: ({ name }) => {
      if (environment.APP_ATTEST_ENVIRONMENT === 'development') return 1;
      // @sentry/cloudflare 8 names its root span "METHOD /path".
      const path = name.split(' ')[1];
      const isImportOperation =
        path === '/notes-import' ||
        (path?.startsWith('/notes-import/') && path !== '/notes-import/status');
      // Attestation was part of Notes Import's operation traffic; it stays at
      // 100% under its own paths.
      const isAttestationOperation =
        path?.startsWith('/attestation/') && path !== '/attestation/v1/status';
      return isImportOperation || isAttestationOperation ? 1 : 0.1;
    },
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

export { Sentry };
