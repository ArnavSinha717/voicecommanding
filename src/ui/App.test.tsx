// @vitest-environment jsdom
/**
 * End-to-end through the UI, without a microphone.
 *
 * This is the payoff for treating recognition as a port. The Web Speech API
 * cannot run here at all — Chromium ships without Google's API keys, so it
 * errors with `network`, and jsdom has no implementation whatsoever. Handing the
 * app a `FakeSpeechAdapter` lets the same code path that serves real users be
 * driven from scripted transcripts: deterministic, offline, milliseconds.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import App from './App'
import { FakeSpeechAdapter } from '../adapters/speech/fake'
import { MemoryStorageAdapter } from '../adapters/storage/local'
import type { CatalogPort, SearchOutcome } from '../ports/catalog'
import { FakeLlmAdapter, textTurn, toolTurn } from '../adapters/llm/fake'

/** Deterministic catalog, so search is testable without touching the network. */
class StubCatalog implements CatalogPort {
  private readonly outcome: SearchOutcome
  constructor(outcome: SearchOutcome) {
    this.outcome = outcome
  }
  search(): Promise<SearchOutcome> {
    return Promise.resolve(this.outcome)
  }
}

afterEach(cleanup)

/**
 * Default setup exercises the deterministic path with no model tier.
 *
 * An explicitly-unavailable LLM keeps these cases synchronous. The production
 * proxy reports itself *optimistically* available — whether a key is configured
 * is a server-side fact the browser cannot know until it asks — so leaving it in
 * would route ambiguous utterances through a network round-trip that jsdom
 * cannot serve. Escalation gets its own tests below, where it is the subject.
 */
function setup(...utterances: string[]) {
  const speech = new FakeSpeechAdapter().enqueue(...utterances)
  const storage = new MemoryStorageAdapter()
  render(
    <App speech={speech} storage={storage} llm={new FakeLlmAdapter({ available: false })} />,
  )
  return { speech, storage }
}

function setupWithCatalog(outcome: SearchOutcome, ...utterances: string[]) {
  const speech = new FakeSpeechAdapter().enqueue(...utterances)
  render(
    <App
      speech={speech}
      storage={new MemoryStorageAdapter()}
      catalog={new StubCatalog(outcome)}
      llm={new FakeLlmAdapter({ available: false })}
    />,
  )
  return { speech }
}

const mic = () => screen.getByRole('button', { name: /listening|microphone/i })
const list = () => screen.getByRole('main')

describe('voice input', () => {
  it('adds a spoken item to the list', () => {
    setup('add two litres of milk')
    fireEvent.click(mic())
    expect(within(list()).getByText('Milk')).toBeDefined()
    expect(within(list()).getByText('2L')).toBeDefined()
  })

  it('groups items under their derived category', () => {
    setup('add milk')
    fireEvent.click(mic())
    expect(screen.getByRole('heading', { name: 'Dairy' })).toBeDefined()
  })

  it('merges a repeated item instead of showing it twice', () => {
    const { speech } = setup('add three apples')
    fireEvent.click(mic())
    speech.enqueue('add two apples')
    fireEvent.click(mic())
    expect(within(list()).getAllByText('Apple')).toHaveLength(1)
    expect(within(list()).getByText('5')).toBeDefined()
  })

  it('accepts Hinglish', () => {
    setup('do litre doodh add karo')
    fireEvent.click(mic())
    expect(within(list()).getByText('Milk')).toBeDefined()
  })

  it('adds an item the catalog has never seen', () => {
    // Open vocabulary: a 2,479-item catalog will always be smaller than what
    // people say, and refusing the unknown is the wrong failure.
    setup('add zorblex crunch bars')
    fireEvent.click(mic())
    expect(within(list()).getByText('Zorblex Crunch Bar')).toBeDefined()
  })
})

