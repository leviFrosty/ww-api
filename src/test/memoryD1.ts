import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/**
 * A D1 test double backed by a real in-memory SQLite database, with the
 * accounts migrations applied, so Drizzle runs its actual SQL. Covers the
 * surface `drizzle-orm/d1` uses: `prepare().bind()` with `run`, `all`,
 * `raw`, and `first`, and `batch` (one transaction, rolled back on error).
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/accounts', import.meta.url)
)

type Row = Record<string, unknown>

class MemoryD1Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly params: SQLInputValue[] = []
  ) {}

  bind(...params: unknown[]): MemoryD1Statement {
    return new MemoryD1Statement(this.db, this.query, params as SQLInputValue[])
  }

  async run() {
    const { changes, lastInsertRowid } = this.db
      .prepare(this.query)
      .run(...this.params)
    return {
      success: true,
      results: [],
      meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) },
    }
  }

  async all<T = Row>() {
    return { success: true, results: this.rows() as T[], meta: {} }
  }

  async raw<T = unknown[]>() {
    const statement = this.db.prepare(this.query)
    statement.setReturnArrays(true)
    return statement.all(...this.params) as T[]
  }

  async first<T = Row>() {
    return (this.rows()[0] as T | undefined) ?? null
  }

  rows(): Row[] {
    return this.db.prepare(this.query).all(...this.params) as Row[]
  }
}

export class MemoryD1 {
  readonly db = new DatabaseSync(':memory:')

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON')
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (const file of files)
      this.db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }

  prepare(query: string): MemoryD1Statement {
    return new MemoryD1Statement(this.db, query)
  }

  async batch(statements: MemoryD1Statement[]) {
    this.db.exec('BEGIN')
    try {
      const results = statements.map((statement) => ({
        success: true,
        results: statement.rows(),
        meta: {},
      }))
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

export const makeMemoryD1 = (): MemoryD1 & D1Database =>
  new MemoryD1() as MemoryD1 & D1Database
