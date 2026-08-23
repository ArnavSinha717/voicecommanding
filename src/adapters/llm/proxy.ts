/**
 * Production LLM adapter: talks to our own origin, never to a provider.
 *
 * The key lives on the server. This client sends an *operation* rather than a
 * prompt — the system prompts, tool definitions and token ceilings are all
 * server-side, so a browser cannot repurpose the endpoint into a general-purpose
 * model. See api/llm.ts.
 *
 * `isAvailable()` is optimistic by necessity: whether a key is configured is a
 * server-side fact the browser cannot see without asking. A missing key comes
 * back as 503 and every method resolves null, which is the same degradation path
 * as a timeout or a rate limit, so the app behaves identically either way.
 */

import type {
  CompleteOptions,
  LlmPort,
  ToolCall,
  ToolOptions,
  ToolResponse,
} from '../../ports/llm'

interface ChoiceMessage {
  readonly content?: string | null
  readonly reasoning?: string | null
  readonly tool_calls?: ReadonlyArray<{
    readonly id?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }>
}

export class ProxyLlmAdapter implements LlmPort {
  readonly label = 'Gemini (via server proxy)'
  private readonly endpoint: string
  /** Set once the server has told us it has no key, so we stop asking. */
  private notConfigured = false

  constructor(endpoint = '/api/llm') {
    this.endpoint = endpoint
  }

  isAvailable(): boolean {
    return !this.notConfigured
  }

  async complete(options: CompleteOptions): Promise<unknown | null> {
    const message = await this.post({ op: 'parse', utterance: options.user }, options.signal)
    if (message === null) return null

    const text = (message.content ?? '') !== '' ? (message.content as string) : (message.reasoning ?? '')
    try {
      return JSON.parse(text)
    } catch {
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
    // Only the conversation travels. The system prompt and the tool list are
    // the server's, so this payload cannot widen what the model can do.
    const messages = options.messages.map((message) => {
      if (message.role === 'tool') {
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
    })

    const message = await this.post({ op: 'plan', messages }, options.signal)
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
        // Malformed arguments are dropped; the loop continues on what remains.
      }
    }

    return { toolCalls, text: message.content ?? '' }
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<ChoiceMessage | null> {
    if (this.notConfigured) return null

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })

      if (response.status === 503) {
        // No key configured. Remember it so the app stops attempting a tier
        // that cannot work, rather than pausing on every unusual utterance.
        this.notConfigured = true
        return null
      }
      if (!response.ok) return null

      const json = (await response.json()) as {
        choices?: ReadonlyArray<{ message?: ChoiceMessage }>
      }
      return json.choices?.[0]?.message ?? null
    } catch {
      return null
    }
  }
}
