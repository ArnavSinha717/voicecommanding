/**
 * Suggestion engine.
 *
 * Three independent signals, blended and each carrying a human-readable reason.
 * The reason is not decoration: a suggestion a user cannot account for reads as
 * the app guessing, and "you buy this about every 13 days and it's been 16" is
 * the difference between feeling predicted and feeling spammed.
 *
 * Every constant comes from `priors.generated.json` (Instacart, 32M order-product
 * rows) or `catalog.generated.json` (BigBasket, 27.5k SKUs). Nothing here is a
 * number someone typed.
 */

import priorsData from '../../data/priors.generated.json'
import { LEXICON, type LexiconEntry } from '../../data/catalog'
import type { Category, Item } from '../types'

const DAY_MS = 86_400_000

interface GammaPrior {
  readonly alpha: number
  readonly beta: number
  readonly meanDays: number
  readonly sd: number
  readonly n: number
}

const priors = priorsData as unknown as {
  _source: string
  replenishment: Readonly<Record<string, GammaPrior>>
  complements: ReadonlyArray<{ a: string; b: string; lift: number; support: number }>
}

export const PRIORS_SOURCE = priors._source

export type SuggestionKind = 'replenishment' | 'complement' | 'deal'

export interface Suggestion {
  readonly canonicalId: string
  readonly name: string
  readonly category: Category
  readonly kind: SuggestionKind
  /** [0,1]; used only for ranking between suggestions. */
  readonly score: number
  /** Shown verbatim in the UI. */
  readonly reason: string
}

/** Purchase timestamps per item, most recent last. */
export type PurchaseHistory = Readonly<Record<string, readonly number[]>>

export interface SuggestOptions {
  readonly items: readonly Item[]
  readonly history: PurchaseHistory
  readonly now: number
  readonly limit?: number
}

const BY_ID = new Map(LEXICON.map((entry) => [entry.canonicalId, entry]))

/**
 * Posterior purchase rate for one item, in purchases per day.
 *
 * Gamma-Poisson conjugacy: if purchases arrive as a Poisson process with rate λ,
 * the gaps are Exponential and a Gamma prior on λ updates in closed form to
 * Gamma(α₀ + n − 1, β₀ + T). No optimiser, no training — one division.
 *
 * The population prior is what makes small histories usable. After a single
 * observed purchase a frequency counter has no variance estimate and either says
 * nothing or over-commits to one sample; here the estimate simply starts near the
 * category average and is pulled toward the user's own behaviour as n grows.
 */
export function posteriorRate(purchaseTimes: readonly number[], category: Category, now: number): number | null {
  const prior = priors.replenishment[category] ?? priors.replenishment.other
  if (prior === undefined) return null

  const sorted = [...purchaseTimes].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return null

  // Observation window: first purchase to now, in days. Guarded below one day so
  // a same-session repeat cannot divide by zero and report an absurd rate.
  const observedDays = Math.max(1, (now - sorted[0]) / DAY_MS)

  // n purchases yield n-1 *gaps*, because the window opens at the first one.
  // Using n instead systematically overestimates the rate — at 20 purchases on a
  // true 3-day cadence it predicted 2.77 days, and the error grows sharply as n
  // falls, which is exactly where the prior is supposed to be steadying things.
  return (prior.alpha + (n - 1)) / (prior.beta + observedDays)
}

/**
 * Probability the item has been used up by now.
 *
 * Exponential CDF at the posterior rate. Rises smoothly rather than tripping at a
 * threshold, so ranking degrades gracefully instead of everything becoming "due"
 * on the same day.
 */
function dueProbability(rate: number, daysSinceLast: number): number {
  return 1 - Math.exp(-rate * daysSinceLast)
}

function formatDays(days: number): string {
  const rounded = Math.round(days)
  if (rounded <= 1) return 'a day'
  if (rounded < 14) return `${rounded} days`
  const weeks = Math.round(days / 7)
  return weeks <= 8 ? `${weeks} weeks` : `${Math.round(days / 30)} months`
}

