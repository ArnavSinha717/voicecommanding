/**
 * Compositional request handler.
 *
 * An agent is the wrong architecture for this product and the right handler for
 * one route. "Add milk" must resolve in under 100ms; a tool loop is several
 * round-trips and several seconds, so building the primary path this way would
 * be actively bad engineering. But "I'm making pasta for six, add what's
 * missing" genuinely needs planning and tool use: read the list, read what was
 * bought before, look items up, work out quantities for six.
 *
 * So requests are routed by complexity — deterministic parser for single-slot
 * commands, this for compositional ones — and several seconds is acceptable here
 * because the user knows they asked for something hard.
 *
 * THE AGENT PROPOSES, IT NEVER MUTATES.
 * Its terminal output is a proposed diff rendered as a confirmation card. That
 * removes the entire class of "the model did something destructive", makes
 * prompt injection through a product name inert, and is better UX besides: the
 * user sees exactly what is about to happen. Every tool is read-only by
 * construction; there is no write tool for a model to reach for.
 */

import { z } from 'zod'

import type { Item } from '../types'
import type { ChatMessage, LlmPort, ToolDefinition } from '../../ports/llm'
import type { ItemResolver } from '../resolve/resolver'
import type { PurchaseHistory } from '../recommend/suggest'
import { LEXICON } from '../../data/catalog'

/** Hard ceiling on model turns. Without one, a confused model loops until timeout. */
const MAX_ITERATIONS = 5
const MAX_PROPOSED_ITEMS = 12

export interface ProposedItem {
  readonly name: string
  readonly canonicalId: string
  readonly quantity: number
  readonly unit: string
  readonly reason: string
}

export interface Proposal {
  readonly items: readonly ProposedItem[]
  readonly summary: string
  /** Tool calls made, surfaced so the user can see what it looked at. */
  readonly steps: readonly string[]
}

/**
 * Requests worth the latency.
 *
 * Narrow on purpose: everything not matched here goes down the fast path, so a
 * mistake costs a missed opportunity rather than a three-second wait to add milk.
 */
const COMPOSITIONAL = [
  /\b(?:i am|i'm|we are|we're)\s+(?:making|cooking|baking|planning)\b/,
  /\bwhat(?:'s| is)?\s+missing\b/,
  /\badd\s+(?:whatever|everything|anything)\s+(?:i|we)\s+need\b/,
  /\b(?:plan|sort out)\s+(?:dinner|lunch|breakfast|meals?|the week)\b/,
  /\bingredients?\s+for\b/,
]

export function isCompositional(text: string): boolean {
  return COMPOSITIONAL.some((pattern) => pattern.test(text))
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_list',
    description: 'The items currently on the shopping list, with quantities.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_history',
    description: 'Items this shopper has bought before. Use to judge what they likely already have.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_catalog',
    description: 'Find grocery items by name. Use to check an item exists before proposing it.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Item name to look for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
]

const ProposalSchema = z.object({
  summary: z.string().max(200),
  items: z
    .array(
      z.object({
        name: z.string().max(60),
        quantity: z.number().positive().max(999).optional(),
        unit: z.string().max(20).optional(),
        reason: z.string().max(120).optional(),
      }),
    )
    .max(MAX_PROPOSED_ITEMS),
})

const SYSTEM = `You help plan a grocery shopping list.

Use the tools to see what is already on the list and what the shopper usually
buys, then propose ONLY the items they still need. Never propose something
already on their list.

When you are done, reply with JSON and nothing else:
{"summary": "<one short sentence>", "items": [{"name": "...", "quantity": 2, "unit": "piece", "reason": "..."}]}

Keep it to what the request actually requires. You are proposing, not deciding —
the shopper confirms before anything is added.`

export interface AgentContext {
  readonly items: readonly Item[]
  readonly history: PurchaseHistory
  readonly resolver: ItemResolver
  readonly signal?: AbortSignal
}

function runTool(name: string, args: Record<string, unknown>, context: AgentContext): string {
  switch (name) {
    case 'get_list':
      return context.items.length === 0
        ? 'The list is empty.'
        : context.items
            .map((item) => `${item.name} (${item.quantity.value} ${item.quantity.unit})`)
            .join(', ')

    case 'get_history': {
      const bought = Object.keys(context.history)
      return bought.length === 0 ? 'No purchase history yet.' : bought.join(', ')
    }

    case 'search_catalog': {
      const query = typeof args.query === 'string' ? args.query : ''
      const resolved = context.resolver.resolve(query)
      if (resolved !== null) return `Found: ${resolved.name} (${resolved.category})`
      const needle = query.toLowerCase()
      const near = LEXICON.filter((entry) =>
        entry.aliases.some((alias) => alias.includes(needle)),
      ).slice(0, 5)
      return near.length === 0 ? `No match for "${query}".` : `Similar: ${near.map((e) => e.name).join(', ')}`
    }

    default:
      // An unknown tool name is a model error, reported back so it can recover
      // within the loop rather than aborting the whole request.
      return `No such tool: ${name}`
  }
}

export async function planShoppingList(
  request: string,
  llm: LlmPort,
  context: AgentContext,
): Promise<Proposal | null> {
  if (!llm.isAvailable()) return null

  const messages: ChatMessage[] = [{ role: 'user', content: request }]
  const steps: string[] = []

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await llm.completeWithTools({
      system: SYSTEM,
      messages,
      tools: TOOLS,
      signal: context.signal,
    })
    if (response === null) return null

    if (response.toolCalls.length > 0) {
      // The assistant turn must carry its tool_calls, and each result must echo
      // the matching id, or the model re-asks the same question forever.
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls })
      for (const call of response.toolCalls) {
        const result = runTool(call.name, call.arguments, context)
        steps.push(call.name)
        messages.push({
          role: 'tool',
          content: result,
          toolName: call.name,
          toolCallId: call.id,
        })
      }
      continue
    }

    const proposal = readProposal(response.text, context, steps)
    if (proposal !== null) return proposal

    // Ended without usable JSON. One nudge, then give up rather than loop.
    messages.push({ role: 'assistant', content: response.text })
    messages.push({ role: 'user', content: 'Reply with the JSON object only.' })
  }

  return null
}

function readProposal(text: string, context: AgentContext, steps: readonly string[]): Proposal | null {
  const match = /\{[\s\S]*\}/.exec(text)
  if (match === null) return null

  let candidate: unknown
  try {
    candidate = JSON.parse(match[0])
  } catch {
    return null
  }

  const parsed = ProposalSchema.safeParse(candidate)
  if (!parsed.success) return null

  const onList = new Set(context.items.map((item) => item.canonicalId))
  const items: ProposedItem[] = []

  for (const proposed of parsed.data.items) {
    const resolution = context.resolver.resolve(proposed.name)
    const canonicalId =
      resolution?.canonicalId ?? proposed.name.toLowerCase().trim().replace(/\s+/g, '-')
    // The prompt says not to repeat what is on the list; the code enforces it,
    // because a prompt is a request and this is an invariant.
    if (canonicalId === '' || onList.has(canonicalId)) continue
    if (items.some((item) => item.canonicalId === canonicalId)) continue

    items.push({
      name: resolution?.name ?? proposed.name,
      canonicalId,
      quantity: proposed.quantity ?? 1,
      unit: proposed.unit ?? 'piece',
      reason: proposed.reason ?? '',
    })
  }

  if (items.length === 0) return null
  return { items, summary: parsed.data.summary, steps }
}
