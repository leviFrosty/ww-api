import { expect, it } from 'vitest'
import { BUDDIES_LIMITS, buddyBlobKey } from '../src/buddies/contracts'
import { backupObjectKey } from '../src/accounts/contracts'
import { SYNC_LIMITS, syncObjectKey } from '../src/accounts/syncContracts'
import {
  BACKSTOP_DAYS,
  BACKSTOP_RULE_ID,
  BACKUP_EXPIRY_DAYS,
  BACKUP_RULE_ID,
  BLOB_PREFIX,
  SYNC_EXPIRY_DAYS,
  SYNC_RULE_ID,
  lifecycleRules,
  parseBlocks,
  ruleFor,
} from './r2-lifecycle.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

/** Keeps the deploy's R2 lifecycle rule in step with the relay. */

it('deletes objects a day past the longest a blob can live', () => {
  expect(BACKSTOP_DAYS).toBe(BUDDIES_LIMITS.maxBlobLifetimeMs / DAY_MS + 1)
  const [backstop] = lifecycleRules().rules
  expect(backstop).toEqual({
    id: BACKSTOP_RULE_ID,
    enabled: true,
    conditions: { prefix: BLOB_PREFIX },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: BACKSTOP_DAYS * 24 * 60 * 60 },
    },
  })
  expect(buddyBlobKey('inbox', 'blob').startsWith(BLOB_PREFIX)).toBe(true)
})

it('deletes account backup slots 400 days after their last upload', () => {
  expect(BACKUP_EXPIRY_DAYS).toBe(400)
  for (const bucket of ['ww-account-backups', 'ww-account-backups-dev']) {
    const [expiry, multipart] = lifecycleRules(bucket).rules
    expect(expiry).toEqual({
      id: BACKUP_RULE_ID,
      enabled: true,
      conditions: { prefix: BLOB_PREFIX },
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: 400 * 24 * 60 * 60 },
      },
    })
    expect(multipart.id).toBe('Default Multipart Abort Rule')
  }
  expect(lifecycleRules('ww-buddy-blobs-dev').rules[0].id).toBe(BACKSTOP_RULE_ID)
  expect(ruleFor('some-other-bucket')).toBeNull()
  expect(backupObjectKey('account', 'slot').startsWith(BLOB_PREFIX)).toBe(true)
})

it('deletes Cloud Sync slots 400 days after their last put', () => {
  expect(SYNC_EXPIRY_DAYS).toBe(SYNC_LIMITS.maxRetentionMs / DAY_MS)
  for (const bucket of ['ww-account-sync', 'ww-account-sync-dev']) {
    const [expiry] = lifecycleRules(bucket).rules
    expect(expiry).toEqual({
      id: SYNC_RULE_ID,
      enabled: true,
      conditions: { prefix: BLOB_PREFIX },
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: 400 * 24 * 60 * 60 },
      },
    })
  }
  expect(syncObjectKey('account', 'slot').startsWith(BLOB_PREFIX)).toBe(true)
})

it('reads wrangler’s labelled blocks', () => {
  const output = [
    "Listing lifecycle rules for bucket 'ww-buddy-blobs'...",
    'name:     buddy-blobs-backstop',
    'enabled:  Yes',
    'prefix:   v1/',
    'action:   Expire objects after 91 days',
    '',
    'name:     Default Multipart Abort Rule',
    'enabled:  Yes',
    'prefix:   (all prefixes)',
    'action:   Abort incomplete multipart uploads after 7 days',
  ].join('\n')
  expect(parseBlocks(output)).toEqual([
    {
      name: 'buddy-blobs-backstop',
      enabled: 'Yes',
      prefix: 'v1/',
      action: 'Expire objects after 91 days',
    },
    {
      name: 'Default Multipart Abort Rule',
      enabled: 'Yes',
      prefix: '(all prefixes)',
      action: 'Abort incomplete multipart uploads after 7 days',
    },
  ])
})