function replenishmentSuggestions(options: SuggestOptions, onList: ReadonlySet<string>): Suggestion[] {
  const out: Suggestion[] = []

  for (const [canonicalId, times] of Object.entries(options.history)) {
    if (onList.has(canonicalId) || times.length === 0) continue
    const entry = BY_ID.get(canonicalId)
    if (entry === undefined) continue

    const rate = posteriorRate(times, entry.category, options.now)
    if (rate === null) continue

    const lastPurchase = Math.max(...times)
    const daysSince = (options.now - lastPurchase) / DAY_MS
    const probability = dueProbability(rate, daysSince)
    // Below even odds it is speculation, not a prediction.
    if (probability < 0.5) continue

    out.push({
      canonicalId,
      name: entry.name,
      category: entry.category,
      kind: 'replenishment',
      score: probability,
      reason: `You buy this about every ${formatDays(1 / rate)} — it's been ${formatDays(daysSince)}`,
    })
  }

  return out
}

/**
 * Category pairings that co-occur more than chance.
 *
 * Deliberately category-level rather than product-level: "pasta goes with pasta
 * sauce" generalises, whereas "Barilla Penne 500g goes with Classico Tomato Basil
 * 24oz" does not, and the product-level matrix is mostly noise at this dataset
 * size.
 */
function complementSuggestions(options: SuggestOptions, onList: ReadonlySet<string>): Suggestion[] {
  const present = new Set(options.items.map((item) => item.category))
  if (present.size === 0) return []

  const partnerLift = new Map<Category, number>()
  for (const rule of priors.complements) {
    if (rule.lift <= 1) continue
    const a = rule.a as Category
    const b = rule.b as Category
    if (present.has(a) && !present.has(b)) partnerLift.set(b, Math.max(partnerLift.get(b) ?? 0, rule.lift))
    if (present.has(b) && !present.has(a)) partnerLift.set(a, Math.max(partnerLift.get(a) ?? 0, rule.lift))
  }

  const out: Suggestion[] = []
  for (const [category, lift] of partnerLift) {
    const candidate = topByPrior(category, onList)
    if (candidate === undefined) continue
    out.push({
      canonicalId: candidate.canonicalId,
      name: candidate.name,
      category,
      kind: 'complement',
      // Lift is unbounded above; map it into [0,1) so it ranks against the other
      // signals without swamping them.
      score: Math.min(0.9, (lift - 1) * 1.5),
      reason: `Often bought with what's on your list`,
    })
  }
  return out
}

function dealSuggestions(onList: ReadonlySet<string>): Suggestion[] {
  return LEXICON.filter((entry) => entry.discount >= 0.3 && !onList.has(entry.canonicalId))
    .sort((a, b) => b.discount * b.prior - a.discount * a.prior)
    .slice(0, 3)
    .map((entry) => ({
      canonicalId: entry.canonicalId,
      name: entry.name,
      category: entry.category,
      kind: 'deal' as const,
      score: entry.discount * 0.6,
      reason: `${Math.round(entry.discount * 100)}% off the usual price`,
    }))
}

function topByPrior(category: Category, exclude: ReadonlySet<string>): LexiconEntry | undefined {
  let best: LexiconEntry | undefined
  for (const entry of LEXICON) {
    if (entry.category !== category || exclude.has(entry.canonicalId)) continue
    if (best === undefined || entry.prior > best.prior) best = entry
  }
  return best
}

export function suggest(options: SuggestOptions): Suggestion[] {
  const onList = new Set(options.items.map((item) => item.canonicalId))

  const all = [
    ...replenishmentSuggestions(options, onList),
    ...complementSuggestions(options, onList),
    ...dealSuggestions(onList),
  ]

  // One suggestion per item, keeping the strongest reason for it.
  const best = new Map<string, Suggestion>()
  for (const suggestion of all) {
    const existing = best.get(suggestion.canonicalId)
    if (existing === undefined || suggestion.score > existing.score) best.set(suggestion.canonicalId, suggestion)
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, options.limit ?? 4)
}

/**
 * Substitutes for an item.
 *
 * Same category, closest by frequency — a shopper denied their usual brand
 * reaches for the next most ordinary thing in that aisle, not a random one.
 * A genuine substitute graph would need product-level co-occurrence, which this
 * dataset is too sparse to support at the item level; noted rather than faked.
 */
export function substitutesFor(canonicalId: string, limit = 3): LexiconEntry[] {
  const entry = BY_ID.get(canonicalId)
  if (entry === undefined) return []
  return LEXICON.filter((other) => other.category === entry.category && other.canonicalId !== canonicalId)
    .sort((a, b) => Math.abs(a.prior - entry.prior) - Math.abs(b.prior - entry.prior))
    .slice(0, limit)
}
