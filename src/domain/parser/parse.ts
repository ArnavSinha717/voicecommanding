/**
 * Grammar parser: transcript -> commands.
 *
 * Deterministic, offline and sub-millisecond. This tier is expected to carry the
 * overwhelming majority of real utterances on its own, which matters for more than
 * latency: free LLM tiers are rate limited, so a system that needs a model call to
 * add milk is a system that breaks for whoever arrives after the quota runs out.
 */

import type {
  Category,
  Command,
  ItemSource,
  NewItem,
  ParseResult,
  Quantity,
  SearchQuery,
  Target,
} from '../types'
import { DEFAULT_QUANTITY, parseQuantity } from '../units'
import type { ItemResolver, Resolution } from '../resolve/resolver'
import type { SpeechHypothesis } from '../../ports/speech'
import { canonicalKey, normalize } from './normalize'
import {
  CLEAR_PATTERNS,
  FOREIGN_DESTINATIONS,
  CONJUNCTION_PATTERN,
  INTENT_RULES,
  LABEL_WORDS,
  NEGATION_PATTERNS,
  PRICE_PATTERNS,
  UNDO_PATTERNS,
  requiresExactResolution,
  type IntentRule,
} from './intents'

/**
 * Short-lived conversational context.
 *
 * Lets "make that two" and "remove it" refer back to whatever was last discussed.
 * This is ordinary anaphora resolution, and it is the difference between something
 * that feels like an assistant and something that feels like a command line.
 */
export interface DialogueState {
  readonly lastCanonicalId: string | null
  readonly lastName: string | null
}

export const EMPTY_DIALOGUE: DialogueState = { lastCanonicalId: null, lastName: null }

/** Words that refer to the previously mentioned item rather than naming a new one. */
const PRONOUNS = new Set([
  'it', 'that', 'this', 'them', 'those', 'these', 'the same',
  'ise', 'isko', 'usko', 'wo', 'woh', 'yeh', 'ye',
])

export interface ParseContext {
  readonly resolver: ItemResolver
  /** List version at parse time, recorded as an optimistic-concurrency precondition. */
  readonly listVersion: number
  readonly dialogue?: DialogueState
  readonly source?: ItemSource
  readonly userHistory?: ReadonlyMap<string, number>
}

function unknown(transcript: string, startedAt: number): ParseResult {
  return {
    commands: [{ kind: 'unknown', transcript }],
    tier: 'grammar',
    confidence: 0,
    runnerUpConfidence: 0,
    transcript,
    latencyMs: performance.now() - startedAt,
  }
}

/**
 * Parse the recognizer's n-best list.
 *
 * Each hypothesis is parsed independently and the highest-scoring interpretation
 * wins. Because scoring is grounded in the catalog, a lower-ranked hypothesis that
 * names a real product can beat a higher-ranked one that does not.
 */
export function parseHypotheses(
  hypotheses: readonly SpeechHypothesis[],
  context: ParseContext,
): ParseResult {
  const startedAt = performance.now()
  if (hypotheses.length === 0) return unknown('', startedAt)

  let best: ParseResult | null = null
  let runnerUp = 0

  for (const hypothesis of hypotheses) {
    const result = parseTranscript(hypothesis.transcript, context, hypothesis)
    if (result.commands[0]?.kind === 'unknown') continue

    if (best === null || result.confidence > best.confidence) {
      if (best !== null) runnerUp = Math.max(runnerUp, best.confidence)
      best = result
    } else {
      runnerUp = Math.max(runnerUp, result.confidence)
    }
  }

  if (best === null) return unknown(hypotheses[0].transcript, startedAt)

  return {
    ...best,
    runnerUpConfidence: Math.max(best.runnerUpConfidence, runnerUp),
    latencyMs: performance.now() - startedAt,
  }
}

export function parseTranscript(
  transcript: string,
  context: ParseContext,
  hypothesis?: SpeechHypothesis,
): ParseResult {
  const startedAt = performance.now()
  const { text } = normalize(transcript)
  if (text === '') return unknown(transcript, startedAt)

  // Negation first: most negated phrasings embed a positive verb, so matching
  // intents before checking would happily add the thing the user just refused.
  if (NEGATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return unknown(transcript, startedAt)
  }

  // Addressed to a different feature entirely — a calendar, a playlist, a contact
  // list. Checked before intent matching, because these utterances use exactly
  // the same verbs we do and only the destination distinguishes them.
  if (FOREIGN_DESTINATIONS.test(text)) {
    return unknown(transcript, startedAt)
  }

  if (UNDO_PATTERNS.some((pattern) => pattern.test(text))) {
    return single({ kind: 'undo' }, 0.97, transcript, startedAt, 'undo')
  }

  if (CLEAR_PATTERNS.some((pattern) => pattern.test(text))) {
    return single({ kind: 'clear' }, 0.97, transcript, startedAt, 'clear')
  }

  for (const rule of INTENT_RULES) {
    const match = rule.pattern.exec(text)
    if (match === null) continue

    const result = applyRule(rule, match, transcript, context, hypothesis, startedAt)
    if (result !== null) return result
  }

  return unknown(transcript, startedAt)
}

