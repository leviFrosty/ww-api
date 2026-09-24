import { DatabaseSync } from 'node:sqlite'

/**
 * Durable Object test doubles backed by a real in-memory SQLite database, so
 * DO code runs its actual SQL instead of pattern-matched fakes. Mirrors the
 * SQLite storage API surface our DOs use: `sql.exec` (one statement, cursors),
 * `transactionSync` (rolls back on throw), alarms, and `deleteAll()` (which, as
 * before compatibility date 2026-02-24, leaves the alarm in place).
 */

type Row = Record<string, unknown>

const cursor = (rows: Row[]) => {
  let index = 0
  const iterator = {
    next: () =>
      index < rows.length
        ? { done: false as const, value: rows[index++] }
        : { done: true as const, value: undefined },
    [Symbol.iterator]() {
      return iterator
    },
    toArray: () => {
      const rest = rows.slice(index)
      index = rows.length
      return rest
    },
    one: () => {
      if (rows.length !== 1)
        throw new Error(`Expected exactly one row, got ${rows.length}`)
      return rows[0]
    },
    columnNames: rows[0] ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten: 0,
  }
  return iterator
}

export interface SqliteState {
  state: DurableObjectState
  alarm(): number | null
  /** The runtime clears the alarm just before invoking `alarm()`. */
  clearAlarm(): void
  tables(): string[]
  /** Direct read access for assertions. */
  query(sql: string, ...bindings: (string | number | null)[]): Row[]
}

export const createSqliteState = (name: string): SqliteState => {
  let db = new DatabaseSync(':memory:')
  let alarmAt: number | null = null
  let depth = 0

  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = query.trim().replace(/;\s*$/, '')
    if (statement.includes(';'))
      throw new Error('Use one SQL statement per exec() call')
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)) {
      throw new Error(
        'DO SQL rejects transaction statements; use transactionSync()'
      )
    }
    for (const binding of bindings) {
      const ok =
        binding === null ||
        typeof binding === 'string' ||
        (typeof binding === 'number' && Number.isFinite(binding))
      if (!ok) throw new Error(`Unsupported SQL binding: ${typeof binding}`)
    }
    const rows = db
      .prepare(statement)
      .all(...(bindings as (string | number | null)[]))
      .map((row: Row) => ({ ...row }))
    return cursor(rows)
  }

  const storage = {
    sql: { exec },
    transactionSync<T>(closure: () => T): T {
      const savepoint = `tx_${depth++}`
      db.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = closure()
        db.exec(`RELEASE ${savepoint}`)
        return result
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
        throw error
      } finally {
        depth--
      }
    },
    getAlarm: async () => alarmAt,
    setAlarm: async (time: number | Date) => {
      alarmAt = typeof time === 'number' ? time : time.getTime()
    },
    deleteAlarm: async () => {
      alarmAt = null
    },
    deleteAll: async () => {
      db.close()
      db = new DatabaseSync(':memory:')
    },
  }

  const state = {
    id: {
      name,
      toString: () => name,
      equals: (other: { name?: string }) => other.name === name,
    },
    storage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    waitUntil: () => undefined,
  } as unknown as DurableObjectState

  return {
    state,
    alarm: () => alarmAt,
    clearAlarm: () => {
      alarmAt = null
    },
    tables: () =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all()
        .map((row: Row) => String(row.name)),
    query: (sql, ...bindings) =>
      db
        .prepare(sql)
        .all(...bindings)
        .map((row: Row) => ({ ...row })),
  }
}

export interface FakeNamespace<T> {
  namespace: DurableObjectNamespace
  /** The live object for `name` (created on first use, like a real DO). */
  object(name: string): T
  storage(name: string): SqliteState
  /** Clears the alarm and runs the object's `alarm()` handler. */
  fireAlarm(name: string): Promise<void>
  /** Makes the next RPC to `name` throw after the callee finishes (lost reply). */
  failNextReply(name: string): void
}

/**
 * A namespace whose stubs call the object's public methods with structured
 * clones of the arguments and result, like Workers RPC.
 */
export const createNamespace = <T extends object>(
  construct: (state: DurableObjectState) => T
): FakeNamespace<T> => {
  const objects = new Map<string, { object: T; storage: SqliteState }>()
  const lostReplies = new Set<string>()

  const ensure = (name: string) => {
    let entry = objects.get(name)
    if (!entry) {
      const storage = createSqliteState(name)
      entry = { storage, object: construct(storage.state) }
      objects.set(name, entry)
    }
    return entry
  }

  const stub = (name: string) =>
    new Proxy(
      {},
      {
        get(_, property) {
          if (property === 'then' || typeof property === 'symbol')
            return undefined
          return async (...args: unknown[]) => {
            const target = ensure(name).object as Record<string, unknown>
            const method = target[property]
            if (typeof method !== 'function')
              throw new Error(`No RPC method ${property}`)
            const result = await (method as (...a: unknown[]) => unknown).apply(
              target,
              structuredClone(args)
            )
            if (lostReplies.delete(name)) throw new Error('RPC reply lost')
            return structuredClone(result)
          }
        },
      }
    )

  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => stub(id.name),
  } as unknown as DurableObjectNamespace

  return {
    namespace,
    object: (name) => ensure(name).object,
    storage: (name) => ensure(name).storage,
    fireAlarm: async (name) => {
      const entry = ensure(name)
      entry.storage.clearAlarm()
      await (entry.object as { alarm(): Promise<void> }).alarm()
    },
    failNextReply: (name) => {
      lostReplies.add(name)
    },
  }
}
