import type { Hono } from 'hono'
import { Scalar } from '@scalar/hono-api-reference'
import { describeRoute, generateSpecs } from 'hono-openapi'
import type { Environment } from '../types'
import { componentSchemaObjects } from './schemas'

export const OPENAPI_PATH = '/openapi.json'
export const DOCS_PATH = '/docs'

const REPO_URL = 'https://github.com/leviFrosty/ww-api'

/** Tag order and blurbs; every documented route uses one of these. */
export const OPENAPI_TAGS = [
  {
    name: 'Service',
    description: 'Liveness, the server clock, and these docs.',
  },
  {
    name: 'Places',
    description:
      'HERE Geocoding & Search proxy. The worker injects its own `apiKey` and forwards every other query parameter unchanged.',
  },
  {
    name: 'Attestation',
    description:
      'Device attestation for the whole API: App Attest on iOS, Play Integrity on Android. Get a challenge, register an App Attest key, and prove the path with `verify`; each protected route then checks an assertion signed for its own `purpose`. These routes lived under `/notes-import/` until 2026-10; the old paths still work, marked deprecated.',
  },
  {
    name: 'Notes Import',
    description:
      'Turns pasted or photographed notes into contacts, visits, and time entries with a model. Every metered call is authenticated with App Attest (iOS) or Play Integrity (Android). Design: [docs/notes-import-streaming-durable-objects.md](' +
      REPO_URL +
      '/blob/main/docs/notes-import-streaming-durable-objects.md).',
  },
  {
    name: 'Buddies',
    description:
      'End-to-end encrypted relay between buddies. The relay only sees ciphertext and random ids. Every op is `POST /buddies/v1/{op}` with a signed envelope; ids travel in bodies, never URLs. The wire contract is [docs/buddies-protocol.md](' +
      REPO_URL +
      '/blob/main/docs/buddies-protocol.md).',
  },
  {
    name: 'Accounts',
    description:
      'Anonymous accounts: a random id and a public key, nothing else. Signed like Buddies ops under the `ww-account/v1` context.',
  },
  {
    name: 'Route planning',
    description:
      'Supporter-only stop ordering through HERE Waypoints Sequence. Coordinates only.',
  },
  {
    name: 'App Store',
    description: 'Public App Store data for the paywall.',
  },
  {
    name: 'Links',
    description:
      'Universal-link support: the AASA file and the no-app fallback pages for shared contacts (`/contacts`), buddy invites (`/buddies/invite`), and Set Up Another Device (`/accounts/handoff`). The short paths (`/c`, `/b`, `/h`) in links already shared are served for good.',
  },
  {
    name: 'Admin',
    description:
      'Maintainer tools. Each needs `x-ww-admin-token`; without a valid token every admin route answers 404.',
  },
]

const DOCUMENTATION = {
  info: {
    title: 'WitnessWork API',
    version: '1',
    description: `The backend for the [WitnessWork](https://github.com/leviFrosty/witness-work) app: a Cloudflare Worker built with Hono. Source: [ww-api](${REPO_URL}).

**Errors.** Every JSON error uses one envelope: \`{ "ok": false, "error", "code", "retryAfter"? }\`. Read \`code\`; \`error\` repeats it, except on attestation, Notes Import, and route planning, where it is a human-readable message. Every 429 and 503 sends \`Retry-After\`.

**Signed requests.** Buddies and accounts ops send \`{ "payload", "signature" }\`: \`payload\` is the request’s fields as base64url-encoded UTF-8 JSON, and \`signature\` is an Ed25519 signature over the op’s context line followed by those exact bytes. Each op lists its decoded \`payload\` fields. Older app builds send the same values as \`p\` and \`s\` (headers \`x-buddies-p\`/\`x-buddies-s\`, \`x-ww-p\`/\`x-ww-s\`), which are still accepted.

**Rate limits.** Places, Notes Import, attestation, route planning, and admin routes each count in their own per-IP bucket of 60 requests a minute. Buddies has its own per-caller tiers, documented on each op.`,
    license: { name: 'See repository', url: REPO_URL },
  },
  servers: [
    { url: 'https://ww-proxy.leviwilkerson.com', description: 'Production' },
    {
      url: 'https://ww-proxy-dev.levi-wilkerson.workers.dev',
      description: 'Development',
    },
  ],
  tags: OPENAPI_TAGS,
  components: {
    securitySchemes: {
      adminToken: {
        type: 'apiKey' as const,
        in: 'header',
        name: 'x-ww-admin-token',
        description: 'The environment’s `ADMIN_API_TOKEN` secret.',
      },
    },
  },
}

type App = Hono<{ Bindings: Environment }>

/** The OpenAPI document for `app`. */
/**
 * Zod's `.int()` emits JavaScript's safe-integer range as `minimum`/`maximum`,
 * which Scalar then shows as the example value. Those bounds say nothing a
 * reader needs, so they're dropped.
 */
const dropSafeIntegerBounds = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value), (key, field) =>
    (key === 'minimum' && field === Number.MIN_SAFE_INTEGER) ||
    (key === 'maximum' && field === Number.MAX_SAFE_INTEGER)
      ? undefined
      : field
  )

export const buildOpenApiSpec = async (app: App) =>
  dropSafeIntegerBounds(
    await generateSpecs(app, {
      documentation: {
        ...DOCUMENTATION,
        components: {
          ...DOCUMENTATION.components,
          schemas: componentSchemaObjects(),
        },
      },
      // `/openapi.json` itself ends in `.json`; nothing here is a static file.
      excludeStaticFile: false,
    })
  )

/** `buildOpenApiSpec`, run once per isolate (a failure retries next time). */
const specFor = (app: App) => {
  let spec: ReturnType<typeof buildOpenApiSpec> | undefined
  return () => {
    spec ??= buildOpenApiSpec(app).catch((error) => {
      spec = undefined
      throw error
    })
    return spec
  }
}

/**
 * Mounts `/openapi.json` (the document) and `/docs` (Scalar's reference UI)
 * on `app`. Call after every other route, so all of them are in the document.
 */
export const mountApiDocs = (app: App) => {
  const spec = specFor(app)
  app.get(
    OPENAPI_PATH,
    describeRoute({
      tags: ['Service'],
      summary: 'OpenAPI document',
      description:
        'This API’s OpenAPI 3.1 document, generated from the routes the worker serves.',
      responses: { 200: { description: 'The OpenAPI document.' } },
    }),
    async (c) =>
      c.json(await spec(), 200, { 'Cache-Control': 'public, max-age=300' })
  )
  app.get(
    DOCS_PATH,
    describeRoute({
      tags: ['Service'],
      summary: 'API reference',
      description: 'This reference, rendered by Scalar from `/openapi.json`.',
      responses: { 200: { description: 'An HTML page.' } },
    }),
    Scalar({
      url: OPENAPI_PATH,
      pageTitle: 'WitnessWork API',
      layout: 'modern',
      // No hosted AI chat, telemetry, or SDK upsell toolbar on our page.
      agent: { disabled: true },
      telemetry: false,
      showDeveloperTools: 'never',
    })
  )
  return app
}
