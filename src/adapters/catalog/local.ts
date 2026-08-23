/**
 * Search over the derived local catalog.
 *
 * Instant, offline, and the only source here that knows a price in rupees —
 * BigBasket ships both marked and selling price, so `priceInr` and `discount`
 * are measured rather than estimated. This is the primary search path; the
 * remote adapter exists to add breadth, not to replace it.
 */

import { LEXICON, type LexiconEntry } from '../../data/catalog'
import { canonicalKey } from '../../domain/parser/normalize'
import { jaroWinkler } from '../../domain/resolve/distance'
import type { CatalogPort, Product, SearchOutcome } from '../../ports/catalog'
import type { SearchQuery } from '../../domain/types'

/** Matching floor for a search term. Looser than resolution: a search offers a
 * list for the user to choose from, so a near miss costs a glance, whereas a bad
 * resolution silently puts the wrong thing on the list. */
const SEARCH_SIMILARITY_FLOOR = 0.7

function toProduct(entry: LexiconEntry): Product {
  return {
    id: entry.canonicalId,
    name: entry.name,
    category: entry.category,
    priceInr: entry.medianPriceInr ?? undefined,
    discount: entry.discount > 0 ? entry.discount : undefined,
    source: 'local',
  }
}

function matches(entry: LexiconEntry, terms: readonly string[]): number {
  if (terms.length === 0) return entry.prior
  let best = 0
  for (const alias of entry.aliases) {
    for (const term of terms) {
      if (alias.includes(term)) {
        // A substring hit beats any fuzzy score: the user's word is literally
        // in the name.
        best = Math.max(best, 0.95)
        continue
      }
      best = Math.max(best, jaroWinkler(alias, term))
    }
  }
  return best
}

export class LocalCatalogAdapter implements CatalogPort {
  search(query: SearchQuery): Promise<SearchOutcome> {
    const terms = canonicalKey(query.text).split(' ').filter((term) => term !== '')

    const scored = LEXICON.map((entry) => ({ entry, score: matches(entry, terms) }))
      .filter(({ score }) => score >= SEARCH_SIMILARITY_FLOOR)
      // Break ties by how commonly the item is stocked, so a search for "oil"
      // leads with cooking oil rather than an obscure variant.
      .sort((a, b) => b.score - a.score || b.entry.prior - a.entry.prior)

    const products = scored
      .map(({ entry }) => toProduct(entry))
      .filter((product) => withinPrice(product, query))
      .slice(0, 12)

    return Promise.resolve({ products, degraded: false })
  }
}

/**
 * Apply a spoken price filter.
 *
 * An item whose price is unknown is kept rather than dropped: excluding it would
 * quietly assert it falls outside the range, which the data does not support.
 * The UI marks the price as unavailable instead.
 */
export function withinPrice(product: Product, query: SearchQuery): boolean {
  if (product.priceInr === undefined) return true
  if (query.maxPrice !== undefined && product.priceInr > query.maxPrice) return false
  if (query.minPrice !== undefined && product.priceInr < query.minPrice) return false
  return true
}
