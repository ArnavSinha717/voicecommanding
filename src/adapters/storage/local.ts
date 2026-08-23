/**
 * localStorage-backed persistence.
 *
 * Every access is wrapped: storage throws outright in private-mode Safari and in
 * browsers configured to block site data, and a shopping list failing to open
 * because of a quota error would be a worse bug than losing the list.
 */

import type { PersistedState, StoragePort } from '../../ports/storage'

const KEY = 'voice-shopping-list/v1'
const SCHEMA_VERSION = 1

export class LocalStorageAdapter implements StoragePort {
  load(): PersistedState | null {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw === null) return null
      const parsed = JSON.parse(raw) as PersistedState
      // A payload from a future or unknown schema is discarded rather than
      // coerced: a wrong-shaped list renders worse than an empty one.
      if (parsed.schemaVersion !== SCHEMA_VERSION) return null
      return parsed
    } catch {
      return null
    }
  }

  save(state: PersistedState): void {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }))
    } catch {
      // Quota exceeded or storage disabled. The in-memory list stays usable.
    }
  }

  clear(): void {
    try {
      window.localStorage.removeItem(KEY)
    } catch {
      /* nothing to do */
    }
  }
}

/** Used in tests and wherever persistence must not leak between cases. */
export class MemoryStorageAdapter implements StoragePort {
  private state: PersistedState | null = null
  load(): PersistedState | null {
    return this.state
  }
  save(state: PersistedState): void {
    this.state = state
  }
  clear(): void {
    this.state = null
  }
}
