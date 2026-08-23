/**
 * String distance metrics.
 *
 * Two different metrics for two different jobs, because they measure different
 * kinds of similarity and using the wrong one actively misranks candidates.
 *
 * Levenshtein measures *orthographic* distance — how many character edits separate
 * two spellings. That is the right model for typos, where the error really is at
 * the character level.
 *
 * Speech recognition errors are not typos. The recognizer heard an acoustic
 * sequence and emitted a plausible word sequence for it, so the error lives in
 * phonetic space. Measured orthographically:
 *
 *   "tomorrow toes" vs "tomatoes"   ~7 edits — correct, but scored as very distant
 *   "milk"          vs "silk"        1 edit  — wrong, but scored as nearly identical
 *
 * Any threshold loose enough to catch the first will admit vast amounts of noise,
 * while the second is ranked above the correct answer. Hence phonetic encoding as
 * the primary signal, with edit distance used to compare *phonetic codes* rather
 * than raw spellings.
 */

/**
 * Levenshtein edit distance, single-row dynamic programming.
 *
 * `maxDistance` allows early exit: when every value in the current row already
 * exceeds the cap, no completion can come back under it. Candidate sets are small
 * after phonetic blocking, but this keeps the eval harness fast when running
 * hundreds of utterances against the full catalog in the baseline configuration.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let rowMinimum = current[0]

    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + substitutionCost, // substitution
      )
      if (current[j] < rowMinimum) rowMinimum = current[j]
    }

    if (rowMinimum > maxDistance) return maxDistance + 1

    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]
}

/** Edit distance mapped to a [0,1] similarity, so it composes with the other features. */
export function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

/**
 * Jaro-Winkler similarity, [0,1].
 *
 * Preferred over raw edit distance when comparing phonetic codes: it rewards
 * shared prefixes, and the leading consonant of a word is both the most
 * perceptually salient sound and the one recognizers get right most often.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const jaro = jaroSimilarity(a, b)
  if (jaro === 0) return 0

  let prefixLength = 0
  const maxPrefix = Math.min(4, a.length, b.length)
  while (prefixLength < maxPrefix && a[prefixLength] === b[prefixLength]) {
    prefixLength += 1
  }

  return jaro + prefixLength * prefixScale * (1 - jaro)
}

function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(i + matchWindow + 1, b.length)
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches += 1
      break
    }
  }

  if (matches === 0) return 0

  // Count transpositions: matched characters that appear in a different order.
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k += 1
    if (a[i] !== b[k]) transpositions += 1
    k += 1
  }

  const half = transpositions / 2
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3
}
