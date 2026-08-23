/**
 * Transcript normalisation.
 *
 * The same spoken word reaches us in different scripts depending on which language
 * the recognizer was told to expect: `hi-IN` returns "दूध", `en-IN` returns "doodh",
 * and an English speaker says "milk". All three refer to one catalog entry, so
 * every transcript is folded to a single romanised form before matching. Without
 * this, a Hinglish speaker's list silently splits into duplicate rows.
 */

/**
 * Devanagari to Latin transliteration.
 *
 * Deliberately phonetic rather than scholarly — the output is a matching key, not
 * something a user reads. Consonants carry an inherent 'a' which a following matra
 * replaces and a virama suppresses, which is the only real subtlety here.
 */
const CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'ng',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'ny',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'v',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  क़: 'q', ख़: 'kh', ग़: 'gh', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f',
}

const INDEPENDENT_VOWELS: Readonly<Record<string, string>> = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo',
  ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au',
}

/** Vowel signs. These replace a consonant's inherent 'a'. */
const MATRAS: Readonly<Record<string, string>> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  // Candra vowels, used to write English loanwords: शॉपिंग, कॉफ़ी.
  'ॉ': 'o', 'ॅ': 'e',
}

/**
 * Marks that carry no romanisation value, or map to a single sound.
 *
 * The Devanagari block runs U+0900-U+097F and holds far more than the letters in
 * everyday use. A property test generating across the whole range found U+0900
 * (inverted candrabindu) surviving untransliterated — rare in practice, but any
 * survivor reaches the matcher as a codepoint no alias can contain.
 */
const MISC_MARKS: Readonly<Record<string, string>> = {
  'ऀ': 'n',   // inverted candrabindu
  'ऺ': '',    // candra long a
  'ऻ': '',
  'ऽ': '',    // avagraha, an elision mark
  '॰': '',    // abbreviation sign
  'ॐ': 'om',
  '॑': '', '॒': '', '॓': '', '॔': '',  // Vedic accents
  '॥': ' ', '।': ' ',                  // danda, a full stop
}

const VIRAMA = '्'
const ANUSVARA = 'ं'
const CHANDRABINDU = 'ँ'
const VISARGA = 'ः'
const NUKTA = '़'

const DEVANAGARI_DIGITS = '०१२३४५६७८९'

/** True when the string contains any Devanagari codepoint. */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text)
}

export function transliterateDevanagari(input: string): string {
  // NFD splits precomposed nukta letters (ख़ U+0959) into base + nukta, so a
  // single table entry covers both encodings. Without this, ख़रीददारी came
  // through as "ख़reedadaaree" with the leading character untransliterated.
  const text = input.normalize('NFD')
  let out = ''
  /** A consonant has been emitted and its inherent 'a' has not yet been resolved. */
  let pendingInherentVowel = false

  /**
   * Resolve a pending inherent vowel.
   *
   * Hindi deletes the word-final inherent vowel (schwa deletion), so दूध is
   * "doodh" rather than "doodha". Emitting it unconditionally would put a trailing
   * vowel on every Hindi word and break matching against romanised aliases, which
   * speakers write the way they say them.
   */
  const flush = (atWordEnd: boolean): void => {
    if (pendingInherentVowel && !atWordEnd) out += 'a'
    pendingInherentVowel = false
  }

  for (const char of text) {
    const consonant = CONSONANTS[char]
    if (consonant !== undefined) {
      flush(false)
      out += consonant
      pendingInherentVowel = true
      continue
    }

    const matra = MATRAS[char]
    if (matra !== undefined) {
      // A vowel sign replaces the inherent vowel rather than following it.
      pendingInherentVowel = false
      out += matra
      continue
    }

    if (char === VIRAMA) {
      // Explicit vowel suppression.
      pendingInherentVowel = false
      continue
    }

    const vowel = INDEPENDENT_VOWELS[char]
    if (vowel !== undefined) {
      flush(false)
      out += vowel
      continue
    }

    if (char === ANUSVARA || char === CHANDRABINDU) {
      flush(false)
      out += 'n'
      continue
    }
    if (char === VISARGA) {
      flush(false)
      out += 'h'
      continue
    }
    if (char === NUKTA) continue

    const mark = MISC_MARKS[char]
    if (mark !== undefined) {
      if (mark === '') continue
      flush(false)
      out += mark
      continue
    }

    const digitIndex = DEVANAGARI_DIGITS.indexOf(char)
    if (digitIndex >= 0) {
      flush(false)
      out += String(digitIndex)
      continue
    }

    // Anything else (space, Latin text, punctuation) ends the current word.
    flush(true)
    out += char
  }

  flush(true)

  // Backstop: anything from the Devanagari block that reached here is a mark
  // this table does not model. Dropping it is strictly better than passing it
  // through, because a residual codepoint can never match a romanised alias.
  return out.replace(/[\u0900-\u097F]/g, '')
}

