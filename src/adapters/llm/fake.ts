/**
 * Scripted language model for tests.
 *
 * Model calls are slow, non-deterministic and quota-limited — three properties
 * a test suite cannot tolerate. This returns exactly what a case needs, records
 * what it was asked, and can be told to fail so degradation paths are covered
 * as thoroughly as the happy one.
 */

import type {
  CompleteOptions,
  LlmPort,
  ToolCall,
  ToolOptions,
  ToolResponse,
} from '../../ports/llm'

export interface FakeLlmOptions {
  /** Queued replies for `complete`, consumed in order. */
  readonly completions?: readonly unknown[]
  /** Queued replies for `completeWithTools`, consumed in order. */
  readonly toolResponses?: readonly ToolResponse[]
  /** Simulates no key configured, a dead endpoint, or an exhausted quota. */
  readonly available?: boolean
  /** Every call resolves null, as a real provider does on 429 or timeout. */
  readonly failing?: boolean
}

export class FakeLlmAdapter implements LlmPort {
  readonly label = 'Fake'
  readonly completeCalls: CompleteOptions[] = []
  readonly toolCalls: ToolOptions[] = []

  private readonly options: FakeLlmOptions
  private completions: unknown[]
  private toolResponses: ToolResponse[]

  constructor(options: FakeLlmOptions = {}) {
    this.options = options
    this.completions = [...(options.completions ?? [])]
    this.toolResponses = [...(options.toolResponses ?? [])]
  }

  isAvailable(): boolean {
    return this.options.available ?? true
  }

  complete(options: CompleteOptions): Promise<unknown | null> {
    this.completeCalls.push(options)
    if (this.options.failing === true || !this.isAvailable()) return Promise.resolve(null)
    return Promise.resolve(this.completions.shift() ?? null)
  }

  completeWithTools(options: ToolOptions): Promise<ToolResponse | null> {
    this.toolCalls.push(options)
    if (this.options.failing === true || !this.isAvailable()) return Promise.resolve(null)
    return Promise.resolve(this.toolResponses.shift() ?? null)
  }
}

/** Convenience for building a tool-calling turn in a test. */
export function toolTurn(...calls: Array<[string, Record<string, unknown>]>): ToolResponse {
  return {
    toolCalls: calls.map(([name, args], index): ToolCall => ({
      id: `call_${index}`,
      name,
      arguments: args,
    })),
    text: '',
  }
}

/** Convenience for a final, non-tool turn. */
export function textTurn(text: string): ToolResponse {
  return { toolCalls: [], text }
}
