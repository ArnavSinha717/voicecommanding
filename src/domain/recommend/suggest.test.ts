import { describe, expect, it } from 'vitest'

import type { Item } from '../types'
import { posteriorRate, suggest, substitutesFor } from './suggest'

const DAY = 86_400_000
const NOW = 1_760_000_000_000

function item(canonicalId: string, category: Item['category']): Item {
  return {
    id: canonicalId,
    name: canonicalId,
    canonicalId,
    quantity: { value: 1, unit: 'piece' },
    category,
    checked: false,
    addedAt: NOW,
    source: 'voice',
    confidence: 1,
  }
}

/** n purchases spaced `gapDays` apart, the last one `sinceDays` ago. */
function purchases(n: number, gapDays: number, sinceDays: number): number[] {
  const last = NOW - sinceDays * DAY
  return Array.from({ length: n }, (_, i) => last - (n - 1 - i) * gapDays * DAY)
}

describe('posterior purchase rate', () => {
  it('moves toward the observed cadence as evidence accumulates', () => {
    // Someone buying dairy every 3 days is far faster than the population's 13.7,
    // so the estimate has to travel. Every extra purchase should shorten it.
    const TRUE_GAP = 3
    const estimates = [2, 3, 5, 10, 30].map(
      (n) => 1 / posteriorRate(purchases(n, TRUE_GAP, 1), 'dairy', NOW)!,
    )

    for (let i = 1; i < estimates.length; i += 1) {
      expect(estimates[i]).toBeLessThan(estimates[i - 1])
    }
    // It starts nearer the population than the shopper and ends the other way round.
    expect(estimates[0]).toBeGreaterThan(TRUE_GAP * 2)
    expect(estimates[estimates.length - 1]).toBeLessThan(TRUE_GAP * 1.5)
  })

  it('does not fully converge, and that is the measured trade', () => {
    /*
     * A deliberate limit, not a bug. The prior keeps pulling toward the category
     * cadence even at thirty observations, so a perfectly regular shopper is
     * never estimated exactly. `scripts/tune-prior.ts` measures what that buys:
     * +13.4% accuracy on three-purchase histories against -1.7% on twenty-plus,
     * on held-out Instacart sequences.
     *
     * Asserted so that anyone strengthening the prior sees this test fail and
     * has to re-run the sweep rather than discover the regression in production.
     */
    const TRUE_GAP = 3
    const dense = 1 / posteriorRate(purchases(30, TRUE_GAP, 1), 'dairy', NOW)!
    expect(dense).toBeGreaterThan(TRUE_GAP)
    expect(dense).toBeLessThan(TRUE_GAP * 1.5)
  })

  it('answers from the population prior on a single observation', () => {
    // A frequency counter has no variance estimate here and must either stay
    // silent or over-commit; the prior gives a usable number immediately.
    const rate = posteriorRate([NOW - 10 * DAY], 'produce', NOW)
    expect(rate).not.toBeNull()
    expect(1 / rate!).toBeGreaterThan(1)
    expect(1 / rate!).toBeLessThan(60)
  })

  it('returns null with no history at all', () => {
    expect(posteriorRate([], 'dairy', NOW)).toBeNull()
  })
})

describe('replenishment suggestions', () => {
  it('suggests an item that is overdue', () => {
    const history = { milk: purchases(6, 4, 20) }
    const results = suggest({ items: [], history, now: NOW, limit: 10 })
    const milk = results.find((s) => s.canonicalId === 'milk')
    expect(milk).toBeDefined()
    expect(milk?.kind).toBe('due')
  })

  it('stays quiet about something bought yesterday', () => {
    const history = { milk: purchases(6, 14, 1) }
    const results = suggest({ items: [], history, now: NOW, limit: 10 })
    expect(results.find((s) => s.canonicalId === 'milk' && s.kind === 'due')).toBeUndefined()
  })

  it('never suggests what is already on the list', () => {
    const history = { milk: purchases(6, 4, 30) }
    const results = suggest({ items: [item('milk', 'dairy')], history, now: NOW, limit: 10 })
    expect(results.find((s) => s.canonicalId === 'milk')).toBeUndefined()
  })

  it('explains itself in terms the user can check', () => {
    const history = { milk: purchases(8, 5, 25) }
    const results = suggest({ items: [], history, now: NOW, limit: 10 })
    const milk = results.find((s) => s.canonicalId === 'milk')
    expect(milk?.reason).toMatch(/Every .+ · last bought .+ ago/)
    // The evidence travels with it so the interface can draw the model, not
    // only quote it.
    expect(milk?.cycle?.expectedDays).toBeGreaterThan(0)
    expect(milk?.cycle?.daysSince).toBeGreaterThan(0)
  })
})

describe('cold start', () => {
  it('still has something to say with no history', () => {
    // The common failure is an empty panel on first run, which reads as broken.
    const results = suggest({ items: [item('milk', 'dairy')], history: {}, now: NOW, limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((s) => s.reason !== '')).toBe(true)
  })

  it('offers commonly-restocked items with an empty list and no history', () => {
    const results = suggest({ items: [], history: {}, now: NOW, limit: 5 })
    const staples = results.filter((s) => s.kind === 'staple')
    expect(staples.length).toBeGreaterThan(0)
    // The claim is behavioural and checkable, derived from 32M purchases —
    // not a static catalogue discount presented as a live offer.
    for (const staple of staples) {
      expect(staple.reorderRate).toBeGreaterThan(0.4)
      expect(staple.reason).toMatch(/buy this again/)
    }
  })

  it('never presents a catalogue discount as the reason for a suggestion', () => {
    // An earlier version led with "51% off the usual price" — a 2020 price
    // snapshot dressed as a promotion, identical for every visitor.
    const results = suggest({ items: [], history: {}, now: NOW, limit: 6 })
    for (const suggestion of results) {
      expect(suggestion.reason).not.toMatch(/%\s*off/i)
    }
  })
})

describe('suggestions never assert more than the data supports', () => {
  it('does not recommend an unrelated item from a co-occurring category', () => {
    // Category lift put pork alongside milk: dairy and meat co-occur, and pork
    // had the highest SKU count in meat. The categories are related; the items
    // are not. Complements were removed rather than shipped in that state.
    const results = suggest({ items: [item('milk', 'dairy')], history: {}, now: NOW, limit: 8 })
    expect(results.map((s) => s.canonicalId)).not.toContain('pork')
    expect(results.every((s) => s.kind === 'due' || s.kind === 'staple')).toBe(true)
  })
})

describe('substitutes', () => {
  it('offers alternatives from the same category', () => {
    const alternatives = substitutesFor('milk')
    expect(alternatives.length).toBeGreaterThan(0)
    expect(alternatives.every((entry) => entry.category === 'dairy')).toBe(true)
    expect(alternatives.every((entry) => entry.canonicalId !== 'milk')).toBe(true)
  })

  it('returns nothing for an item the catalog does not know', () => {
    expect(substitutesFor('zorblex-crunch-bar')).toEqual([])
  })
})
