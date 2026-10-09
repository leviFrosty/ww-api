import { expect, it } from 'vitest'
import { BUDDIES_LIMITS, buddyBlobKey } from '../src/buddies/contracts'
import {
  BACKSTOP_DAYS,
  BACKSTOP_RULE_ID,
  BLOB_PREFIX,
  lifecycleRules,
  parseBlocks,
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
