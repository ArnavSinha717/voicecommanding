/**
 * Reducer invariants over arbitrary command sequences.
 *
 * Example tests check the sequences someone imagined. A shopping list is driven
 * by speech, so the real sequences are stranger than that: a misheard remove
 * between two adds, an undo after a clear, the same item checked off twice while
 * a stale voice command lands. These assert what must be true after *any*
 * sequence, and fast-check looks for the one that breaks it.
 */

import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Category, Command, Quantity, Unit } from '../types'
import { applyCommand, EMPTY_STATE, type ApplyOptions, type ListState } from './reducer'
import { canMerge, toBase } from '../units'

/**
 * Fixed seed so a failure is reproducible and CI cannot go intermittently red.
 *
 * The trade is real: a random seed explores more of the space over time, and it
 * is what surfaced the undo bug in the first place — one run in four. Bump this
 * number occasionally to search fresh ground. fast-check prints the seed and a
 * shrunk counterexample on failure, so any red build replays exactly.
 */
beforeAll(() => {
  fc.configureGlobal({ seed: 20260823, numRuns: 300 })
})

const CANONICAL_IDS = ['milk', 'bread', 'apple', 'rice', 'paneer'] as const
const UNITS: readonly Unit[] = ['piece', 'dozen', 'bottle', 'ml', 'l', 'g', 'kg']

let counter = 0
const options = (): ApplyOptions => ({ now: 1_700_000_000_000, generateId: () => `id-${(counter += 1)}` })

const quantity: fc.Arbitrary<Quantity> = fc.record({
  value: fc.integer({ min: 1, max: 100 }),
  unit: fc.constantFrom(...UNITS),
})

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant('add' as const),
    source: fc.constant('voice' as const),
    item: fc.record({
      canonicalId: fc.constantFrom(...CANONICAL_IDS),
      name: fc.constantFrom(...CANONICAL_IDS),
      quantity,
      category: fc.constantFrom<Category>('dairy', 'produce', 'pantry', 'other'),
      confidence: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
    }),
  }),
  fc.record({
    kind: fc.constantFrom('remove' as const, 'check' as const, 'uncheck' as const),
    target: fc.record({
      canonicalId: fc.constantFrom(...CANONICAL_IDS),
      expectedVersion: fc.integer({ min: 0, max: 50 }),
    }),
  }),
  fc.record({
    kind: fc.constant('setQuantity' as const),
    target: fc.record({
      canonicalId: fc.constantFrom(...CANONICAL_IDS),
      expectedVersion: fc.integer({ min: 0, max: 50 }),
    }),
    quantity,
  }),
  fc.constant<Command>({ kind: 'clear' }),
  fc.constant<Command>({ kind: 'undo' }),
  fc.record({ kind: fc.constant('unknown' as const), transcript: fc.string({ maxLength: 20 }) }),
)

const script = fc.array(command, { maxLength: 25 })

function run(commands: readonly Command[]): ListState {
  return commands.reduce((state, next) => applyCommand(state, next, options()).state, EMPTY_STATE)
}

describe('structural invariants hold after any sequence', () => {
  it('never throws', () => {
    fc.assert(fc.property(script, (commands) => {
      expect(() => run(commands)).not.toThrow()
    }))
  })

  it('never holds two rows for the same item', () => {
    // Duplicate rows are the single most visible way a list looks broken.
    fc.assert(
      fc.property(script, (commands) => {
        const ids = run(commands).items.map((item) => item.canonicalId)
        expect(new Set(ids).size).toBe(ids.length)
      }),
    )
  })

  it('never holds two rows with the same id', () => {
    fc.assert(
      fc.property(script, (commands) => {
        const ids = run(commands).items.map((item) => item.id)
        expect(new Set(ids).size).toBe(ids.length)
      }),
    )
  })

  it('keeps every quantity positive and finite', () => {
    fc.assert(
      fc.property(script, (commands) => {
        for (const item of run(commands).items) {
          expect(Number.isFinite(item.quantity.value)).toBe(true)
          expect(item.quantity.value).toBeGreaterThan(0)
        }
      }),
    )
  })

  it('advances the version on every mutation and never rewinds it', () => {
    fc.assert(
      fc.property(script, (commands) => {
        let state = EMPTY_STATE
        for (const next of commands) {
          const result = applyCommand(state, next, options())
          expect(result.state.version).toBeGreaterThanOrEqual(state.version)
          state = result.state
        }
      }),
    )
  })

  it('always surfaces something for the user to read', () => {
    // A command that changes nothing and says nothing looks like a dead app.
    fc.assert(
      fc.property(command, (next) => {
        const result = applyCommand(EMPTY_STATE, next, options())
        if (next.kind === 'search') return
        expect(result.effects.length).toBeGreaterThan(0)
      }),
    )
  })

  it('treats state as immutable', () => {
    fc.assert(
      fc.property(script, (commands) => {
        const before = run(commands)
        const snapshot = JSON.stringify(before)
        applyCommand(before, { kind: 'clear' }, options())
        expect(JSON.stringify(before)).toBe(snapshot)
      }),
    )
  })
})

