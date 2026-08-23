/**
 * Item resolution: spoken phrase -> catalog entry.
 *
 * Two-stage retrieval, the standard shape for search systems. A cheap
 * recall-oriented step narrows the catalog to a handful of candidates, then an
 * expensive precision-oriented step ranks them. Edit distance never runs across the
 * whole catalog.
 *
 *   stage 1  phonetic index lookup   O(1) hash    ~400 aliases -> ~20 candidates
 *   stage 2  linear scorer            ~20 scored
 *
 * Every stage is behind a config flag because none of them are assumed to help.
 * The ablation harness toggles them independently and reports per-slice accuracy;
 * anything that does not clear the pre-registered threshold gets removed. The
 * literature is explicit that phonetic matching *alone* produces excessive false
 * positives, which is why it is one feature in a scorer here and never the
 * decision rule.
 */

import { doubleMetaphone } from 'double-metaphone'

import { LEXICON, type LexiconEntry } from '../../data/catalog'
import type { SpeechHypothesis } from '../../ports/speech'
import type { Category } from '../types'
import { canonicalKey } from '../parser/normalize'
import { foldLongVowels } from '../../data/aliases'
import { jaroWinkler } from './distance'

/**
 * Feature weights for the linear reranker.
 *
 * A linear blend rather than a learned model: there is no training data, there are
 * four features, and the dev set is a few hundred examples. Anything richer would
 * overfit. It is also interpretable — every decision can be explained by printing
 * the per-term contributions, which matters for debugging and for the UI's
 * "did I get that right?" cue.
 *
 * Conceptually this is n-best reranking with features tuned by grid search, the
 * same family as MERT in statistical MT. Values are produced by
 * `scripts/tune-weights.ts` against the dev split — none of them are hand-set.
 */
export interface ScoringWeights {
  readonly asrConfidence: number
  readonly phonetic: number
  readonly catalogPrior: number
  readonly userPrior: number
}

/** Placeholder weights, overwritten by the tuning script's committed output. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  asrConfidence: 0.25,
  phonetic: 0.5,
  catalogPrior: 0.15,
  userPrior: 0.1,
}

export interface ResolverConfig {
  /** Levenshtein/Jaro fallback over raw spellings. Ablation config B. */
  readonly useFuzzy: boolean
  /** Double Metaphone candidate generation. Ablation config C. */
  readonly usePhonetic: boolean
  /** Score every ASR hypothesis, not just rank 0. Ablation config D. */
  readonly useNBest: boolean
  readonly weights: ScoringWeights
  /** Below this score, resolution is treated as failed. */
  readonly minScore: number
  /**
   * Jaro-Winkler similarity a candidate must clear to enter fuzzy matching.
   *
   * Swept by `scripts/tune-threshold.ts` against a pre-registered objective
   * rather than chosen by feel. It matters more than it looks: the catalog holds
   * ~2.5k items, so a loose threshold finds a spurious neighbour for almost any
   * word — at 0.82 "opinion" matched onion and "light" matched light soy sauce.
   *
   * Selected value 0.90, from the observed separation between fuzzy matches that
   * are recoveries and ones that are mistakes:
   *
   *   REJECT   water -> wafer 0.893 | rap -> grape 0.867 | opinion -> onion 0.854
   *   ACCEPT   brede -> bread 0.907 | panner -> paneer 0.922 | tomatoe -> tomato 0.971
   *
   * 0.90 is the boundary between those two groups. `resolver.threshold.test.ts`
   * pins both sides, so a future change to the catalogue or the metric that
   * reopens the gap fails loudly.
   *
   * An earlier value of 0.84 came from a sweep on MASSIVE against a
   * false-positive bound. That sweep no longer discriminates: once unknown items
   * pass through, every high-precision rule fires whether or not resolution
   * succeeded, so fire rate stops responding to the threshold entirely. What the
   * threshold now governs is *which item* you get, and MASSIVE has no item-level
   * labels to score that against. Said plainly in scripts/tune-threshold.ts.
   *
   * Note that "dudh" -> "doodh" scores only 0.805 and is still resolved: long-vowel
   * folding makes it an exact hit, so it never reaches the fuzzy path.
   */
  readonly fuzzyThreshold: number
}

export const BASELINE_CONFIG: ResolverConfig = {
  fuzzyThreshold: 0.9,
  useFuzzy: false,
  usePhonetic: false,
  useNBest: false,
  weights: DEFAULT_WEIGHTS,
  minScore: 0.35,
}

/**
 * Shipping configuration.
 *
 * `usePhonetic` is OFF by design, not by oversight. Measured over MASSIVE en-US
 * it buys +0.5pp recall for +0.1pp false positives — and because MASSIVE is
 * written text it contains no acoustic errors at all, so the benchmark can
 * measure phonetic matching's cost but structurally cannot measure its benefit.
 * Shipping a component whose upside is unmeasurable and whose downside is
 * measured is a bad trade. The implementation stays so the ablation row remains
 * reproducible; see the ablation table in the README.
 */
