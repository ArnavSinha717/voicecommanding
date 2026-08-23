/**
 * Product search port.
 *
 * Search is the one feature that genuinely wants the network — nobody's device
 * holds every brand and size — but it must not be the only path. The local
 * catalog answers instantly and offline; a remote source adds breadth when it is
 * reachable. Behind one interface, callers do not have to care which answered.
 */

import type { Category, SearchQuery } from '../domain/types'

export interface Product {
  readonly id: string
  readonly name: string
  readonly brand?: string
  readonly category?: Category
  /** Price in rupees, where the source knows one. Never invented. */
  readonly priceInr?: number
  /** Pack size as the source states it, e.g. "500 ml". */
  readonly size?: string
  /** Fraction off the marked price, where known. */
  readonly discount?: number
  /** Which adapter produced this, shown so a user can judge the result. */
  readonly source: 'local' | 'openfoodfacts'
}

export interface SearchOutcome {
  readonly products: readonly Product[]
  /**
   * True when a remote source was unreachable and only local results are shown.
   * Surfaced in the UI rather than silently returning a short list.
   */
  readonly degraded: boolean
}

export interface CatalogPort {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchOutcome>
}
