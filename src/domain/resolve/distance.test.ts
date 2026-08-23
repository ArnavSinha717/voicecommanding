import { describe, expect, it } from 'vitest'

import { editSimilarity, jaroWinkler, levenshtein } from './distance'

describe('levenshtein', () => {
  it.each([
    ['kitten', 'sitting', 3],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['same', 'same', 0],
    ['milk', 'silk', 1],
  ])('%j -> %j is %i edits', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('is symmetric', () => {
    expect(levenshtein('tomatoes', 'tomorrow toes')).toBe(levenshtein('tomorrow toes', 'tomatoes'))
  })

  it('reports over the cap rather than the true distance when bounded', () => {
    // The early exit exists so the baseline ablation config can scan the whole
    // catalog without quadratic blowup; it must never under-report.
    const capped = levenshtein('tomatoes', 'tomorrow toes', 2)
    expect(capped).toBeGreaterThan(2)
    expect(levenshtein('milk', 'silk', 2)).toBe(1)
  })

  it('exits early on a length difference alone', () => {
    expect(levenshtein('a', 'abcdefghij', 3)).toBeGreaterThan(3)
  })
})

describe('editSimilarity', () => {
  it('is 1 for identical strings and 0 for two empty ones', () => {
    expect(editSimilarity('milk', 'milk')).toBe(1)
    expect(editSimilarity('', '')).toBe(1)
  })

  it('ranks a homophone above a genuine phonetic neighbour, which is the trap', () => {
    // This is precisely why edit distance is the wrong primary metric for ASR
    // output: "silk" is one edit from "milk" and means something else entirely,
    // while "tomorrow toes" is many edits from "tomatoes" and is the same word.
    expect(editSimilarity('milk', 'silk')).toBeGreaterThan(
      editSimilarity('tomatoes', 'tomorrow toes'),
    )
  })
})

describe('jaroWinkler', () => {
  it('is 1 for identical strings', () => {
    expect(jaroWinkler('paneer', 'paneer')).toBe(1)
  })

  it('is 0 when either side is empty', () => {
    expect(jaroWinkler('', 'paneer')).toBe(0)
    expect(jaroWinkler('paneer', '')).toBe(0)
  })

  it('rewards a shared prefix over a shared suffix', () => {
    // Leading sounds are both the most perceptually salient and the ones
    // recognizers get right most often, which is why the prefix bonus matters.
    expect(jaroWinkler('paneer', 'paneed')).toBeGreaterThan(jaroWinkler('paneer', 'xaneer'))
  })

  it('stays within [0,1]', () => {
    for (const [a, b] of [
      ['milk', 'silk'],
      ['tomato', 'tomatoes'],
      ['a', 'zzzzzzzz'],
      ['dhania', 'dhaniya'],
    ]) {
      const score = jaroWinkler(a, b)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('counts transpositions', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9)
    expect(jaroWinkler('martha', 'marhta')).toBeLessThan(1)
  })
})
