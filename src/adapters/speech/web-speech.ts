/**
 * Web Speech API adapter.
 *
 * Holds every browser quirk so the domain does not have to. Contains no parsing,
 * no scoring and no state beyond what the recognizer itself requires — if logic
 * starts accumulating here, it belongs in the domain instead.
 */

import type {
  LanguageTag,
  RecognitionMode,
  SpeechError,
  SpeechErrorCode,
  SpeechHypothesis,
  SpeechListeners,
  SpeechPort,
  SpeechStartOptions,
} from '../../ports/speech'
import {
  getSpeechRecognitionConstructor,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from './web-speech-types'

const DEFAULT_MAX_ALTERNATIVES = 5

/**
 * Map recognizer error codes to our taxonomy.
 *
 * 'network' deserves special mention: in Chromium builds it does not mean the
 * network is down. Chrome streams audio to Google's speech service using API keys
 * compiled into the official binary, and Chromium ships without them, so the call
 * fails with a misleading code. The user-facing copy therefore avoids blaming the
 * user's connection and steers to the text fallback.
 */
function mapError(code: string, lang?: string): SpeechError {
  const taxonomy: Record<string, { code: SpeechErrorCode; message: string; recoverable: boolean }> = {
    'no-speech': {
      code: 'no-speech',
      message: "I didn't hear anything. Tap the mic and try again.",
      recoverable: true,
    },
    'audio-capture': {
      code: 'audio-capture',
      message: 'No microphone found. You can type your item instead.',
      recoverable: false,
    },
    'not-allowed': {
      code: 'permission-denied',
      message: 'Microphone access is blocked. Enable it in your browser settings, or type instead.',
      recoverable: false,
    },
    'service-not-allowed': {
      code: 'permission-denied',
      message: 'Speech recognition is unavailable in this browser. You can type instead.',
      recoverable: false,
    },
    network: {
      code: 'network',
      message: 'Speech recognition is unreachable right now. You can type instead.',
      recoverable: false,
    },
    'language-not-supported': {
      code: 'language-unavailable',
      message:
        lang === undefined
          ? 'That language is not available for speech in this browser. Try another, or type instead.'
          : `Speech recognition for ${lang} is not available in this browser. Switch language above, or type instead.`,
      recoverable: false,
    },
    aborted: {
      code: 'aborted',
      message: 'Listening stopped.',
      recoverable: true,
    },
  }

  return (
    taxonomy[code] ?? {
      code: 'unknown' as SpeechErrorCode,
      message: 'Something went wrong with the microphone. You can type instead.',
      recoverable: true,
    }
  )
}

/** Read the n-best list from a result event, best hypothesis first. */
function extractHypotheses(event: SpeechRecognitionEventLike): SpeechHypothesis[] {
  const result = event.results[event.resultIndex]
  if (result === undefined) return []

  const hypotheses: SpeechHypothesis[] = []
  for (let i = 0; i < result.length; i += 1) {
    const alternative = result[i]
    if (alternative === undefined) continue
    const transcript = alternative.transcript.trim()
    if (transcript === '') continue
    hypotheses.push({
      transcript,
      // Chrome reports 0 for interim results and occasionally for finals. Callers
      // treat 0 as "unknown" and fall back to rank-derived weighting.
      confidence: Number.isFinite(alternative.confidence) ? alternative.confidence : 0,
      rank: i,
    })
  }
  return hypotheses
}

/** How long to wait for any result before giving up and telling the user. */
const SILENCE_TIMEOUT_MS = 12_000

export class WebSpeechAdapter implements SpeechPort {
  private recognition: SpeechRecognitionLike | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null

  isSupported(): boolean {
    return getSpeechRecognitionConstructor() !== null
  }

  async availability(lang: LanguageTag): Promise<RecognitionMode> {
    const Ctor = getSpeechRecognitionConstructor()
    if (Ctor === null) return 'unavailable'

    // On-device support landed in Chrome 139 and is absent elsewhere, so a missing
    // `available` static simply means "cloud only", not "broken".
    if (typeof Ctor.available !== 'function') return 'cloud'

    try {
      const status = await Ctor.available({ langs: [lang], processLocally: true })
      return status === 'available' ? 'on-device' : 'cloud'
    } catch {
      return 'cloud'
    }
  }

  async installOnDevice(lang: LanguageTag): Promise<boolean> {
    const Ctor = getSpeechRecognitionConstructor()
    if (Ctor === null || typeof Ctor.install !== 'function') return false
    try {
      return await Ctor.install({ langs: [lang], processLocally: true })
    } catch {
      return false
    }
  }

  start(options: SpeechStartOptions, listeners: SpeechListeners): void {
    const Ctor = getSpeechRecognitionConstructor()
    if (Ctor === null) {
      listeners.onError({
        code: 'not-supported',
        message: 'This browser cannot listen. Type your item instead.',
        recoverable: false,
      })
      listeners.onEnd()
      return
    }

    // Starting a second recognition while one is live throws InvalidStateError.
    this.abort()

    const recognition = new Ctor()
    recognition.lang = options.lang
    recognition.interimResults = options.interimResults ?? true
    recognition.maxAlternatives = options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES
    recognition.continuous = false
    if (options.preferOnDevice === true) {
      // Only set when availability() has already confirmed a local model for
      // this language: the flag *forces* local processing, so setting it
      // speculatively turns a working cloud language into an outright failure.
      // Ignored by engines predating Chrome 139, which is harmless.
      recognition.processLocally = true
    }

    recognition.onstart = () => listeners.onStart?.()

    // The only honest signal that audio is reaching the recogniser. An earlier
    // version drove the level meter from a second getUserMedia stream opened
    // alongside this one; two consumers competed for the microphone, the meter
    // won, and recognition was starved — it animated convincingly while never
    // hearing a word. Anything the indicator shows now comes from the
    // recogniser itself.
    recognition.onaudiostart = () => listeners.onAudioLevel?.(0.35)
    recognition.onspeechstart = () => listeners.onAudioLevel?.(1)
    recognition.onspeechend = () => listeners.onAudioLevel?.(0)

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const hypotheses = extractHypotheses(event)
      if (hypotheses.length === 0) return
      const result = event.results[event.resultIndex]
      const isFinal = result?.isFinal ?? false
      if (isFinal) this.clearWatchdog()
      listeners.onResult({ hypotheses, isFinal })
    }

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      this.clearWatchdog()
      listeners.onError(mapError(event.error, options.lang))
    }

    recognition.onend = () => {
      this.teardown()
      listeners.onEnd()
    }

    this.recognition = recognition

    // Watchdog. Chrome normally ends a non-continuous session itself once it
    // detects a pause, but if it never receives usable audio it can sit open
    // indefinitely with no result and no error — the user is left holding a
    // button that appears to be listening forever.
    this.watchdog = setTimeout(() => {
      if (this.recognition !== recognition) return
      listeners.onError({
        code: 'no-speech',
        message: "I didn't catch anything. Tap the mic and try again, or type it.",
        recoverable: true,
      })
      this.abort()
      listeners.onEnd()
    }, SILENCE_TIMEOUT_MS)

    try {
      recognition.start()
    } catch {
      this.teardown()
      listeners.onError({
        code: 'unknown',
        message: 'Could not start listening. Try again, or type instead.',
        recoverable: true,
      })
      listeners.onEnd()
    }
  }

  stop(): void {
    this.clearWatchdog()
    this.recognition?.stop()
  }

  abort(): void {
    const recognition = this.recognition
    if (recognition !== null) {
      // Detach before aborting so the in-flight onend does not reach a listener
      // belonging to a session the caller has already replaced.
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.onstart = null
      recognition.abort()
    }
    this.teardown()
  }

  private teardown(): void {
    this.clearWatchdog()
    this.recognition = null
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = null
  }
}
