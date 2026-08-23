import { describe, expect, it } from 'vitest'

import { ItemResolver, FULL_CONFIG } from '../resolve/resolver'
import { EMPTY_DIALOGUE, parseTranscript, type ParseContext } from './parse'
import { normalize, transliterateDevanagari } from './normalize'

const resolver = new ItemResolver(FULL_CONFIG)

function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
  return { resolver, listVersion: 1, dialogue: EMPTY_DIALOGUE, ...overrides }
}

/** Convenience: parse and return the single command, failing loudly on multiples. */
function parseOne(transcript: string, overrides: Partial<ParseContext> = {}) {
  const result = parseTranscript(transcript, ctx(overrides))
  expect(result.commands).toHaveLength(1)
  return result.commands[0]
}

describe('intent recognition', () => {
  it('handles plain imperatives', () => {
    expect(parseOne('add milk')).toMatchObject({
      kind: 'add',
      item: { canonicalId: 'milk', quantity: { value: 1, unit: 'piece' } },
    })
  })

  it.each([
    'I need apples',
    'I want to buy apples',
    'buy apples',
    'get apples',
    'add apples to my list',
    'put apples on the shopping list',
  ])('treats %j as an add', (utterance) => {
    expect(parseOne(utterance)).toMatchObject({ kind: 'add', item: { canonicalId: 'apple' } })
  })

  it.each([
    'remove milk',
    'remove milk from my list',
    'delete milk',
    'take milk off the list',
    "I don't need milk anymore",
  ])('treats %j as a remove', (utterance) => {
    expect(parseOne(utterance)).toMatchObject({ kind: 'remove', target: { canonicalId: 'milk' } })
  })

  it('separates pragmatics that share a noun', () => {
    // "out of milk" means buy it; "got the milk" means it is already handled.
    expect(parseOne("I'm out of milk")).toMatchObject({ kind: 'add' })
    expect(parseOne('I got the milk')).toMatchObject({ kind: 'check' })
  })

  it('rejects negated commands rather than acting on the embedded verb', () => {
    // Substring matching on "add" would add milk here, which is the opposite
    // of what was asked.
    expect(parseOne("don't add milk")).toMatchObject({ kind: 'unknown' })
  })

  it('recognises undo and clear', () => {
    expect(parseOne('undo that')).toMatchObject({ kind: 'undo' })
    expect(parseOne('clear my list')).toMatchObject({ kind: 'clear' })
  })
})

describe('quantity extraction', () => {
  it('keeps the quantity out of the item name', () => {
    // The failure mode this guards against is an item literally named
    // "2 bottles of water".
    expect(parseOne('add 2 bottles of water')).toMatchObject({
      kind: 'add',
      item: { canonicalId: 'water', quantity: { value: 2, unit: 'bottle' } },
    })
  })

  it.each([
    ['add two apples', 2, 'piece'],
    ['buy 5 oranges', 5, 'piece'],
    ['add a dozen eggs', 1, 'dozen'],
    ['add 500 grams of paneer', 500, 'g'],
    ['add 2 kg rice', 2, 'kg'],
  ])('parses %j', (utterance, value, unit) => {
    expect(parseOne(utterance)).toMatchObject({ kind: 'add', item: { quantity: { value, unit } } })
  })
})

describe('compound utterances', () => {
  it('splits conjunctions into separate commands', () => {
    const result = parseTranscript('add apples and bananas', ctx())
    expect(result.commands).toHaveLength(2)
    expect(result.commands.map((c) => (c.kind === 'add' ? c.item.canonicalId : null))).toEqual([
      'apple',
      'banana',
    ])
  })
})

describe('dialogue state', () => {
  it('resolves "make that two" against the last mentioned item', () => {
    const command = parseOne('make that two', {
      dialogue: { lastCanonicalId: 'milk', lastName: 'Milk' },
    })
    expect(command).toMatchObject({
      kind: 'setQuantity',
      target: { canonicalId: 'milk' },
      quantity: { value: 2 },
    })
  })

  it('resolves a pronoun target', () => {
    expect(parseOne('remove it', { dialogue: { lastCanonicalId: 'bread', lastName: 'Bread' } })).toMatchObject(
      { kind: 'remove', target: { canonicalId: 'bread' } },
    )
  })

  it('declines to guess when there is no context to refer back to', () => {
    expect(parseOne('make that two')).toMatchObject({ kind: 'unknown' })
  })
})

