/**
 * Application wiring.
 *
 * The one place speech, parsing, list state and storage meet. Everything it
 * coordinates is pure or behind a port, so this file holds orchestration and
 * React state and no business rules — swapping in `FakeSpeechAdapter` here is
 * the whole of what makes the app testable without a microphone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { FakeSpeechAdapter } from '../adapters/speech/fake'
import { WebSpeechAdapter } from '../adapters/speech/web-speech'
import { LocalStorageAdapter } from '../adapters/storage/local'
import { parseHypotheses, parseTranscript, type ParseContext } from '../domain/parser/parse'
import { applyCommand, EMPTY_STATE, type Effect, type ListState } from '../domain/list/reducer'
import { ItemResolver, DEFAULT_CONFIG } from '../domain/resolve/resolver'
import type { LanguageTag, RecognitionMode, SpeechError, SpeechPort } from '../ports/speech'
import type { StoragePort } from '../ports/storage'
import type { CatalogPort, Product } from '../ports/catalog'
import { LocalCatalogAdapter } from '../adapters/catalog/local'
import { CompositeCatalogAdapter, OpenFoodFactsAdapter } from '../adapters/catalog/openfoodfacts'
import type { SearchQuery } from '../domain/types'
import type { LlmPort } from '../ports/llm'
import { ProxyLlmAdapter } from '../adapters/llm/proxy'
import { parseWithLlm, shouldEscalate } from '../domain/parser/llm-parse'
import { isCompositional, planShoppingList, type Proposal } from '../domain/agent/agent'
import { normalize } from '../domain/parser/normalize'
import type { Command, ItemSource } from '../domain/types'
import { suggest, type PurchaseHistory, type Suggestion } from '../domain/recommend/suggest'

/**
 * How often the suggestion clock advances.
 *
 * Replenishment is measured in days, so a minute of granularity is far finer
 * than the signal warrants and keeps re-renders rare.
 */
const CLOCK_TICK_MS = 60_000

/** What the mic button is doing. Rendered directly, so the user is never guessing. */
export type MicState = 'idle' | 'listening' | 'thinking' | 'error'

export interface Toast {
  readonly id: number
  readonly message: string
  readonly kind: 'announce' | 'clarify'
  /** Announcements from a mutation can be reversed; clarifications cannot. */
  readonly undoable: boolean
}

export const LANGUAGES: ReadonlyArray<{ tag: LanguageTag; label: string }> = [
  { tag: 'en-IN', label: 'English (India)' },
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'hi-IN', label: 'हिन्दी' },
]

export interface SearchState {
  readonly query: SearchQuery | null
  readonly results: readonly Product[]
  readonly loading: boolean
  /** A remote source was unreachable; local results shown alone. */
  readonly degraded: boolean
}

/** A plan awaiting the user's confirmation. The agent never applies its own work. */
export interface AgentState {
  readonly thinking: boolean
  readonly proposal: Proposal | null
  readonly failed: boolean
}

export interface ShoppingListApi {
  readonly state: ListState
  readonly micState: MicState
  readonly supported: boolean
  readonly recognitionMode: RecognitionMode
  readonly interimTranscript: string
  readonly audioLevel: number
  readonly lastError: SpeechError | null
  readonly toasts: readonly Toast[]
  readonly suggestions: readonly Suggestion[]
  readonly search: SearchState
  readonly clearSearch: () => void
  readonly agent: AgentState
  readonly acceptProposal: () => void
  readonly rejectProposal: () => void
  /** Whether an LLM tier is configured at all; shown so behaviour is explicable. */
  readonly llmAvailable: boolean
  readonly language: LanguageTag
  readonly listen: () => void
  readonly stopListening: () => void
  readonly submitText: (text: string) => void
  readonly dispatch: (command: Command) => void
  readonly setLanguage: (tag: LanguageTag) => void
  readonly dismissToast: (id: number) => void
}

interface Options {
  /** Overridden in tests and in the offline demo. */
  readonly speech?: SpeechPort
  readonly storage?: StoragePort
  readonly catalog?: CatalogPort
  readonly llm?: LlmPort
}

