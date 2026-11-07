import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * wrangler.toml's Durable Object migrations. Wrangler finds a Worker's
 * applied tag by name and sends only the steps after it; it never checks for
 * a repeated tag or a class created twice, and a renumbered applied tag
 * makes it replay every step. So the lists are pinned here: what each Worker
 * has applied stays as it is, and any new class goes at the end of both
 * lists, once. `[[env.dev.migrations]]` replaces the top-level list for dev.
 */

type Table = { header: string; lines: string[] }
const tables: Table[] = []
for (const line of readFileSync(
  new URL('../wrangler.toml', import.meta.url),
  'utf8'
).split('\n')) {
  const header = /^\s*(\[\[?[^\]]+\]\]?)/.exec(line)?.[1]
  if (header) tables.push({ header, lines: [] })
  else tables.at(-1)?.lines.push(line)
}
const field = (table: Table, name: string) =>
  table.lines
    .map((line) => new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(#.*)?$`).exec(line))
    .find(Boolean)?.[1]

const migrations = (prefix: string) =>
  tables
    .filter((table) => table.header === `[[${prefix}migrations]]`)
    .map((table) => ({
      tag: JSON.parse(field(table, 'tag') ?? 'null') as string,
      classes: JSON.parse(field(table, 'new_sqlite_classes') ?? '[]') as string[],
      other: table.lines.some((line) =>
        /^\s*(new_classes|renamed_classes|deleted_classes|transferred_classes)\s*=/.test(line)
      ),
    }))

const boundClasses = (prefix: string) =>
  tables
    .filter((table) => table.header === `[[${prefix}durable_objects.bindings]]`)
    .map((table) => JSON.parse(field(table, 'class_name') ?? 'null') as string)

/** Applied before Shared Spaces and the web launch, on both Workers. */
const SHARED_HISTORY = [
  ['v1', 'NotesImportRun', 'NotesImportIndex'],
  ['v2', 'AppAttestIdentity'],
  ['v3', 'BuddyInbox', 'BuddyInvite'],
  ['v4', 'PlayIntegrityChallenges'],
  ['v5', 'RoutePlanningQuota'],
  ['v6', 'BuddyRegistrationQuota'],
  ['v7', 'AccountHandoff'],
  ['v8', 'AccountSync'],
  ['v9', 'ScribeMeter'],
]

const ENVS = [
  {
    name: 'production',
    prefix: '',
    // ww-proxy was at v9; SharedSpace landed on main first.
    applied: [
      ...SHARED_HISTORY,
      ['v10', 'SharedSpace'],
      ['v11', 'AccountRateCounter'],
      ['v12', 'AccountApproval'],
    ],
  },
  {
    name: 'dev',
    prefix: 'env.dev.',
    // What ww-proxy-dev has applied (v12 since 2026-11-04).
    applied: [
      ...SHARED_HISTORY,
      ['v10', 'AccountRateCounter'],
      ['v11', 'AccountApproval'],
      ['v12', 'SharedSpace'],
    ],
  },
]

describe('wrangler.toml Durable Object migrations', () => {
  for (const env of ENVS) {
    describe(env.name, () => {
      const list = migrations(env.prefix)

      it('keeps the tags the Worker has applied, in order', () => {
        expect(
          list.slice(0, env.applied.length).map(({ tag, classes }) => [tag, ...classes])
        ).toEqual(env.applied)
      })

      it('numbers tags v1, v2, … with no repeats', () => {
        expect(list.map(({ tag }) => tag)).toEqual(list.map((_, i) => `v${i + 1}`))
      })

      it('creates every bound class exactly once', () => {
        expect(list.some(({ other }) => other)).toBe(false)
        const created = list.flatMap(({ classes }) => classes)
        expect(new Set(created).size).toBe(created.length)
        expect([...created].sort()).toEqual([...boundClasses(env.prefix)].sort())
      })
    })
  }
})
