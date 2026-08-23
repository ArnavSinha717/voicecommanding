/**
 * Core domain types.
 *
 * This module is deliberately free of browser, React and network imports. Everything
 * downstream of a transcript is pure data transformation, which is what makes the
 * parser and reducer testable without a microphone. See docs/ARCHITECTURE.md.
 */

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/** Physical dimension a unit measures. Quantities only combine within a dimension. */
export type Dimension = 'count' | 'volume' | 'mass'

export type Unit =
  // count
  | 'piece'
  | 'pack'
  | 'bottle'
  | 'can'
  | 'box'
  | 'dozen'
  // volume
  | 'ml'
  | 'l'
  // mass
  | 'g'
  | 'kg'

export interface Quantity {
  readonly value: number
  readonly unit: Unit
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type Category =
  | 'produce'
  | 'dairy'
  | 'bakery'
  | 'meat'
  | 'pantry'
  | 'frozen'
  | 'beverages'
  | 'snacks'
  | 'household'
  | 'personal-care'
  | 'other'

/** How an item came to be on the list. Surfaced in the history view. */
export type ItemSource = 'voice' | 'text' | 'suggestion' | 'agent'

export interface Item {
  readonly id: string
  /** Display name, in the language the user spoke. */
  readonly name: string
  /** Language-independent key used for merging, history and recommendations. */
  readonly canonicalId: string
  readonly quantity: Quantity
  readonly category: Category
  readonly checked: boolean
  readonly addedAt: number
  readonly source: ItemSource
  /** Resolver confidence [0,1]. Low values drive a visual "did I get that right?" cue. */
  readonly confidence: number
}

// ---------------------------------------------------------------------------
// Command targeting
// ---------------------------------------------------------------------------

/**
 * Reference to an item that a command intends to act on.
 *
 * Voice is asynchronous and slow: roughly 800ms elapses between the user speaking
 * and a parsed command arriving. In that window the user may have tapped the item
 * away. `expectedVersion` is an optimistic-concurrency precondition — the reducer
 * re-resolves the target against *current* state at commit time, so a concurrent
 * edit degrades into a clarification instead of a crash or a resurrected item.
 */
export interface Target {
  readonly canonicalId: string
  /** List version observed when the command was parsed. */
  readonly expectedVersion: number
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface SearchQuery {
  readonly text: string
  readonly brand?: string
  readonly labels?: readonly string[]
  readonly maxPrice?: number
  readonly minPrice?: number
}

export interface NewItem {
  readonly name: string
  readonly canonicalId: string
  readonly quantity: Quantity
  readonly category: Category
  readonly confidence: number
}

/**
 * A parsed user intent. Exhaustively switched on by the reducer, so adding a
 * variant surfaces every site that needs updating as a type error.
 */
export type Command =
  | { readonly kind: 'add'; readonly item: NewItem; readonly source: ItemSource }
  | { readonly kind: 'remove'; readonly target: Target }
  | { readonly kind: 'setQuantity'; readonly target: Target; readonly quantity: Quantity }
  | { readonly kind: 'check'; readonly target: Target }
  | { readonly kind: 'uncheck'; readonly target: Target }
  | { readonly kind: 'clear' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'search'; readonly query: SearchQuery }
  /** Parser could not determine an intent. Carries the transcript for the review queue. */
  | { readonly kind: 'unknown'; readonly transcript: string }

export type CommandKind = Command['kind']

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

/** Which stage produced a command. Reported per-slice by the ablation harness. */
export type ParseTier = 'grammar' | 'llm' | 'agent'

export interface ParseResult {
  /**
   * Commands to apply, in order.
   *
   * Usually one. "Add apples and bananas" is genuinely two commands, so this is a
   * list rather than a single value — collapsing it would either drop the second
   * item or create one called "apples and bananas".
   */
  readonly commands: readonly Command[]
  readonly tier: ParseTier
  /** Combined confidence [0,1]; drives escalation to the LLM tier. */
  readonly confidence: number
  /**
   * Score of the next-best interpretation.
   *
   * Escalation keys off the *margin* between this and `confidence`, not an absolute
   * threshold: two interpretations both scoring well means genuine ambiguity, which
   * a threshold alone would wave through.
   */
  readonly runnerUpConfidence: number
  readonly transcript: string
  readonly latencyMs: number
  /** Which grammar rule fired, for per-rule error attribution in the eval harness. */
  readonly matchedRule?: string
}
