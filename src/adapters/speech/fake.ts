/**
 * In-memory speech adapter for tests, the eval harness and the offline demo mode.
 *
 * This is the payoff for making recognition a port. Because the Web Speech API is
 * unavailable in Playwright's bundled Chromium — Chromium has no Google API keys,
 * so it errors with `network` — driving the real API from CI is not an option.
 * Tests instead hand the application a different implementation of the same
 * interface and push transcripts through it directly: deterministic, offline, and
 * fast enough to run hundreds of utterances per second in the ablation harness.
 *
 * Acts as both a stub (scripted results) and a spy (recorded calls).
 */

import type {
  LanguageTag,
  RecognitionMode,
  SpeechError,
  SpeechHypothesis,
  SpeechListeners,
  SpeechPort,
  SpeechStartOptions,
} from '../../ports/speech'

/** A scripted utterance. Strings expand to a single hypothesis at rank 0. */
export type ScriptedUtterance =
  | string
  | {
      readonly hypotheses: readonly SpeechHypothesis[]
      /** Interim transcripts emitted before the final result. */
      readonly interim?: readonly string[]
    }

export interface FakeSpeechOptions {
  readonly supported?: boolean
  readonly mode?: RecognitionMode
  /** When set, `start` reports this error instead of producing a result. */
  readonly failWith?: SpeechError
}

function toHypotheses(utterance: ScriptedUtterance): readonly SpeechHypothesis[] {
  if (typeof utterance === 'string') {
    return [{ transcript: utterance, confidence: 0.95, rank: 0 }]
  }
  return utterance.hypotheses
}

function toInterim(utterance: ScriptedUtterance): readonly string[] {
  return typeof utterance === 'string' ? [] : (utterance.interim ?? [])
}

export class FakeSpeechAdapter implements SpeechPort {
  private readonly queue: ScriptedUtterance[] = []
  private listeners: SpeechListeners | null = null

  // Spy surface, asserted on by tests.
  readonly startCalls: SpeechStartOptions[] = []
  stopCount = 0
  abortCount = 0
  installCalls: LanguageTag[] = []

  private readonly options: FakeSpeechOptions

  constructor(options: FakeSpeechOptions = {}) {
    this.options = options
  }

  /** Queue an utterance to be delivered on the next `start`. */
  enqueue(...utterances: ScriptedUtterance[]): this {
    this.queue.push(...utterances)
    return this
  }

  isSupported(): boolean {
    return this.options.supported ?? true
  }

  availability(_lang: LanguageTag): Promise<RecognitionMode> {
    return Promise.resolve(this.options.mode ?? 'cloud')
  }

  installOnDevice(lang: LanguageTag): Promise<boolean> {
    this.installCalls.push(lang)
    return Promise.resolve((this.options.mode ?? 'cloud') === 'on-device')
  }

  start(options: SpeechStartOptions, listeners: SpeechListeners): void {
    this.startCalls.push(options)
    this.listeners = listeners

    if (!this.isSupported()) {
      listeners.onError({
        code: 'not-supported',
        message: 'This browser cannot listen. Type your item instead.',
        recoverable: false,
      })
      listeners.onEnd()
      return
    }

    listeners.onStart?.()

    if (this.options.failWith !== undefined) {
      listeners.onError(this.options.failWith)
      listeners.onEnd()
      return
    }

    const utterance = this.queue.shift()
    if (utterance === undefined) {
      // Nothing scripted: behave like a genuine silent session rather than hanging,
      // so tests exercise the same no-speech path a real user would hit.
      listeners.onError({
        code: 'no-speech',
        message: "I didn't hear anything. Tap the mic and try again.",
        recoverable: true,
      })
      listeners.onEnd()
      return
    }

    for (const text of toInterim(utterance)) {
      listeners.onResult({
        hypotheses: [{ transcript: text, confidence: 0, rank: 0 }],
        isFinal: false,
      })
    }

    listeners.onResult({ hypotheses: toHypotheses(utterance), isFinal: true })
    listeners.onEnd()
  }

  stop(): void {
    this.stopCount += 1
    this.listeners?.onEnd()
    this.listeners = null
  }

  abort(): void {
    this.abortCount += 1
    this.listeners = null
  }

  /** Push a result outside of `start`, for tests that need mid-session control. */
  emit(utterance: ScriptedUtterance, isFinal = true): void {
    this.listeners?.onResult({ hypotheses: toHypotheses(utterance), isFinal })
  }
}
