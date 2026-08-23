/**
 * Algebraic properties of quantity merging.
 *
 * Merging is where a shopping list is most likely to quietly lose or invent
 * stock, and the failure is invisible: a wrong total looks exactly like a right
 * one. Example tests only check the cases someone thought of. These assert the
 * laws that must hold for *every* pair, and fast-check searches for the pair
 * that breaks them.
 */

import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Quantity, Unit } from './types'
import { canMerge, dimensionOf, formatQuantity, merge, parseQuantity, toBase } from './units'
import { normalize } from './parser/normalize'

beforeAll(() => {
  fc.configureGlobal({ seed: 20260823 })
})

const UNITS: readonly Unit[] = ['piece', 'dozen', 'pack', 'bottle', 'can', 'box', 'ml', 'l', 'g', 'kg']

const quantity = fc.record({
  value: fc.integer({ min: 1, max: 5000 }),
  unit: fc.constantFrom(...UNITS),
})

/** Two quantities drawn from the same mergeable family. */
const mergeablePair = quantity.chain((a) =>
  fc.tuple(
    fc.constant(a),
    fc
      .constantFrom(...UNITS)
      .filter((unit) => canMerge(a, { value: 1, unit }))
      .map((unit) => ({ value: 1, unit })),
  ),
)

describe('canMerge', () => {
  it('is reflexive', () => {
    fc.assert(fc.property(quantity, (q) => canMerge(q, q)))
  })

  it('is symmetric', () => {
    fc.assert(fc.property(quantity, quantity, (a, b) => canMerge(a, b) === canMerge(b, a)))
  })

  it('is transitive', () => {
    fc.assert(
      fc.property(quantity, quantity, quantity, (a, b, c) => {
        if (canMerge(a, b) && canMerge(b, c)) return canMerge(a, c)
        return true
      }),
    )
  })
})

describe('merge', () => {
  it('succeeds exactly when canMerge says it will', () => {
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        expect(merge(a, b) !== null).toBe(canMerge(a, b))
      }),
    )
  })

  it('is commutative in the quantity it produces', () => {
    // "add 2 apples" then "add 3" must equal "add 3" then "add 2". Order of
    // speech cannot change the total.
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        const forward = merge(a, b)
        const backward = merge(b, a)
        if (forward === null || backward === null) return
        expect(toBase(forward)).toBeCloseTo(toBase(backward), 6)
      }),
    )
  })

  it('conserves the total measured in base units', () => {
    // The property that matters: merging must neither lose nor invent stock.
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        const merged = merge(a, b)
        if (merged === null) return
        expect(toBase(merged)).toBeCloseTo(toBase(a) + toBase(b), 6)
      }),
    )
  })

  it('is associative where all three combine', () => {
    fc.assert(
      fc.property(quantity, quantity, quantity, (a, b, c) => {
        if (!canMerge(a, b) || !canMerge(b, c)) return
        const left = merge(merge(a, b) as Quantity, c)
        const right = merge(a, merge(b, c) as Quantity)
        if (left === null || right === null) return
        expect(toBase(left)).toBeCloseTo(toBase(right), 6)
      }),
    )
  })

  it('never crosses a physical dimension', () => {
    // 2 bottles + 1kg is not a quantity, and silently coercing it would be a
    // worse bug than admitting the ambiguity.
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        if (merge(a, b) === null) return
        expect(dimensionOf(a.unit)).toBe(dimensionOf(b.unit))
      }),
    )
  })

  it('produces a positive result from positive inputs', () => {
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        const merged = merge(a, b)
        if (merged === null) return
        expect(merged.value).toBeGreaterThan(0)
      }),
    )
  })
})

describe('formatting', () => {
  it('never throws and never produces an empty string', () => {
    fc.assert(
      fc.property(quantity, (q) => {
        const text = formatQuantity(q)
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toContain('NaN')
        expect(text).not.toContain('undefined')
      }),
    )
  })

  it('round-trips through the parser for count and metric units', () => {
    // Rendering a quantity and reading it back must give the same thing.
    // Anything else means the app can display a value it cannot itself parse.
    fc.assert(
      fc.property(
        fc.record({
          value: fc.integer({ min: 1, max: 999 }),
          unit: fc.constantFrom<Unit>('kg', 'g', 'l', 'ml', 'bottle', 'can', 'box', 'pack'),
        }),
        (q) => {
          const rendered = `${formatQuantity(q)} milk`
          const parsed = parseQuantity(normalize(rendered).tokens)
          expect(parsed).not.toBeNull()
          expect(toBase(parsed!.quantity)).toBeCloseTo(toBase(q), 6)
        },
      ),
    )
  })
})

describe('parseQuantity', () => {
  it('never throws on arbitrary token streams', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 }), (tokens) => {
        expect(() => parseQuantity(tokens)).not.toThrow()
      }),
    )
  })

  it('consumes no more tokens than it was given', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 }), (tokens) => {
        const parsed = parseQuantity(tokens)
        if (parsed === null) return
        expect(parsed.tokensConsumed).toBeGreaterThan(0)
        expect(parsed.tokensConsumed).toBeLessThanOrEqual(tokens.length)
      }),
    )
  })

  it('only ever reports a positive quantity', () => {
    fc.assert(
      fc.property(mergeablePair, ([a]) => {
        const parsed = parseQuantity(normalize(`${formatQuantity(a)} milk`).tokens)
        if (parsed === null) return
        expect(parsed.quantity.value).toBeGreaterThan(0)
      }),
    )
  })
})
