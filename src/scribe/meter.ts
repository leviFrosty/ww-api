import type { ScribeLimits } from './config'
import { windowLengthsMs } from './config'
import type {
  ScribePlan,
  StepUsage,
  UsageSnapshot,
  UsageWindow,
  UsageWindowId,
} from './wire'

/**
 * Scribe AI's meter, pure (protocol: Metering). The `ScribeMeter` Durable
 * Object stores window starts and totals and calls these; nothing here reads
 * a clock or storage.
 */

export const WINDOW_IDS: readonly UsageWindowId[] = ['session', 'weekly', 'monthly']

/** The windows that limit and are shown for a plan, shortest first. */
export const planWindows = (plan: ScribePlan): UsageWindowId[] =>
  plan === 'supporter' ? ['session', 'weekly'] : ['monthly']

/** One window's stored state. */
export interface WindowState {
  /** Epoch ms of the charge that started it; null before any. */
  startedAt: number | null
  /** Units charged since `startedAt`. */
  used: number
}

export type WindowStates = Record<UsageWindowId, WindowState>

export const emptyWindows = (): WindowStates => ({
  session: { startedAt: null, used: 0 },
  weekly: { startedAt: null, used: 0 },
  monthly: { startedAt: null, used: 0 },
})

export type WindowLengths = Record<UsageWindowId, number>

// --- Units --------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  /** Cache reads. */
  cachedInputTokens: number
  /**
   * Cache writes, part of the uncached input. GPT-5.6+ bills them at 1.25×
   * input, and implicit caching writes every uncached token of a prompt of
   * 1,024 tokens or more (measured: all but ≈ 3).
   */
  cacheWriteTokens: number
  /** Includes reasoning tokens. */
  outputTokens: number
}

/**
 * `ceil(w.input × uncached + w.cacheWrite × writes + w.cachedInput × cached +
 * w.output × output)`, where writes = min(cacheWrite, input − cached) and
 * uncached = max(0, input − cached − writes). Rounded to a millionth first,
 * so float noise (0.1 × 2300 = 229.99…) never adds a unit.
 */
export const computeUnits = (
  usage: TokenUsage,
  weights: ScribeLimits['weights']
): number => {
  const cached = Math.max(0, usage.cachedInputTokens)
  const writes = Math.max(0, Math.min(usage.cacheWriteTokens, usage.inputTokens - cached))
  const uncached = Math.max(0, usage.inputTokens - cached - writes)
  const output = Math.max(0, usage.outputTokens)
  const raw =
    weights.input * uncached +
    weights.cacheWrite * writes +
    weights.cachedInput * cached +
    weights.output * output
  return Math.max(0, Math.ceil(Math.round(raw * 1e6) / 1e6))
}

/** The step usage the `done` event carries. */
export const stepUsage = (
  usage: TokenUsage & { reasoningTokens: number },
  weights: ScribeLimits['weights']
): StepUsage => ({
  inputTokens: usage.inputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.reasoningTokens,
  units: computeUnits(usage, weights),
})

// --- Windows ------------------------------------------------------------------

export const isRunning = (state: WindowState, length: number, now: number): boolean =>
  state.startedAt != null && now < state.startedAt + length

/** Units used in a window right now: 0 once it has ended. */
export const usedNow = (state: WindowState, length: number, now: number): number =>
  isRunning(state, length, now) ? state.used : 0

/** The limit of one window under a plan's limits; -1 is unlimited. */
export const windowLimit = (limits: ScribeLimits, id: UsageWindowId): number => {
  switch (id) {
    case 'session':
      return limits.supporter.session
    case 'weekly':
      return limits.supporter.weekly
    case 'monthly':
      return limits.free.monthly
  }
}

/**
 * Charges every window, starting any that isn't running at `now`. Every
 * charge accrues to all three; the plan only decides which ones limit. A
 * charge of 0 units starts nothing.
 */
