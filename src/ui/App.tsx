/**
 * Application shell.
 *
 * Mobile-first and one-thumb: the list occupies the screen, the microphone sits
 * where a thumb rests, and a text field is always present rather than hidden
 * behind a fallback. Roughly a third of browsers cannot do speech recognition at
 * all — Firefox ships it disabled — so typing is a first-class path, not an
 * apology.
 */

import { useMemo, useState, type FormEvent } from 'react'

import type { Category, Item } from '../domain/types'
import { formatQuantity } from '../domain/units'
import { LANGUAGES, useShoppingList, type MicState } from './useShoppingList'
import type { SpeechPort } from '../ports/speech'
import type { StoragePort } from '../ports/storage'
import type { CatalogPort } from '../ports/catalog'
import type { LlmPort } from '../ports/llm'
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

/** Fixed order, so the list does not reshuffle as categories come and go. */
const CATEGORY_ORDER: readonly Category[] = [
  'produce', 'dairy', 'bakery', 'meat', 'frozen', 'pantry',
  'beverages', 'snacks', 'household', 'personal-care', 'other',
]

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

  const outstanding = list.state.items.filter((item) => !item.checked).length

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
          <p className="subtitle">
            {list.state.items.length === 0
              ? 'Nothing yet'
              : `${outstanding} to get · ${list.state.items.length} total`}
          </p>
        </div>
        <label className="language">
          <span className="visually-hidden">Voice language</span>
          <select
            value={list.language}
            onChange={(event) => list.setLanguage(event.target.value)}
          >
            {LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className="list" aria-label="Shopping list">
        {list.state.items.length === 0 ? (
          <div className="empty">
            <p>Say what you need, or type it.</p>
            <ul className="examples">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => list.submitText(example)}>
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          grouped.map(({ category, items }) => (
            <section key={category} className="group">
              <h2>{CATEGORY_LABELS[category]}</h2>
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
                      <span className="name">{item.name}</span>
                      {item.quantity.value !== 1 || item.quantity.unit !== 'piece' ? (
                        <span className="quantity">{formatQuantity(item.quantity)}</span>
                      ) : null}
                      {/* Low confidence is surfaced rather than hidden: the user
                          is the only one who can confirm a doubtful match. */}
                      {item.confidence < 0.6 ? (
                        <span className="uncertain" title="Not sure I heard this right">
                          ?
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
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </main>

      {list.agent.thinking || list.agent.proposal !== null || list.agent.failed ? (
        <section className="proposal" aria-label="Suggested plan">
          {list.agent.thinking ? (
            <p className="notice">Working out what you need…</p>
          ) : list.agent.failed ? (
            <p className="notice error">
              I couldn’t plan that one. Try naming the items instead.
              <button type="button" onClick={list.rejectProposal}>
                Dismiss
              </button>
            </p>
          ) : (
            <>
              {/* The agent proposes; it never applies its own work. Nothing is
                  added until this is accepted. */}
              <h2>{list.agent.proposal?.summary}</h2>
              <ul>
                {list.agent.proposal?.items.map((proposed) => (
                  <li key={proposed.canonicalId}>
                    <span className="proposed-name">
                      {proposed.quantity > 1 ? `${proposed.quantity} × ` : null}
                      {proposed.name}
                    </span>
                    {proposed.reason !== '' ? (
                      <span className="proposed-reason">{proposed.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
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
        <section className="results" aria-label="Search results">
          <header>
            <h2>
              Results for “{list.search.query.text}”
              {list.search.query.maxPrice !== undefined ? ` under ₹${list.search.query.maxPrice}` : null}
            </h2>
            <button type="button" onClick={list.clearSearch}>
              Close
            </button>
          </header>

          {list.search.loading ? (
            /* Skeletons rather than a spinner: the row count is known, so the
               layout does not jump when results land. */
            <ul className="skeletons" aria-busy="true">
              {[0, 1, 2].map((row) => (
                <li key={row} />
              ))}
            </ul>
          ) : list.search.results.length === 0 ? (
            <p className="notice">Nothing matched. Try fewer words.</p>
          ) : (
            <ul>
              {list.search.results.map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => {
                      list.submitText(`add ${product.name}`)
                      list.clearSearch()
                    }}
                  >
                    <span className="result-name">{product.name}</span>
                    <span className="result-meta">
                      {product.brand !== undefined ? <span>{product.brand}</span> : null}
                      {product.size !== undefined ? <span>{product.size}</span> : null}
                      {/* Price is shown only where a source actually has one.
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
                  </button>
                </li>
              ))}
            </ul>
          )}

          {list.search.degraded ? (
            <p className="notice subtle">
              Showing offline results only — the product database is unreachable.
            </p>
          ) : null}
        </section>
      ) : null}

      {list.suggestions.length > 0 ? (
        <section className="suggestions" aria-label="Suggestions">
          <h2>You might need</h2>
          <ul>
            {list.suggestions.map((suggestion) => (
              <li key={suggestion.canonicalId}>
                <button
                  type="button"
                  onClick={() =>
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
                >
                  <span className="suggestion-name">{suggestion.name}</span>
                  {/* Every suggestion states why it is here. An unexplained one
                      reads as the app guessing at you. */}
                  <span className="suggestion-reason">{suggestion.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Transcript is announced politely so screen-reader users get the same
          real-time feedback sighted users get from watching it appear. */}
      <div className="transcript" aria-live="polite">
        {list.interimTranscript !== '' ? `“${list.interimTranscript}”` : null}
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
                Undo
              </button>
            ) : null}
            <button
              type="button"
              className="dismiss"
              aria-label="Dismiss"
              onClick={() => list.dismissToast(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <footer className="composer">
        <form onSubmit={onSubmit}>
          <input
            type="text"
            value={draft}
            placeholder="Type an item…"
            aria-label="Type a command"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="send" disabled={draft.trim() === ''}>
            Add
          </button>
        </form>

        <button
          type="button"
          className={`mic ${list.micState}`}
          aria-label={MIC_LABEL[list.micState]}
          aria-pressed={list.micState === 'listening'}
          disabled={!list.supported}
          onClick={() => (list.micState === 'listening' ? list.stopListening() : list.listen())}
        >
          {/* Ring scales with input level, so the user can see the mic is
              actually hearing them rather than trusting a static icon. */}
          <span
            className="level"
            style={{ transform: `scale(${1 + list.audioLevel * 0.6})` }}
            aria-hidden="true"
          />
          <span className="glyph" aria-hidden="true">
            {list.micState === 'thinking' ? '…' : '●'}
          </span>
        </button>
      </footer>

      {!list.supported ? (
        <p className="notice">
          This browser can’t listen — Firefox ships speech recognition switched off. Typing works
          exactly the same.
        </p>
      ) : null}
      {list.lastError !== null ? <p className="notice error">{list.lastError.message}</p> : null}
      {list.recognitionMode === 'on-device' ? (
        <p className="notice subtle">Recognition is running on your device.</p>
      ) : null}
    </div>
  )
}
