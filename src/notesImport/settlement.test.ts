import { describe, expect, it, vi } from 'vitest'
import { RevenueCatError } from '../revenuecat'
import { resolveTerminalSupporter } from './settlement'

const BASE = {
  devBypass: false,
  apiKey: 'rc-key',
  appUserId: 'meter-id',
  entitlementId: 'Supporter',
} as const

describe('resolveTerminalSupporter', () => {
  it('overwrites kickoff status only with a successful RevenueCat result', async () => {
    const confirmedFree = vi.fn(async () => false)
    const confirmedSupporter = vi.fn(async () => true)

    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: true,
        checkSupporter: confirmedFree,
      })
    ).resolves.toBe(false)
    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: false,
        checkSupporter: confirmedSupporter,
      })
    ).resolves.toBe(true)
  })

  it('retains kickoff Supporter status when the terminal refresh fails', async () => {
    const checkSupporter = vi.fn(async () => {
      throw new RevenueCatError('RevenueCat 503')
    })

    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: true,
        checkSupporter,
      })
    ).resolves.toBe(true)
    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: false,
        checkSupporter,
      })
    ).resolves.toBe(false)
  })

  it('retains kickoff status and reports unexpected refresh errors', async () => {
    const error = new Error('network failure')
    const captureException = vi.fn()

    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: true,
        checkSupporter: vi.fn(async () => {
          throw error
        }),
        captureException,
      })
    ).resolves.toBe(true)
    expect(captureException).toHaveBeenCalledWith(error)
  })

  it('asks about a bearer run’s account, never its meter id', async () => {
    const checkSupporter = vi.fn(async () => true)
    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: false,
        account: { accountId: 'account-id', revenueCatAppUserId: 'rc-user' },
        checkSupporter,
      })
    ).resolves.toBe(true)
    expect(checkSupporter).toHaveBeenCalledWith({
      apiKey: 'rc-key',
      appUserId: 'rc-user',
    })
  })

  it('confirms a bearer run without a RevenueCat id as free, asking no one', async () => {
    const checkSupporter = vi.fn(async () => true)
    await expect(
      resolveTerminalSupporter({
        ...BASE,
        kickoffSupporter: false,
        account: { accountId: 'account-id', revenueCatAppUserId: null },
        checkSupporter,
      })
    ).resolves.toBe(false)
    expect(checkSupporter).not.toHaveBeenCalled()
  })
})
