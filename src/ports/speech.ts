/**
 * Speech recognition port.
 *
 * WHY THIS IS A PORT RATHER THAN A DIRECT API CALL
 *
 * The Web Speech API cannot run in a test environment. Chrome streams audio to
 * Google's servers using proprietary API keys compiled into the Chrome binary;
 * Chromium ships without those keys, so `SpeechRecognition` fires an error event
 * with `error: 'network'`. Playwright drives bundled Chromium by default, which
 * means any test touching recognition fails with a misleading network error unless
 * it is pinned to `channel: 'chrome'`.
 *
 * Injecting recognition behind this interface is therefore not an aesthetic
 * preference — it is the only way to test the application at all. This is the
 * Humble Object pattern: the adapter holds the untestable API surface and contains
 * no logic, while every decision lives in the pure domain behind it.
 *
 * A second constraint shapes the design. `SpeechGrammarList` / JSGF are inert —
 * the spec states grammar features "have no effect on speech recognition services"
 * and Chrome ignores them entirely. There is no hotword biasing or vocabulary
 * injection, so domain knowledge cannot be pushed upstream into the recognizer and
 * must be applied to the transcript after the fact. That is why `SpeechResult`
 * exposes the full n-best list rather than just the top hypothesis: reranking those
 * alternatives against our catalog is the only correction lever the platform allows.
 */

/** BCP-47 language tag, e.g. 'en-IN', 'hi-IN'. */
export type LanguageTag = string

export interface SpeechHypothesis {
  readonly transcript: string
  /**
   * Recognizer-reported confidence [0,1].
   *
   * Unreliable in practice — Chrome frequently reports 0 for interim results and
   * sometimes for finals. Consumers must treat a 0 here as "unknown" and fall back
   * to rank-derived weighting rather than trusting it as a real probability.
   */
  readonly confidence: number
  /** Position in the n-best list; 0 is the recognizer's preferred hypothesis. */
  readonly rank: number
}

export interface SpeechResult {
  /** n-best hypotheses, best first. Length depends on `maxAlternatives`. */
  readonly hypotheses: readonly SpeechHypothesis[]
  /** False while the user is still speaking; such results may still change. */
  readonly isFinal: boolean
}

export type SpeechErrorCode =
  | 'not-supported'
  | 'permission-denied'
  | 'no-speech'
  | 'audio-capture'
  | 'network'
  | 'language-unavailable'
  | 'aborted'
  | 'unknown'

export interface SpeechError {
  readonly code: SpeechErrorCode
  /** User-facing text. Every error must suggest a concrete next action. */
  readonly message: string
  /** False when the only path forward is the text-input fallback. */
  readonly recoverable: boolean
}

/**
 * Where recognition will run for a given language.
 *
 * 'on-device' became available in Chrome 139 via `processLocally: true`, backed by
 * SODA. It is lower latency and keeps audio off the network, but is desktop-only
 * and requires an installed language pack.
 */
export type RecognitionMode = 'on-device' | 'cloud' | 'unavailable'

export interface SpeechListeners {
  /** Fired for both interim and final results; check `isFinal`. */
  readonly onResult: (result: SpeechResult) => void
  readonly onError: (error: SpeechError) => void
  /** Recognition has stopped, whether by request, silence or error. */
  readonly onEnd: () => void
  /** Audio is being captured; safe to show the listening indicator. */
  readonly onStart?: () => void
  /** Normalised input level [0,1] for the level meter. */
  readonly onAudioLevel?: (level: number) => void
}

export interface SpeechStartOptions {
  readonly lang: LanguageTag
  /** How many n-best hypotheses to request. Defaults to 5. */
  readonly maxAlternatives?: number
  /** Emit interim results so the UI can parse incrementally. Defaults to true. */
  readonly interimResults?: boolean
  /** Prefer on-device recognition where the platform supports it. */
  readonly preferOnDevice?: boolean
}

export interface SpeechPort {
  /** False when the platform has no recognition at all (e.g. Firefox by default). */
  isSupported(): boolean

  /** Whether recognition can run for `lang`, and where. */
  availability(lang: LanguageTag): Promise<RecognitionMode>

  /**
   * Ask the platform to download an on-device language pack.
   * Resolves false when unsupported or declined; callers fall back to cloud.
   */
  installOnDevice(lang: LanguageTag): Promise<boolean>

  start(options: SpeechStartOptions, listeners: SpeechListeners): void

  /** Stop capture and deliver any pending final result. */
  stop(): void

  /** Stop capture and discard pending results. */
  abort(): void
}