describe('undo', () => {
  it('restores the previous state for any single invertible command', () => {
    const invertible = command.filter((c) => c.kind !== 'undo' && c.kind !== 'unknown')
    fc.assert(
      fc.property(script, invertible, (setup, next) => {
        const before = run(setup)
        const after = applyCommand(before, next, options()).state
        // Nothing changed, so there is nothing to undo.
        if (after.version === before.version) return

        const undone = applyCommand(after, { kind: 'undo' }, options()).state
        expect(undone.items.map((i) => i.canonicalId).sort()).toEqual(
          before.items.map((i) => i.canonicalId).sort(),
        )
        for (const item of before.items) {
          const restored = undone.items.find((i) => i.canonicalId === item.canonicalId)
          expect(restored).toBeDefined()
          expect(toBase(restored!.quantity)).toBeCloseTo(toBase(item.quantity), 6)
          expect(restored!.checked).toBe(item.checked)
        }
      }),
      { numRuns: 1000 },
    )
  })

  it('restores the checked state, not just the row', () => {
    // Minimal counterexample from the property test above, pinned as an example
    // so the specific regression is legible without running a generator:
    // check an item off, remove it, undo -- it used to come back unchecked,
    // because remove's inverse was an `add` and adding creates a fresh row.
    const state = run([
      { kind: 'add', source: 'voice', item: { canonicalId: 'paneer', name: 'Paneer', quantity: { value: 1, unit: 'piece' }, category: 'dairy', confidence: 1 } },
      { kind: 'check', target: { canonicalId: 'paneer', expectedVersion: 1 } },
      { kind: 'remove', target: { canonicalId: 'paneer', expectedVersion: 2 } },
      { kind: 'undo' },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0].checked).toBe(true)
  })

  it('never leaves more history than commands applied', () => {
    fc.assert(
      fc.property(script, (commands) => {
        expect(run(commands).history.length).toBeLessThanOrEqual(commands.length)
      }),
    )
  })
})

describe('merging conserves stock', () => {
  it('adding the same item twice sums the quantities', () => {
    fc.assert(
      fc.property(quantity, quantity, (a, b) => {
        const add = (q: Quantity): Command => ({
          kind: 'add',
          source: 'voice',
          item: { canonicalId: 'milk', name: 'Milk', quantity: q, category: 'dairy', confidence: 1 },
        })
        const state = run([add(a), add(b)])
        expect(state.items).toHaveLength(1)
        const total = toBase(state.items[0].quantity)
        // Incommensurable units are refused rather than coerced, so the row
        // keeps the first quantity and the user is asked.
        expect(total).toBeCloseTo(canMerge(a, b) ? toBase(a) + toBase(b) : toBase(a), 6)
      }),
    )
  })
})

describe('stale commands', () => {
  it('a wrong expectedVersion never corrupts the list', () => {
    // Voice takes ~800ms, so a command routinely arrives against a version that
    // has moved on. It must reconcile or clarify, never damage state.
    fc.assert(
      fc.property(script, fc.integer({ min: 0, max: 999 }), (setup, staleVersion) => {
        const before = run(setup)
        const stale: Command = {
          kind: 'remove',
          target: { canonicalId: 'milk', expectedVersion: staleVersion },
        }
        const after = applyCommand(before, stale, options()).state
        const ids = after.items.map((i) => i.canonicalId)
        expect(new Set(ids).size).toBe(ids.length)
        expect(after.items.length).toBeLessThanOrEqual(before.items.length)
      }),
    )
  })
})
