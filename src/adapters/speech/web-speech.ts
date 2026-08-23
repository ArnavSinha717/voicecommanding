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
function mapError(code: string): SpeechError {
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
      message: 'That language is not available for speech here. Try another, or type instead.',
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

export class WebSpeechAdapter implements SpeechPort {
  private recognition: SpeechRecognitionLike | null = null
  private meter: AudioLevelMeter | null = null

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
      // Ignored by engines that predate Chrome 139; harmless there.
      recognition.processLocally = true
    }

    recognition.onstart = () => listeners.onStart?.()

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const hypotheses = extractHypotheses(event)
      if (hypotheses.length === 0) return
      const result = event.results[event.resultIndex]
      listeners.onResult({ hypotheses, isFinal: result?.isFinal ?? false })
    }

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      listeners.onError(mapError(event.error))
    }

    recognition.onend = () => {
      this.teardown()
      listeners.onEnd()
    }

    this.recognition = recognition

    if (listeners.onAudioLevel !== undefined) {
      this.meter = new AudioLevelMeter(listeners.onAudioLevel)
      // Best-effort: a failed level meter must never block recognition itself.
      void this.meter.start()
    }

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
    this.recognition?.stop()
    this.meter?.stop()
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
    this.recognition = null
    this.meter?.stop()
    this.meter = null
  }
}

/**
 * Microphone level meter for the listening indicator.
 *
 * The Web Speech API does not expose its audio stream, so visualising input level
 * requires a parallel `getUserMedia` capture. This is purely cosmetic: every
 * failure path is swallowed, because a missing waveform must never prevent someone
 * from adding milk to their list.
 */
class AudioLevelMeter {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private frame: number | null = null

  private readonly onLevel: (level: number) => void

  constructor(onLevel: (level: number) => void) {
    this.onLevel = onLevel
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(this.stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      this.context = context

      const buffer = new Uint8Array(analyser.frequencyBinCount)
      const tick = (): void => {
        analyser.getByteTimeDomainData(buffer)
        // RMS deviation from the 128 silence midpoint, normalised to roughly [0,1].
        let sumSquares = 0
        for (const sample of buffer) {
          const centred = (sample - 128) / 128
          sumSquares += centred * centred
        }
        const rms = Math.sqrt(sumSquares / buffer.length)
        this.onLevel(Math.min(1, rms * 3))
        this.frame = requestAnimationFrame(tick)
      }
      this.frame = requestAnimationFrame(tick)
    } catch {
      this.stop()
    }
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    void this.context?.close().catch(() => undefined)
    this.context = null
  }
}
