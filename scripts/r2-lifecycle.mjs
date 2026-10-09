#!/usr/bin/env node
/**
 * Makes sure a Buddies photo bucket exists and carries its lifecycle rules,
 * so a deploy never depends on someone having run them by hand.
 *
 *   node scripts/r2-lifecycle.mjs ww-buddy-blobs           # create if missing, set the rules
 *   node scripts/r2-lifecycle.mjs ww-buddy-blobs --check   # read-only; exit 1 if anything is off
 *
 * The backstop deletes any object a day past the longest a photo can live
 * (`BUDDIES_LIMITS.maxBlobLifetimeMs`, 90 days). R2 counts an object's age from
 * its last write, and every upload rewrites the object, so the rule never
 * touches a live photo; it only catches objects the relay lost track of.
 * `lifecycle set` replaces every rule on the bucket, so R2's default
 * multipart-abort rule is restated here too.
 *
 * Needs Cloudflare credentials wrangler can use (`wrangler login`, or
 * CLOUDFLARE_API_TOKEN with R2 edit and CLOUDFLARE_ACCOUNT_ID in CI).
 */
import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DAY_SECONDS = 24 * 60 * 60

/** `BUDDIES_LIMITS.maxBlobLifetimeMs` in days, plus one (checked by a test). */
export const BACKSTOP_DAYS = 90 + 1
export const BACKSTOP_RULE_ID = 'buddy-blobs-backstop'
export const BLOB_PREFIX = 'v1/'

export const lifecycleRules = () => ({
  rules: [
    {
      id: BACKSTOP_RULE_ID,
      enabled: true,
      conditions: { prefix: BLOB_PREFIX },
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: BACKSTOP_DAYS * DAY_SECONDS },
      },
    },
    {
      id: 'Default Multipart Abort Rule',
      enabled: true,
      conditions: { prefix: '' },
      abortMultipartUploadsTransition: {
        condition: { type: 'Age', maxAge: 7 * DAY_SECONDS },
      },
    },
  ],
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const wrangler = (args) => {
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'wrangler'),
    args,
    { cwd: root, encoding: 'utf8' }
  )
  return {
    ok: result.status === 0,
    output: stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  }
}

/** wrangler's labelled blocks (`name: …` lines, blank lines between) as objects. */
export const parseBlocks = (output) =>
  output
    .split(/\n\s*\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split('\n')
          .map((line) => /^(\w+):\s+(.*)$/.exec(line.trim()))
          .filter(Boolean)
          .map(([, label, value]) => [label, value.trim()])
      )
    )
    .filter((fields) => Object.keys(fields).length)

const bucketExists = (bucket) => {
  const listed = wrangler(['r2', 'bucket', 'list'])
  if (!listed.ok) throw new Error(`wrangler r2 bucket list failed:\n${listed.output}`)
  return parseBlocks(listed.output).some((fields) => fields.name === bucket)
}

/** Whether the bucket's rules include the backstop at the right age. */
const backstopSet = (bucket) => {
  const listed = wrangler(['r2', 'bucket', 'lifecycle', 'list', bucket])
  if (!listed.ok) throw new Error(`wrangler r2 bucket lifecycle list failed:\n${listed.output}`)
  return parseBlocks(listed.output).some(
    (rule) =>
      rule.name === BACKSTOP_RULE_ID &&
      rule.enabled === 'Yes' &&
      rule.prefix === BLOB_PREFIX &&
      rule.action?.includes(`Expire objects after ${BACKSTOP_DAYS} days`)
  )
}

const main = () => {
  const [bucket, ...flags] = process.argv.slice(2)
  const check = flags.includes('--check')
  if (!bucket || bucket.startsWith('-')) {
    console.error('usage: node scripts/r2-lifecycle.mjs <bucket> [--check]')
    process.exit(2)
  }

  if (!bucketExists(bucket)) {
    if (check) {
      console.error(`r2-lifecycle: bucket ${bucket} does not exist`)
      process.exit(1)
    }
    const created = wrangler(['r2', 'bucket', 'create', bucket])
    if (!created.ok) throw new Error(`creating ${bucket} failed:\n${created.output}`)
    console.log(`r2-lifecycle: created ${bucket}`)
  }

  if (check) {
    if (!backstopSet(bucket)) {
      console.error(`r2-lifecycle: ${bucket} lacks ${BACKSTOP_RULE_ID} (${BLOB_PREFIX}, ${BACKSTOP_DAYS} days)`)
      process.exit(1)
    }
    console.log(`r2-lifecycle: ${bucket} ok (${BACKSTOP_RULE_ID}, ${BACKSTOP_DAYS} days)`)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'r2-lifecycle-'))
  try {
    const file = join(dir, 'lifecycle.json')
    writeFileSync(file, JSON.stringify(lifecycleRules(), null, 2))
    const set = wrangler(['r2', 'bucket', 'lifecycle', 'set', bucket, '--file', file, '--force'])
    if (!set.ok) throw new Error(`setting ${bucket}'s lifecycle failed:\n${set.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (!backstopSet(bucket)) throw new Error(`${bucket}'s lifecycle rules did not take`)
  console.log(`r2-lifecycle: ${bucket} ok (${BACKSTOP_RULE_ID}, ${BACKSTOP_DAYS} days)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`r2-lifecycle: ${error.message}`)
    process.exit(1)
  }
}
