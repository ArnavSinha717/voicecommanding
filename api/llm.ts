/**
 * Server-side model proxy.
 *
 * Exists for one reason: the API key must never reach the browser. Vite inlines
 * anything prefixed `VITE_` straight into the bundle, so a key configured that
 * way is readable by anyone who opens devtools. Here it lives in the server
 * environment and the client only ever talks to our own origin.
 *
 * A naive proxy that forwards whatever it is given would be worse than no proxy
 * at all — it is an open, anonymous, free LLM for anyone who finds the URL, and
 * the bill or the quota is ours. So this endpoint is deliberately *not* a
 * passthrough:
 *
 *   - the client picks an operation, never a prompt. System prompts live here.
 *   - tool definitions live here. The client cannot introduce a new tool.
 *   - token ceilings, message counts and payload sizes are capped here.
 *   - requests are rate limited per IP.
 *
 * The worst a caller can do is spend a bounded amount of our quota parsing
 * shopping utterances, which is what the endpoint is for.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'

/** Fast and cheap for single-shot parsing; the agent needs tool calling. */
const PARSE_MODEL = 'gemini-2.5-flash-lite'
const PLAN_MODEL = 'gemini-2.5-flash'

const LIMITS = {
  /** Longest utterance we will forward. Real speech is far shorter. */
  utterance: 400,
  /** Agent loop is capped at 5 turns; each turn adds an assistant + tool pair. */
  messages: 24,
  messageChars: 4000,
  parseTokens: 400,
  planTokens: 800,
  /** Requests per IP per window. */
  perWindow: 30,
  windowMs: 60_000,
} as const

// ---------------------------------------------------------------------------
// Prompts and tools live server-side so the client cannot substitute its own.
// Kept in sync with src/domain/parser/llm-parse.ts and src/domain/agent/agent.ts.
// ---------------------------------------------------------------------------

const PARSE_SYSTEM = `You convert one spoken shopping-list utterance into JSON.

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

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['add', 'remove', 'check', 'search', 'unknown'] },
    item: { type: 'string' },
    quantity: { type: 'number' },
    unit: { type: 'string' },
  },
  required: ['intent', 'item'],
  additionalProperties: false,
}

const PLAN_SYSTEM = `You help plan a grocery shopping list.

Use the tools to see what is already on the list and what the shopper usually
buys, then propose ONLY the items they still need. Never propose something
already on their list.

When you are done, reply with JSON and nothing else:
{"summary": "<one short sentence>", "items": [{"name": "...", "quantity": 2, "unit": "piece", "reason": "..."}]}

Keep it to what the request actually requires. You are proposing, not deciding —
the shopper confirms before anything is added.`

const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_list',
      description: 'The items currently on the shopping list, with quantities.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_history',
      description: 'Items this shopper has bought before.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Find grocery items by name.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * In-memory sliding window, per instance.
 *
 * Honest about what this is: serverless instances are ephemeral and not shared,
 * so a determined caller spread across cold starts gets more than the nominal
 * budget. It is a speed bump against casual abuse, not a guarantee. A durable
 * store (Vercel KV, Upstash) is the real answer and is the first thing to add
 * if this ever saw traffic worth defending.
 */
const hits = new Map<string, number[]>()

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < LIMITS.windowMs)
  recent.push(now)
  hits.set(ip, recent)
  // Bound the map so a long-lived instance cannot grow without limit.
  if (hits.size > 5000) hits.clear()
  return recent.length > LIMITS.perWindow
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// ---------------------------------------------------------------------------

interface ParseRequest {
  readonly op: 'parse'
  readonly utterance: string
}

interface PlanRequest {
  readonly op: 'plan'
  readonly messages: ReadonlyArray<Record<string, unknown>>
}

async function callGemini(apiKey: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const upstream = await fetch(`${GEMINI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })

  if (!upstream.ok) {
    // Upstream detail is not relayed: it can carry quota and project metadata,
    // and the client treats every failure identically anyway.
    return json({ error: 'upstream_unavailable', status: upstream.status }, 502)
  }
  return json(await upstream.json())
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

    const apiKey = process.env.GEMINI_API_KEY
    if (apiKey === undefined || apiKey === '') {
      // Not an error: the app is designed to run without a model tier, and the
      // client degrades to the deterministic parser on this response.
      return json({ error: 'not_configured' }, 503)
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      'unknown'
    if (rateLimited(ip, Date.now())) return json({ error: 'rate_limited' }, 429)

    let payload: ParseRequest | PlanRequest
    try {
      payload = (await request.json()) as ParseRequest | PlanRequest
    } catch {
      return json({ error: 'bad_request' }, 400)
    }

    const timeout = AbortSignal.timeout(30_000)

    if (payload.op === 'parse') {
      const utterance = String(payload.utterance ?? '')
      if (utterance === '' || utterance.length > LIMITS.utterance) {
        return json({ error: 'bad_request' }, 400)
      }
      return callGemini(
        apiKey,
        {
          model: PARSE_MODEL,
          temperature: 0,
          max_tokens: LIMITS.parseTokens,
          messages: [
            { role: 'system', content: PARSE_SYSTEM },
            { role: 'user', content: utterance },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'command', strict: true, schema: PARSE_SCHEMA },
          },
        },
        timeout,
      )
    }

    if (payload.op === 'plan') {
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      if (messages.length === 0 || messages.length > LIMITS.messages) {
        return json({ error: 'bad_request' }, 400)
      }
      if (JSON.stringify(messages).length > LIMITS.messageChars) {
        return json({ error: 'payload_too_large' }, 413)
      }
      // The system prompt and tool list are ours, appended here rather than
      // accepted from the caller, so the endpoint cannot be repurposed.
      return callGemini(
        apiKey,
        {
          model: PLAN_MODEL,
          temperature: 0,
          max_tokens: LIMITS.planTokens,
          messages: [{ role: 'system', content: PLAN_SYSTEM }, ...messages],
          tools: PLAN_TOOLS,
        },
        timeout,
      )
    }

    return json({ error: 'unknown_operation' }, 400)
  },
}