/**
 * Prior for a rule.
 *
 * Measured precision where the benchmark covers the rule; a deliberately neutral
 * 0.5 where it does not, so an unmeasured rule never outranks a measured one.
 */
function rulePrior(rule: IntentRule): number {
  return rule.precision ?? 0.5
}

function applyRule(
  rule: IntentRule,
  match: RegExpExecArray,
  transcript: string,
  context: ParseContext,
  hypothesis: SpeechHypothesis | undefined,
  startedAt: number,
): ParseResult | null {
  const groups = match.groups ?? {}
  const ruleName = `${rule.id}:${rule.lang}`

  if (rule.kind === 'search') {
    const query = buildSearchQuery(groups.rest ?? '')
    // "find" and "show me" are domain-general: on real data they fired on
    // "find news about brexit" and "show me the alarms i set" just as readily as
    // on "find organic apples under 5 dollars". A search only counts as a
    // shopping search if something grounds it in the catalog - a price filter, a
    // product qualifier, or a resolvable item.
    const grounded =
      query.maxPrice !== undefined ||
      query.minPrice !== undefined ||
      isGroundedItem(context, query.text, requiresExactResolution(rule))
    if (!grounded) return null
    return single({ kind: 'search', query }, rulePrior(rule), transcript, startedAt, ruleName)
  }

  // "make that two" carries a quantity but no item; the target is whatever was
  // last discussed. Without dialogue state this is unresolvable, so bail to the
  // next rule rather than guessing.
  if (rule.kind === 'setQuantity' && groups.rest === undefined) {
    const lastId = context.dialogue?.lastCanonicalId
    if (lastId == null) return null
    const quantity = readQuantity(groups.qty ?? '')
    if (quantity === null) return null
    return single(
      { kind: 'setQuantity', target: targetFor(lastId, context), quantity },
      rulePrior(rule),
      transcript,
      startedAt,
      ruleName,
    )
  }

  const span = groups.rest ?? ''
  if (span.trim() === '') return null

  // "add apples and bananas" is two commands, not one oddly-named item.
  const parts = span.split(CONJUNCTION_PATTERN).filter((part) => part.trim() !== '')
  const commands: Command[] = []
  let lowestScore = 1

  for (const part of parts) {
    const built = buildItemCommand(rule, part, groups.qty, context, hypothesis)
    if (built === null) continue
    commands.push(built.command)
    lowestScore = Math.min(lowestScore, built.score)
  }

  if (commands.length === 0) return null

  return {
    commands,
    tier: 'grammar',
    // Rule prior and resolution quality both have to hold for the whole reading to
    // be trustworthy, so the two are combined rather than taken independently.
    confidence: rulePrior(rule) * lowestScore,
    runnerUpConfidence: 0,
    transcript,
    latencyMs: performance.now() - startedAt,
    matchedRule: ruleName,
  }
}

interface BuiltCommand {
  readonly command: Command
  readonly score: number
}

