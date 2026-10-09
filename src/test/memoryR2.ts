/**
 * In-memory R2 bucket for tests: the `put`/`get`/`head`/`delete`/`list` subset the
 * Buddies photo blobs use, with a `sha256` integrity check like R2's, a call
 * log, and failure injection. Cast to `R2Bucket` at the call site.
 */

export interface MemoryR2Object {
  bytes: Uint8Array
  uploaded: number
}

export interface MemoryR2 {
  objects: Map<string, MemoryR2Object>
  /**
   * Every call, in order: `put <key>`, `get <key>`, `delete <key,key>`,
   * `list <prefix>`.
   */
  calls: string[]
  /** Makes the next call of `method` throw (an R2 outage). */
  failNext(method: 'put' | 'get' | 'delete' | 'list'): void
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { sha256?: string }
  ): Promise<{ key: string; size: number }>
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>
  head(key: string): Promise<{ key: string; size: number } | null>
  delete(keys: string | string[]): Promise<void>
  /** Keys in order, `limit` (default 1,000) at a time; `cursor` is the last key. */
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<
    | {
        objects: { key: string; size: number; uploaded: Date }[]
        truncated: true
        cursor: string
      }
    | {
        objects: { key: string; size: number; uploaded: Date }[]
        truncated: false
      }
  >
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value.slice(0))
    : new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        )
      )

export const makeMemoryR2 = (): MemoryR2 => {
  const objects = new Map<string, MemoryR2Object>()
  const calls: string[] = []
  const failing = new Set<string>()
  const check = (method: string) => {
    if (failing.delete(method)) throw new Error(`r2 ${method} failed`)
  }
  return {
    objects,
    calls,
    failNext: (method) => {
      failing.add(method)
    },
    put: async (key, value, options = {}) => {
      calls.push(`put ${key}`)
      check('put')
      const bytes = bytesOf(value)
      if (options.sha256 != null) {
        const digest = hex(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        )
        if (digest !== options.sha256) throw new Error('r2 sha256 mismatch')
      }
      objects.set(key, { bytes, uploaded: Date.now() })
      return { key, size: bytes.byteLength }
    },
    get: async (key) => {
      calls.push(`get ${key}`)
      check('get')
      const object = objects.get(key)
      if (!object) return null
      return {
        body: new Response(object.bytes.slice()).body as ReadableStream,
        size: object.bytes.byteLength,
      }
    },
    head: async (key) => {
      const object = objects.get(key)
      return object ? { key, size: object.bytes.byteLength } : null
    },
    delete: async (keys) => {
      const list = typeof keys === 'string' ? [keys] : keys
      calls.push(`delete ${list.join(',')}`)
      check('delete')
      for (const key of list) objects.delete(key)
    },
    list: async ({ prefix = '', cursor, limit = 1_000 } = {}) => {
      calls.push(`list ${prefix}`)
      check('list')
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort()
      const page = keys.slice(0, limit).map((key) => {
        const object = objects.get(key)!
        return {
          key,
          size: object.bytes.byteLength,
          uploaded: new Date(object.uploaded),
        }
      })
      return keys.length > limit
        ? { objects: page, truncated: true, cursor: page[page.length - 1].key }
        : { objects: page, truncated: false }
    },
  }
}