export const applyCharge = (
  windows: WindowStates,
  units: number,
  now: number,
  lengths: WindowLengths
): WindowStates => {
  if (units <= 0) return windows
  const next = emptyWindows()
  for (const id of WINDOW_IDS) {
    const state = windows[id]
    next[id] = isRunning(state, lengths[id], now)
      ? { startedAt: state.startedAt, used: state.used + units }
      : { startedAt: now, used: units }
  }
  return next
}

/** Floor(used × 100 / limit), at least 1 when used > 0, at most 100. */
export const percentUsed = (used: number, limit: number): number => {
  if (limit === -1) return 0
  if (limit <= 0) return 100
  if (used <= 0) return 0
  return Math.min(100, Math.max(1, Math.floor((used * 100) / limit)))
}

const isFull = (used: number, limit: number) => limit !== -1 && used >= limit

export interface SnapshotInput {
  plan: ScribePlan
  supporterCheckFailed: boolean
  windows: WindowStates
  limits: ScribeLimits
  now: number
}

/** The usage snapshot every response carries (protocol: Usage snapshot). */
export const usageSnapshot = ({
  plan,
  supporterCheckFailed,
  windows,
  limits,
  now,
}: SnapshotInput): UsageSnapshot => {
  const lengths = windowLengthsMs(limits)
  let limited = false
  let resetsAt: number | null = null
  const shown: UsageWindow[] = planWindows(plan).map((id) => {
    const state = windows[id]
    const running = isRunning(state, lengths[id], now)
    const used = running ? state.used : 0
    const limit = windowLimit(limits, id)
    const windowResetsAt = running ? state.startedAt! + lengths[id] : null
    if (isFull(used, limit)) {
      limited = true
      if (windowResetsAt != null && (resetsAt == null || windowResetsAt > resetsAt))
        resetsAt = windowResetsAt
    }
    return {
      id,
      percentUsed: percentUsed(used, limit),
      resetsAt: windowResetsAt,
      units: { used, limit },
    }
  })
  return {
    plan,
    supporterCheckFailed,
    windows: shown,
    limited,
    resetsAt: limited ? resetsAt : null,
    asOf: now,
  }
}

// --- Admission ----------------------------------------------------------------

export interface AdmissionInput {
  plan: ScribePlan
  windows: WindowStates
  limits: ScribeLimits
  now: number
  step: number
  /** When this turn's step 0 was admitted, or null when it wasn't (or expired). */
  turnOpenedAt: number | null
}

export type AdmissionDecision =
  | { admitted: true; grace: boolean }
  | { admitted: false }

/**
 * Meter + turn grace (protocol: Enforcement). Admit when every window of the
 * plan has `used < limit`; a step > 0 of a turn admitted at step 0 within
 * `turnGraceMinutes` is also admitted while every window has
 * `used < limit + graceUnits`. An admitted step is charged in full, whatever
 * it overshoots.
 */
export const decideAdmission = ({
  plan,
  windows,
  limits,
  now,
  step,
  turnOpenedAt,
}: AdmissionInput): AdmissionDecision => {
  const lengths = windowLengthsMs(limits)
  const usage = planWindows(plan).map((id) => ({
    used: usedNow(windows[id], lengths[id], now),
    limit: windowLimit(limits, id),
  }))
  const under = (slack: number) =>
    usage.every(({ used, limit }) => limit === -1 || used < limit + slack)
  if (under(0)) return { admitted: true, grace: false }
  const inGrace =
    step > 0 &&
    turnOpenedAt != null &&
    now - turnOpenedAt <= limits.turnGraceMinutes * 60_000
  if (inGrace && under(limits.graceUnits)) return { admitted: true, grace: true }
  return { admitted: false }
}

/** Seconds until `resetsAt` (at least 1), for `Retry-After` on `limit_reached`. */
export const retryAfterUntil = (resetsAt: number | null, now: number): number | undefined =>
  resetsAt == null ? undefined : Math.max(1, Math.ceil((resetsAt - now) / 1000))
