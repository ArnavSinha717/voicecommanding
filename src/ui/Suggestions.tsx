/**
 * Suggestion panel.
 *
 * The engine's reasoning is the most defensible thing this app does, so the
 * interface draws it rather than only quoting it. A sentence — "usually every 9
 * days, last bought 12 days ago" — has to be read and held in mind; a bar past a
 * marker is grasped at a glance, and it is the same number either way.
 *
 * Grouped by *why*, because the three groups answer different questions. "You
 * have run out" is past tense. "You will run out before you are next here" is
 * the one worth acting on while standing in a shop, and it only exists because
 * the model is asked about a horizon rather than about this instant. "People who
 * buy this buy it again" is population behaviour, filling the gap before any
 * history exists.
 */

import type { Suggestion } from '../domain/recommend/suggest'
import { describeHorizon, type Horizon } from '../domain/recommend/horizon'
import { AlertIcon, ClockIcon, PlusIcon, RepeatIcon } from './icons'

interface Props {
  readonly suggestions: readonly Suggestion[]
  readonly horizon: Horizon
  readonly onAdd: (suggestion: Suggestion) => void
}

export function Suggestions({ suggestions, horizon, onAdd }: Props) {
  const due = suggestions.filter((s) => s.kind === 'due')
  const upcoming = suggestions.filter((s) => s.kind === 'upcoming')
  const staples = suggestions.filter((s) => s.kind === 'staple')
  if (suggestions.length === 0) return null

  const horizonDays = Math.round(horizon.days)
  const cadence = describeHorizon(horizon)

  return (
    <>
      {due.length > 0 ? (
        <Group
          title="Probably out"
          hint="Past the point you normally rebuy"
          icon={<AlertIcon size={16} />}
          suggestions={due}
          horizon={horizon}
          onAdd={onAdd}
        />
      ) : null}

      {upcoming.length > 0 ? (
        <Group
          title={`Before your next shop`}
          hint={`${cadence}, so these should run out within ${horizonDays === 1 ? 'a day' : `${horizonDays} days`}`}
          icon={<ClockIcon size={16} />}
          suggestions={upcoming}
          horizon={horizon}
          onAdd={onAdd}
        />
      ) : null}

      {staples.length > 0 ? (
        <Group
          title="Worth restocking"
          hint="How often shoppers buy these again, across 32M purchases"
          icon={<RepeatIcon size={16} />}
          suggestions={staples}
          horizon={horizon}
          onAdd={onAdd}
        />
      ) : null}
    </>
  )
}

function Group({
  title, hint, icon, suggestions, horizon, onAdd,
}: {
  readonly title: string
  readonly hint: string
  readonly icon: React.ReactNode
  readonly suggestions: readonly Suggestion[]
  readonly horizon: Horizon
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
                  <CycleBar cycle={suggestion.cycle} horizonDays={horizon.days} />
                ) : null}

                <span className="row-sub">
                  {suggestion.reason}
                  {suggestion.usuallyDiscounted !== undefined ? (
                    // A catalogue property, never the reason. Phrased so it
                    // cannot be mistaken for a promotion running right now.
                    <span className="often-cheaper"> · often discounted</span>
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
 * Elapsed time against the modelled purchase cycle, and where the next shop falls.
 *
 * Three things on one line: the fill is time already elapsed, the solid marker is
 * the point the item is more likely used up than not, and the dashed marker is
 * the next expected shopping trip. When the dashed marker sits past the solid one
 * the argument for buying today is visible without reading a word — you will be
 * out before you are back.
 *
 * The solid marker is the cycle's MEDIAN, not its mean.
 *
 * That distinction is the difference between the picture agreeing with the words
 * under it and contradicting them. Consumption is modelled as exponential, whose
 * mean sits at the 63rd percentile, so `dueProbability` crosses one-half at
 * `cycle × ln2` — around 4.9 days into a 7-day cycle, not at 7. Drawing the mean
 * put the marker two days right of the moment the engine had already decided the
 * item was due, so a row reading "likely out in 3 days" showed a marker the fill
 * would not reach for five.
 *
 * Overshoot is capped so a badly overdue item does not blow the bar out; the
 * point is "past due", not "how absurdly past".
 */
function CycleBar({
  cycle, horizonDays,
}: {
  readonly cycle: NonNullable<Suggestion['cycle']>
  readonly horizonDays: number
}) {
  const { daysSince, expectedDays } = cycle
  const runsOutAt = expectedDays * Math.LN2
  const nextShopAt = daysSince + horizonDays
  const scale = Math.max(runsOutAt, daysSince, nextShopAt) * 1.12

  const pct = (days: number) => Math.min(100, Math.max(0, (days / scale) * 100))

  return (
    <span className="cycle" aria-hidden="true">
      <span
        className={`cycle-fill${daysSince > runsOutAt ? ' is-overdue' : ''}`}
        style={{ width: `${pct(daysSince)}%` }}
      />
      <span className="cycle-marker" style={{ left: `${pct(runsOutAt)}%` }} />
      <span className="cycle-horizon" style={{ left: `${pct(nextShopAt)}%` }} />
    </span>
  )
}
