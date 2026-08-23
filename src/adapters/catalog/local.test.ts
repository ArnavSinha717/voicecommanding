import { describe, expect, it } from 'vitest'

import type { SearchQuery } from '../../domain/types'
import { LocalCatalogAdapter, withinPrice } from './local'
import { CompositeCatalogAdapter } from './openfoodfacts'
import type { CatalogPort, Product, SearchOutcome } from '../../ports/catalog'

const local = new LocalCatalogAdapter()
const query = (text: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({ text, ...extra })

describe('local catalog search', () => {
  it('finds an item by name', async () => {
    const { products } = await local.search(query('milk'))
    expect(products.length).toBeGreaterThan(0)
    expect(products.some((p) => p.name.toLowerCase().includes('milk'))).toBe(true)
  })

  it('carries a real rupee price where the dataset has one', async () => {
    const { products } = await local.search(query('rice'))
    const priced = products.filter((p) => p.priceInr !== undefined)
    expect(priced.length).toBeGreaterThan(0)
    expect(priced.every((p) => (p.priceInr ?? 0) > 0)).toBe(true)
  })

  it('never needs the network', async () => {
    const { degraded } = await local.search(query('bread'))
    expect(degraded).toBe(false)
  })

  it('tolerates a misspelling', async () => {
    const { products } = await local.search(query('tomatoe'))
    expect(products.some((p) => p.name.toLowerCase().includes('tomato'))).toBe(true)
  })

  it('returns nothing for gibberish rather than forcing a match', async () => {
    const { products } = await local.search(query('zzqqxx'))
    expect(products).toHaveLength(0)
  })

  it('labels its results as local', async () => {
    const { products } = await local.search(query('milk'))
    expect(products.every((p) => p.source === 'local')).toBe(true)
  })
})

describe('price filtering', () => {
  it('excludes items above a spoken ceiling', async () => {
    const { products } = await local.search(query('oil', { maxPrice: 100 }))
    for (const product of products) {
      if (product.priceInr !== undefined) expect(product.priceInr).toBeLessThanOrEqual(100)
    }
  })

  it('keeps an item whose price is unknown', () => {
    // Dropping it would quietly assert the item falls outside the range, which
    // the data does not support. The UI marks the price unavailable instead.
    const unpriced: Product = { id: 'x', name: 'X', source: 'openfoodfacts' }
    expect(withinPrice(unpriced, query('x', { maxPrice: 5 }))).toBe(true)
  })

  it('applies a floor as well as a ceiling', () => {
    const product: Product = { id: 'x', name: 'X', priceInr: 50, source: 'local' }
    expect(withinPrice(product, query('x', { minPrice: 100 }))).toBe(false)
    expect(withinPrice(product, query('x', { minPrice: 10 }))).toBe(true)
  })
})

/** Stand-in for a remote source, so composition is testable without a network. */
class StubCatalog implements CatalogPort {
  private readonly outcome: SearchOutcome
  constructor(outcome: SearchOutcome) {
    this.outcome = outcome
  }
  search(): Promise<SearchOutcome> {
    return Promise.resolve(this.outcome)
  }
}

describe('composite catalog', () => {
  it('puts local results first, remote after', async () => {
    const remote = new StubCatalog({
      products: [{ id: 'off:1', name: 'Some Imported Thing', source: 'openfoodfacts' }],
      degraded: false,
    })
    const { products } = await new CompositeCatalogAdapter(local, remote).search(query('milk'))
    expect(products[0]?.source).toBe('local')
    expect(products.some((p) => p.source === 'openfoodfacts')).toBe(true)
  })

  it('deduplicates the same product name across sources', async () => {
    const remote = new StubCatalog({
      products: [{ id: 'off:1', name: 'Milk', source: 'openfoodfacts' }],
      degraded: false,
    })
    const { products } = await new CompositeCatalogAdapter(local, remote).search(query('milk'))
    const named = products.filter((p) => p.name.toLowerCase() === 'milk')
    expect(named).toHaveLength(1)
  })

  it('still returns local results when the remote source fails', async () => {
    const broken = new StubCatalog({ products: [], degraded: true })
    const { products, degraded } = await new CompositeCatalogAdapter(local, broken).search(query('milk'))
    expect(products.length).toBeGreaterThan(0)
    // Reported rather than hidden: a silently short list looks like no matches.
    expect(degraded).toBe(true)
  })
})
