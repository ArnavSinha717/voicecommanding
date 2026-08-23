/**
 * Open Food Facts search, via the Search-a-licious API.
 *
 * Keyless, open data, and roughly 50ms in practice — it needs no proxy and no
 * account, which is why it is reachable directly from the browser.
 *
 * It knows brands and pack sizes the local catalog does not, and knows no prices
 * at all. Where a price is unknown this adapter leaves it undefined and the UI
 * says so; the alternative — inventing a plausible number — would be the single
 * most dishonest thing this app could do.
 */

import type { SearchQuery } from '../../domain/types'
import type { CatalogPort, Product, SearchOutcome } from '../../ports/catalog'

const ENDPOINT = 'https://search.openfoodfacts.org/search'
const FIELDS = 'code,product_name,brands,quantity'
const PAGE_SIZE = 12

/** Beyond this the user is better served by the local results already on screen. */
const TIMEOUT_MS = 4000

interface Hit {
  readonly code?: string
  readonly product_name?: string
  readonly brands?: readonly string[] | string
  readonly quantity?: string
}

function firstBrand(brands: Hit['brands']): string | undefined {
  if (Array.isArray(brands)) return brands[0]
  if (typeof brands === 'string' && brands !== '') return brands.split(',')[0]?.trim()
  return undefined
}

export class OpenFoodFactsAdapter implements CatalogPort {
  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchOutcome> {
    const terms = [query.text, ...(query.labels ?? [])].filter((term) => term !== '').join(' ')
    if (terms.trim() === '') return { products: [], degraded: false }

    const url = new URL(ENDPOINT)
    url.searchParams.set('q', terms)
    url.searchParams.set('page_size', String(PAGE_SIZE))
    url.searchParams.set('fields', FIELDS)

    // Own timeout, plus the caller's cancellation. A slow third party must never
    // hold the UI: local results are already rendered by the time this resolves.
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS)
    const composite = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])

    try {
      const response = await fetch(url, { signal: composite })
      if (!response.ok) return { products: [], degraded: true }

      const body = (await response.json()) as { hits?: readonly Hit[] }
      const products: Product[] = (body.hits ?? [])
        .filter((hit) => (hit.product_name ?? '') !== '')
        .map((hit) => ({
          id: `off:${hit.code ?? hit.product_name ?? ''}`,
          name: hit.product_name as string,
          brand: firstBrand(hit.brands),
          size: hit.quantity,
          // Deliberately no price: Open Food Facts does not carry one, and a
          // guess dressed as data is worse than an honest gap.
          source: 'openfoodfacts' as const,
        }))

      return { products, degraded: false }
    } catch {
      // Offline, blocked, timed out — all the same to the caller: local results
      // stand and the UI flags that breadth is missing.
      return { products: [], degraded: true }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Local results first, remote appended.
 *
 * Ordering is the point: the offline source is authoritative for anything it
 * knows, carries real prices, and cannot fail. Remote results widen the tail.
 */
export class CompositeCatalogAdapter implements CatalogPort {
  private readonly sources: readonly CatalogPort[]

  constructor(...sources: CatalogPort[]) {
    this.sources = sources
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchOutcome> {
    const outcomes = await Promise.all(this.sources.map((source) => source.search(query, signal)))

    const seen = new Set<string>()
    const products: Product[] = []
    for (const outcome of outcomes) {
      for (const product of outcome.products) {
        const key = product.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        products.push(product)
      }
    }

    return { products, degraded: outcomes.some((outcome) => outcome.degraded) }
  }
}
