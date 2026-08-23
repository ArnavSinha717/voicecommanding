import { beforeEach, describe, expect, it } from 'vitest'

import type { Command, NewItem, Quantity } from '../types'
import { applyCommand, EMPTY_STATE, type ApplyOptions, type ListState } from './reducer'

let counter = 0
const options: ApplyOptions = {
  now: 1_700_000_000_000,
  generateId: () => `id-${(counter += 1)}`,
}

beforeEach(() => {
  counter = 0
})

function newItem(canonicalId: string, quantity: Quantity, name = canonicalId): NewItem {
  return { name, canonicalId, quantity, category: 'other', confidence: 1 }
}

function add(canonicalId: string, quantity: Quantity, name?: string): Command {
  return { kind: 'add', item: newItem(canonicalId, quantity, name), source: 'voice' }
}

/** Apply a sequence of commands, returning the final state. */
function run(state: ListState, ...commands: Command[]): ListState {
  return commands.reduce((acc, command) => applyCommand(acc, command, options).state, state)
}

const piece = (value: number): Quantity => ({ value, unit: 'piece' })

describe('adding', () => {
  it('creates a row', () => {
    const { state } = applyCommand(EMPTY_STATE, add('apple', piece(3)), options)
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ canonicalId: 'apple', quantity: piece(3) })
  })

  it('merges quantities instead of creating a duplicate row', () => {
    const state = run(EMPTY_STATE, add('apple', piece(3)), add('apple', piece(2)))
    expect(state.items).toHaveLength(1)
    expect(state.items[0].quantity).toEqual(piece(5))
  })

  it('converts between units of the same dimension', () => {
    const state = run(
      EMPTY_STATE,
      add('rice', { value: 500, unit: 'g' }),
      add('rice', { value: 1, unit: 'kg' }),
    )
    expect(state.items[0].quantity).toEqual({ value: 1.5, unit: 'kg' })
  })

  it('asks rather than guessing when units are incommensurable', () => {
    // 2 bottles + 1kg is not a quantity. Silently coercing it would be worse
    // than admitting the ambiguity.
    const first = applyCommand(EMPTY_STATE, add('water', { value: 2, unit: 'bottle' }), options)
    const second = applyCommand(first.state, add('water', { value: 1, unit: 'kg' }), options)

    expect(second.effects[0]).toMatchObject({ kind: 'clarify' })
    expect(second.state.items).toHaveLength(1)
    expect(second.state.items[0].quantity).toEqual({ value: 2, unit: 'bottle' })
  })
})

describe('optimistic concurrency', () => {
  it('still applies when the version is stale but the item is present', () => {
    // The user tapped something else while this command was in flight. The list
    // moved on, but the target is still there, so the command is valid.
    const state = run(EMPTY_STATE, add('milk', piece(1)), add('bread', piece(1)))
    const staleRemove: Command = {
      kind: 'remove',
      target: { canonicalId: 'milk', expectedVersion: 0 },
    }

    const result = applyCommand(state, staleRemove, options)
    expect(result.state.items.map((i) => i.canonicalId)).toEqual(['bread'])
  })

  it('clarifies rather than crashing when the target was removed mid-flight', () => {
    // Voice takes ~800ms. If the user tapped the item away in that window, a naive
    // implementation crashes on the undefined reference or resurrects the row.
    const state = run(EMPTY_STATE, add('milk', piece(1)))
    const afterTap = applyCommand(
      state,
      { kind: 'remove', target: { canonicalId: 'milk', expectedVersion: state.version } },
      options,
    ).state

    const lateVoiceCommand = applyCommand(
      afterTap,
      { kind: 'remove', target: { canonicalId: 'milk', expectedVersion: state.version } },
      options,
    )

    expect(lateVoiceCommand.effects[0]).toMatchObject({ kind: 'clarify' })
    expect(lateVoiceCommand.state.items).toHaveLength(0)
  })
})

describe('undo', () => {
  it('reverses an add', () => {
    const state = run(EMPTY_STATE, add('apple', piece(3)), { kind: 'undo' })
    expect(state.items).toHaveLength(0)
  })

  it('reverses a remove, restoring the original quantity', () => {
    const state = run(
      EMPTY_STATE,
      add('apple', piece(3)),
      { kind: 'remove', target: { canonicalId: 'apple', expectedVersion: 1 } },
      { kind: 'undo' },
    )
    expect(state.items).toHaveLength(1)
    expect(state.items[0].quantity).toEqual(piece(3))
  })

  it('restores the previous quantity, not a default', () => {
    const state = run(
      EMPTY_STATE,
      add('apple', piece(3)),
      { kind: 'setQuantity', target: { canonicalId: 'apple', expectedVersion: 1 }, quantity: piece(9) },
      { kind: 'undo' },
    )
    expect(state.items[0].quantity).toEqual(piece(3))
  })

  it('restores a cleared list', () => {
    const state = run(EMPTY_STATE, add('apple', piece(1)), add('milk', piece(1)), { kind: 'clear' }, { kind: 'undo' })
    expect(state.items.map((i) => i.canonicalId).sort()).toEqual(['apple', 'milk'])
  })

  it('does not itself become undoable', () => {
    // Otherwise undo would toggle the same change forever.
    const state = run(EMPTY_STATE, add('apple', piece(1)), { kind: 'undo' }, { kind: 'undo' })
    expect(state.items).toHaveLength(0)
  })

  it('reports politely with nothing to undo', () => {
    const result = applyCommand(EMPTY_STATE, { kind: 'undo' }, options)
    expect(result.effects[0]).toMatchObject({ kind: 'announce', message: 'Nothing to undo' })
  })
})

describe('checking off', () => {
  it('marks and unmarks', () => {
    const target = { canonicalId: 'milk', expectedVersion: 1 }
    const checked = run(EMPTY_STATE, add('milk', piece(1)), { kind: 'check', target })
    expect(checked.items[0].checked).toBe(true)

    const unchecked = applyCommand(checked, { kind: 'uncheck', target }, options)
    expect(unchecked.state.items[0].checked).toBe(false)
  })

  it('is idempotent without inflating history', () => {
    const target = { canonicalId: 'milk', expectedVersion: 1 }
    const once = run(EMPTY_STATE, add('milk', piece(1)), { kind: 'check', target })
    const twice = applyCommand(once, { kind: 'check', target }, options)
    expect(twice.state.history).toHaveLength(once.history.length)
  })
})

describe('dialogue state', () => {
  it('tracks the last item so pronouns have something to refer to', () => {
    const state = run(EMPTY_STATE, add('milk', piece(1), 'Milk'))
    expect(state.dialogue).toMatchObject({ lastCanonicalId: 'milk' })
  })
})

describe('unknown commands', () => {
  it('asks for a rephrase instead of failing silently', () => {
    const result = applyCommand(EMPTY_STATE, { kind: 'unknown', transcript: 'blorp' }, options)
    expect(result.effects[0]).toMatchObject({ kind: 'clarify' })
    expect(result.state).toBe(EMPTY_STATE)
  })
})
