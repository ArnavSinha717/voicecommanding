import { describe, expect, it } from 'vitest'

import {
  canonicalKey,
  hasDevanagari,
  normalize,
  singularize,
  stripFraming,
  transliterateDevanagari,
} from './normalize'

describe('Devanagari transliteration', () => {
  it.each([
    ['दूध', 'doodh'],
    ['अंडे', 'ande'],
    ['चावल', 'chaaval'],
    ['नमक', 'namak'],
    ['आलू', 'aaloo'],
  ])('transliterates %s', (input, expected) => {
    expect(transliterateDevanagari(input)).toBe(expected)
  })

  it('deletes the word-final inherent vowel', () => {
    // Hindi schwa deletion: दूध is "doodh", not "doodha". Emitting the inherent
    // vowel unconditionally put a trailing 'a' on every word and broke matching
    // against romanised aliases, which people write the way they say them.
    expect(transliterateDevanagari('दूध')).not.toMatch(/a$/)
    expect(transliterateDevanagari('नमक')).toBe('namak')
  })

  it('keeps the inherent vowel between consonants', () => {
    expect(transliterateDevanagari('नमक')).toContain('nam')
  })

  it('lets a vowel sign replace the inherent vowel rather than follow it', () => {
    expect(transliterateDevanagari('की')).toBe('kee')
    expect(transliterateDevanagari('को')).toBe('ko')
  })

  it('suppresses the vowel on an explicit virama', () => {
    // क् is a bare "k" with no vowel at all.
    expect(transliterateDevanagari('क्')).toBe('k')
  })

  it('handles candra vowels used in loanwords', () => {
    // शॉपिंग (shopping) is everyday spoken Hindi; without ॉ it came through as
    // "sh<devanagari>ping" with the matra untransliterated.
    expect(transliterateDevanagari('शॉपिंग')).toBe('shoping')
    expect(transliterateDevanagari('शॉपिंग')).not.toMatch(/[ऀ-ॿ]/)
  })

  it('handles both encodings of nukta consonants', () => {
    // ख़ exists precomposed (U+0959) and decomposed (ख + U+093C); NFD folds them.
    const precomposed = transliterateDevanagari('ख़')
    const decomposed = transliterateDevanagari('ख' + '़')
    expect(precomposed).toBe(decomposed)
    expect(precomposed).not.toMatch(/[ऀ-ॿ]/)
  })

  it('converts Devanagari digits', () => {
    expect(transliterateDevanagari('२')).toBe('2')
  })

  it('passes Latin text through untouched', () => {
    expect(transliterateDevanagari('milk')).toBe('milk')
  })

  it('leaves no Devanagari codepoints in the output for real utterances', () => {
    for (const utterance of ['शॉपिंग सूची में से अंडे हटा दो', 'ब्रेड को ख़रीददारी की सूची से हटा दो']) {
      expect(transliterateDevanagari(utterance)).not.toMatch(/[ऀ-ॿ]/)
    }
  })
})

describe('hasDevanagari', () => {
  it('detects script so the caller knows the user likely spoke Hindi', () => {
    expect(hasDevanagari('दूध')).toBe(true)
    expect(hasDevanagari('milk')).toBe(false)
    expect(hasDevanagari('add दूध')).toBe(true)
  })
})

describe('framing', () => {
  it.each([
    ['please add milk', 'add milk'],
    ['can you add milk', 'add milk'],
    ['olly add milk', 'add milk'],
    ['add milk please', 'add milk'],
    ['hey add milk', 'add milk'],
    ['kripayaa add milk', 'add milk'],
  ])('strips %j', (input, expected) => {
    expect(stripFraming(input)).toBe(expected)
  })

  it('strips stacked framing in one call', () => {
    // Real speech layers it; a single pass leaves the inner one in place and
    // every anchored rule then fails to match.
    expect(stripFraming('can you please add milk')).toBe('add milk')
  })

  it('leaves an unframed command alone', () => {
    expect(stripFraming('add milk')).toBe('add milk')
  })
})

describe('normalize', () => {
  it('expands contractions so tokens do not fragment', () => {
    // The subject is preserved: the removal rule is anchored on "i do not need".
    expect(normalize("I don't need milk").text).toBe('i do not need milk')
  })

  it('turns currency symbols into words for the price parser', () => {
    expect(normalize('under $5').text).toContain('dollars')
    expect(normalize('under ₹200').text).toContain('rupees')
  })

  it('collapses punctuation and whitespace', () => {
    expect(normalize('  add   milk,  please!  ').text).toBe('add milk')
  })

  it('reports when the input was transliterated', () => {
    expect(normalize('दूध').wasTransliterated).toBe(true)
    expect(normalize('milk').wasTransliterated).toBe(false)
  })

  it('returns no tokens for empty input', () => {
    expect(normalize('').tokens).toEqual([])
    expect(normalize('   ').tokens).toEqual([])
  })
})

describe('singularize', () => {
  it.each([
    ['apples', 'apple'],
    ['tomatoes', 'tomatoe'],
    ['berries', 'berry'],
    ['boxes', 'box'],
    ['egg', 'egg'],
  ])('%j -> %j', (input, expected) => {
    expect(singularize(input)).toBe(expected)
  })

  it('leaves words that merely end in -s alone', () => {
    // "this song" became "thi song" and leaked into open-vocabulary item names.
    for (const word of ['this', 'is', 'was', 'news', 'gas', 'bus']) {
      expect(singularize(word)).toBe(word)
    }
  })

  it('leaves double-s endings alone', () => {
    expect(singularize('glass')).toBe('glass')
  })
})

describe('canonicalKey', () => {
  it('folds articles, possessives and plurals to one key', () => {
    expect(canonicalKey('the apples')).toBe(canonicalKey('apple'))
    expect(canonicalKey('some tomatoes')).toBe(canonicalKey('tomatoe'))
  })

  it('drops Hindi particles so the item name survives alone', () => {
    expect(canonicalKey('soochee se ande')).toBe('ande')
  })

  it('is stable under repeated application', () => {
    const once = canonicalKey('the apples')
    expect(canonicalKey(once)).toBe(once)
  })
})
