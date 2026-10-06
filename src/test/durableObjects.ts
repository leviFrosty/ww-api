import { DatabaseSync } from 'node:sqlite'

/**
 * Durable Object test doubles backed by a real in-memory SQLite database, so
 * DO code runs its actual SQL instead of pattern-matched fakes. Mirrors the
 * SQLite storage API surface our DOs use: `sql.exec` (one statement, cursors),
 * `transactionSync` (rolls back on throw), alarms, and `deleteAll()` (which, as
 * before compatibility date 2026-02-24, leaves the alarm in place). Also the
 * WebSocket Hibernation API: `acceptWebSocket`, `getWebSockets`, and
 * `setWebSocketAutoResponse`, with the runtime globals it needs below.
 */

type Row = Record<string, unknown>

// --- WebSockets -------------------------------------------------------------

const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** The handlers the runtime calls on a Durable Object for accepted sockets. */
interface SocketHandlers {
  webSocketMessage?(ws: WebSocket, message: string): unknown
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): unknown
}

/** Where an accepted (server) end reports traffic: its Durable Object. */
interface SocketHost {
  message(server: FakeWebSocket, message: string): void
  closed(server: FakeWebSocket, code: number, reason: string): void
}

/**
 * One end of a fake `WebSocketPair`. What one end sends lands in the other's
 * `received`, unless the other end was accepted by a Durable Object: then the
 * object gets it as the runtime would deliver it, auto-response first. A
 * client end answers a close right away; an accepted end waits for its
 * object's `webSocketClose` to call `close()`.
 */
export class FakeWebSocket {
  readyState = OPEN
  peer!: FakeWebSocket
  /** Messages delivered to this end, in order. */
  readonly received: string[] = []
  /** The code and reason the other end closed with. */
  closedBy: { code: number; reason: string } | null = null
  host: SocketHost | null = null
  #attachment: unknown = null

  send(message: string): void {
    if (this.readyState !== OPEN) throw new TypeError('WebSocket is not open')
    if (this.peer.host) this.peer.host.message(this.peer, message)
    else this.peer.received.push(message)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED) throw new TypeError('WebSocket is closed')
    if (this.readyState === CLOSING) {
      // Answering the peer's close completes the handshake.
      this.readyState = CLOSED
      this.peer.readyState = CLOSED
      return
    }
    this.readyState = CLOSING
    const peer = this.peer
    peer.readyState = CLOSING
    peer.closedBy = { code, reason }
    if (peer.host) peer.host.closed(peer, code, reason)
    else peer.close(code, reason)
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment)
  }

  /** Received messages parsed as JSON. */
  messages<T = unknown>(): T[] {
    return this.received.map((message) => JSON.parse(message) as T)
  }
}

export class FakeWebSocketPair {
  0: FakeWebSocket
  1: FakeWebSocket

  constructor() {
    const client = new FakeWebSocket()
    const server = new FakeWebSocket()
    client.peer = server
    server.peer = client
    this[0] = client
    this[1] = server
  }
}

export class FakeWebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string
  ) {}
}

/** Workers' `Response`, which (unlike Node's) takes 101 and `webSocket`. */
export class WorkersResponse extends Response {
  readonly webSocket: FakeWebSocket | null

  constructor(
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: FakeWebSocket | null }
  ) {
    const upgrade = init?.status === 101
    super(body, upgrade ? { ...init, status: 200 } : init)
    this.webSocket = init?.webSocket ?? null
    if (upgrade) Object.defineProperty(this, 'status', { value: 101 })
  }
}

/** Runtime globals the Hibernation API needs; install with `vi.stubGlobal`. */
export const WORKERS_WEBSOCKET_GLOBALS = {
  WebSocketPair: FakeWebSocketPair,
  WebSocketRequestResponsePair: FakeWebSocketRequestResponsePair,
  Response: WorkersResponse,
}

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
  /** Routes accepted sockets' traffic to the object's handlers. */
  attach(handlers: SocketHandlers): void
  /** Accepted (server) ends, including closed ones. */
  sockets(): FakeWebSocket[]
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

  const sockets: FakeWebSocket[] = []
  let autoResponse: FakeWebSocketRequestResponsePair | null = null
  let handlers: SocketHandlers | null = null
  const host: SocketHost = {
    message: (server, message) => {
      // Answered by the runtime; the object never wakes.
      if (autoResponse && message === autoResponse.request) {
        server.send(autoResponse.response)
        return
      }
      handlers?.webSocketMessage?.(server as never, message)
    },
    closed: (server, code, reason) => {
      handlers?.webSocketClose?.(server as never, code, reason, true)
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
    acceptWebSocket: (ws: FakeWebSocket) => {
      ws.host = host
      sockets.push(ws)
    },
    // Disconnected sockets drop out of the list.
    getWebSockets: () => sockets.filter((ws) => ws.readyState !== CLOSED),
    setWebSocketAutoResponse: (pair?: FakeWebSocketRequestResponsePair) => {
      autoResponse = pair ?? null
    },
    getWebSocketAutoResponse: () => autoResponse,
  } as unknown as DurableObjectState

  return {
    state,
    attach: (object) => {
      handlers = object
    },
    sockets: () => [...sockets],
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
 * clones of the arguments and result, like Workers RPC (`fetch` excepted).
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
      storage.attach(entry.object as SocketHandlers)
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
          // `fetch` passes the Request and Response through, uncloned.
          if (property === 'fetch') {
            return (request: Request) =>
              (
                ensure(name).object as {
                  fetch(request: Request): Promise<Response>
                }
              ).fetch(request)
          }
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
