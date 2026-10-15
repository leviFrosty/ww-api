import type { AppContext } from '../types'
import { bytesToBase64Url, sha256Bytes, timingSafeEqual } from '../crypto'
import { readBlobBody } from '../buddies/envelope'
import { buddiesErrorResponse } from '../buddies/errorResponse'
import {
  ACCOUNT_LIMITS,
  backupObjectKey,
  backupPrefix,
  type AccountsOp,
} from './contracts'
import {
  accountForKey,
  guarded,
  refuseAtEdge,
  verifiedBody,
  verifiedHeaders,
  type Verified,
} from './signed'
import type { AccountRecord } from './store'

/**
 * End-to-end encrypted backups (witness-work `docs/accounts-protocol.md`,
 * "Backup"): one R2 object per device slot at `v1/<accountId>/<slotId>`. The
 * server sees ciphertext, its size, and when it was uploaded
 * (`customMetadata.uploadedAt`, epoch ms). A suspended account can still
 * back up. R2's lifecycle rule deletes a slot 400 days after its last upload
 * (`scripts/r2-lifecycle.mjs`).
 *
 * `backup/put` counts against the Buddies photo-upload edge tier, the rest
 * against the read tier.
 *
 * Privacy: nothing here logs or reports bodies, keys, account ids, or slot
 * ids.
 */

const { backupBytes, backupSlots, backupPutIntervalMs } = ACCOUNT_LIMITS

interface Slot {
  slotId: string
  size: number
  uploadedAt: number
}

/** The account's slots, oldest key first. */
const listSlots = async (
  bucket: R2Bucket,
  accountId: string
): Promise<Slot[]> => {
  const prefix = backupPrefix(accountId)
  const slots: Slot[] = []
  let cursor: string | undefined
  for (;;) {
    // `include` is honored from compatibility date 2022-08-04; the base
    // workers-types this repo compiles against predate it.
    const page = await bucket.list({
      prefix,
      cursor,
      include: ['customMetadata'],
    } as R2ListOptions)
    for (const object of page.objects) {
      const stamped = Number(object.customMetadata?.uploadedAt)
      slots.push({
        slotId: object.key.slice(prefix.length),
        size: object.size,
        uploadedAt: Number.isSafeInteger(stamped)
          ? stamped
          : object.uploaded.getTime(),
      })
    }
    if (!page.truncated) return slots
    cursor = page.cursor
  }
}

/**
 * The bucket, the verified call, and its registered account; or the refusal.
 * Off (`disabled`) without the bucket or the accounts database.
 */
const authorized = async <K extends AccountsOp>(
  c: AppContext,
  edgeAs: 'blob/put' | 'inbox/sync',
  verify: () => Promise<Verified<K>>
): Promise<
  | {
      bucket: R2Bucket
      verified: Exclude<Verified<K>, { refusal: Response }>
      account: AccountRecord
    }
  | { refusal: Response }
> => {
  const bucket = c.env.ACCOUNT_BACKUPS
  if (!bucket || !c.env.ACCOUNTS_DB)
    return { refusal: buddiesErrorResponse('disabled') }
  const limited = await refuseAtEdge(c, edgeAs)
  if (limited) return { refusal: limited }
  const verified = await verify()
  if ('refusal' in verified) return verified
  const found = await accountForKey(c.env, verified.payload.accountPub)
  if ('refusal' in found) return found
  return { bucket, verified, account: found.account }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * `backup/put`: the envelope in `x-ww-p`/`x-ww-s`, the blob as the raw body.
 * A declared `Content-Length` over the cap is refused before anything is
 * read; otherwise the body is read up to the signed `size` and checked
 * against `size` and `sha256` before it replaces the slot.
 */
const handlePut = guarded('backup/put', async (c) => {
  const declared = c.req.header('content-length')
  if (declared != null && Number(declared) > backupBytes)
    return c.env.ACCOUNT_BACKUPS && c.env.ACCOUNTS_DB
      ? buddiesErrorResponse('too_large')
      : buddiesErrorResponse('disabled')
  const call = await authorized(c, 'blob/put', () =>
    verifiedHeaders(c, 'backup/put')
  )
  if ('refusal' in call) return call.refusal
  const { bucket, account } = call
  const { slotId, size, sha256 } = call.verified.fields
  if (size > backupBytes) return buddiesErrorResponse('too_large')

  const now = Date.now()
  const slots = await listSlots(bucket, account.id)
  const existing = slots.find((slot) => slot.slotId === slotId)
  if (existing) {
    const wait = existing.uploadedAt + backupPutIntervalMs - now
    if (wait > 0)
      return buddiesErrorResponse('rate_limited', {
        retryAfterSeconds: Math.max(1, Math.ceil(wait / 1_000)),
      })
  } else if (slots.length >= backupSlots) {
    return buddiesErrorResponse('limit')
  }

  const body = await readBlobBody(c.req.raw, size, backupBytes)
  if (!body.ok) return buddiesErrorResponse(body.error)
  const digest = await sha256Bytes(body.value)
  if (!timingSafeEqual(bytesToBase64Url(digest), sha256))
    return buddiesErrorResponse('bad_request')

  await bucket.put(backupObjectKey(account.id, slotId), body.value, {
    sha256: hex(digest),
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { uploadedAt: String(now) },
  })
  return c.json({ ok: true, uploadedAt: now })
})

const handleList = guarded('backup/list', async (c) => {
  const call = await authorized(c, 'inbox/sync', () =>
    verifiedBody(c, 'backup/list')
  )
  if ('refusal' in call) return call.refusal
  const slots = await listSlots(call.bucket, call.account.id)
  return c.json({ ok: true, slots })
})

/** Streams the slot's bytes back exactly as put. */
const handleGet = guarded('backup/get', async (c) => {
  const call = await authorized(c, 'inbox/sync', () =>
    verifiedBody(c, 'backup/get')
  )
  if ('refusal' in call) return call.refusal
  const object = await call.bucket.get(
    backupObjectKey(call.account.id, call.verified.fields.slotId)
  )
  if (!object) return buddiesErrorResponse('not_found')
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

/** One slot, or every slot without `slotId`. Idempotent. */
const handleDelete = guarded('backup/delete', async (c) => {
  const call = await authorized(c, 'inbox/sync', () =>
    verifiedBody(c, 'backup/delete')
  )
  if ('refusal' in call) return call.refusal
  const { bucket, account } = call
  const { slotId } = call.verified.fields
  const keys =
    slotId != null
      ? [backupObjectKey(account.id, slotId)]
      : (await listSlots(bucket, account.id)).map((slot) =>
          backupObjectKey(account.id, slot.slotId)
        )
  // R2 deletes at most 1,000 keys a call.
  for (let start = 0; start < keys.length; start += 1_000)
    await bucket.delete(keys.slice(start, start + 1_000))
  return c.json({ ok: true })
})

export const backupHandlers = {
  put: handlePut,
  list: handleList,
  get: handleGet,
  delete: handleDelete,
}
