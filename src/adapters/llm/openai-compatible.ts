/**
 * One adapter for every provider that speaks the OpenAI chat format.
 *
 * Ollama exposes `/v1/chat/completions` and Gemini ships an OpenAI compatibility
 * layer, so a single implementation covers local development, the eval harness
 * and production — the difference is a base URL and a model name, not code.
 * That is exactly the provider swap a framework would have been imported for.
 *
 * Two providers with two roles:
 *
 *   Ollama    development and every ablation run. The harness pushes hundreds of
 *             utterances through the fallback tier per configuration; doing that
 *             against a hosted free tier would exhaust a day's quota in an
 *             afternoon. Local inference is unlimited and costs nothing.
 *
 *   Gemini    the deployed app only, where a reviewer makes a handful of calls.
 */

import type {
  ChatMessage,
  CompleteOptions,
  LlmPort,
  ToolCall,
  ToolOptions,
  ToolResponse,
} from '../../ports/llm'

export interface OpenAiCompatibleConfig {
  readonly label: string
  readonly baseUrl: string
  readonly model: string
  /** Absent for a local Ollama; required for hosted providers. */
  readonly apiKey?: string
  /** Hosted free tiers are slow enough that a ceiling matters. */
  readonly timeoutMs?: number
  /** Local endpoints need no key; hosted ones are unusable without one. */
  readonly requiresKey?: boolean
}

interface ChoiceMessage {
  readonly content?: string | null
  /**
   * Reasoning models (qwen3.x, and others) emit their chain of thought here and
   * leave `content` empty. Ollama's OpenAI shim surfaces the two separately, so
   * a parser reading only `content` sees nothing at all — which is exactly what
   * happened: every qwen3.5 call returned null while the model was in fact
   * answering, at length, in a field nobody read.
   */
  readonly reasoning?: string | null
  readonly tool_calls?: ReadonlyArray<{
    readonly id?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }>
}

export class OpenAiCompatibleAdapter implements LlmPort {
  private readonly config: OpenAiCompatibleConfig

  constructor(config: OpenAiCompatibleConfig) {
    this.config = config
  }

  get label(): string {
    return this.config.label
  }

  isAvailable(): boolean {
    if (this.config.requiresKey !== true) return true
    return (this.config.apiKey ?? '') !== ''
  }

  async complete(options: CompleteOptions): Promise<unknown | null> {
    const body = {
      model: this.config.model,
      // Temperature 0: parsing an utterance has one right answer, and sampling
      // variety here just makes the same input resolve differently on retry.
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'command', strict: true, schema: options.schema },
      },
    }

    const message = await this.post(body, options.signal)
    if (message === null) return null

    // Fall back to the reasoning channel so a thinking model is usable at all.
    const text = (message.content ?? '') !== '' ? (message.content as string) : (message.reasoning ?? '')
    try {
      return JSON.parse(text)
    } catch {
      // Some models wrap JSON in prose or fences despite the schema request.
      // Recovering the first object is cheap; the caller validates it anyway.
      const match = /\{[\s\S]*\}/.exec(text)
      if (match === null) return null
      try {
        return JSON.parse(match[0])
      } catch {
        return null
      }
    }
  }

  async completeWithTools(options: ToolOptions): Promise<ToolResponse | null> {
    const body = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: 'system', content: options.system },
        ...options.messages.map(toWireMessage),
      ],
      tools: options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    }

    const message = await this.post(body, options.signal)
    if (message === null) return null

    const toolCalls: ToolCall[] = []
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      const name = call.function?.name
      if (name === undefined) continue
      try {
        toolCalls.push({
          id: call.id ?? `call_${index}`,
          name,
          arguments: JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>,
        })
      } catch {
        // A malformed argument blob is dropped rather than failing the turn;
        // the loop will either retry or finish on the remaining calls.
      }
    }

    return { toolCalls, text: message.content ?? '' }
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<ChoiceMessage | null> {
    if (!this.isAvailable()) return null

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs ?? 20_000)
    const composite = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey !== undefined && this.config.apiKey !== ''
            ? { authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: composite,
      })

      // 429 is the expected failure on a free tier, not an exceptional one.
      // Every non-OK status resolves null so the caller degrades identically.
      if (!response.ok) return null

      const json = (await response.json()) as {
        choices?: ReadonlyArray<{ message?: ChoiceMessage }>
      }
      return json.choices?.[0]?.message ?? null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    // `tool_call_id` is what ties this result to the call that asked for it.
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.toolName ?? 'tool',
      content: message.content,
    }
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

/**
 * Local model for development and every ablation run. No key, no quota.
 *
 * Default chosen by measurement on this task, not by reputation. On four
 * indirect utterances requiring schema-constrained JSON:
 *
 *   qwen2.5:7b-instruct   771ms median, 4/4 correct   <- default
 *   qwen2.5:3b            390ms median, 2/4 correct
 *   gemma4:e4b-it-qat    5472ms median, 3/4 correct
 *   qwen3.5:4b            unusable — a reasoning model, spends the whole token
 *                         budget in the `reasoning` channel and returns empty
 *                         content
 *
 * The first call to any model costs 15-45s while weights load into memory;
 * warm it before timing anything.
 */
export function createOllamaAdapter(model = 'qwen2.5:7b-instruct'): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    label: `Ollama (${model})`,
    baseUrl: 'http://localhost:11434/v1',
    model,
    timeoutMs: 60_000,
  })
}

/** Hosted free tier for the deployed app. Absent key means the tier is simply off. */
export function createGeminiAdapter(apiKey: string | undefined, model = 'gemini-2.5-flash'): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    label: `Gemini (${model})`,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model,
    apiKey,
    requiresKey: true,
    timeoutMs: 15_000,
  })
}
