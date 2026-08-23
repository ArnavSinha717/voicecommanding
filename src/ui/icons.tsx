/**
 * Inline SVG icons.
 *
 * Emoji are not icons. They render differently on every platform, they are read
 * aloud by screen readers as whatever their unicode name happens to be, and they
 * cannot inherit colour or stroke weight. These are drawn from the same 24px
 * grid with a consistent 1.75 stroke, so they sit together as one set.
 *
 * Inlined rather than pulled from an icon package: the whole set below is under
 * 2 KB, and a dependency for a dozen paths would not survive the submission's
 * minimal-dependency requirement.
 *
 * Every icon is `aria-hidden`. Meaning lives on the control that contains it —
 * a button's accessible name, never the glyph.
 */

interface IconProps {
  readonly size?: number
  readonly className?: string
}

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className,
  }
}

export function MicIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  )
}

export function StopIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PlusIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TrashIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function UndoIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </svg>
  )
}

export function CloseIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function SparkIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  )
}

export function TagIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 11V5a2 2 0 0 1 2-2h6l10 10-8 8L3 11z" />
      <circle cx="7.5" cy="7.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function KeyboardIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  )
}

export function AlertIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3l9.5 17H2.5z" />
      <path d="M12 10v4M12 17.5h.01" />
    </svg>
  )
}

export function DeviceIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="6" y="2" width="12" height="20" rx="3" />
      <path d="M11 18.5h2" />
    </svg>
  )
}

export function ClockIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  )
}

export function RepeatIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 9a5 5 0 0 1 5-5h10l-3-3M20 15a5 5 0 0 1-5 5H5l3 3" />
    </svg>
  )
}

/**
 * Listening indicator.
 *
 * Bars driven by the recogniser's own speech events, not by a second microphone
 * stream — opening one alongside the Web Speech API starved it and the app
 * animated convincingly while hearing nothing. Purely decorative, so it is
 * hidden from assistive technology and frozen under reduced-motion.
 */
export function Waveform({ active, level = 0 }: { readonly active: boolean; readonly level?: number }) {
  const bars = [0.35, 0.7, 1, 0.7, 0.35]
  return (
    <span className={`waveform${active ? ' is-active' : ''}`} aria-hidden="true">
      {bars.map((scale, index) => (
        <span
          key={index}
          style={{
            // A floor keeps the shape legible before speech is detected.
            transform: `scaleY(${active ? Math.max(0.25, scale * (0.4 + level * 0.6)) : 0.2})`,
            animationDelay: `${index * 90}ms`,
          }}
        />
      ))}
    </span>
  )
}
