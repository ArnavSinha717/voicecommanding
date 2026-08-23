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
  it('converges on the observed cadence as evidence accumulates', () => {
    // Someone buying dairy every 3 days is far faster than the population's 13.7,
    // so the estimate has to travel. More evidence should land closer to truth.
    const TRUE_GAP = 3
    const sparse = posteriorRate(purchases(3, TRUE_GAP, 1), 'dairy', NOW)
    const dense = posteriorRate(purchases(30, TRUE_GAP, 1), 'dairy', NOW)
    expect(sparse).not.toBeNull()
    expect(dense).not.toBeNull()

    const sparseError = Math.abs(1 / sparse! - TRUE_GAP)
    const denseError = Math.abs(1 / dense! - TRUE_GAP)
    expect(denseError).toBeLessThan(sparseError)
    expect(denseError).toBeLessThan(0.5)
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
    expect(milk?.kind).toBe('replenishment')
  })

  it('stays quiet about something bought yesterday', () => {
    const history = { milk: purchases(6, 14, 1) }
    const results = suggest({ items: [], history, now: NOW, limit: 10 })
    expect(results.find((s) => s.canonicalId === 'milk' && s.kind === 'replenishment')).toBeUndefined()
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
    expect(milk?.reason).toMatch(/You buy this about every .+ — it's been .+/)
  })
})

describe('cold start', () => {
  it('still has something to say with no history', () => {
    // The common failure is an empty panel on first run, which reads as broken.
    const results = suggest({ items: [item('milk', 'dairy')], history: {}, now: NOW, limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((s) => s.reason !== '')).toBe(true)
  })

  it('offers deals even with an empty list and no history', () => {
    const results = suggest({ items: [], history: {}, now: NOW, limit: 5 })
    expect(results.some((s) => s.kind === 'deal')).toBe(true)
  })
})

describe('suggestions never assert more than the data supports', () => {
  it('does not recommend an unrelated item from a co-occurring category', () => {
    // Category lift put pork alongside milk: dairy and meat co-occur, and pork
    // had the highest SKU count in meat. The categories are related; the items
    // are not. Complements were removed rather than shipped in that state.
    const results = suggest({ items: [item('milk', 'dairy')], history: {}, now: NOW, limit: 8 })
    expect(results.map((s) => s.canonicalId)).not.toContain('pork')
    expect(results.every((s) => s.kind === 'replenishment' || s.kind === 'deal')).toBe(true)
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
