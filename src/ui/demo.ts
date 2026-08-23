/**
 * Demo seed, enabled with ?demo.
 *
 * A reviewer opening a cold URL sees an empty list, which shows none of the
 * work: no categories, no quantities, no replenishment reasoning, nothing
 * checked off. The suggestion engine in particular has almost nothing to say
 * without history, so its most interesting output is invisible on first run.
 *
 * The seed is plausible rather than flattering — a part-finished shop, a couple
 * of things already in the trolley, and a purchase history old enough that
 * replenishment has a real reason to fire.
 *
 * Off by default, so the honest cold-start experience is still what a normal
 * visitor gets.
 */

import type { Item } from '../domain/types'
import type { PersistedState } from '../ports/storage'

const DAY = 86_400_000

interface Seed {
  readonly canonicalId: string
  readonly name: string
  readonly category: Item['category']
  readonly quantity: Item['quantity']
  readonly checked: boolean
}

const SEED_ITEMS: readonly Seed[] = [
  { canonicalId: 'milk', name: 'Milk', category: 'dairy', quantity: { value: 2, unit: 'l' }, checked: false },
  { canonicalId: 'paneer', name: 'Paneer', category: 'dairy', quantity: { value: 500, unit: 'g' }, checked: true },
  { canonicalId: 'tomato', name: 'Tomatoes', category: 'produce', quantity: { value: 6, unit: 'piece' }, checked: false },
  { canonicalId: 'coriander', name: 'Coriander', category: 'produce', quantity: { value: 1, unit: 'piece' }, checked: true },
  { canonicalId: 'bread', name: 'Bread', category: 'bakery', quantity: { value: 1, unit: 'piece' }, checked: false },
  { canonicalId: 'atta', name: 'Atta', category: 'pantry', quantity: { value: 5, unit: 'kg' }, checked: false },
  { canonicalId: 'chai', name: 'Chai', category: 'beverages', quantity: { value: 1, unit: 'pack' }, checked: false },
]

export function demoState(now: number): PersistedState {
  const items: Item[] = SEED_ITEMS.map((seed, index) => ({
    id: `demo-${index}`,
    name: seed.name,
    canonicalId: seed.canonicalId,
    quantity: seed.quantity,
    category: seed.category,
    checked: seed.checked,
    addedAt: now - index * 60_000,
    source: index % 3 === 0 ? 'voice' : 'text',
    confidence: 1,
  }))

  // Spaced so the posterior lands near a real cadence and the gap since the last
  // purchase is long enough for the item to read as genuinely due.
  const history: Record<string, number[]> = {
    curd: [now - 26 * DAY, now - 19 * DAY, now - 12 * DAY],
    egg: [now - 31 * DAY, now - 22 * DAY, now - 14 * DAY],
    onion: [now - 40 * DAY, now - 26 * DAY, now - 13 * DAY],
  }

  return { items, history, language: 'en-IN', schemaVersion: 1 }
}

export function demoRequested(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('demo')
}
