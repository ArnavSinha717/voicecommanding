/**
 * List state reducer.
 *
 * A pure function of (state, command) with no React, no storage and no clock of
 * its own — `now` is passed in. Every behaviour the product has can therefore be
 * tested by applying commands to a value and inspecting the result, with no
 * rendering and no microphone.
 */

import type { Command, Item, Target } from '../types'
import { canMerge, formatQuantity, merge } from '../units'
import type { DialogueState } from '../parser/parse'
import { EMPTY_DIALOGUE } from '../parser/parse'

/**
 * One applied command, with the rows as they stood before it.
 *
 * The log records what happened; undo restores the snapshot. An earlier design
 * had undo replay an *inverse command*, which is more elegant and was wrong: a
 * property test found that checking an item off, removing it, and undoing
 * brought it back unchecked. `remove`'s inverse was an `add`, and adding creates
 * a fresh row — so any operation touching more than one field silently lost the
 * others. The same flaw affected merges, which reset `checked` alongside the
 * quantity.
 *
 * A snapshot cannot have that class of bug. The cost is one array copy per
 * mutation, which for a shopping list is nothing, and the command log is still
 * kept intact — it is what makes scenarios replayable and would carry a
 * multi-device merge.
 */
export interface HistoryEntry {
  readonly command: Command
  readonly at: number
  readonly description: string
  /** Items exactly as they were before this command applied. */
  readonly previousItems: readonly Item[]
}

export interface ListState {
  readonly items: readonly Item[]
  /** Incremented on every mutation; commands carry the version they were parsed against. */
  readonly version: number
  readonly history: readonly HistoryEntry[]
  readonly dialogue: DialogueState
}

export const EMPTY_STATE: ListState = {
  items: [],
  version: 0,
  history: [],
  dialogue: EMPTY_DIALOGUE,
}

/**
 * Something the UI should surface. Returned rather than performed, so the reducer
 * stays pure and the messages are assertable in tests.
 */
export type Effect =
  | { readonly kind: 'announce'; readonly message: string }
  /** The command was understood but could not be applied; ask rather than fail. */
  | { readonly kind: 'clarify'; readonly message: string }
  | { readonly kind: 'search'; readonly command: Extract<Command, { kind: 'search' }> }

export interface ApplyResult {
  readonly state: ListState
  readonly effects: readonly Effect[]
}

export interface ApplyOptions {
  readonly now: number
  /** Injected so ids are deterministic in tests. */
  readonly generateId: () => string
}

/**
 * Resolve a command's target against *current* state.
 *
 * Roughly 800ms elapses between someone speaking and a parsed command arriving,
 * and they may have tapped the item away in the meantime. The version recorded at
 * parse time is a hint that the world may have moved, not a hard precondition —
 * so a stale version triggers re-resolution rather than rejection, and only a
 * genuine miss becomes a clarification. This is optimistic concurrency control:
 * assume no conflict, detect at commit, reconcile explicitly.
 */
function resolveTarget(state: ListState, target: Target): Item | null {
  return state.items.find((item) => item.canonicalId === target.canonicalId) ?? null
}

export function applyCommand(
  state: ListState,
  command: Command,
  options: ApplyOptions,
): ApplyResult {
  switch (command.kind) {
    case 'add':
      return applyAdd(state, command, options)

    case 'remove': {
      const item = resolveTarget(state, command.target)
      if (item === null) return missing(state, command.target)
      return commit(
        state,
        { ...state, items: state.items.filter((i) => i.id !== item.id) },
        command,
        `Removed ${item.name}`,
        item.canonicalId,
        item.name,
        options,
      )
    }

    case 'setQuantity': {
      const item = resolveTarget(state, command.target)
      if (item === null) return missing(state, command.target)
      return commit(
        state,
        { ...state, items: replace(state.items, item.id, { ...item, quantity: command.quantity }) },
        command,
        `${item.name} set to ${formatQuantity(command.quantity)}`,
        item.canonicalId,
        item.name,
        options,
      )
    }

    case 'check':
    case 'uncheck': {
      const item = resolveTarget(state, command.target)
      if (item === null) return missing(state, command.target)
      const checked = command.kind === 'check'
      if (item.checked === checked) {
        return { state, effects: [{ kind: 'announce', message: `${item.name} is already ${checked ? 'checked off' : 'on the list'}` }] }
      }
      return commit(
        state,
        { ...state, items: replace(state.items, item.id, { ...item, checked }) },
        command,
        `${item.name} ${checked ? 'checked off' : 'back on the list'}`,
        item.canonicalId,
        item.name,
        options,
      )
    }

    case 'clear': {
      if (state.items.length === 0) {
        return { state, effects: [{ kind: 'announce', message: 'Your list is already empty' }] }
      }
      const cleared = state.items
      return commit(
        state,
        { ...state, items: [] },
        command,
        `Cleared ${cleared.length} item${cleared.length === 1 ? '' : 's'}`,
        null,
        null,
        options,
      )
    }

    case 'undo':
      return applyUndo(state, options)

    case 'search':
      return { state, effects: [{ kind: 'search', command }] }

    case 'unknown':
      return {
        state,
        effects: [
          {
            kind: 'clarify',
            message: "I didn't catch that. Try \"add two litres of milk\".",
          },
        ],
      }
  }
}