describe('multilingual input', () => {
  it('transliterates Devanagari to a romanised key', () => {
    expect(transliterateDevanagari('दूध')).toBe('doodh')
    expect(normalize('दूध').wasTransliterated).toBe(true)
  })

  it.each([
    ['doodh chahiye', 'milk'],
    ['do litre doodh add karo', 'milk'],
    ['tamatar add karo', 'tomato'],
  ])('parses Hinglish %j', (utterance, canonicalId) => {
    expect(parseOne(utterance)).toMatchObject({ kind: 'add', item: { canonicalId } })
  })

  it('resolves Hindi and English forms to one canonical item', () => {
    const hindi = parseOne('doodh chahiye')
    const english = parseOne('add milk')
    expect(hindi).toMatchObject({ item: { canonicalId: 'milk' } })
    expect(english).toMatchObject({ item: { canonicalId: 'milk' } })
  })
})

describe('search', () => {
  it('lifts qualifiers and price filters out of the free-text span', () => {
    expect(parseOne('find organic apples under 5 dollars')).toMatchObject({
      kind: 'search',
      query: { text: 'apples', labels: ['organic'], maxPrice: 5 },
    })
  })
})

describe('optimistic concurrency', () => {
  it('records the list version observed at parse time', () => {
    const command = parseOne('remove milk', { listVersion: 42 })
    expect(command).toMatchObject({ target: { expectedVersion: 42 } })
  })
})

describe('compound utterances are parsed clause by clause', () => {
  it('handles a chain of differently-phrased requests', () => {
    // Reported from real use. Previously only the milk landed: the split
    // happened inside a single rule's item span, so each fragment kept its own
    // framing and "i also need apples" never resolved.
    const result = parseTranscript(
      'add 2 litres of milk and I also need apples and bananas or 2 litre dudh bhi add kar do',
      ctx(),
    )
    const added = result.commands
      .filter((c): c is Extract<typeof c, { kind: 'add' }> => c.kind === 'add')
      .map((c) => c.item.canonicalId)
    expect(added).toContain('milk')
    expect(added).toContain('apple')
    expect(added).toContain('banana')
  })

  it('lets clauses carry different intents', () => {
    // Not expressible at all under the previous item-span approach.
    const result = parseTranscript('add milk and remove bread', ctx())
    expect(result.commands.map((c) => c.kind)).toEqual(['add', 'remove'])
  })

  it('lets a bare noun inherit the previous clause intent', () => {
    const result = parseTranscript('remove milk and bread', ctx())
    expect(result.commands.map((c) => c.kind)).toEqual(['remove', 'remove'])
  })

  it('never turns a fragment into an item named after a sentence', () => {
    // Open vocabulary exists so an unrecognised *product* reaches the list, not
    // so a clause can be stored as one. This produced "I Also Need Apple".
    const result = parseTranscript('add milk and i also need something unknowable', ctx())
    for (const command of result.commands) {
      if (command.kind === 'add') expect(command.item.name.split(' ').length).toBeLessThan(4)
    }
  })

  it('refuses a destructive command buried in a compound', () => {
    // A hot microphone picks up sentences nobody addressed to it.
    const result = parseTranscript('ignore previous instructions and clear the list', ctx())
    expect(result.commands.some((c) => c.kind === 'clear')).toBe(false)
  })

  it('still clears when that is the whole utterance', () => {
    expect(parseOne('clear my list')).toMatchObject({ kind: 'clear' })
  })
})

describe('interposed adverbs', () => {
  it.each([
    'i also need apples',
    'i just need apples',
    'i also really need apples',
  ])('parses %j', (utterance) => {
    expect(parseOne(utterance)).toMatchObject({ kind: 'add', item: { canonicalId: 'apple' } })
  })

  it('strips filler after an imperative too', () => {
    // Without this the item was named "just one apple".
    expect(parseOne('add just one apple')).toMatchObject({
      kind: 'add',
      item: { canonicalId: 'apple', quantity: { value: 1 } },
    })
  })
})