/**
 * Spoken-form fixes applied before tokenising.
 *
 * Recognizers emit numerals inconsistently ("2" vs "two"), attach possessives, and
 * produce contractions that would otherwise fragment a token stream.
 */
const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bi'm\b/g, 'i am'],
  [/\bwe're\b/g, 'we are'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bdidn't\b/g, 'did not'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bit's\b/g, 'it is'],
  [/\bthat's\b/g, 'that is'],
  [/\bi've\b/g, 'i have'],
  [/\bi'd\b/g, 'i would'],
  [/\bi'll\b/g, 'i will'],
]

/**
 * Framing that wraps a command without changing it.
 *
 * Every intent rule is anchored at the start of the utterance, so an unstripped
 * "please" defeats all of them. Measured against MASSIVE en-US, these prefixes
 * appear on a large share of real utterances — "please" 962 times, "can you" 436,
 * the wake word "olly" 420 — and dropping them was worth more recall than any
 * other single change. Derived from corpus frequency, not from imagination.
 */
const FRAMING_PREFIXES: readonly RegExp[] = [
  /^(?:olly|alexa|siri|hey|ok google|hi)\s+/,
  /^please\s+/,
  /^(?:can|could|would|will) you\s+/,
  /^i (?:would like|want|need) (?:you )?to\s+/,
  /^(?:help me|let us|lets|let me)\s+/,
  /^(?:go ahead and|go to the list and)\s+/,
  // Hindi framing: कृपया (please), क्या आप/तुम (can you), मुझे ... चाहिए भी
  /^kripayaa\s+/,
  /^kripaya\s+/,
  /^kya (?:aap|tum)\s+/,
  /^mujhe\s+/,
]

/** The same framing can appear after the command: "add milk please". */
const FRAMING_SUFFIXES: readonly RegExp[] = [
  /\s+(?:please|olly|alexa|thanks|thank you)$/,
  /\s+for me$/,
]

/**
 * Strip framing until the utterance stops shrinking.
 *
 * Real speech stacks it — "can you please add milk" carries two prefixes — so a
 * single pass is not enough.
 */
export function stripFraming(text: string): string {
  let current = text
  for (let pass = 0; pass < 4; pass += 1) {
    const before = current
    for (const pattern of [...FRAMING_PREFIXES, ...FRAMING_SUFFIXES]) {
      current = current.replace(pattern, ' ').trim()
    }
    if (current === before) break
  }
  return current
}

export interface NormalizedText {
  /** Whitespace-collapsed, punctuation-stripped, lowercased, romanised. */
  readonly text: string
  readonly tokens: readonly string[]
  /** True when the source contained Devanagari, i.e. the user likely spoke Hindi. */
  readonly wasTransliterated: boolean
}

export function normalize(raw: string): NormalizedText {
  const wasTransliterated = hasDevanagari(raw)
  let text = wasTransliterated ? transliterateDevanagari(raw) : raw

  text = text.toLowerCase()

  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement)
  }

  text = text
    // Keep intra-word hyphens and apostrophes out of the way, drop other punctuation.
    .replace(/[.,!?;:"“”‘’()[\]{}]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/'/g, '')
    // Currency symbols become words so price filters can pick them up.
    .replace(/₹/g, ' rupees ')
    .replace(/\$/g, ' dollars ')
    .replace(/\s+/g, ' ')
    .trim()

  // Separate a number from a unit written flush against it: "500g" -> "500 g".
  // Found by a round-trip property test — the app formatted metric quantities
  // as "1kg" and then could not parse its own output back, so typing
  // "add 500g paneer" silently lost the quantity. Recognisers and humans both
  // produce this form freely.
  text = text.replace(
    /\b(\d+(?:\.\d+)?)\s*(kgs?|kilograms?|kilos?|gms?|grams?|mls?|millilitres?|milliliters?|ltrs?|litres?|liters?|[gl])\b/g,
    '$1 $2',
  )

  // Drop an adverb sitting between a subject and its verb: "i also need apples"
  // has to reach the rules as "i need apples", or the anchor never matches.
  //
  // Deliberately positional rather than a blanket removal — "add just one apple"
  // must keep its "just". MASSIVE shows this pattern at low frequency (just,
  // still, currently, please), because its utterances are clipped; real speech
  // carries far more of it, which is where this was actually found.
  // Repeated, because speech stacks them: "i also really need some bananas".
  // After a subject pronoun *or* an imperative verb: "i also need apples" and
  // "add just one apple" both carry filler in the same role. The second form
  // was silently producing an item named "just one apple".
  const interposedAdverb =
    /\b(i|we|you|add|remove|delete|get|buy|grab|put|include|need|want|find)\s+(?:also|just|really|still|actually|simply|currently|definitely|probably|honestly|literally)\s+(?=\w)/g
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text
    text = text.replace(interposedAdverb, '$1 ')
    if (text === before) break
  }

  text = stripFraming(text)

  const tokens = text === '' ? [] : text.split(' ')
  return { text, tokens, wasTransliterated }
}

/**
 * Reduce a phrase to a canonical matching key.
 *
 * Strips filler words and trailing plurals so "the apples", "some apple" and
 * "apples" collapse together. Applied to both user input and catalog entries, so
 * the two sides are always compared in the same space.
 */
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'some', 'my', 'our', 'please', 'kuch', 'thoda', 'thodi',
  'of', 'ka', 'ki', 'ke', 'to', 'for',
  // Hindi particles and list nouns, so "soochee se ande" yields "ande".
  'kee', 'kaa', 'se', 'men', 'mein', 'ko', 'meree', 'mera', 'meri', 'is', 'us',
  'ek', 'naee', 'nai', 'soochee', 'suchi', 'list', 'lisht', 'shoping', 'shopping',
  'khareedadaaree', 'khareedaaree', 'kiraane', 'kirane',
])

export function canonicalKey(phrase: string): string {
  const { tokens } = normalize(phrase)
  const kept = tokens.filter((token) => !FILLER_WORDS.has(token)).map(singularize)
  return kept.join(' ')
}

/**
 * Crude English de-pluralisation.
 *
 * Good enough for grocery nouns and deliberately conservative: over-stemming would
 * collapse distinct catalog entries, which is worse than leaving a plural in place.
 */
/**
 * Words ending in -s that are not plurals. Without these, "this song" became
 * "thi song" and leaked into open-vocabulary item names.
 */
const NOT_PLURAL = new Set([
  'this', 'his', 'its', 'is', 'was', 'has', 'does', 'goes', 'yes', 'gas', 'bus',
  'plus', 'news', 'lens', 'series', 'species', 'always', 'perhaps', 'cross',
])

export function singularize(word: string): string {
  if (word.length <= 3 || NOT_PLURAL.has(word)) return word
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2)
  if (word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1)
  return word
}
