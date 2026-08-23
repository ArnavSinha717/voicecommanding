/**
 * Application shell.
 *
 * Voice-first, one-handed, and built for where it is actually used: standing in
 * a shop, phone in one hand, eyes mostly on the shelves. Three consequences run
 * through the layout.
 *
 * The microphone is the largest control on screen. Anything smaller says the
 * keyboard is the real interface and voice is a novelty bolted on.
 *
 * The list is scannable rather than readable — a colour rail per aisle means
 * finding the dairy line takes a glance, not a parse.
 *
 * Typing is a first-class path, never a fallback. Roughly a third of browsers
 * cannot do speech recognition at all (Firefox ships it disabled), and a noisy
 * shop defeats most of the rest.
 */

import { useMemo, useState, type FormEvent } from 'react'

import type { Category, Item } from '../domain/types'
import { formatQuantity } from '../domain/units'
import { LANGUAGES, useShoppingList, type MicState } from './useShoppingList'
import type { SpeechPort } from '../ports/speech'
import type { StoragePort } from '../ports/storage'
import type { CatalogPort } from '../ports/catalog'
import type { LlmPort } from '../ports/llm'
import { Suggestions } from './Suggestions'
import {
  AlertIcon,
  CloseIcon,
  DeviceIcon,
  KeyboardIcon,
  MicIcon,
  PlusIcon,
  SparkIcon,
  StopIcon,
  TagIcon,
  TrashIcon,
  UndoIcon,
  Waveform,
} from './icons'
import './app.css'

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  produce: 'Produce',
  dairy: 'Dairy',
  bakery: 'Bakery',
  meat: 'Meat & Fish',
  pantry: 'Pantry',
  frozen: 'Frozen',
  beverages: 'Beverages',
  snacks: 'Snacks',
  household: 'Household',
  'personal-care': 'Personal Care',
  other: 'Other',
}

/** Fixed order, so the list never reshuffles as categories come and go. */
const CATEGORY_ORDER: readonly Category[] = [
  'produce', 'dairy', 'bakery', 'meat', 'frozen', 'pantry',
  'beverages', 'snacks', 'household', 'personal-care', 'other',
]

/** Chosen to teach the range, not fill space: quantity, compound, removal, Hinglish. */
const EXAMPLES = [
  'Add two litres of milk',
  'I need apples and bananas',
  'Remove bread from my list',
  'do litre doodh add karo',
]

const MIC_LABEL: Readonly<Record<MicState, string>> = {
  idle: 'Start listening',
  listening: 'Listening — tap to stop',
  thinking: 'Working that out',
  error: 'Microphone problem — tap to retry',
}

export interface AppProps {
  /** Injected by tests and the offline demo; production uses the real adapters. */
  readonly speech?: SpeechPort
  readonly storage?: StoragePort
  readonly catalog?: CatalogPort
  readonly llm?: LlmPort
}

