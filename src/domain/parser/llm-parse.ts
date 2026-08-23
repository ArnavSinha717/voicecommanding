/**
 * LLM fallback tier.
 *
 * Reached only when the grammar is genuinely unsure — not on every utterance.
 * That distinction is the whole design: free tiers are rate limited, so a system
 * needing a model call to add milk is a system that breaks for whoever arrives
 * after the quota runs out. Measured on MASSIVE, the deterministic path handles
 * the overwhelming majority on its own; this catches the tail.
 *
 * Escalation keys off the *margin* between the best and second-best reading, not
 * an absolute score. Two interpretations both scoring well means real ambiguity,
 * which a plain threshold would wave straight through.
 *
 * The model's output is never trusted structurally. It is validated against a
 * schema on our side and mapped onto the same `Command` union the grammar
 * produces, so nothing downstream can tell which tier answered — and a model
 * that hallucinates a field, an intent or a nested object simply fails
 * validation and degrades to a clarification.
 */

import { z } from 'zod'

import type { Command, ItemSource, ParseResult, Target } from '../types'
import type { JsonSchema, LlmPort } from '../../ports/llm'
import type { ItemResolver } from '../resolve/resolver'
import { canonicalKey } from './normalize'
import { DEFAULT_QUANTITY, parseNumberWord, parseUnitWord } from '../units'

/** Escalate when the winning reading is weak, or barely beats the runner-up. */
export const ESCALATION = {
  /** Below this, the grammar is not confident enough to act alone. */
  minConfidence: 0.55,
  /** Two readings this close together is ambiguity, not a decision. */
  minMargin: 0.15,
} as const

export function shouldEscalate(result: ParseResult): boolean {
  if (result.commands[0]?.kind === 'unknown') return true
  if (result.confidence < ESCALATION.minConfidence) return true
  return result.confidence - result.runnerUpConfidence < ESCALATION.minMargin
}

/**
 * Output contract, enforced twice.
 *
 * The provider is asked to honour it, and it is re-validated here regardless.
 * A model is an untrusted input source: `strict: true` is a request, not a
 * guarantee, and several will cheerfully return prose around a JSON blob.
 */
const INTENTS = ['add', 'remove', 'check', 'search', 'unknown'] as const

export const LLM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    item: { type: 'string' },
    quantity: { type: 'number' },
    unit: { type: 'string' },
  },
  required: ['intent', 'item'],
  additionalProperties: false,
}

const LlmCommand = z.object({
  intent: z.enum(INTENTS),
  item: z.string().max(60),
  quantity: z.number().positive().max(9999).optional(),
  unit: z.string().max(20).optional(),
})

export const SYSTEM_PROMPT = `You convert one spoken shopping-list utterance into JSON.

intent must be exactly one of: add, remove, check, search, unknown.
  add     the speaker wants something on the list, including indirect phrasings
          like "we're out of X" or "grab X"
  remove  take something off the list
  check   they already have it, e.g. "I got the milk"
  search  they are looking for a product to buy
  unknown anything that is not about a shopping list

item must be the grocery item alone: no verbs, no quantities, no words like
"list". If intent is unknown, set item to "unknown".

Include quantity and unit only if the speaker actually said them.
Answer with JSON only. Do not explain your reasoning.`

export interface LlmParseContext {
  readonly resolver: ItemResolver
  readonly listVersion: number
  readonly source?: ItemSource
  readonly signal?: AbortSignal
}

/**
 * Parse one utterance through the model.
 * Resolves null on any failure — unavailable, rate limited, timed out, or output
 * that did not validate — so the caller falls back to a clarification.
 */
export async function parseWithLlm(
  transcript: string,
  llm: LlmPort,
  context: LlmParseContext,
): Promise<ParseResult | null> {
  if (!llm.isAvailable()) return null

  const startedAt = performance.now()
  const raw = await llm.complete({
    system: SYSTEM_PROMPT,
    user: transcript,
    schema: LLM_SCHEMA,
    signal: context.signal,
  })
  if (raw === null) return null

  const parsed = LlmCommand.safeParse(raw)
  if (!parsed.success) return null

  const command = toCommand(parsed.data, context)
  if (command === null) return null

  return {
    commands: [command],
    tier: 'llm',
    // Deliberately below the grammar's confident band: this reading is a
    // recovery, and the UI marks it as one so the user can correct it.
    confidence: 0.6,
    runnerUpConfidence: 0,
    transcript,
    latencyMs: performance.now() - startedAt,
    matchedRule: 'llm',
  }
}

function toCommand(
  data: z.infer<typeof LlmCommand>,
  context: LlmParseContext,
): Command | null {
  if (data.intent === 'unknown') return null

  const phrase = data.item.trim()
  if (phrase === '' || phrase.toLowerCase() === 'unknown') return null

  if (data.intent === 'search') {
    return { kind: 'search', query: { text: canonicalKey(phrase) } }
  }

  // Exact matches only for model output. Fuzzy matching an LLM-extracted phrase
  // is worse than not matching at all: measured on real utterances it turned
  // "those green things for the salad" into Green Tea and "the white stuff for
  // cereal" into a face cream. An unrecognised phrase belongs on the list as
  // itself, which the open-vocabulary path already handles correctly.
  const exact = context.resolver.resolve(phrase)
  const resolution = exact?.stage === 'exact' ? exact : null
  const canonicalId = resolution?.canonicalId ?? canonicalKey(phrase).replace(/\s+/g, '-')
  if (canonicalId === '') return null

  const target: Target = { canonicalId, expectedVersion: context.listVersion }

  switch (data.intent) {
    case 'remove':
      return { kind: 'remove', target }
    case 'check':
      return { kind: 'check', target }
    case 'add':
      return {
        kind: 'add',
        source: context.source ?? 'voice',
        item: {
          name: resolution?.name ?? titleCase(canonicalKey(phrase)),
          canonicalId,
          quantity: readQuantity(data),
          category: resolution?.category ?? 'other',
          // Low by construction: an LLM-recovered item is the least certain
          // thing on the list and is flagged for the user accordingly.
          confidence: 0.5,
        },
      }
  }
}

function readQuantity(data: z.infer<typeof LlmCommand>) {
  if (data.quantity === undefined) return DEFAULT_QUANTITY
  const unit = data.unit === undefined ? null : parseUnitWord(data.unit.toLowerCase())
  const value = Number.isFinite(data.quantity) ? data.quantity : parseNumberWord(String(data.quantity))
  if (value === null || value <= 0) return DEFAULT_QUANTITY
  return { value, unit: unit ?? 'piece' } as const
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (character) => character.toUpperCase())
}
