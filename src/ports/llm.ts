/**
 * Language-model port.
 *
 * Two distinct uses with very different budgets, deliberately kept as separate
 * methods so a provider that is good at one and poor at the other can be chosen
 * per job:
 *
 *   complete()          one shot, schema-constrained, <800ms. Parses an utterance
 *                       the grammar could not, and only when the grammar's own
 *                       margin says it is genuinely unsure.
 *
 *   completeWithTools() a bounded loop for compositional requests such as
 *                       "I'm making pasta for six, add what's missing". Several
 *                       seconds is acceptable because the user knows they asked
 *                       for something hard.
 *
 * NO LANGCHAIN. This interface *is* the provider abstraction a framework would
 * supply, at about twenty lines, and the submission guidelines require minimal
 * dependencies. LangGraph earns its place on persistent, resumable, multi-node
 * graphs; this is three read-only tools behind an iteration cap.
 *
 * Everything here is optional. With no provider configured the app runs on the
 * deterministic parser alone and says so — a demo must never depend on somebody
 * else's quota still having room.
 */

export interface JsonSchema {
  readonly type: string
  readonly [key: string]: unknown
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

export interface ToolCall {
  /**
   * Provider-assigned call id.
   *
   * Not decoration: the OpenAI protocol links a tool *result* back to its call
   * through this id, and without it the model cannot tell that its question was
   * answered. Omitting it made the agent call `get_list` on every single turn,
   * never seeing the list, until the iteration cap stopped it.
   */
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** Set on tool-result messages so the model can match them to its call. */
  readonly toolName?: string
  /** Required on tool-result messages; echoes the id from the originating call. */
  readonly toolCallId?: string
  /** Set on an assistant turn that requested tools, so the exchange is well formed. */
  readonly toolCalls?: readonly ToolCall[]
}

export interface CompleteOptions {
  readonly system: string
  readonly user: string
  /** Provider-enforced output shape. Still re-validated on our side. */
  readonly schema: JsonSchema
  readonly signal?: AbortSignal
}

export interface ToolOptions {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly tools: readonly ToolDefinition[]
  readonly signal?: AbortSignal
}

export interface ToolResponse {
  /** Tool calls the model wants performed. Empty when it is finished. */
  readonly toolCalls: readonly ToolCall[]
  /** Final text, present when the model stopped calling tools. */
  readonly text: string
}

export interface LlmPort {
  /** False when no key or endpoint is configured; callers degrade silently. */
  isAvailable(): boolean
  /** Reported in the UI so a user knows what answered. */
  readonly label: string
  /** Resolves null on any failure — never throws into the parse path. */
  complete(options: CompleteOptions): Promise<unknown | null>
  completeWithTools(options: ToolOptions): Promise<ToolResponse | null>
}
