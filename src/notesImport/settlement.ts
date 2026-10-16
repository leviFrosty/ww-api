import { isSupporter, RevenueCatError } from '../revenuecat'
import { Sentry } from '../sentry'
import {
  isAccountSupporter,
  type AccountSupporterLookup,
} from '../accounts/supporter'

export interface ResolveTerminalSupporterArgs {
  kickoffSupporter: boolean
  devBypass: boolean
  apiKey: string
  appUserId: string
  entitlementId: string
  /**
   * A bearer run's account: its Supporter status (`isAccountSupporter`)
   * replaces the lookup by `appUserId`.
   */
  account?: AccountSupporterLookup
  /** Injectable for the smallest public regression seam. */
  checkSupporter?: typeof isSupporter
  captureException?: (error: unknown) => void
}

/**
 * Refresh entitlement for a successful run. A confirmed RevenueCat result may
 * change tiers, but a failed refresh retains the entitlement observed at
 * kickoff rather than manufacturing a downgrade.
 */
export const resolveTerminalSupporter = async ({
  kickoffSupporter,
  devBypass,
  apiKey,
  appUserId,
  entitlementId,
  account,
  checkSupporter = isSupporter,
  captureException = Sentry.captureException,
}: ResolveTerminalSupporterArgs): Promise<boolean> => {
  if (devBypass) return kickoffSupporter

  try {
    return account
      ? await isAccountSupporter(
          { REVENUECAT_API_KEY: apiKey },
          account,
          checkSupporter
        )
      : await checkSupporter({ apiKey, appUserId, entitlementId })
  } catch (error) {
    if (!(error instanceof RevenueCatError)) captureException(error)
    return kickoffSupporter
  }
}
