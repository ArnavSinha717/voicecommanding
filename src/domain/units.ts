/**
 * Unit ontology, quantity parsing and merge semantics.
 *
 * Adding "2 apples" to a list that already holds "3 apples" must produce 5, not a
 * second row — duplicate rows for the same item read as a broken app. But merging
 * has to respect physical dimensions: 500g + 1kg is 1.5kg, while 2 bottles + 1kg is
 * not a quantity at all and must be surfaced to the user rather than silently
 * coerced.
 */

import type { Dimension, Quantity, Unit } from './types'

interface UnitSpec {
  readonly dimension: Dimension
  /** Multiplier to the dimension's base unit (piece, ml, g). */
  readonly toBase: number
  /**
   * Whether this unit converts to others in its dimension.
   *
   * Container units (pack, bottle, can, box) are counted, but "2 bottles" and
   * "2 pieces" are not the same claim about the world, so each container merges
   * only with itself.
   */
  readonly convertible: boolean
  /** Shown after the number. Empty for bare counts: "3 apples", not "3 piece apples". */
  readonly label: string
  readonly pluralLabel?: string
}

const UNITS: Readonly<Record<Unit, UnitSpec>> = {
  piece: { dimension: 'count', toBase: 1, convertible: true, label: '' },
  dozen: { dimension: 'count', toBase: 12, convertible: true, label: 'dozen' },
  pack: { dimension: 'count', toBase: 1, convertible: false, label: 'pack', pluralLabel: 'packs' },
  bottle: { dimension: 'count', toBase: 1, convertible: false, label: 'bottle', pluralLabel: 'bottles' },
  can: { dimension: 'count', toBase: 1, convertible: false, label: 'can', pluralLabel: 'cans' },
  box: { dimension: 'count', toBase: 1, convertible: false, label: 'box', pluralLabel: 'boxes' },
  ml: { dimension: 'volume', toBase: 1, convertible: true, label: 'ml' },
  l: { dimension: 'volume', toBase: 1000, convertible: true, label: 'L' },
  g: { dimension: 'mass', toBase: 1, convertible: true, label: 'g' },
  kg: { dimension: 'mass', toBase: 1000, convertible: true, label: 'kg' },
}

/** Base unit each dimension normalises to. */
const BASE_UNIT: Readonly<Record<Dimension, Unit>> = {
  count: 'piece',
  volume: 'ml',
  mass: 'g',
}

export const DEFAULT_QUANTITY: Quantity = { value: 1, unit: 'piece' }

export function dimensionOf(unit: Unit): Dimension {
  return UNITS[unit].dimension
}

/**
 * Merge key for a unit. Two quantities combine only when their families match.
 * Convertible units share their dimension; containers stand alone.
 */
function family(unit: Unit): string {
  const spec = UNITS[unit]
  return spec.convertible ? spec.dimension : `container:${unit}`
}

export function canMerge(a: Quantity, b: Quantity): boolean {
  return family(a.unit) === family(b.unit)
}

/**
 * Sum two quantities, or return null when they are not commensurable.
 *
 * Returning null rather than throwing keeps this total: callers decide whether an
 * incompatible pair becomes a clarification prompt or a second line item.
 */
export function merge(a: Quantity, b: Quantity): Quantity | null {
  if (!canMerge(a, b)) return null

  if (!UNITS[a.unit].convertible) {
    // Same container on both sides, so the units are already identical.
    return { value: a.value + b.value, unit: a.unit }
  }

  const dimension = dimensionOf(a.unit)
  const totalInBase = toBase(a) + toBase(b)
  // Present the result in the larger of the two units so 500g + 1kg reads as 1.5kg.
  const preferred = UNITS[a.unit].toBase >= UNITS[b.unit].toBase ? a.unit : b.unit
  return fromBase(totalInBase, preferred, dimension)
}

export function toBase(q: Quantity): number {
  return q.value * UNITS[q.unit].toBase
}

