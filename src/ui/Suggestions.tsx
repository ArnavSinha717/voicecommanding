/**
 * Suggestion panel.
 *
 * The engine's reasoning is the most defensible thing this app does, so the
 * interface draws it rather than only quoting it. A sentence — "usually every 9
 * days, last bought 12 days ago" — has to be read and held in mind; a bar past a
 * marker is grasped at a glance, and it is the same number either way.
 *
 * Grouped by *why*, because the two kinds answer different questions. "You are
 * about to run out of this" is personal and time-sensitive. "People who buy this
 * buy it again" is population behaviour that fills the gap before any history
 * exists. Mixing them into one ranked list makes both read as noise.
 */

import type { Suggestion } from '../domain/recommend/suggest'
import { ClockIcon, PlusIcon, RepeatIcon } from './icons'

interface Props {
  readonly suggestions: readonly Suggestion[]
  readonly onAdd: (suggestion: Suggestion) => void
}

export function Suggestions({ suggestions, onAdd }: Props) {
  const overdue = suggestions.filter((s) => s.kind === 'replenishment')
  const staples = suggestions.filter((s) => s.kind === 'staple')
  if (suggestions.length === 0) return null

  return (
    <>
      {overdue.length > 0 ? (
        <Group
          title="Running low"
          hint="Based on how often you buy them"
          icon={<ClockIcon size={16} />}
          suggestions={overdue}
          onAdd={onAdd}
        />
      ) : null}

      {staples.length > 0 ? (
        <Group
          title="Worth restocking"
          hint="How often shoppers buy these again, across 32M purchases"
          icon={<RepeatIcon size={16} />}
          suggestions={staples}
          onAdd={onAdd}
        />
      ) : null}
    </>
  )
}

function Group({
  title, hint, icon, suggestions, onAdd,
}: {
  readonly title: string
  readonly hint: string
  readonly icon: React.ReactNode
  readonly suggestions: readonly Suggestion[]
  readonly onAdd: (suggestion: Suggestion) => void
}) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        {icon}
        <h2>{title}</h2>
      </div>
      <p className="panel-hint">{hint}</p>
      <div className="panel-body">
        <ul>
          {suggestions.map((suggestion) => (
            <li key={suggestion.canonicalId}>
              <button
                type="button"
                className="suggestion"
                onClick={() => onAdd(suggestion)}
                aria-label={`Add ${suggestion.name}. ${suggestion.reason}`}
              >
                <span className="suggestion-main">
                  <span
                    className="suggestion-dot"
                    style={{ background: `var(--cat-${suggestion.category})` }}
                    aria-hidden="true"
                  />
                  <span className="row-title">{suggestion.name}</span>
                  {suggestion.priceInr !== undefined ? (
                    <span className="suggestion-price">₹{Math.round(suggestion.priceInr)}</span>
                  ) : null}
                </span>

                {suggestion.cycle !== undefined ? (
                  <CycleBar
                    daysSince={suggestion.cycle.daysSince}
                    expectedDays={suggestion.cycle.expectedDays}
                  />
                ) : null}

                <span className="row-sub">
                  {suggestion.reason}
                  {suggestion.usuallyDiscounted !== undefined ? (
                    // A catalogue property, never the reason. Phrased so it
                    // cannot be mistaken for a promotion running right now.
                    <span className="often-cheaper">
                      · often discounted
                    </span>
                  ) : null}
                </span>

                <span className="row-add" aria-hidden="true"><PlusIcon size={15} /></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/**
 * Elapsed time against the modelled purchase cycle.
 *
 * The marker is where the posterior expects the next purchase; the fill is how
 * far past it the shopper is. Overshoot is capped so a badly overdue item does
 * not blow the bar out — the point is "past due", not "how absurdly past".
 */
function CycleBar({ daysSince, expectedDays }: { readonly daysSince: number; readonly expectedDays: number }) {
  const scale = Math.max(expectedDays * 1.6, daysSince)
  const markerAt = Math.min(96, (expectedDays / scale) * 100)
  const fillTo = Math.min(100, (daysSince / scale) * 100)
  const overdue = daysSince > expectedDays

  return (
    <span className="cycle" aria-hidden="true">
      <span className={`cycle-fill${overdue ? ' is-overdue' : ''}`} style={{ width: `${fillTo}%` }} />
      <span className="cycle-marker" style={{ left: `${markerAt}%` }} />
    </span>
  )
}
