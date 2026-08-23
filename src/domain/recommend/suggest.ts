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
  /** head -> share of purchases that were repeat purchases, from 32M rows. */
  reorderRates: ReadonlyArray<{ head: string; rate: number; purchases: number }>
}

/**
 * How often someone who buys an item buys it again.
 *
 * The only behavioural signal available to a shopper with no history of their
 * own. It sanity-checks well at both ends: whole wheat bread is rebought 72.9%
 * of the time across 107k purchases, birthday candles 4.3%.
 */
const REORDER = new Map(priors.reorderRates.map((entry) => [entry.head, entry]))

export const PRIORS_SOURCE = priors._source

export type SuggestionKind = 'replenishment' | 'staple'

export interface Suggestion {
  readonly canonicalId: string
  readonly name: string
  readonly category: Category
  readonly kind: SuggestionKind
  /** [0,1]; used only for ranking between suggestions. */
  readonly score: number
  /** Shown verbatim in the UI. */
  readonly reason: string
  /**
   * The evidence behind a replenishment suggestion, so the interface can draw
   * the model rather than only quote it.
   *
   * A sentence — "you buy this about every 9 days, it's been 12" — has to be
   * read and held in mind before it means anything. A bar past a marker is
   * grasped at a glance, and it is the same number either way. Absent for
   * deals, which have no cycle.
   */
  readonly cycle?: {
    /** Posterior mean interval between purchases, in days. */
    readonly expectedDays: number
    readonly daysSince: number
    /** Probability the item is used up by now, [0,1]. */
    readonly due: number
  }
  /** What the shopper usually buys, so the row can offer that rather than "1". */
  readonly usualQuantity?: { readonly value: number; readonly unit: string }
  /** Rupee price where the catalogue knows one. */
  readonly priceInr?: number
  /**
   * Share of purchases of this item that were repeat purchases, [0,1].
   *
   * Present on staple suggestions, which is what they are ranked by.
   */
  readonly reorderRate?: number
  /**
   * A catalogue property, NOT a live offer.
   *
   * BigBasket's marked price against its selling price, from a static 2020
   * snapshot. It is shown as a secondary badge and never as the reason a thing
   * is being suggested — an earlier version led with "51% off the usual price",
   * which reads as a promotion happening right now and is identical for every
   * user. That is a catalogue filter dressed as a recommendation.
   */
  readonly usuallyDiscounted?: number
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
      reason: `Usually every ${formatDays(1 / rate)} · last bought ${formatDays(daysSince)} ago`,
      cycle: {
        expectedDays: Number((1 / rate).toFixed(1)),
        daysSince: Number(daysSince.toFixed(1)),
        due: Number(probability.toFixed(3)),
      },
      priceInr: entry.medianPriceInr ?? undefined,
    })
  }

  return out
}

/*
 * COMPLEMENT SUGGESTIONS WERE REMOVED.
 *
 * Instacart gives reliable *category* co-occurrence — dairy and meat appear
 * together with lift 1.17 across 45,824 baskets. The signal is real. The leap
 * from it to a specific product is not, and the output was indefensible: buying
 * milk suggested pork, because pork carried the highest SKU count in the meat
 * category. Nothing in the data connects those two items; only their categories.
 *
 * A usable complement needs product-level co-occurrence — "pasta goes with pasta
 * sauce" — and at this dataset's density the item-level matrix is almost entirely
 * noise. Deriving it properly is the obvious next step and is noted in the README
 * as an acknowledged gap.
 *
 * Replenishment and staples remain: both make claims the data supports.
 */

/**
 * Categories a grocery list is actually about.
 *
 * Staples fill the gap for a shopper with no history, so they are the first
 * thing anyone sees. Food is weighted ahead of the rest — soap and toothpaste
 * belong on a shopping list too, just not above the bread.
 */
const FOOD_CATEGORIES = new Set<Category>([
  'produce', 'dairy', 'bakery', 'meat', 'pantry', 'frozen', 'beverages', 'snacks',
])

/** Below this, an item is an occasional purchase rather than something restocked. */
const STAPLE_FLOOR = 0.45

/**
 * Items most people buy again, that this shopper does not have.
 *
 * Replaces a "deals" list built from catalogue discounts. Those were real
 * dataset fields but made a false claim: a static price snapshot presented as a
 * live offer, identical for every visitor, with nothing about the shopper in it.
 * A reorder rate is a statement about behaviour — 32M purchase decisions — and
 * it is checkable.
 */
function stapleSuggestions(options: SuggestOptions, onList: ReadonlySet<string>): Suggestion[] {
  // Bias toward aisles this shopper is already buying from, so the list reads as
  // related to what they are doing rather than as a generic top-sellers rail.
  const present = new Set(options.items.map((item) => item.category))

  return LEXICON.filter((entry) => {
    if (onList.has(entry.canonicalId)) return false
    const reorder = REORDER.get(entry.canonicalId.replace(/-/g, ' '))
    return reorder !== undefined && reorder.rate >= STAPLE_FLOOR
  })
    .map((entry) => {
      const reorder = REORDER.get(entry.canonicalId.replace(/-/g, ' '))!
      const relevance = present.size === 0 || present.has(entry.category) ? 1 : 0.6
      const food = FOOD_CATEGORIES.has(entry.category) ? 1 : 0.45
      return { entry, reorder, weight: reorder.rate * entry.prior * relevance * food }
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map(({ entry, reorder }) => ({
      canonicalId: entry.canonicalId,
      name: entry.name,
      category: entry.category,
      kind: 'staple' as const,
      score: reorder.rate * 0.7,
      reason: `${Math.round(reorder.rate * 100)}% of shoppers buy this again`,
      reorderRate: reorder.rate,
      priceInr: entry.medianPriceInr ?? undefined,
      usuallyDiscounted: entry.discount > 0.15 ? entry.discount : undefined,
    }))
}

export function suggest(options: SuggestOptions): Suggestion[] {
  const onList = new Set(options.items.map((item) => item.canonicalId))

  const all = [...replenishmentSuggestions(options, onList), ...stapleSuggestions(options, onList)]

  // One suggestion per item, keeping the strongest reason for it.
  const best = new Map<string, Suggestion>()
  for (const suggestion of all) {
    const existing = best.get(suggestion.canonicalId)
    if (existing === undefined || suggestion.score > existing.score) best.set(suggestion.canonicalId, suggestion)
  }

  /*
   * Balanced rather than purely ranked.
   *
   * Replenishment and staples answer different questions — "what am I about to
   * run out of" and "what do people like me keep buying" — and a single sorted
   * list lets one bury the other. Each kind keeps a guaranteed share, and
   * whichever has more to say fills the remainder.
   */
  const limit = options.limit ?? 6
  const ranked = [...best.values()].sort((a, b) => b.score - a.score)
  const overdue = ranked.filter((s) => s.kind === 'replenishment')
  const staples = ranked.filter((s) => s.kind === 'staple')

  const reserved = Math.min(2, staples.length)
  const picked = [...overdue.slice(0, limit - reserved), ...staples.slice(0, reserved)]
  for (const suggestion of ranked) {
    if (picked.length >= limit) break
    if (!picked.includes(suggestion)) picked.push(suggestion)
  }
  return picked.slice(0, limit)
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
