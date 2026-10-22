#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

/**
 * Resets an account's Scribe AI usage windows (`POST /admin/scribe/reset`).
 * `--notes-import` resets the old Notes Import meter instead
 * (`POST /admin/notes-import/reset`), which answers only while KV
 * `scribe:legacy-notes-import` is on.
 */

const PROD_URL = 'https://ww-proxy.leviwilkerson.com'
const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/
const FLAGS = new Set(['--dev', '--notes-import'])

export function resolveResetCommand(args, env) {
  const development = args.includes('--dev')
  const notesImport = args.includes('--notes-import')
  const positional = args.filter((arg) => !FLAGS.has(arg))
  if (positional.length !== 1 || !VALID_ID.test(positional[0])) {
    throw new Error(
      'Usage: pnpm run admin:reset-usage [--dev] [--notes-import] <accountId> (8-64 letters, digits, _ or -)'
    )
  }

  const token = development ? env.ADMIN_API_TOKEN_DEV : env.ADMIN_API_TOKEN
  if (!token) {
    throw new Error(
      `${development ? 'ADMIN_API_TOKEN_DEV' : 'ADMIN_API_TOKEN'} is not set in .env`
    )
  }

  const rawBaseUrl = development
    ? env.WW_API_DEV_URL
    : env.WW_API_PROD_URL || PROD_URL
  if (!rawBaseUrl) {
    throw new Error('WW_API_DEV_URL is not set in .env')
  }

  return {
    path: notesImport ? '/admin/notes-import/reset' : '/admin/scribe/reset',
    body: notesImport ? { meterId: positional[0] } : { accountId: positional[0] },
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
    token,
    environment: development ? 'development' : 'production',
  }
}

async function main() {
  const command = resolveResetCommand(process.argv.slice(2), process.env)
  const response = await fetch(`${command.baseUrl}${command.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ww-admin-token': command.token,
    },
    body: JSON.stringify(command.body),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(
      `${command.environment} reset failed (${response.status}): ${body}`
    )
  }
  process.stdout.write(`${body}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
