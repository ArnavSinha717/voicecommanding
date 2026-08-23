import { describe, expect, it } from 'vitest'

import { suggest } from './suggest'
import { POPULATION_CADENCE_DAYS, describeHorizon, estimateHorizon, tripDays } from './horizon'

const DAY = 86_400_000
const NOW = 1_760_000_000_000

/** Timestamps `days` ago, one per entry. */
function ago(...days: number[]): number[] {
  return days.map((d) => NOW - d * DAY)
}

describe('shopping trips', () => {
  it('counts a single session as one trip, however many items it held', () => {
    const trips = tripDays({
      milk: ago(3),
      bread: [NOW - 3 * DAY + 60_000],
      eggs: [NOW - 3 * DAY + 120_000],
    })
    expect(trips).toHaveLength(1)
  })

  it('separates purchases made on different days', () => {
    expect(tripDays({ milk: ago(21, 14, 7) })).toHaveLength(3)
  })
})

describe('horizon', () => {
  it('falls back to the population cadence with nothing to go on', () => {
    const horizon = estimateHorizon({}, NOW)
    expect(horizon.days).toBe(POPULATION_CADENCE_DAYS)
    expect(horizon.basis).toBe('population')
  })

  it('does not claim to have learned a rhythm from one or two visits', () => {
    expect(estimateHorizon({ milk: ago(4) }, NOW).basis).toBe('population')
    expect(estimateHorizon({ milk: ago(11, 4) }, NOW).basis).toBe('population')
  })

  it('learns a frequent shopper is frequent', () => {
    const frequent = estimateHorizon({ milk: ago(12, 9, 6, 3) }, NOW)
    expect(frequent.basis).toBe('learned')
    expect(frequent.days).toBeLessThan(POPULATION_CADENCE_DAYS)
  })

  it('separates a monthly stock-up from a twice-weekly shop', () => {
    const monthly = estimateHorizon({ rice: ago(120, 90, 60, 30) }, NOW)
    const twiceWeekly = estimateHorizon({ milk: ago(12, 9, 6, 3) }, NOW)
    expect(monthly.days).toBeGreaterThan(twiceWeekly.days * 2)
  })

  it('says which basis it is speaking from', () => {
    expect(describeHorizon(estimateHorizon({}, NOW))).toMatch(/like most shoppers/)
    expect(describeHorizon(estimateHorizon({ milk: ago(12, 9, 6, 3) }, NOW))).toMatch(/^You shop/)
  })
})

describe('predicting rather than reacting', () => {
  /*
   * The reason the horizon exists.
   *
   * Milk on a short cycle, bought recently: not yet used up, but certain to be
   * before the shopper is next in a shop. Asked "are you out now" the answer is
   * no and the app stays quiet — which is useless precisely because the shopper
   * is standing in the shop today.
   */
  const history = { milk: ago(20, 15, 10, 2) }

  it('surfaces an item that is not out yet but will be before the next shop', () => {
    const results = suggest({
      items: [],
      history,
      now: NOW,
      limit: 10,
      horizon: { days: 7, basis: 'learned', trips: 4 },
    })
    const milk = results.find((s) => s.canonicalId === 'milk')
    expect(milk).toBeDefined()
    expect(milk?.kind).toBe('upcoming')
    expect(milk?.cycle?.due).toBeLessThan(0.5)
    expect(milk?.cycle?.dueByNextShop).toBeGreaterThan(0.5)
  })

  it('stays quiet about the same item when the next shop is tomorrow', () => {
    const results = suggest({
      items: [],
      history,
      now: NOW,
      limit: 10,
      horizon: { days: 1, basis: 'learned', trips: 4 },
    })
    expect(results.find((s) => s.canonicalId === 'milk')).toBeUndefined()
  })

  it('leaves slow-moving items where they were', () => {
    // A long cycle dwarfs the horizon, so extending it barely moves the estimate.
    const rice = { rice: ago(120, 75, 30) }
    const short = suggest({ items: [], history: rice, now: NOW, limit: 10, horizon: { days: 1, basis: 'learned', trips: 4 } })
    const long = suggest({ items: [], history: rice, now: NOW, limit: 10, horizon: { days: 7, basis: 'learned', trips: 4 } })
    const a = short.find((s) => s.canonicalId === 'rice')?.cycle?.dueByNextShop
    const b = long.find((s) => s.canonicalId === 'rice')?.cycle?.dueByNextShop
    if (a !== undefined && b !== undefined) expect(b - a).toBeLessThan(0.15)
  })

  it('ranks what is already gone above what is merely coming', () => {
    const results = suggest({
      items: [],
      history: { milk: ago(20, 15, 10, 2), bread: ago(30, 20, 11) },
      now: NOW,
      limit: 10,
      horizon: { days: 7, basis: 'learned', trips: 4 },
    })
    const kinds = results.filter((s) => s.kind !== 'staple').map((s) => s.kind)
    expect(kinds.indexOf('due')).toBeLessThan(kinds.lastIndexOf('upcoming'))
  })

  it('never claims something is due sooner than it is already due', () => {
    const results = suggest({ items: [], history, now: NOW, limit: 10 })
    for (const s of results) {
      if (s.cycle === undefined) continue
      expect(s.cycle.dueByNextShop).toBeGreaterThanOrEqual(s.cycle.due)
    }
  })
})
