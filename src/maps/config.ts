export const MAPS_LIMITS = {
  /**
   * A MapKit JS token's lifetime. MapKit JS asks for a new one through its
   * `authorizationCallback` when it expires, so short costs only a request
   * every half hour per open map.
   */
  tokenLifetimeSeconds: 30 * 60,
  /**
   * Tokens per account in any rolling minute. A page load asks once; several
   * tabs, reloads, and a retry fit well inside.
   */
  tokenMinuteLimit: 10,
  /**
   * Tokens per account in any rolling 24 hours: an open map renews 48 times a
   * day, so this is ten all-day tabs' worth with room for reloads.
   */
  tokenDailyLimit: 500,
  /** `{ "origin": "…" }` is well under this. */
  maxTokenBodyBytes: 1024,
} as const

export const PLACE_SEARCH_LIMITS = {
  /** Longer than any name or address a person types. */
  maxQueryLength: 200,
  /** The native place field shows five suggestions. */
  defaultResults: 5,
  maxResults: 20,
  /**
   * Decimals of `at` sent to HERE: 4 is about 11 m, plenty to rank nearby
   * places, and no more precise than that.
   */
  atDecimals: 4,
  /** Discover answers in well under a second. */
  hereTimeoutMs: 8_000,
} as const