export const DEFAULT_CONFIG: ResolverConfig = {
  fuzzyThreshold: 0.9,
  useFuzzy: true,
  usePhonetic: false,
  useNBest: true,
  weights: DEFAULT_WEIGHTS,
  minScore: 0.35,
}

/** Every stage enabled. Used by the ablation harness, not by the app. */
export const FULL_CONFIG: ResolverConfig = {
  fuzzyThreshold: 0.9,
  useFuzzy: true,
  usePhonetic: true,
  useNBest: true,
  weights: DEFAULT_WEIGHTS,
  minScore: 0.35,
}

export type ResolutionStage = 'exact' | 'phonetic' | 'fuzzy'

export interface Resolution {
  readonly canonicalId: string
  readonly name: string
  readonly category: Category
  /** Winning score [0,1]. */
  readonly score: number
  /** Runner-up score, so callers can escalate on a narrow margin. */
  readonly runnerUpScore: number
  /** Which retrieval stage produced the winner; reported by the ablation harness. */
  readonly stage: ResolutionStage
  /** The transcript that won, which may not be the recognizer's top hypothesis. */
  readonly sourceTranscript: string
  /** Per-feature contributions, for debugging and explainability. */
  readonly features: Readonly<Record<keyof ScoringWeights, number>>
}

/**
 * Phonetic key for a phrase.
 *
 * Double Metaphone operates on single words, so multi-word aliases are encoded
 * word by word and rejoined. Codes drop most vowels and collapse consonants into
 * equivalence classes, which is what lets "tomorrow toes" land near "tomatoes"
 * while keeping "milk" and "silk" apart — they differ in the leading consonant,
 * the position recognizers get right most often.
 */
export function phoneticCode(phrase: string): string {
  return phrase
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => doubleMetaphone(word)[0])
    .join(' ')
}

interface IndexedAlias {
  readonly alias: string
  readonly key: string
  readonly code: string
  readonly entry: LexiconEntry
}

export interface ResolveOptions {
  /** Recognizer confidence for the transcript being resolved, [0,1]. */
  readonly asrConfidence?: number
  /** Rank in the n-best list; used when `asrConfidence` is an unreliable 0. */
  readonly rank?: number
  /** How often this user has bought each item, keyed by canonicalId. */
  readonly userHistory?: ReadonlyMap<string, number>
}

export class ItemResolver {
  private readonly aliases: IndexedAlias[] = []
  private readonly exactIndex = new Map<string, IndexedAlias[]>()
  private readonly phoneticIndex = new Map<string, IndexedAlias[]>()

  private readonly config: ResolverConfig

  constructor(
    config: ResolverConfig = FULL_CONFIG,
    lexicon: readonly LexiconEntry[] = LEXICON,
  ) {
    this.config = config
    for (const entry of lexicon) {
      for (const alias of entry.aliases) {
        const key = canonicalKey(alias)
        const indexed: IndexedAlias = { alias, key, code: phoneticCode(key), entry }
        this.aliases.push(indexed)
        push(this.exactIndex, key, indexed)
        push(this.phoneticIndex, indexed.code, indexed)
      }
    }
  }

  /**
   * Resolve a single phrase.
   * Returns null when nothing clears `minScore`, which callers treat as a signal
   * to escalate rather than as an error.
   */
  resolve(phrase: string, options: ResolveOptions = {}): Resolution | null {
    const key = canonicalKey(phrase)
    if (key === '') return null

    // Try the literal key first, then the vowel-folded form: "doodh" from a
    // Devanagari transliteration and "dudh" as typed both reach one entry.
    const exact = this.exactIndex.get(key) ?? this.exactIndex.get(foldLongVowels(key))
    if (exact !== undefined && exact.length > 0) {
      // An exact alias hit needs no scoring; nothing can beat it.
      return this.toResolution(exact[0], 1, 0, 'exact', phrase, options, 1)
    }

    const { candidates, stage } = this.generateCandidates(key)
    if (candidates.length === 0) return null

    const scored = candidates
      .map((candidate) => ({ candidate, ...this.score(candidate, key, options) }))
      .sort((a, b) => b.total - a.total)

    const best = scored[0]
    if (best === undefined || best.total < this.config.minScore) return null

    return this.toResolution(
      best.candidate,
      best.total,
      scored[1]?.total ?? 0,
      stage,
      phrase,
      options,
      best.total,
      best.features,
    )
  }