export default function App({ speech, storage, catalog, llm }: AppProps) {
  const list = useShoppingList({ speech, storage, catalog, llm })
  const [draft, setDraft] = useState('')

  const grouped = useMemo(() => {
    const byCategory = new Map<Category, Item[]>()
    for (const item of list.state.items) {
      const bucket = byCategory.get(item.category) ?? []
      bucket.push(item)
      byCategory.set(item.category, bucket)
    }
    return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
      category,
      items: byCategory.get(category) ?? [],
    }))
  }, [list.state.items])

  const total = list.state.items.length
  const done = list.state.items.filter((item) => item.checked).length
  const outstanding = total - done
  const listening = list.micState === 'listening'

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    list.submitText(draft)
    setDraft('')
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Shopping List</h1>
          <p className="subtitle">{total === 0 ? 'Nothing yet' : `${outstanding} still to get`}</p>
        </div>

        {total > 0 ? <Progress done={done} total={total} /> : null}

        <label className="language">
          <span className="visually-hidden">Voice language</span>
          <select value={list.language} onChange={(event) => list.setLanguage(event.target.value)}>
            {LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="layout">
      <main className="list" aria-label="Shopping list">
        {total === 0 ? (
          <div className="empty">
            <div className="empty-art">
              <MicIcon size={30} />
            </div>
            <h2>Say what you need</h2>
            <p>Tap the microphone, or type it below.</p>
            <ul className="examples">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => list.submitText(example)}>
                    <TagIcon size={17} />
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          grouped.map(({ category, items }) => (
            <section
              key={category}
              className="group"
              style={{ ['--cat' as string]: `var(--cat-${category})` }}
            >
              <div className="group-head">
                <span className="group-dot" />
                <h2>{CATEGORY_LABELS[category]}</h2>
                <span className="group-count">{items.length}</span>
              </div>
              <ul>
                {items.map((item) => (
                  <li key={item.id} className={item.checked ? 'item checked' : 'item'}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={() =>
                          list.dispatch({
                            kind: item.checked ? 'uncheck' : 'check',
                            target: { canonicalId: item.canonicalId, expectedVersion: list.state.version },
                          })
                        }
                      />
                      <span className="item-name">{item.name}</span>
                      {item.quantity.value !== 1 || item.quantity.unit !== 'piece' ? (
                        <span className="quantity">{formatQuantity(item.quantity)}</span>
                      ) : null}
                      {item.confidence < 0.6 ? (
                        <span className="uncertain" title="I wasn't sure I heard this correctly — check the name">
                          <AlertIcon size={13} />
                          <span className="visually-hidden">Unconfirmed — check this name</span>
                        </span>
                      ) : null}
                    </label>
                    <button
                      type="button"
                      className="remove"
                      aria-label={`Remove ${item.name}`}
                      onClick={() =>
                        list.dispatch({
                          kind: 'remove',
                          target: { canonicalId: item.canonicalId, expectedVersion: list.state.version },
                        })
                      }
                    >
                      <TrashIcon size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

      </main>

      <aside className="side" aria-label="Assistant">
      <footer className="dock">
        {/* Announced politely so screen-reader users get the same real-time
            feedback sighted users get from watching it appear. */}
        <div className={`transcript${listening ? ' listening' : ''}`} aria-live="polite">
          {listening ? <Waveform active level={list.audioLevel} /> : null}
          <span className="text">
            {list.interimTranscript !== ''
              ? `“${list.interimTranscript}”`
              : listening
                ? 'Listening…'
                : null}
          </span>
        </div>

        <div className="dock-row">
          <form className="composer" onSubmit={onSubmit}>
            <input
              type="text"
              value={draft}
              placeholder="Type an item…"
              aria-label="Type a command"
              enterKeyHint="done"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="send" aria-label="Add" disabled={draft.trim() === ''}>
              <PlusIcon size={20} />
            </button>
          </form>

          <button
            type="button"
            className={`mic ${list.micState}`}
            aria-label={MIC_LABEL[list.micState]}
            aria-pressed={listening}
            disabled={!list.supported}
            onClick={() => (listening ? list.stopListening() : list.listen())}
          >
            {listening ? <StopIcon size={22} /> : <MicIcon size={24} />}
          </button>
        </div>
      </footer>
        {/* The agent proposes; it never applies its own work. Nothing is added
            until this is accepted. */}
        {list.agent.thinking || list.agent.proposal !== null || list.agent.failed ? (
          <section className="panel" aria-label="Suggested plan">
            <div className="panel-head">
              <SparkIcon size={17} />
              <h2>
                {list.agent.thinking
                  ? 'Working out what you need…'
                  : (list.agent.proposal?.summary ?? 'Could not plan that')}
              </h2>
              {!list.agent.thinking ? (
                <button type="button" className="close" aria-label="Dismiss" onClick={list.rejectProposal}>
                  <CloseIcon size={17} />
                </button>
              ) : null}
            </div>

            {list.agent.thinking ? (
              <div className="panel-body">
                <ul className="skeletons" aria-busy="true">
                  {[0, 1].map((row) => <li key={row} />)}
                </ul>
              </div>
            ) : list.agent.failed ? (
              <div className="panel-body">
                <p className="notice warn">
                  <AlertIcon size={16} />
                  I couldn’t plan that one. Try naming the items instead.
                </p>
              </div>
            ) : (
              <>
                <div className="panel-body">
                  <ul>
                    {list.agent.proposal?.items.map((proposed) => (
                      <li key={proposed.canonicalId}>
                        <div className="row-button">
                          <div className="row-text">
                            <span className="row-title">
                              {proposed.quantity > 1 ? `${proposed.quantity} × ` : null}
                              {proposed.name}
                            </span>
                            {proposed.reason !== '' ? (
                              <span className="row-sub">{proposed.reason}</span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="proposal-actions">
                  <button type="button" className="accept" onClick={list.acceptProposal}>
                    Add all
                  </button>
                  <button type="button" onClick={list.rejectProposal}>
                    No thanks
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {list.search.query !== null ? (
          <section className="panel" aria-label="Search results">
            <div className="panel-head">
              <TagIcon size={17} />
              <h2>
                “{list.search.query.text}”
                {list.search.query.maxPrice !== undefined ? ` under ₹${list.search.query.maxPrice}` : null}
              </h2>
              <button type="button" className="close" aria-label="Close search" onClick={list.clearSearch}>
                <CloseIcon size={17} />
              </button>
            </div>

            <div className="panel-body">
              {list.search.loading ? (
                /* Skeletons rather than a spinner: the row count is known, so
                   results landing does not shift the layout. */
                <ul className="skeletons" aria-busy="true">
                  {[0, 1, 2].map((row) => <li key={row} />)}
                </ul>
              ) : list.search.results.length === 0 ? (
                <p className="notice">Nothing matched. Try fewer words.</p>
              ) : (
                <ul>
                  {list.search.results.map((product) => (
                    <li key={product.id}>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => {
                          list.submitText(`add ${product.name}`)
                          list.clearSearch()
                        }}
                      >
                        <div className="row-text">
                          <span className="row-title">{product.name}</span>
                          <span className="meta">
                            {product.brand !== undefined ? <span>{product.brand}</span> : null}
                            {product.size !== undefined ? <span>{product.size}</span> : null}
                            {/* Price shown only where a source actually has one.
                                An invented figure would be the worst thing here. */}
                            {product.priceInr !== undefined ? (
                              <span className="price">₹{product.priceInr}</span>
                            ) : (
                              <span className="price unknown">price unavailable</span>
                            )}
                            {product.discount !== undefined ? (
                              <span className="deal">{Math.round(product.discount * 100)}% off</span>
                            ) : null}
                          </span>
                        </div>
                        <span className="row-add"><PlusIcon size={15} /></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {list.search.degraded ? (
                <p className="notice">
                  <AlertIcon size={15} />
                  Showing offline results only — the product database is unreachable.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        <Suggestions
          suggestions={list.suggestions}
          onAdd={(suggestion) =>
            list.dispatch({
              kind: 'add',
              item: {
                name: suggestion.name,
                canonicalId: suggestion.canonicalId,
                quantity: { value: 1, unit: 'piece' },
                category: suggestion.category,
                confidence: 1,
              },
              source: 'suggestion',
            })
          }
        />

        <div className="notices">
          {!list.supported ? (
            <p className="notice warn">
              <KeyboardIcon size={16} />
              This browser can’t listen — Firefox ships speech recognition switched off. Typing works
              exactly the same.
            </p>
          ) : null}
          {list.lastError !== null ? (
            <p className="notice warn">
              <AlertIcon size={16} />
              {list.lastError.message}
            </p>
          ) : null}
          {list.recognitionMode === 'on-device' ? (
            <p className="notice info">
              <DeviceIcon size={16} />
              Recognition is running on your device.
            </p>
          ) : null}
        </div>
      </aside>
      </div>

      <div className="toasts" aria-live="polite">
        {list.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span>{toast.message}</span>
            {toast.undoable ? (
              <button
                type="button"
                onClick={() => {
                  list.dispatch({ kind: 'undo' })
                  list.dismissToast(toast.id)
                }}
              >
                <UndoIcon size={15} />
                Undo
              </button>
            ) : null}
            <button
              type="button"
              className="dismiss"
              aria-label="Dismiss"
              onClick={() => list.dismissToast(toast.id)}
            >
              <CloseIcon size={15} />
            </button>
          </div>
        ))}
      </div>

    </div>
  )
}

/** Remaining-count ring — progress without a bar taking up a whole row. */
function Progress({ done, total }: { readonly done: number; readonly total: number }) {
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const fraction = total === 0 ? 0 : done / total

  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} collected`}
    >
      <svg viewBox="0 0 44 44">
        <circle className="track" cx="22" cy="22" r={radius} />
        <circle
          className="value"
          cx="22"
          cy="22"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span>{total - done}</span>
    </div>
  )
}