export function useShoppingList(options: Options = {}): ShoppingListApi {
  const speech = useMemo(() => options.speech ?? new WebSpeechAdapter(), [options.speech])
  const storage = useMemo(() => options.storage ?? new LocalStorageAdapter(), [options.storage])
  const resolver = useMemo(() => new ItemResolver(DEFAULT_CONFIG), [])
  const llm = useMemo(
    // Our own origin, never a provider. The key lives server-side; if none is
    // configured the proxy answers 503, the adapter marks itself unavailable,
    // and every tier depending on it silently does nothing. The app is built to
    // work without one.
    () => options.llm ?? new ProxyLlmAdapter(),
    [options.llm],
  )
  const catalog = useMemo(
    () =>
      options.catalog ??
      new CompositeCatalogAdapter(new LocalCatalogAdapter(), new OpenFoodFactsAdapter()),
    [options.catalog],
  )

  // Restored synchronously on first render rather than in an effect: loading via
  // setState would render an empty list, then immediately re-render with the real
  // one, producing a visible flash of "Nothing yet" on every launch.
  const [restored] = useState(() => storage.load())
  const [state, setState] = useState<ListState>(() =>
    restored === null ? EMPTY_STATE : { ...EMPTY_STATE, items: restored.items },
  )
  const [micState, setMicState] = useState<MicState>('idle')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [audioLevel, setAudioLevel] = useState(0)
  const [lastError, setLastError] = useState<SpeechError | null>(null)
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const [language, setLanguage] = useState<LanguageTag>(() =>
    restored !== null && restored.language !== '' ? restored.language : 'en-IN',
  )
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>('unavailable')
  const [history, setHistory] = useState<PurchaseHistory>(() => restored?.history ?? {})
  const [search, setSearch] = useState<SearchState>({
    query: null,
    results: [],
    loading: false,
    degraded: false,
  })
  /** Cancels an in-flight search when a newer one starts. */
  const searchAbort = useRef<AbortController | null>(null)
  const [agent, setAgent] = useState<AgentState>({ thinking: false, proposal: null, failed: false })
  const agentAbort = useRef<AbortController | null>(null)

  const toastId = useRef(0)

  useEffect(() => {
    storage.save({ items: state.items, history, language, schemaVersion: 1 })
  }, [state.items, history, language, storage])

  useEffect(() => {
    let cancelled = false
    void speech.availability(language).then((mode) => {
      if (!cancelled) setRecognitionMode(mode)
    })
    return () => {
      cancelled = true
    }
  }, [speech, language])

  const runSearch = useCallback(
    (query: SearchQuery) => {
      searchAbort.current?.abort()
      const controller = new AbortController()
      searchAbort.current = controller

      setSearch({ query, results: [], loading: true, degraded: false })
      void catalog
        .search(query, controller.signal)
        .then((outcome) => {
          if (controller.signal.aborted) return
          setSearch({ query, results: outcome.products, loading: false, degraded: outcome.degraded })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setSearch({ query, results: [], loading: false, degraded: true })
        })
    },
    [catalog],
  )

  const clearSearch = useCallback(() => {
    searchAbort.current?.abort()
    setSearch({ query: null, results: [], loading: false, degraded: false })
  }, [])

  const pushToast = useCallback((effects: readonly Effect[]) => {
    const next = effects
      .filter((effect): effect is Extract<Effect, { kind: 'announce' | 'clarify' }> =>
        effect.kind === 'announce' || effect.kind === 'clarify',
      )
      .map((effect) => ({
        id: (toastId.current += 1),
        message: effect.message,
        kind: effect.kind,
        undoable: effect.kind === 'announce',
      }))
    if (next.length === 0) return
    setToasts((current) => [...current.slice(-2), ...next])
  }, [])

  /**
   * Checking an item off is the only reliable signal that it was actually bought,
   * so that is what feeds replenishment. Adding it to a list only says the user
   * intends to; plenty of lists never get shopped.
   */
  const recordPurchases = useCallback((commands: readonly Command[], at: number) => {
    const purchased = commands
      .filter((command): command is Extract<Command, { kind: 'check' }> => command.kind === 'check')
      .map((command) => command.target.canonicalId)
    if (purchased.length === 0) return
    setHistory((current) => {
      const next = { ...current }
      for (const id of purchased) next[id] = [...(next[id] ?? []), at]
      return next
    })
  }, [])

  /**
   * Latest committed state, for reading inside an event handler.
   *
   * The reducer is pure, but *reacting* to what it returns is not: toasts and
   * searches are side effects. Running them inside a setState updater made them
   * skippable and double-runnable — React may invoke an updater more than once
   * — which is why searches silently never fired. The updater now only computes,
   * and the effects happen here, in the handler, where they belong.
   */
  const stateRef = useRef(state)
  // Synced after commit rather than during render: writing a ref while rendering
  // is a side effect, and React may render without committing.
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const runCommands = useCallback(
    (commands: readonly Command[]) => {
      const at = Date.now()
      recordPurchases(commands, at)

      let working = stateRef.current
      const collected: Effect[] = []
      for (const command of commands) {
        const result = applyCommand(working, command, {
          now: at,
          generateId: () => crypto.randomUUID(),
        })
        working = result.state
        collected.push(...result.effects)
      }

      stateRef.current = working
      setState(working)
      pushToast(collected)
      for (const effect of collected) {
        if (effect.kind === 'search') runSearch(effect.command.query)
      }
    },
    [pushToast, recordPurchases, runSearch],
  )

  const contextFor = useCallback(
    (source: ItemSource): ParseContext => ({
      resolver,
      listVersion: state.version,
      dialogue: state.dialogue,
      source,
    }),
    [resolver, state.version, state.dialogue],
  )

  const runAgent = useCallback(
    (request: string) => {
      agentAbort.current?.abort()
      const controller = new AbortController()
      agentAbort.current = controller
      setAgent({ thinking: true, proposal: null, failed: false })

      void planShoppingList(request, llm, {
        items: stateRef.current.items,
        history,
        resolver,
        signal: controller.signal,
      })
        .then((proposal) => {
          if (controller.signal.aborted) return
          setAgent({ thinking: false, proposal, failed: proposal === null })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setAgent({ thinking: false, proposal: null, failed: true })
        })
    },
    [llm, history, resolver],
  )

  /**
   * Single entry point for an utterance, from voice or from typing.
   *
   * Routing order matters. Compositional requests go to the agent; everything
   * else takes the deterministic path and only escalates to a model when the
   * grammar's own margin says it is genuinely unsure. Adding milk never waits
   * on a network call.
   */
  const handleUtterance = useCallback(
    (transcript: string, source: ItemSource, hypotheses?: readonly { transcript: string; confidence: number; rank: number }[]) => {
      const text = normalize(transcript).text
      if (isCompositional(text) && llm.isAvailable()) {
        runAgent(transcript)
        return
      }

      const context = contextFor(source)
      const parsed =
        hypotheses === undefined
          ? parseTranscript(transcript, context)
          : parseHypotheses(hypotheses, context)

      if (!shouldEscalate(parsed) || !llm.isAvailable()) {
        runCommands(parsed.commands)
        return
      }

      // Apply the grammar's reading immediately if it had one, then let the
      // model correct it — the user sees something happen either way, and a
      // slow or rate-limited provider costs nothing.
      setMicState('thinking')
      void parseWithLlm(transcript, llm, { resolver, listVersion: stateRef.current.version, source })
        .then((recovered) => {
          runCommands((recovered ?? parsed).commands)
        })
        .catch(() => runCommands(parsed.commands))
        .finally(() => setMicState('idle'))
    },
    [contextFor, llm, resolver, runAgent, runCommands],
  )

  const listen = useCallback(() => {
    setLastError(null)
    setInterimTranscript('')
    setMicState('listening')

    speech.start(
      { lang: language, maxAlternatives: 5, interimResults: true, preferOnDevice: true },
      {
        onStart: () => setMicState('listening'),
        onAudioLevel: setAudioLevel,
        onResult: (result) => {
          if (!result.isFinal) {
            // Show the live transcript so the user can see it is working before
            // the recognizer commits, rather than staring at a silent button.
            setInterimTranscript(result.hypotheses[0]?.transcript ?? '')
            return
          }
          setMicState('thinking')
          const best = result.hypotheses[0]?.transcript ?? ''
          setInterimTranscript(best)
          handleUtterance(best, 'voice', result.hypotheses)
        },
        onError: (error) => {
          setLastError(error)
          setMicState('error')
        },
        onEnd: () => {
          setAudioLevel(0)
          setMicState((current) => (current === 'error' ? 'error' : 'idle'))
        },
      },
    )
  }, [speech, language, handleUtterance])

  const stopListening = useCallback(() => {
    speech.stop()
    setMicState('idle')
  }, [speech])

  const submitText = useCallback(
    (text: string) => {
      if (text.trim() === '') return
      setInterimTranscript(text)
      handleUtterance(text, 'text')
    },
    [handleUtterance],
  )

  const acceptProposal = useCallback(() => {
    const proposal = agent.proposal
    if (proposal === null) return
    runCommands(
      proposal.items.map((proposed) => ({
        kind: 'add' as const,
        source: 'agent' as const,
        item: {
          name: proposed.name,
          canonicalId: proposed.canonicalId,
          quantity: { value: proposed.quantity, unit: 'piece' as const },
          category: 'other' as const,
          confidence: 0.7,
        },
      })),
    )
    setAgent({ thinking: false, proposal: null, failed: false })
  }, [agent.proposal, runCommands])

  const rejectProposal = useCallback(() => {
    agentAbort.current?.abort()
    setAgent({ thinking: false, proposal: null, failed: false })
  }, [])

  const dispatch = useCallback((command: Command) => runCommands([command]), [runCommands])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  /**
   * Wall-clock time, refreshed on an interval.
   *
   * Suggestions depend on elapsed time — an item becomes due because time passed,
   * not because anything was clicked — but calling Date.now() during render makes
   * the result impure and unstable across re-renders. The clock is an external
   * system, so it is read in an effect and held in state.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const suggestions = useMemo(
    () => suggest({ items: state.items, history, now, limit: 4 }),
    [state.items, history, now],
  )

  return {
    state,
    suggestions,
    search,
    clearSearch,
    agent,
    acceptProposal,
    rejectProposal,
    llmAvailable: llm.isAvailable(),
    micState,
    supported: speech.isSupported(),
    recognitionMode,
    interimTranscript,
    audioLevel,
    lastError,
    toasts,
    language,
    listen,
    stopListening,
    submitText,
    dispatch,
    setLanguage,
    dismissToast,
  }
}

/** Re-exported so tests and the demo can build the app without a microphone. */
export { FakeSpeechAdapter }
