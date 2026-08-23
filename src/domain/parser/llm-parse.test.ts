import { describe, expect, it } from 'vitest'

import { FakeLlmAdapter } from '../../adapters/llm/fake'
import { DEFAULT_CONFIG, ItemResolver } from '../resolve/resolver'
import { parseTranscript } from './parse'
import { parseWithLlm, shouldEscalate } from './llm-parse'

const resolver = new ItemResolver(DEFAULT_CONFIG)
const context = { resolver, listVersion: 1 }

describe('escalation', () => {
  it('escalates when the grammar understood nothing', () => {
    expect(shouldEscalate(parseTranscript('blorp the wugs', context))).toBe(true)
  })

  it('does not escalate a confident, unambiguous reading', () => {
    // The whole point of the tier: adding milk must never need a model call, or
    // the app breaks for whoever arrives after the quota runs out.
    expect(shouldEscalate(parseTranscript('add milk to my shopping list', context))).toBe(false)
  })

  it('escalates on a narrow margin even when the score is decent', () => {
    // Two readings scoring alike is genuine ambiguity, which a plain absolute
    // threshold would wave straight through.
    const ambiguous = {
      commands: [{ kind: 'add' as const, item: { name: 'X', canonicalId: 'x', quantity: { value: 1, unit: 'piece' as const }, category: 'other' as const, confidence: 0.8 }, source: 'voice' as const }],
      tier: 'grammar' as const,
      confidence: 0.8,
      runnerUpConfidence: 0.75,
      transcript: 'x',
      latencyMs: 1,
    }
    expect(shouldEscalate(ambiguous)).toBe(true)
  })
})

describe('llm fallback', () => {
  it('maps a model reading onto the same Command union the grammar produces', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'milk', quantity: 2, unit: 'litre' }] })
    const result = await parseWithLlm('we need a couple of the white stuff', llm, context)
    expect(result?.tier).toBe('llm')
    expect(result?.commands[0]).toMatchObject({
      kind: 'add',
      item: { canonicalId: 'milk', quantity: { value: 2, unit: 'l' } },
    })
  })

  it('passes an unrecognised phrase through as an item rather than mis-matching it', async () => {
    // Measured failure this guards: fuzzy matching model output turned "those
    // green things" into Green Tea and "the white stuff" into a face cream.
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'green things' }] })
    const result = await parseWithLlm('grab those green things', llm, context)
    expect(result?.commands[0]).toMatchObject({
      kind: 'add',
      // Singularised by the same canonicalisation the catalog keys use, so an
      // unknown item and a known one are named consistently.
      item: { name: 'Green Thing', category: 'other' },
    })
  })

  it('marks its output as less certain than the grammar', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'kombucha' }] })
    const result = await parseWithLlm('some kombucha please', llm, context)
    const command = result?.commands[0]
    expect(command?.kind).toBe('add')
    if (command?.kind === 'add') expect(command.item.confidence).toBeLessThan(0.6)
  })

  it('handles remove and check intents', async () => {
    for (const [intent, kind] of [['remove', 'remove'], ['check', 'check']] as const) {
      const llm = new FakeLlmAdapter({ completions: [{ intent, item: 'bread' }] })
      const result = await parseWithLlm('x', llm, context)
      expect(result?.commands[0]).toMatchObject({ kind, target: { canonicalId: 'bread' } })
    }
  })
})

describe('the model is an untrusted input', () => {
  it('rejects an intent outside the schema', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'delete_everything', item: 'milk' }] })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })

  it('rejects a missing required field', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add' }] })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })

  it('rejects an absurd quantity', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'milk', quantity: 1e9 }] })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })

  it('rejects a wildly long item name', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'x'.repeat(500) }] })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })

  it('rejects a nested object where a string belongs', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: { nested: true } }] })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })

  it('treats an explicit unknown as no command', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'unknown', item: 'unknown' }] })
    expect(await parseWithLlm('what time is it', llm, context)).toBeNull()
  })
})

describe('degradation', () => {
  it('returns null when no provider is configured', async () => {
    const llm = new FakeLlmAdapter({ available: false })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
    // Not even attempted: an unavailable provider costs nothing.
    expect(llm.completeCalls).toHaveLength(0)
  })

  it('returns null when the provider fails, as on a 429', async () => {
    const llm = new FakeLlmAdapter({ failing: true })
    expect(await parseWithLlm('x', llm, context)).toBeNull()
  })
})