  /**
   * Resolve across the recognizer's full n-best list.
   *
   * Recognizers return several hypotheses with confidences, and almost every
   * implementation reads `results[0][0]` and discards the rest. Scoring all of them
   * against the catalog lets a lower-ranked hypothesis win when it is the one that
   * actually names a real product — the "tomorrow toes" / "tomatoes" case.
   */
  resolveBest(
    hypotheses: readonly SpeechHypothesis[],
    options: ResolveOptions = {},
  ): Resolution | null {
    const considered = this.config.useNBest ? hypotheses : hypotheses.slice(0, 1)

    let best: Resolution | null = null
    let runnerUp = 0

    for (const hypothesis of considered) {
      const resolution = this.resolve(hypothesis.transcript, {
        ...options,
        asrConfidence: hypothesis.confidence,
        rank: hypothesis.rank,
      })
      if (resolution === null) continue

      if (best === null || resolution.score > best.score) {
        runnerUp = Math.max(runnerUp, best?.score ?? resolution.runnerUpScore)
        best = resolution
      } else {
        runnerUp = Math.max(runnerUp, resolution.score)
      }
    }

    if (best === null) return null
    return { ...best, runnerUpScore: Math.max(best.runnerUpScore, runnerUp) }
  }

  private generateCandidates(key: string): { candidates: IndexedAlias[]; stage: ResolutionStage } {
    if (this.config.usePhonetic) {
      const code = phoneticCode(key)

      // Exact code match only. An earlier version fell back to scanning every
      // alias for jaroWinkler(code) > 0.8, which measured catastrophically:
      // Double Metaphone codes are 3-5 characters and Jaro-Winkler on strings
      // that short matches nearly anything, so "coldplay" resolved to eggs and
      // "alarm" to potato. That is the false-positive explosion the ASR-correction
      // literature warns about when phonetics is used as a decision rule rather
      // than as one feature. Blocking must be exact; ranking happens downstream.
      const exactCode = this.phoneticIndex.get(code)
      if (exactCode !== undefined && exactCode.length > 0) {
        return { candidates: exactCode, stage: 'phonetic' }
      }
    }

    if (this.config.useFuzzy) {
      const near = this.aliases.filter((a) => jaroWinkler(a.key, key) > this.config.fuzzyThreshold)
      if (near.length > 0) return { candidates: near, stage: 'fuzzy' }
    }

    return { candidates: [], stage: 'exact' }
  }

  /**
   * Linear scorer. All features are normalised to [0,1] and oriented so that
   * higher is better, otherwise the weights would not be comparable to each other.
   */
  private score(
    candidate: IndexedAlias,
    key: string,
    options: ResolveOptions,
  ): { total: number; features: Record<keyof ScoringWeights, number> } {
    const { weights } = this.config

    // Chrome reports 0 confidence for interim results and sometimes for finals, so
    // a 0 here means "unknown" rather than "certainly wrong". Fall back to the
    // hypothesis rank, which is always meaningful.
    const reported = options.asrConfidence ?? 0
    const asrConfidence = reported > 0 ? reported : 1 / ((options.rank ?? 0) + 1)

    const phonetic = this.config.usePhonetic
      ? jaroWinkler(candidate.code, phoneticCode(key))
      : jaroWinkler(candidate.key, key)

    const catalogPrior = candidate.entry.prior

    // Laplace-smoothed, so an item the user has never bought scores low rather
    // than zero — absence of evidence should not be a hard veto.
    const historyCount = options.userHistory?.get(candidate.entry.canonicalId) ?? 0
    const historyTotal = options.userHistory?.size ?? 0
    const userPrior = (historyCount + 1) / (historyTotal + this.aliases.length)

    const features = { asrConfidence, phonetic, catalogPrior, userPrior }
    const total =
      weights.asrConfidence * asrConfidence +
      weights.phonetic * phonetic +
      weights.catalogPrior * catalogPrior +
      weights.userPrior * userPrior

    const weightSum =
      weights.asrConfidence + weights.phonetic + weights.catalogPrior + weights.userPrior

    return { total: weightSum === 0 ? 0 : total / weightSum, features }
  }

  private toResolution(
    candidate: IndexedAlias,
    score: number,
    runnerUpScore: number,
    stage: ResolutionStage,
    sourceTranscript: string,
    options: ResolveOptions,
    _total: number,
    features?: Record<keyof ScoringWeights, number>,
  ): Resolution {
    return {
      canonicalId: candidate.entry.canonicalId,
      name: candidate.entry.name,
      category: candidate.entry.category,
      score,
      runnerUpScore,
      stage,
      sourceTranscript,
      features: features ?? {
        asrConfidence: options.asrConfidence ?? 1,
        phonetic: 1,
        catalogPrior: candidate.entry.prior,
        userPrior: 0,
      },
    }
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, [value])
  else existing.push(value)
}