function buildItemCommand(
  rule: IntentRule,
  span: string,
  qtyGroup: string | undefined,
  context: ParseContext,
  hypothesis: SpeechHypothesis | undefined,
): BuiltCommand | null {
  const { tokens } = normalize(span)
  if (tokens.length === 0) return null

  const parsedQuantity = parseQuantity(tokens)
  const remainingTokens = tokens.slice(parsedQuantity?.tokensConsumed ?? 0)
  const itemPhrase = remainingTokens.join(' ').trim()

  // Pronoun reference: "remove it", "check that off".
  const isPronoun = PRONOUNS.has(itemPhrase)
  const resolution: Resolution | null = isPronoun
    ? null
    : context.resolver.resolve(itemPhrase === '' ? span : itemPhrase, {
        asrConfidence: hypothesis?.confidence,
        rank: hypothesis?.rank,
        userHistory: context.userHistory,
      })

  // Low-precision phrasings may only act on an item the catalog knows exactly.
  // Measured effect: this is what stops "order two cheeseburgers from wings n.
  // ale" fuzzy-matching its way to cheese.
  if (resolution !== null && requiresExactResolution(rule) && resolution.stage !== 'exact') {
    return null
  }

  // OPEN VOCABULARY
  //
  // A catalog is always smaller than what people say. 2,479 items covers a lot,
  // but someone will ask for a regional vegetable, a new product or a brand that
  // is not in it, and refusing those would be the wrong failure: the user said a
  // real thing and the app did nothing.
  //
  // So resolution enriches rather than validates. A recognised item gets
  // cross-language merging, a category and recommendations; an unrecognised one
  // still lands on the list under exactly what was said, categorised 'other'.
  //
  // Gated on rule precision, because the gate is what separates "add chia seeds"
  // from "put on some coldplay": only phrasings measured as reliable may
  // introduce a word the catalog has never seen.
  const unknownItem =
    resolution === null && !isPronoun && !requiresExactResolution(rule) ? phraseAsItem(itemPhrase) : null

  const canonicalId = isPronoun
    ? context.dialogue?.lastCanonicalId ?? null
    : resolution?.canonicalId ?? unknownItem?.canonicalId ?? null
  if (canonicalId === null) return null

  // Unknown items carry deliberately low confidence, which drives the UI's
  // "did I get that right?" affordance rather than being hidden.
  const score = isPronoun ? 0.85 : resolution?.score ?? 0.4

  switch (rule.kind) {
    case 'add': {
      const identity = resolution ?? unknownItem
      if (identity === null) return null
      const item: NewItem = {
        name: identity.name,
        canonicalId: identity.canonicalId,
        quantity: parsedQuantity?.quantity ?? DEFAULT_QUANTITY,
        category: identity.category,
        confidence: resolution?.score ?? 0.4,
      }
      return {
        command: { kind: 'add', item, source: context.source ?? 'voice' },
        score,
      }
    }
    case 'remove':
      return { command: { kind: 'remove', target: targetFor(canonicalId, context) }, score }
    case 'check':
      return { command: { kind: 'check', target: targetFor(canonicalId, context) }, score }
    case 'uncheck':
      return { command: { kind: 'uncheck', target: targetFor(canonicalId, context) }, score }
    case 'setQuantity': {
      const quantity = readQuantity(qtyGroup ?? '')
      if (quantity === null) return null
      return {
        command: { kind: 'setQuantity', target: targetFor(canonicalId, context), quantity },
        score,
      }
    }
    default:
      return null
  }
}

/**
 * Treat an unrecognised phrase as an item in its own right.
 *
 * Category is 'other' rather than a guess: the catalog lookup already failed, so
 * inventing a category would be fabricating information. A later enrichment pass
 * (product-catalog lookup, or the LLM tier) can fill it in without the user ever
 * having been blocked.
 */
function phraseAsItem(phrase: string): { canonicalId: string; name: string; category: Category } | null {
  const key = canonicalKey(phrase)
  if (key === '' || key.length > 40) return null
  return {
    canonicalId: key.replace(/\s+/g, '-'),
    name: key.replace(/\b\w/g, (c) => c.toUpperCase()),
    category: 'other',
  }
}

/**
 * Build a targeting reference carrying the list version observed right now.
 *
 * Voice is slow: roughly 800ms passes between speech and a parsed command. The
 * user may have tapped the item away in that window. Recording the version here
 * lets the reducer detect the conflict at commit time and ask, rather than crash
 * or silently resurrect a deleted row.
 */
function targetFor(canonicalId: string, context: ParseContext): Target {
  return { canonicalId, expectedVersion: context.listVersion }
}

/** Does the search text name something the catalog actually knows? */
function isGroundedItem(context: ParseContext, text: string, exactOnly: boolean): boolean {
  const resolution = context.resolver.resolve(text)
  if (resolution === null) return false
  return exactOnly ? resolution.stage === 'exact' : true
}

function readQuantity(text: string): Quantity | null {
  const { tokens } = normalize(text)
  return parseQuantity(tokens)?.quantity ?? null
}

function buildSearchQuery(span: string): SearchQuery {
  const { text } = normalize(span)
  let remaining = text

  const maxPriceMatch = PRICE_PATTERNS.under.exec(remaining)
  const minPriceMatch = PRICE_PATTERNS.over.exec(remaining)
  const maxPrice = maxPriceMatch?.groups?.value
  const minPrice = minPriceMatch?.groups?.value

  remaining = remaining.replace(PRICE_PATTERNS.under, ' ').replace(PRICE_PATTERNS.over, ' ')

  // Lift qualifiers out of the free-text span into structured filters, so
  // "organic apples" searches for apples with an organic label rather than for the
  // literal string "organic apples".
  const labels: string[] = []
  for (const label of LABEL_WORDS) {
    if (remaining.includes(label)) {
      labels.push(label)
      remaining = remaining.replace(label, ' ')
    }
  }

  return {
    text: remaining.replace(/\s+/g, ' ').trim(),
    labels: labels.length > 0 ? labels : undefined,
    maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
    minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
  }
}

function single(
  command: Command,
  confidence: number,
  transcript: string,
  startedAt: number,
  matchedRule: string,
): ParseResult {
  return {
    commands: [command],
    tier: 'grammar',
    confidence,
    runnerUpConfidence: 0,
    transcript,
    latencyMs: performance.now() - startedAt,
    matchedRule,
  }
}
