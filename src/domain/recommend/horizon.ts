/**
 * How long until this shopper's next shop.
 *
 * The recommender used to ask "are you out of this now". That is the one moment
 * the answer is useless: you are standing in the shop, and whatever you have
 * already run out of, you ran out of days ago. The question worth answering is
 * "what will I run out of before I am next here" — and answering it needs a
 * horizon.
 *
 * The horizon is modelled, not assumed. Trips are a Poisson process exactly as
 * individual purchases are, so the same Gamma-Poisson update runs one level up:
 * a population prior from Instacart, pulled toward this shopper's own rhythm as
 * they accumulate trips. A shopper who buys every other day and one who does a
 * monthly stock-up get different answers from the same code.
 */

import priorsData from '../../data/priors.generated.json'

const DAY_MS = 86_400_000

const { tripCadence } = priorsData as unknown as {
  tripCadence: {
    readonly alpha: number
    readonly beta: number
    readonly medianDays: number
    readonly p25Days: number
    readonly p75Days: number
    readonly users: number
  }
}

/** Prior strength in trips, matching the item model's tuned value. */
const PRIOR_STRENGTH = 1.5

/**
 * Population cadence: the median over 169,230 Instacart users of each user's own
 * median gap between orders.
 *
 * Per user rather than pooled, deliberately. Pooling every gap answers a
 * different question — frequent shoppers contribute proportionally more gaps, so
 * the pooled median (7.0 days) is length-biased toward them. A shopper this app
 * has never seen is one draw from the distribution over *users*.
 *
 * Gaps of exactly 30 days are dropped upstream as Instacart's censoring cap
 * rather than observations; 11.5% of all gaps sit on it, and keeping them moves
 * this number from 9 days to 13.
 */
export const POPULATION_CADENCE_DAYS = tripCadence.medianDays

export interface Horizon {
  /** Days until the next shop is expected. */
  readonly days: number
  /** Whether this reflects the shopper's own trips or the population. */
  readonly basis: 'learned' | 'population'
  /** Distinct shopping days observed for this shopper. */
  readonly trips: number
}

/**
 * Distinct days on which anything was bought.
 *
 * Six items bought in one session is one trip, not six. Collapsing to the day
 * also absorbs the difference between a list built across an evening and one
 * built in a single burst.
 */
export function tripDays(history: Readonly<Record<string, readonly number[]>>): number[] {
  const days = new Set<number>()
  for (const times of Object.values(history)) {
    for (const time of times) days.add(Math.floor(time / DAY_MS))
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * Expected days until the next shopping trip.
 *
 * Identical in form to `posteriorRate`: prior worth PRIOR_STRENGTH trips over
 * PRIOR_STRENGTH × the population cadence in days, updated by the shopper's own
 * trips over their own observed window.
 *
 * `basis` is reported rather than hidden. An interface that says "you shop about
 * every 9 days" to someone who has used the app twice is claiming to know
 * something it does not, and the honest version — "typical shopper" until there
 * is evidence otherwise — costs one field.
 */
export function estimateHorizon(history: Readonly<Record<string, readonly number[]>>, now: number): Horizon {
  const days = tripDays(history)

  // One trip carries no gap, so there is nothing yet to learn from.
  if (days.length < 2) {
    return { days: POPULATION_CADENCE_DAYS, basis: 'population', trips: days.length }
  }

  const observedDays = Math.max(1, now / DAY_MS - days[0])
  const gaps = days.length - 1
  const rate = (PRIOR_STRENGTH + gaps) / (PRIOR_STRENGTH * POPULATION_CADENCE_DAYS + observedDays)

  return {
    days: 1 / rate,
    // Below three trips the population prior still dominates; claiming to have
    // learned the shopper's rhythm from two visits would be overselling it.
    basis: days.length >= 4 ? 'learned' : 'population',
    trips: days.length,
  }
}

/** Phrasing for the horizon, kept next to the model that produces it. */
export function describeHorizon(horizon: Horizon): string {
  const rounded = Math.round(horizon.days)
  const every = rounded <= 1 ? 'every day' : `about every ${rounded} days`
  return horizon.basis === 'learned'
    ? `You shop ${every}`
    : `Assuming you shop ${every}, like most shoppers`
}
