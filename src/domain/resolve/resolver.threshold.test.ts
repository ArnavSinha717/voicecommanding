/**
 * Both sides of the fuzzy-match boundary.
 *
 * Fuzzy matching earns its place by recovering a near miss, and loses it the
 * moment it answers confidently with the wrong item — which is worse than
 * admitting it does not know, because the open-vocabulary path would otherwise
 * have added exactly what the user said.
 *
 * These cases are all observed, not invented: each rejection below was a real
 * mis-resolution seen while running the parser over real data.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, ItemResolver } from './resolver'

const resolver = new ItemResolver(DEFAULT_CONFIG)

describe('fuzzy matching rejects a confident wrong answer', () => {
  it.each([
    ['water', 'wafer'],
    ['opinion', 'onion'],
    ['rap', 'grape'],
  ])('does not resolve %j to %j', (input, forbidden) => {
    const resolved = resolver.resolve(input)
    // Null is the right answer here: the caller adds the phrase as its own item.
    expect(resolved?.canonicalId).not.toBe(forbidden)
  })
})

describe('fuzzy matching still recovers a genuine near miss', () => {
  it.each([
    ['tomatoe', 'tomato'],
    ['panner', 'paneer'],
  ])('resolves %j to %j', (input, expected) => {
    expect(resolver.resolve(input)?.canonicalId).toBe(expected)
  })
})

describe('vowel folding runs before fuzzy matching', () => {
  it('resolves a short-vowel Hinglish spelling exactly', () => {
    // "dudh" scores only 0.805 against "doodh" and would fail the fuzzy gate.
    // Folding makes it an exact hit, so it never reaches that path.
    const resolved = resolver.resolve('dudh')
    expect(resolved?.canonicalId).toBe('milk')
    expect(resolved?.stage).toBe('exact')
  })
})
