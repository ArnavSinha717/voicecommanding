import { describe, expect, it } from 'vitest'

import type { SpeechHypothesis } from '../../ports/speech'
import {
  BASELINE_CONFIG,
  DEFAULT_CONFIG,
  FULL_CONFIG,
  ItemResolver,
  phoneticCode,
  type ResolverConfig,
} from './resolver'

const resolver = new ItemResolver(DEFAULT_CONFIG)

function hypothesis(transcript: string, rank: number, confidence = 0): SpeechHypothesis {
  return { transcript, confidence, rank }
}

describe('exact resolution', () => {
  it.each([
    ['milk', 'milk'],
    ['bread', 'bread'],
    ['tomato', 'tomato'],
    ['paneer', 'paneer'],
  ])('resolves %j', (phrase, canonicalId) => {
    expect(resolver.resolve(phrase)?.canonicalId).toBe(canonicalId)
  })

  it('scores an exact hit at the ceiling and reports the stage', () => {
    const result = resolver.resolve('milk')
    expect(result?.score).toBe(1)
    expect(result?.stage).toBe('exact')
  })

  it('ignores filler words and plurals on the way in', () => {
    expect(resolver.resolve('the apples')?.canonicalId).toBe('apple')
    expect(resolver.resolve('some tomatoes')?.canonicalId).toBe('tomato')
  })

  it('returns null for an empty phrase', () => {
    expect(resolver.resolve('')).toBeNull()
    expect(resolver.resolve('   ')).toBeNull()
  })

  it('returns null rather than forcing a match on nonsense', () => {
    // The open-vocabulary path depends on this: a null here means "not in the
    // catalog", which the parser turns into an item rather than a failure.
    expect(resolver.resolve('zorblex')).toBeNull()
  })
})

describe('multilingual aliases', () => {
  it.each([
    ['doodh', 'milk'],
    ['dudh', 'milk'],
    ['tamatar', 'tomato'],
    ['pyaz', 'onion'],
    ['aloo', 'potato'],
    ['ande', 'egg'],
  ])('resolves %j to %j', (phrase, canonicalId) => {
    expect(resolver.resolve(phrase)?.canonicalId).toBe(canonicalId)
  })

  it('collapses long and short vowel spellings onto one entry', () => {
    // The transliterator emits scholarly long vowels while people type short
    // ones; both must reach the same row or a Hinglish list silently splits.
    expect(resolver.resolve('doodh')?.canonicalId).toBe(resolver.resolve('dudh')?.canonicalId)
  })
})

describe('n-best reranking', () => {
  const hypotheses = [
    hypothesis('tomorrow toes', 0, 0.4),
    hypothesis('tomatoes', 1, 0.3),
  ]

  it('can prefer a lower-ranked hypothesis that names a real product', () => {
    const result = resolver.resolveBest(hypotheses)
    expect(result?.canonicalId).toBe('tomato')
  })

  it('only considers the top hypothesis when n-best is disabled', () => {
    const single = new ItemResolver({ ...DEFAULT_CONFIG, useNBest: false })
    expect(single.resolveBest(hypotheses)).toBeNull()
  })

  it('returns null when no hypothesis resolves', () => {
    expect(resolver.resolveBest([hypothesis('zorblex', 0), hypothesis('qwertyuiop', 1)])).toBeNull()
  })

  it('handles an empty hypothesis list', () => {
    expect(resolver.resolveBest([])).toBeNull()
  })
})

describe('ablation configurations', () => {
  it('baseline resolves exact matches but not approximate ones', () => {
    const baseline = new ItemResolver(BASELINE_CONFIG)
    expect(baseline.resolve('milk')?.canonicalId).toBe('milk')
    expect(baseline.resolve('tomatoe')).toBeNull()
  })

  it('fuzzy matching recovers a near miss the baseline drops', () => {
    const fuzzy = new ItemResolver({ ...BASELINE_CONFIG, useFuzzy: true })
    expect(fuzzy.resolve('tomatoe')?.canonicalId).toBe('tomato')
  })

  it('respects the tuned fuzzy threshold', () => {
    // 0.84 was selected on the dev split under a pre-registered false-positive
    // bound. A looser value admits more, which is the trade the sweep measured.
    const strict = new ItemResolver({ ...DEFAULT_CONFIG, fuzzyThreshold: 0.99 })
    const loose = new ItemResolver({ ...DEFAULT_CONFIG, fuzzyThreshold: 0.7 })
    expect(strict.resolve('tomatoe')).toBeNull()
    expect(loose.resolve('tomatoe')).not.toBeNull()
  })

  it('reports which stage produced the winner', () => {
    const full = new ItemResolver(FULL_CONFIG)
    expect(full.resolve('milk')?.stage).toBe('exact')
    expect(['phonetic', 'fuzzy']).toContain(full.resolve('tomatoe')?.stage)
  })
})

describe('scoring', () => {
  it('exposes per-feature contributions for explainability', () => {
    const result = new ItemResolver({ ...BASELINE_CONFIG, useFuzzy: true }).resolve('tomatoe')
    expect(result?.features).toBeDefined()
    for (const value of Object.values(result!.features)) {
      // Comparable weights require every feature normalised to the same range.
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('falls back to rank when the recognizer reports zero confidence', () => {
    // Chrome reports 0 for interim results and sometimes for finals, so a 0 must
    // mean "unknown" rather than "certainly wrong".
    const config: ResolverConfig = { ...BASELINE_CONFIG, useFuzzy: true }
    const ranked = new ItemResolver(config)
    const first = ranked.resolve('tomatoe', { asrConfidence: 0, rank: 0 })
    const fourth = ranked.resolve('tomatoe', { asrConfidence: 0, rank: 3 })
    expect(first!.score).toBeGreaterThan(fourth!.score)
  })

  it('lets purchase history break a tie', () => {
    const config: ResolverConfig = { ...BASELINE_CONFIG, useFuzzy: true }
    const plain = new ItemResolver(config).resolve('tomatoe')
    const withHistory = new ItemResolver(config).resolve('tomatoe', {
      userHistory: new Map([['tomato', 12]]),
    })
    expect(withHistory!.score).toBeGreaterThan(plain!.score)
  })
})

describe('phonetic encoding', () => {
  it('encodes multi-word phrases word by word', () => {
    expect(phoneticCode('pasta sauce').split(' ')).toHaveLength(2)
  })

  it('keeps words apart when the leading consonant differs', () => {
    // "milk"/"silk" is exactly the pair edit distance ranks as near-identical.
    expect(phoneticCode('milk')).not.toBe(phoneticCode('silk'))
  })

  it('handles an empty string', () => {
    expect(phoneticCode('')).toBe('')
  })
})