describe('degradation', () => {
  it('offers typing when the browser cannot listen', () => {
    const speech = new FakeSpeechAdapter({ supported: false })
    render(<App speech={speech} storage={new MemoryStorageAdapter()} />)
    expect(screen.getByText(/can’t listen/i)).toBeDefined()
    expect(screen.getByLabelText('Type a command')).toBeDefined()
  })

  it('keeps working when the microphone is refused', () => {
    const speech = new FakeSpeechAdapter({
      failWith: { code: 'permission-denied', message: 'Microphone access is blocked.', recoverable: false },
    })
    render(<App speech={speech} storage={new MemoryStorageAdapter()} />)
    fireEvent.click(mic())
    expect(screen.getByText(/Microphone access is blocked/)).toBeDefined()

    fireEvent.change(screen.getByLabelText('Type a command'), { target: { value: 'add bread' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(within(list()).getByText('Bread')).toBeDefined()
  })

  it('asks for a rephrase rather than acting on speech it did not understand', () => {
    setup('put on some coldplay')
    fireEvent.click(mic())
    expect(screen.getByText(/didn't catch that/i)).toBeDefined()
    // The empty state renders its example chips as list items, so absence of a
    // checkbox is what actually proves nothing was added.
    expect(within(list()).queryByRole('checkbox')).toBeNull()
  })
})

describe('correction', () => {
  it('undoes the last change from the toast', () => {
    setup('add milk')
    fireEvent.click(mic())
    expect(within(list()).getByText('Milk')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(within(list()).queryByText('Milk')).toBeNull()
  })

  it('removes an item by tapping', () => {
    setup('add milk')
    fireEvent.click(mic())
    fireEvent.click(screen.getByRole('button', { name: 'Remove Milk' }))
    expect(within(list()).queryByText('Milk')).toBeNull()
  })

  it('checks an item off without removing it', () => {
    setup('add milk')
    fireEvent.click(mic())
    const checkbox = within(list()).getByRole('checkbox')
    fireEvent.click(checkbox)
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    expect(within(list()).getByText('Milk')).toBeDefined()
  })
})

describe('persistence', () => {
  it('restores the list on reload', () => {
    const storage = new MemoryStorageAdapter()
    const speech = new FakeSpeechAdapter().enqueue('add milk')
    const first = render(<App speech={speech} storage={storage} />)
    fireEvent.click(mic())
    first.unmount()

    render(<App speech={new FakeSpeechAdapter()} storage={storage} />)
    expect(within(list()).getByText('Milk')).toBeDefined()
  })
})

describe('empty state', () => {
  it('teaches by example', () => {
    setup()
    const example = screen.getByRole('button', { name: 'Add two litres of milk' })
    fireEvent.click(example)
    expect(within(list()).getByText('Milk')).toBeDefined()
  })
})

describe('voice search', () => {
  it('shows results with real prices for a spoken query', async () => {
    setupWithCatalog(
      {
        products: [
          { id: 'a', name: 'Organic Apple', priceInr: 169, source: 'local' },
          { id: 'b', name: 'Apple Juice', priceInr: 60, discount: 0.2, source: 'local' },
        ],
        degraded: false,
      },
      'find organic apples under 200 rupees',
    )
    fireEvent.click(mic())
    expect(await screen.findByText('Organic Apple')).toBeDefined()
    expect(screen.getByText('₹169')).toBeDefined()
    expect(screen.getByText('20% off')).toBeDefined()
  })

  it('says a price is unavailable rather than inventing one', async () => {
    // Open Food Facts carries no prices. Showing a plausible figure would be the
    // most dishonest thing this app could do.
    setupWithCatalog(
      { products: [{ id: 'off:1', name: 'Imported Preserve', source: 'openfoodfacts' }], degraded: false },
      'find preserves',
    )
    fireEvent.click(mic())
    expect(await screen.findByText('price unavailable')).toBeDefined()
  })

  it('adds a search result to the list', async () => {
    setupWithCatalog(
      { products: [{ id: 'a', name: 'Paneer', priceInr: 76, source: 'local' }], degraded: false },
      'find paneer',
    )
    fireEvent.click(mic())
    fireEvent.click(await screen.findByText('Paneer'))
    expect(within(list()).getByText('Paneer')).toBeDefined()
  })

  it('flags when only offline results are available', async () => {
    setupWithCatalog(
      { products: [{ id: 'a', name: 'Rice', priceInr: 279, source: 'local' }], degraded: true },
      'find rice',
    )
    fireEvent.click(mic())
    expect(await screen.findByText(/offline results only/i)).toBeDefined()
  })

  it('reports an empty result set plainly', async () => {
    // "find zorblex" would not fire at all — an ungrounded search is rejected
    // so "find news about brexit" cannot reach the catalog. A grounded query
    // that simply matches nothing is the case worth covering.
    setupWithCatalog({ products: [], degraded: false }, 'find paneer')
    fireEvent.click(mic())
    expect(await screen.findByText(/Nothing matched/i)).toBeDefined()
  })
})

describe('quantity entry', () => {
  it('parses a metric quantity written flush against its unit', () => {
    // Found by a round-trip property test: the app rendered "500g" and could
    // not read it back, so typing this silently dropped the quantity.
    setup()
    fireEvent.change(screen.getByLabelText('Type a command'), { target: { value: 'add 500g paneer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(within(list()).getByText('500g')).toBeDefined()
  })

  it('merges metric quantities across units', () => {
    setup()
    const input = screen.getByLabelText('Type a command')
    const send = screen.getByRole('button', { name: 'Add' })
    fireEvent.change(input, { target: { value: 'add 500g rice' } })
    fireEvent.click(send)
    fireEvent.change(input, { target: { value: 'add 1kg rice' } })
    fireEvent.click(send)
    expect(within(list()).getByText('1.5kg')).toBeDefined()
  })
})

describe('the agent route', () => {
  const proposal = JSON.stringify({
    summary: 'Adding what the pasta needs.',
    items: [{ name: 'cheese', quantity: 1, unit: 'piece', reason: 'Common topping' }],
  })

  function setupAgent(...turns: ReturnType<typeof textTurn>[]) {
    const llm = new FakeLlmAdapter({ toolResponses: turns })
    const speech = new FakeSpeechAdapter().enqueue("I'm making pasta for six, add what's missing")
    render(<App speech={speech} storage={new MemoryStorageAdapter()} llm={llm} />)
    return { llm }
  }

  it('proposes rather than adding, and waits for confirmation', async () => {
    setupAgent(toolTurn(['get_list', {}]), textTurn(proposal))
    fireEvent.click(mic())
    expect(await screen.findByText('Adding what the pasta needs.')).toBeDefined()
    // Nothing on the list until the user says so.
    expect(within(list()).queryByRole('checkbox')).toBeNull()
  })

  it('adds the proposed items only when accepted', async () => {
    setupAgent(textTurn(proposal))
    fireEvent.click(mic())
    fireEvent.click(await screen.findByRole('button', { name: 'Add all' }))
    expect(within(list()).getByText('Cheese')).toBeDefined()
  })

  it('discards the plan when rejected', async () => {
    setupAgent(textTurn(proposal))
    fireEvent.click(mic())
    fireEvent.click(await screen.findByRole('button', { name: 'No thanks' }))
    expect(screen.queryByText('Adding what the pasta needs.')).toBeNull()
    expect(within(list()).queryByRole('checkbox')).toBeNull()
  })

  it('explains itself when it cannot plan', async () => {
    const llm = new FakeLlmAdapter({ failing: true })
    const speech = new FakeSpeechAdapter().enqueue("I'm making pasta for six, add what's missing")
    render(<App speech={speech} storage={new MemoryStorageAdapter()} llm={llm} />)
    fireEvent.click(mic())
    expect(await screen.findByText(/couldn’t plan that one/i)).toBeDefined()
  })
})

describe('degrading without a model', () => {
  it('still handles ordinary commands with no provider configured', () => {
    const llm = new FakeLlmAdapter({ available: false })
    const speech = new FakeSpeechAdapter().enqueue('add two litres of milk')
    render(<App speech={speech} storage={new MemoryStorageAdapter()} llm={llm} />)
    fireEvent.click(mic())
    // The deterministic path carries the product on its own; the model tier is
    // an enhancement, never a dependency.
    expect(within(list()).getByText('Milk')).toBeDefined()
    expect(llm.completeCalls).toHaveLength(0)
  })

  it('never calls the model for a command the grammar understood', () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'bread' }] })
    const speech = new FakeSpeechAdapter().enqueue('add milk to my shopping list')
    render(<App speech={speech} storage={new MemoryStorageAdapter()} llm={llm} />)
    fireEvent.click(mic())
    expect(within(list()).getByText('Milk')).toBeDefined()
    // Adding milk must never wait on a network call or spend quota.
    expect(llm.completeCalls).toHaveLength(0)
  })

  it('escalates only when the grammar is unsure', async () => {
    const llm = new FakeLlmAdapter({ completions: [{ intent: 'add', item: 'milk' }] })
    const speech = new FakeSpeechAdapter().enqueue('we could really do with some of the white stuff')
    render(<App speech={speech} storage={new MemoryStorageAdapter()} llm={llm} />)
    fireEvent.click(mic())
    expect(await within(list()).findByText('Milk')).toBeDefined()
    expect(llm.completeCalls).toHaveLength(1)
  })
})

describe('on-device recognition is requested only when it exists', () => {
  it('does not force local processing when only cloud recognition is available', async () => {
    // `processLocally: true` forces on-device recognition. Requesting it
    // speculatively made Chrome reject any language whose pack was not
    // installed, reported to the user as "not supported" for a language the
    // cloud recogniser handles fine.
    const speech = new FakeSpeechAdapter({ mode: 'cloud' }).enqueue('add milk')
    render(
      <App speech={speech} storage={new MemoryStorageAdapter()} llm={new FakeLlmAdapter({ available: false })} />,
    )
    await waitFor(() => expect(speech.startCalls.length + 1).toBeGreaterThan(0))
    fireEvent.click(mic())
    expect(speech.startCalls[0]?.preferOnDevice).toBe(false)
  })

  it('requests local processing when a model is present', async () => {
    const speech = new FakeSpeechAdapter({ mode: 'on-device' }).enqueue('add milk')
    render(
      <App speech={speech} storage={new MemoryStorageAdapter()} llm={new FakeLlmAdapter({ available: false })} />,
    )
    // availability() is async; the mode has to land before the mic is pressed.
    await waitFor(() => expect(screen.getByText(/running on your device/i)).toBeDefined())
    fireEvent.click(mic())
    expect(speech.startCalls[0]?.preferOnDevice).toBe(true)
  })

  it('always asks for several hypotheses so reranking has something to work with', () => {
    const speech = new FakeSpeechAdapter().enqueue('add milk')
    render(
      <App speech={speech} storage={new MemoryStorageAdapter()} llm={new FakeLlmAdapter({ available: false })} />,
    )
    fireEvent.click(mic())
    expect(speech.startCalls[0]?.maxAlternatives).toBeGreaterThan(1)
  })
})