function applyAdd(
  state: ListState,
  command: Extract<Command, { kind: 'add' }>,
  options: ApplyOptions,
): ApplyResult {
  const { item } = command
  const existing = state.items.find((i) => i.canonicalId === item.canonicalId)

  if (existing !== undefined) {
    // A second row for the same item reads as a broken app, so quantities combine
    // where they are commensurable and the user is asked where they are not.
    if (!canMerge(existing.quantity, item.quantity)) {
      return {
        state,
        effects: [
          {
            kind: 'clarify',
            message: `${existing.name} is already on your list as ${formatQuantity(existing.quantity)}. Replace it with ${formatQuantity(item.quantity)}?`,
          },
        ],
      }
    }

    const merged = merge(existing.quantity, item.quantity)
    if (merged === null) return { state, effects: [] }

    return commit(
      state,
      { ...state, items: replace(state.items, existing.id, { ...existing, quantity: merged, checked: false }) },
      command,
      `${existing.name} now ${formatQuantity(merged)}`,
      existing.canonicalId,
      existing.name,
      options,
    )
  }

  const created: Item = {
    id: options.generateId(),
    name: item.name,
    canonicalId: item.canonicalId,
    quantity: item.quantity,
    category: item.category,
    checked: false,
    addedAt: options.now,
    source: command.source,
    confidence: item.confidence,
  }

  return commit(
    state,
    { ...state, items: [...state.items, created] },
    command,
    `Added ${formatQuantity(created.quantity)} ${created.name}`.replace('1 ', ''),
    created.canonicalId,
    created.name,
    options,
  )
}

function applyUndo(state: ListState, _options: ApplyOptions): ApplyResult {
  const last = state.history[state.history.length - 1]
  if (last === undefined) {
    return { state, effects: [{ kind: 'announce', message: 'Nothing to undo' }] }
  }

  // Restoring the snapshot, and dropping the entry rather than adding one, so
  // undo never becomes undoable — otherwise it would toggle forever.
  return {
    state: {
      ...state,
      items: last.previousItems,
      version: state.version + 1,
      history: state.history.slice(0, -1),
    },
    effects: [{ kind: 'announce', message: `Undid: ${last.description}` }],
  }
}

function missing(state: ListState, target: Target): ApplyResult {
  return {
    state,
    effects: [
      {
        kind: 'clarify',
        message: `${humanise(target.canonicalId)} isn't on your list.`,
      },
    ],
  }
}

function commit(
  previous: ListState,
  next: ListState,
  command: Command,
  description: string,
  lastCanonicalId: string | null,
  lastName: string | null,
  options: ApplyOptions,
): ApplyResult {
  const entry: HistoryEntry = {
    command,
    at: options.now,
    description,
    previousItems: previous.items,
  }
  return {
    state: {
      ...next,
      version: previous.version + 1,
      history: [...previous.history, entry],
      dialogue:
        lastCanonicalId === null
          ? previous.dialogue
          : { lastCanonicalId, lastName },
    },
    effects: [{ kind: 'announce', message: description }],
  }
}

function replace(items: readonly Item[], id: string, next: Item): Item[] {
  return items.map((item) => (item.id === id ? next : item))
}

function humanise(canonicalId: string): string {
  const spaced = canonicalId.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