function fromBase(baseValue: number, unit: Unit, dimension: Dimension): Quantity {
  const spec = UNITS[unit]
  const value = baseValue / spec.toBase
  // Avoid presenting fractional counts: 1.5 dozen is clearer as 18.
  if (dimension === 'count' && !Number.isInteger(value)) {
    return { value: baseValue, unit: BASE_UNIT[dimension] }
  }
  return { value: round(value), unit }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatQuantity(q: Quantity): string {
  const spec = UNITS[q.unit]
  if (spec.label === '') return String(round(q.value))
  const label = q.value === 1 ? spec.label : (spec.pluralLabel ?? spec.label)
  // Metric units read better closed up: "500g", not "500 g".
  const separator = spec.dimension === 'count' ? ' ' : ''
  return `${round(q.value)}${separator}${label}`
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Number words across the languages we accept, including romanised Hindi and
 * Devanagari. Speech recognizers emit "two" or "do" as words rather than digits,
 * so a digit-only parser silently drops most spoken quantities.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  // English
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30,
  half: 0.5, couple: 2, pair: 2,
  // Romanised Hindi
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, cheh: 6, chhe: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, barah: 12, aadha: 0.5, adha: 0.5,
  // Devanagari
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, सात: 7, आठ: 8, नौ: 9,
  दस: 10, आधा: 0.5,
}

/** Unit words mapped to canonical units, including Hindi mass/volume terms. */
const UNIT_WORDS: Readonly<Record<string, Unit>> = {
  // count / containers
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece',
  dozen: 'dozen', dozens: 'dozen', darjan: 'dozen', दर्जन: 'dozen',
  pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack', पैकेट: 'pack',
  bottle: 'bottle', bottles: 'bottle', botal: 'bottle', बोतल: 'bottle',
  can: 'can', cans: 'can', tin: 'can', tins: 'can',
  box: 'box', boxes: 'box', dabba: 'box', डिब्बा: 'box',
  // volume
  ml: 'ml', milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  l: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l', ltr: 'l',
  लीटर: 'l', leetar: 'l',
  // mass
  g: 'g', gram: 'g', grams: 'g', gm: 'g', gms: 'g', ग्राम: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  kilo_gram: 'kg', किलो: 'kg',
}

export interface ParsedQuantity {
  readonly quantity: Quantity
  /** Number of leading tokens consumed, so the caller can strip them from the item name. */
  readonly tokensConsumed: number
}

export function parseNumberWord(token: string): number | null {
  const numeric = Number(token)
  if (!Number.isNaN(numeric) && token.trim() !== '') return numeric
  return NUMBER_WORDS[token] ?? null
}

export function parseUnitWord(token: string): Unit | null {
  return UNIT_WORDS[token] ?? null
}

/**
 * Read a leading quantity from a token stream.
 *
 * Handles the shapes speech actually produces: "2 apples", "two apples",
 * "a dozen eggs", "half a kilo of rice", "do litre doodh", "500 g paneer".
 * Returns null when the stream does not start with a quantity, in which case the
 * caller applies DEFAULT_QUANTITY.
 */
export function parseQuantity(tokens: readonly string[]): ParsedQuantity | null {
  if (tokens.length === 0) return null

  const value = parseNumberWord(tokens[0])
  if (value === null) return null

  let consumed = 1
  let unit: Unit = 'piece'

  // "half a kilo" / "a dozen" — an article between the number and the unit.
  let next = tokens[consumed]
  if (next === 'a' || next === 'an') {
    const afterArticle = tokens[consumed + 1]
    if (afterArticle !== undefined && parseUnitWord(afterArticle) !== null) {
      consumed += 1
      next = afterArticle
    }
  }

  if (next !== undefined) {
    const parsedUnit = parseUnitWord(next)
    if (parsedUnit !== null) {
      unit = parsedUnit
      consumed += 1
      // "2 bottles of water" — drop the connective so it never reaches the item name.
      if (tokens[consumed] === 'of' || tokens[consumed] === 'ka' || tokens[consumed] === 'ke') {
        consumed += 1
      }
    }
  }

  return { quantity: { value, unit }, tokensConsumed: consumed }
}
