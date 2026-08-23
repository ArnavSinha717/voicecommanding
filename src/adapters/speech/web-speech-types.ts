/**
 * Minimal structural types for the Web Speech API.
 *
 * `lib.dom.d.ts` coverage of speech recognition is inconsistent across TypeScript
 * versions, and the on-device additions from Chrome 139 (`available`, `install`,
 * `processLocally`) are not in any released lib at time of writing. Declaring the
 * shapes we actually touch keeps the adapter honest about its assumptions and
 * confines every `any` to this one file.
 */

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string
  readonly confidence: number
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike
}

export interface SpeechRecognitionResultListLike {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResultLike
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

export interface SpeechRecognitionErrorEventLike extends Event {
  /** One of: 'no-speech' | 'aborted' | 'audio-capture' | 'network' | 'not-allowed' | 'service-not-allowed' | 'language-not-supported' */
  readonly error: string
  readonly message: string
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  /** Chrome 139+: force on-device recognition. Ignored by older engines. */
  processLocally?: boolean

  start(): void
  stop(): void
  abort(): void

  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  /** Audio capture has begun. */
  onaudiostart: (() => void) | null
  /** The recogniser believes it is hearing speech, not just noise. */
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
}

export type AvailabilityStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable'

export interface SpeechRecognitionOptionsLike {
  readonly langs: readonly string[]
  readonly processLocally?: boolean
}

/**
 * Static surface added in Chrome 139 for on-device recognition. Absent everywhere
 * else, hence every call site must feature-detect before use.
 */
export interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike
  available?: (options: SpeechRecognitionOptionsLike) => Promise<AvailabilityStatus>
  install?: (options: SpeechRecognitionOptionsLike) => Promise<boolean>
}

interface SpeechCapableWindow {
  SpeechRecognition?: SpeechRecognitionConstructorLike
  webkitSpeechRecognition?: SpeechRecognitionConstructorLike
}

/**
 * Resolve the recognition constructor, preferring the unprefixed name.
 *
 * Safari and older Chrome only expose the `webkit`-prefixed constructor; Firefox
 * exposes neither by default, since `dom.webspeech.recognition.enable` has shipped
 * false on every release since Firefox 22.
 */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as SpeechCapableWindow
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
