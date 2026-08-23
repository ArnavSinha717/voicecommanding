/**
 * The item catalog.
 *
 * Assembled from two sources with very different provenance:
 *
 *   catalog.generated.json   2,479 items derived from 27,555 real BigBasket SKUs
 *                            by scripts/build-catalog.ts. Names, categories,
 *                            frequency priors and rupee prices all trace back to
 *                            the dataset; none were typed by hand.
 *
 *   aliases.ts               romanised Hindi equivalences, hand-authored because
 *                            no public dataset provides them. Words only, no
 *                            numbers.
 *
 * Replaces an earlier hand-written lexicon of ~100 items whose `prior` values
 * were invented. That mattered in practice, not just in principle: those priors
 * fed the resolution scorer, so guessed numbers were silently deciding which
 * item a garbled transcript resolved to.
 */

import catalogData from './catalog.generated.json'
import type { Category } from '../domain/types'
import { MULTILINGUAL_ALIASES, foldLongVowels } from './aliases'

export interface LexiconEntry {
  readonly canonicalId: string
  readonly name: string
  readonly category: Category
  /** Spoken forms resolving to this entry: derived key plus any aliases. */
  readonly aliases: readonly string[]
  /** Derived from SKU count; see build-catalog.ts for the stated assumption. */
  readonly prior: number
  /** Median rupee price across this item's SKUs, or null where none had a price. */
  readonly medianPriceInr: number | null
  /** Median fraction off the marked price; 0 when the item is never discounted. */
  readonly discount: number
}

/**
 * Positional record: [canonicalId, key, name, category, prior, medianPriceInr, discount].
 * Field order is declared by `_fields` in the generated file and asserted by
 * catalog.test.ts, so a change to the generator cannot silently shift columns.
 */
type GeneratedItem = readonly [string, string, string, string, number, number | null, number]

const generated = catalogData as unknown as {
  _source: string
  _licence: string
  _fields: readonly string[]
  items: readonly GeneratedItem[]
}

export const CATALOG_FIELDS = generated._fields

/** Provenance, surfaced in the UI's about panel and the README. */
export const CATALOG_SOURCE = generated._source
export const CATALOG_LICENCE = generated._licence

export const LEXICON: readonly LexiconEntry[] = generated.items.map(
  ([canonicalId, key, name, category, prior, medianPriceInr, discount]) => {
    const forms = new Set<string>([key, ...(MULTILINGUAL_ALIASES[canonicalId] ?? [])])
    // Index the vowel-folded form too, so "doodh" and "dudh" both hit.
    for (const form of [...forms]) forms.add(foldLongVowels(form))
    return {
      canonicalId,
      name,
      category: category as Category,
      aliases: [...forms],
      prior,
      medianPriceInr,
      discount,
    }
  },
)

const BY_ID = new Map(LEXICON.map((entry) => [entry.canonicalId, entry]))

export function findByCanonicalId(canonicalId: string): LexiconEntry | undefined {
  return BY_ID.get(canonicalId)
}

/**
 * Aliases the derived catalog has no home for.
 *
 * A hand-authored alias is only useful if its target actually exists in the
 * generated data; a rename upstream would otherwise silently orphan it. Surfaced
 * by a test rather than left to rot.
 */
export function orphanedAliases(): string[] {
  return Object.keys(MULTILINGUAL_ALIASES).filter((id) => !BY_ID.has(id))
}
