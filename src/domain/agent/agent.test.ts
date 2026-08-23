import { describe, expect, it } from 'vitest'

import { FakeLlmAdapter, textTurn, toolTurn } from '../../adapters/llm/fake'
import { DEFAULT_CONFIG, ItemResolver } from '../resolve/resolver'
import type { Item } from '../types'
import { isCompositional, planShoppingList } from './agent'

const resolver = new ItemResolver(DEFAULT_CONFIG)

function item(canonicalId: string, name: string): Item {
  return {
    id: canonicalId,
    name,
    canonicalId,
    quantity: { value: 1, unit: 'piece' },
    category: 'pantry',
    checked: false,
    addedAt: 0,
    source: 'voice',
    confidence: 1,
  }
}

const proposal = JSON.stringify({
  summary: 'Adding what the pasta needs.',
  items: [
    { name: 'pasta sauce', quantity: 2, unit: 'piece', reason: 'Goes with pasta' },
    { name: 'cheese', quantity: 1, unit: 'piece', reason: 'Common topping' },
  ],
})

describe('routing', () => {
  it.each([
    "i'm making pasta for six, add what's missing",
    'what is missing from my list',
    'ingredients for biryani',
    'plan dinner for the week',
  ])('routes %j to the agent', (request) => {
    expect(isCompositional(request)).toBe(true)
  })

  it.each(['add milk', 'remove bread', 'find organic apples', 'i need eggs'])(
    'keeps %j on the fast deterministic path',
    (request) => {
      // A tool loop costs seconds. Adding milk must never pay that.
      expect(isCompositional(request)).toBe(false)
    },
  )
})

describe('planning', () => {
  it('gathers context with tools before proposing', async () => {
    const llm = new FakeLlmAdapter({
      toolResponses: [toolTurn(['get_list', {}], ['get_history', {}]), textTurn(proposal)],
    })
    const result = await planShoppingList('x', llm, { items: [item('pasta', 'Pasta')], history: {}, resolver })
    expect(result?.steps).toEqual(['get_list', 'get_history'])
    expect(result?.summary).toBe('Adding what the pasta needs.')
    expect(result?.items.map((i) => i.canonicalId)).toContain('pasta-sauce')
  })

  it('echoes each tool call id back on its result', async () => {
    // Without tool_call_id the model cannot tell its question was answered and
    // re-asks the same one every turn until the iteration cap stops it.
    const llm = new FakeLlmAdapter({
      toolResponses: [toolTurn(['get_list', {}]), textTurn(proposal)],
    })
    await planShoppingList('x', llm, { items: [], history: {}, resolver })
    const secondTurn = llm.toolCalls[1]
    const toolMessage = secondTurn.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.toolCallId).toBe('call_0')
    const assistantMessage = secondTurn.messages.find((m) => m.role === 'assistant')
    expect(assistantMessage?.toolCalls?.[0]?.id).toBe('call_0')
  })

  it('never proposes something already on the list', async () => {
    // The prompt asks for this; the code enforces it, because a prompt is a
    // request and this is an invariant.
    const llm = new FakeLlmAdapter({
      toolResponses: [
        textTurn(JSON.stringify({ summary: 's', items: [{ name: 'pasta' }, { name: 'cheese' }] })),
      ],
    })
    const result = await planShoppingList('x', llm, {
      items: [item('pasta', 'Pasta')],
      history: {},
      resolver,
    })
    expect(result?.items.map((i) => i.canonicalId)).not.toContain('pasta')
    expect(result?.items.map((i) => i.canonicalId)).toContain('cheese')
  })

  it('deduplicates repeated proposals', async () => {
    const llm = new FakeLlmAdapter({
      toolResponses: [
        textTurn(JSON.stringify({ summary: 's', items: [{ name: 'cheese' }, { name: 'cheese' }] })),
      ],
    })
    const result = await planShoppingList('x', llm, { items: [], history: {}, resolver })
    expect(result?.items).toHaveLength(1)
  })
})

describe('the agent proposes, it never mutates', () => {
  it('exposes only read-only tools', async () => {
    const llm = new FakeLlmAdapter({ toolResponses: [textTurn(proposal)] })
    await planShoppingList('x', llm, { items: [], history: {}, resolver })
    const names = llm.toolCalls[0].tools.map((tool) => tool.name)
    // There is no write tool for a model to reach for. That removes the whole
    // class of "the model did something destructive", and makes an injection
    // attempt through a product name inert.
    expect(names).toEqual(['get_list', 'get_history', 'search_catalog'])
    expect(names.some((n) => /add|remove|delete|clear|write|set/.test(n))).toBe(false)
  })
})

describe('guardrails', () => {
  it('gives up rather than looping when the model never finishes', async () => {
    const llm = new FakeLlmAdapter({
      toolResponses: Array.from({ length: 20 }, () => toolTurn(['get_list', {}])),
    })
    expect(await planShoppingList('x', llm, { items: [], history: {}, resolver })).toBeNull()
    // Bounded by MAX_ITERATIONS, not by a timeout.
    expect(llm.toolCalls.length).toBeLessThanOrEqual(5)
  })

  it('caps how much can be proposed at once', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `item ${i}` }))
    const llm = new FakeLlmAdapter({
      toolResponses: [textTurn(JSON.stringify({ summary: 's', items: many }))],
    })
    // Over the cap the payload fails validation outright rather than being
    // silently truncated into something the user did not ask for.
    expect(await planShoppingList('x', llm, { items: [], history: {}, resolver })).toBeNull()
  })

  it('rejects a malformed proposal', async () => {
    const llm = new FakeLlmAdapter({ toolResponses: [textTurn('Sure! I will add some things.')] , })
    expect(await planShoppingList('x', llm, { items: [], history: {}, resolver })).toBeNull()
  })

  it('returns null with no provider configured', async () => {
    const llm = new FakeLlmAdapter({ available: false })
    expect(await planShoppingList('x', llm, { items: [], history: {}, resolver })).toBeNull()
    expect(llm.toolCalls).toHaveLength(0)
  })

  it('returns null when the provider fails', async () => {
    const llm = new FakeLlmAdapter({ failing: true })
    expect(await planShoppingList('x', llm, { items: [], history: {}, resolver })).toBeNull()
  })
})
