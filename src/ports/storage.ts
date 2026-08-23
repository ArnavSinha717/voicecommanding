/**
 * Persistence port.
 *
 * The list is local-first: it lives on the device and works with no network and
 * no account. Keeping storage behind an interface means the domain never learns
 * whether it is talking to localStorage, IndexedDB or a sync backend, and tests
 * get an in-memory implementation for free.
 */

import type { Item } from '../domain/types'

export interface PersistedState {
  readonly items: readonly Item[]
  /** Purchase timestamps by canonicalId, feeding replenishment suggestions. */
  readonly history: Readonly<Record<string, readonly number[]>>
  readonly language: string
  readonly schemaVersion: number
}

export interface StoragePort {
  load(): PersistedState | null
  save(state: PersistedState): void
  clear(): void
}
