/**
 * Legacy KV adapter. SQLite identity objects are authoritative; these helpers are
 * used only for lazy import and the compatibility mirror needed by deployed v1
 * clients during rolling upgrades.
 */

export type AppAttestKv = Pick<
  KVNamespace,
  'get' | 'put' | 'delete' | 'list'
>

export interface DeviceKeyRecord {
  /** Base64url SPKI of the device's attested P-256 public key. */
  spki: string
  /** Highest assertion sign-count seen; each assertion must exceed it. */
  signCount: number
  /** The identity (Keychain UUID) this device key is pinned to (ADR 0007). */
  uuid: string
  environment: 'development' | 'production'
  attestedAt: number
  /**
   * Bundle id the key attested against. Absent on records written before
   * bundle binding; those are bound to the primary `IOS_BUNDLE_ID`.
   */
  bundleId?: string
}

const keyStoreKey = (keyId: string) => `key:${keyId}`

/** Legacy reverse index from install UUID to the deployed v1 key id. */
const uuidOwnerKey = (uuid: string) => `uuidOwner:${uuid}`

const parseKeyRecord = (raw: string): DeviceKeyRecord | null => {
  try {
    const value = JSON.parse(raw) as Partial<DeviceKeyRecord>
    if (
      typeof value.spki !== 'string' ||
      !Number.isSafeInteger(value.signCount) ||
      (value.signCount ?? -1) < 0 ||
      typeof value.uuid !== 'string' ||
      (value.environment !== 'development' &&
        value.environment !== 'production') ||
      !Number.isFinite(value.attestedAt) ||
      (value.bundleId !== undefined &&
        (typeof value.bundleId !== 'string' || value.bundleId === ''))
    ) {
      return null
    }
    return value as DeviceKeyRecord
  } catch {
    return null
  }
}

export const getKeyRecord = async (
  kv: AppAttestKv,
  keyId: string
): Promise<DeviceKeyRecord | null> => {
  const raw = await kv.get(keyStoreKey(keyId))
  return raw == null ? null : parseKeyRecord(raw)
}

export interface LegacyDeviceKeyMatch {
  keyId: string
  record: DeviceKeyRecord
}

/**
 * Scan every legacy key page for records pinned to an install UUID. The caller
 * decides whether zero, one, or multiple matches are safe for its operation.
 */
export const listKeyRecordsForUuid = async (
  kv: AppAttestKv,
  uuid: string
): Promise<LegacyDeviceKeyMatch[]> => {
  const matches: LegacyDeviceKeyMatch[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const page = await kv.list({
      prefix: 'key:',
      ...(cursor == null ? {} : { cursor }),
    })
    for (const key of page.keys) {
      if (!key.name.startsWith('key:')) {
        throw new Error('legacy App Attest key listing returned wrong prefix')
      }
      const keyId = key.name.slice('key:'.length)
      if (!keyId) throw new Error('legacy App Attest key id is empty')
      const raw = await kv.get(key.name)
      if (raw == null) throw new Error('listed legacy App Attest key is missing')
      const record = parseKeyRecord(raw)
      if (!record) throw new Error('listed legacy App Attest key is malformed')
      if (record.uuid === uuid) matches.push({ keyId, record })
    }
    if (page.list_complete) break
    if (!page.cursor) throw new Error('legacy App Attest key listing omitted cursor')
    if (seenCursors.has(page.cursor)) {
      throw new Error('legacy App Attest key listing repeated cursor')
    }
    seenCursors.add(page.cursor)
    cursor = page.cursor
  } while (true)

  return matches
}

export const putKeyRecord = (
  kv: AppAttestKv,
  keyId: string,
  record: DeviceKeyRecord
): Promise<void> => kv.put(keyStoreKey(keyId), JSON.stringify(record))

export const deleteKeyRecord = (
  kv: AppAttestKv,
  keyId: string
): Promise<void> => kv.delete(keyStoreKey(keyId))

/** The keyId that owns `uuid`, or null if the identity is still unclaimed. */
export const getUuidOwner = (
  kv: AppAttestKv,
  uuid: string
): Promise<string | null> => kv.get(uuidOwnerKey(uuid))

/** Update the deployed v1 UUID→key compatibility mirror. */
export const putUuidOwner = (
  kv: AppAttestKv,
  uuid: string,
  keyId: string
): Promise<void> => kv.put(uuidOwnerKey(uuid), keyId)
