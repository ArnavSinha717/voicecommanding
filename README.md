# Voice Shopping List

Add to your shopping list by speaking, in English or Hindi. Works offline, works
without a microphone, and works when the AI is unavailable.

**Live:** https://unthinkable-a1dw3evzj-arnavsinha1602-3835s-projects.vercel.app

```bash
npm install
npm run dev          # http://localhost:5173
```

No account, no API key, no configuration required to run it.

---

## What this is

A voice-driven shopping list that parses natural speech into structured commands —
`"add two litres of milk"`, `"take bread off the list"`, `"do litre doodh add karo"` —
categorises items, tracks quantities with real unit arithmetic, suggests what you
are likely running low on, and searches a real product catalogue with real prices.

The interesting part is not the feature list. It is that **every claim below is
measured**, and the numbers are reproducible with one command.

---

## The short version

Most voice list apps do this:

```js
if (transcript.includes('add')) { addItem(transcript.replace('add', '')) }
```

That fails on `"add 2 bottles of water"` (item becomes *"2 bottles of water"*),
on `"take milk off the list"` (a removal with no removal verb), and on
`"don't add milk"` (it adds the milk).

This one uses an anchored grammar with slot extraction, an item resolver grounded
in a 2,115-item catalogue derived from real retail data, and an LLM only for the
tail — measured, so we know exactly how much each layer is worth.

---

## Architecture

Recognition, storage, product search and the language model are all **ports**. The
domain is pure TypeScript with no browser imports, which is what makes any of it
testable.

```mermaid
graph TD
    subgraph Browser
        UI[React UI]
        UI --> HOOK[useShoppingList]
    end

    subgraph "Domain — pure TypeScript, no browser APIs"
        HOOK --> PARSE[Parser<br/>grammar + slots]
        PARSE --> RESOLVE[Resolver<br/>catalogue matching]
        RESOLVE --> REDUCE[Reducer<br/>list state + undo]
        HOOK --> SUGGEST[Suggestions<br/>Bayesian replenishment]
    end

    subgraph Ports
        SP[SpeechPort]
        CP[CatalogPort]
        LP[LlmPort]
        STP[StoragePort]
    end

    HOOK -.-> SP
    HOOK -.-> CP
    HOOK -.-> LP
    HOOK -.-> STP

    SP --> WSA[Web Speech API]
    SP --> FSA[FakeSpeechAdapter<br/>tests + eval]
    CP --> LOCAL[Local catalogue<br/>offline, ₹ prices]
    CP --> OFF[Open Food Facts]
    STP --> LS[localStorage]
    LP --> PROXY["/api/llm<br/>server-side key"]
    PROXY --> GEM[Gemini]

    style PARSE fill:#e8f2ec
    style RESOLVE fill:#e8f2ec
    style REDUCE fill:#e8f2ec
    style SUGGEST fill:#e8f2ec
```

### Why ports, specifically

Not architectural taste — a hard constraint. **The Web Speech API cannot run in a
test environment.** Chrome streams audio to Google's servers using API keys
compiled into the official binary; Chromium ships without them and throws
`error: 'network'`. Playwright drives bundled Chromium, and jsdom has no
implementation at all.

So recognition *had* to be injectable, or the application could not be tested.
Everything else follows from that one fact. This is the Humble Object pattern: the
adapter holds the untestable API surface and contains no logic.

A second constraint shapes the design. `SpeechGrammarList` and JSGF are inert —
the spec states grammar features "have no effect on speech recognition services".
There is no hotword biasing and no vocabulary injection, so **domain knowledge
cannot be pushed into the recogniser** and must be applied to the transcript
afterwards.

---

## How an utterance is handled

```mermaid
flowchart TD
    A["🎙 utterance"] --> B[normalise<br/>strip framing, transliterate, expand]
    B --> C{compositional?<br/>'making pasta for six'}
    C -->|yes| AGENT[Agent<br/>tool loop → proposal]
    C -->|no| D[Grammar<br/>20 anchored rules]
    D --> E{confident?<br/>margin vs runner-up}
    E -->|yes, ~1ms| F[Command]
    E -->|no| G[LLM fallback<br/>schema-constrained]
    G --> F
    F --> H[Resolve against catalogue]
    H --> I{known item?}
    I -->|yes| J[canonical merge<br/>category + price]
    I -->|no| K["add it anyway<br/>category 'other'"]
    J --> L[Reducer]
    K --> L
    AGENT --> M[Confirmation card<br/>user accepts or rejects]

    style D fill:#e8f2ec
    style F fill:#e8f2ec
    style K fill:#fff4e0
```

Three decisions in that diagram are worth calling out.

**Escalation uses the *margin*, not a threshold.** Two interpretations both scoring
well is genuine ambiguity, which an absolute cutoff waves straight through.
`"add milk to my shopping list"` never escalates — adding milk must never wait on a
network call or spend quota.

**Unknown items are added, not refused.** A catalogue is always smaller than what
people say. `"add chia seeds"` and `"add zorblex crunch bars"` both work; the second
lands under *Other* with lower confidence, flagged in the UI. Resolution *enriches*,
it does not *validate*.

**The agent proposes, it never mutates.** Its three tools are read-only by
construction — there is no write tool for a model to reach for, which makes prompt
injection through a product name inert.

---

## Measured results

Everything here is reproducible:

```bash
npm run eval          # ablation over MASSIVE
npm run eval:errors   # per-rule precision + error analysis
```

Evaluated on **MASSIVE** (Amazon Science, CC BY 4.0) — 16,521 real assistant
utterances per locale, professionally localised. None of it was written by me,
which is the point: a corpus you author yourself cannot tell you anything you had
not already assumed.

**Held-out test split, en-US** (142 in-domain, 2,832 out-of-domain):

| Configuration | fired | correct family | false positives | resolved | p95 |
|---|---|---|---|---|---|
| exact match only | 25.4% | 23.2% | 1.8% | 5 | 0.04ms |
| **+ fuzzy** | **25.4%** | **23.2%** | **1.8%** | **8** | 3.0ms |
| + phonetic | 25.4% | 23.2% | 1.8% | 5 | 0.03ms |

**hi-IN test split** — every Hindi command that fires is correct:

| Configuration | fired | correct family | false positives |
|---|---|---|---|
| exact match only | 23.9% | 23.9% | 2.1% |
| **+ fuzzy** | **23.9%** | **23.9%** | **2.1%** |

### What the numbers mean

**False positives are the metric to trust.** The 15,728 out-of-domain utterances
need no label mapping — they are alarms, music and weather, and a shopping list
must not act on any of them. Early versions fired on 5.1% of them, resolving
*"put on some coldplay"* to **eggs** and *"remove the alarm"* to **potato**. That is
now 1.8%, and a chunk of the remainder is benchmark artifact rather than bug:
*"I need coffee"* is labelled `iot_coffee`, but in a dedicated shopping app adding
coffee is correct.

**Recall is deliberately not optimised further.** Of the 793 `lists` utterances,
160 are list-level operations, 299 are read-back queries, and much of the rest is
not grocery at all — *"remove events from my list"*, *"delete the first item"*.
Chasing that number would be benchmark-gaming, not product work. MASSIVE is an
excellent false-positive benchmark and a weak recall benchmark for this specific
product, and it is reported that way.

### Phonetic matching was built, measured, and rejected

Double Metaphone is a standard technique for exactly this problem. It is
implemented here and **switched off by default**, because it buys +0.5pp recall
for +0.1pp false positives — and because MASSIVE is written text, so it contains
no acoustic errors at all. The benchmark can measure phonetic matching's *cost*
but structurally cannot measure its *benefit*. Shipping a component whose upside
is unmeasurable and whose downside is measured is a bad trade.

The code stays so the ablation row reproduces.

---

## Every number has a source

There are no invented constants in this codebase. Each is either derived from a
public dataset or tuned against a held-out split.

| Value | Source |
|---|---|
| Catalogue: 2,115 items, categories, ₹ prices, discounts | BigBasket, 27,555 real SKUs → `npm run build:catalog` |
| Item frequency priors | log-normalised SKU count |
| Replenishment priors (produce 12.6d, dairy 13.7d, household 26.4d) | Instacart, 32.4M order-product rows → `npm run build:priors` |
| Category complements (lift) | Instacart basket co-occurrence, min. support 200 |
| Intent rule confidences | **measured precision** on MASSIVE train, not hand-set |
| Fuzzy match threshold (0.90) | boundary between observed recoveries and mis-resolutions |
| Verb inventories | MASSIVE frequency (remove 95, delete 58, erase 11…) |
| Framing prefixes | MASSIVE frequency ("please" 962, "can you" 436) |

The fuzzy threshold is pinned at the boundary between fuzzy matches that recover a
near miss and ones that answer confidently with the wrong item:

```
REJECT   water → wafer 0.893  ·  rap → grape 0.867  ·  opinion → onion 0.854
ACCEPT   brede → bread 0.907  ·  panner → paneer 0.922  ·  tomatoe → tomato 0.971
```

A mis-resolution is worse than no resolution, because the open-vocabulary path
would otherwise have added exactly what was said. Both sides are pinned by tests.

`npm run tune:threshold` originally derived this from a sweep against a
pre-registered false-positive bound. It no longer discriminates, and the script
says so: once unknown items pass through, every high-precision rule fires whether
or not resolution succeeded, so fire rate stopped responding to the threshold.
What it actually governs is *which item* you get, and MASSIVE carries no
item-level labels to score that against.

### The one hand-authored file

`src/data/aliases.ts` maps romanised Hindi to catalogue items — `doodh` → milk,
`tamatar` → tomato. No public dataset provides this. MASSIVE `hi-IN` is Devanagari
with no item-level slot annotation, L3Cube-HingCorpus is unlabelled, and product
catalogues list *"Amul Taaza Toned Milk 500ml"* but never *"doodh"*.

It contains word equivalences and **zero numbers**, and says so at the top.

---

## Multilingual

Hindi is verb-final, so every English-anchored rule structurally cannot match it —
`सूची से अंडे हटाओ` is *[list] se [item] remove*. Before dedicated SOV rules existed,
hi-IN scored **0.0%** across every configuration. That gap was invisible until the
system met real Hindi data.

Transliteration handles the details that matter:

| Input | Becomes | Why it matters |
|---|---|---|
| `दूध` | `doodh` | Word-final schwa deletion — not `doodha` |
| `शॉपिंग` | `shoping` | Candra vowel `ॉ`, used for loanwords |
| `ख़रीददारी` | `khareedadaaree` | Nukta letters exist pre- and decomposed; NFD folds both |
| `doodh` / `dudh` | one entry | Long-vowel folding |

So `दूध`, `doodh`, `dudh` and `milk` all reach the same row instead of splitting a
Hinglish speaker's list into four.

---

## Testing

```bash
npm test              # 269 tests
npm run verify        # typecheck + lint + test + build
```

**93.6% statements, 96.2% lines** across the domain.

Property-based tests (fast-check) found three bugs that example tests structurally
could not:

- **The app rendered a quantity it could not parse.** `formatQuantity` produced
  `"1kg"`; `parseQuantity` could not read it back. Typing `"add 500g paneer"`
  silently dropped the quantity.
- **Undo lost the checked state.** *Check an item off → remove it → undo → it
  returns unchecked.* Undo replayed an *inverse command*, and `remove`'s inverse
  was an `add`, which creates a fresh row. Inverse commands cannot express an
  operation that changes several fields at once. Replaced with a snapshot.
- **Rare Devanagari marks survived transliteration**, reaching the matcher as
  codepoints no alias could contain.

The parser is proven **total** over ~2,000 generated adversarial inputs: never
throws, always returns a well-formed command, confidence always within [0,1],
always deterministic. Injection-shaped payloads (`{"kind":"clear"}`, `<script>`,
`DROP TABLE`) are inert, because commands are values produced by a grammar and are
never strings evaluated anywhere.

### The secret-leak guard

`tests/config.leak.test.ts` runs a real production build with canary values
planted in every plausible `VITE_*` variable and asserts none reach the bundle.

This guards a real regression. An earlier revision read the model key from
`import.meta.env.VITE_GEMINI_API_KEY`; Vite inlines those at build time, so the key
appeared verbatim in the shipped JavaScript. A code review would not reliably catch
a reintroduction — `import.meta.env.VITE_ANYTHING` looks like ordinary
configuration, and only the build output reveals the problem. So the build itself
is the assertion.

---

## Deployment

Static SPA plus one function. No database, no auth, no sessions.

```bash
vercel env add GEMINI_API_KEY production    # optional
npm run verify && vercel deploy --prod
```

`api/llm.ts` holds the key server-side. It is deliberately **not** a passthrough —
a naive proxy is an open, anonymous, free LLM for anyone who finds the URL. The
client selects an *operation*, never a prompt; system prompts, tool definitions and
token ceilings all live server-side, and requests are rate limited per IP.

**The app is fully functional with no key.** Voice, list, categories, quantities,
suggestions and search all work; only the LLM fallback and the agent route are
unavailable, and the UI says so rather than failing silently.

---

## Known limitations

Stated plainly, because pretending otherwise would be worse.

- **Seasonal suggestions are not implemented.** The brief asks for them and no open
  dataset maps produce to months; Instacart has day-of-week but no calendar date.
  Rather than hand-author a season table, the gap is left open. *"On sale"* is
  implemented, because BigBasket carries both marked and selling price so discount
  is measurable.
- **Substitutes are same-category nearest-by-frequency.** A real substitute graph
  needs product-level co-occurrence, and this dataset is too sparse at item level.
- **Hinglish is measured on a proxy.** No labelled code-mixed corpus exists for
  list intents. Devanagari Hindi is measured on MASSIVE's real held-out split;
  romanised Hinglish relies on deterministic transliteration.
- **The catalogue is Indian retail.** Regionally accurate, but a US or European
  shopper will hit the open-vocabulary path more often.
- **Rate limiting is per-instance and in-memory.** A speed bump against casual
  abuse, not a guarantee. A durable store is the real answer.
- **The 10ms Cloudflare / 60s Vercel function limits** were both verified against
  current documentation rather than assumed.

---

## Approach

> Speech recognition is the constraint that shapes everything. The Web Speech API
> cannot run in any test environment — Chromium lacks Google's API keys — so
> recognition had to become an injected port before a single feature could be
> verified. That one fact produced the whole architecture.
>
> I decided early that claims would be measured, not asserted. Rather than write my
> own test corpus, which can only confirm what I already assumed, I evaluated
> against MASSIVE: 16,521 real assistant utterances I did not author. Its 15,728
> out-of-domain utterances became a false-positive benchmark, and the first run was
> humbling — the parser resolved "put on some coldplay" to eggs.
>
> Every constant is derived. Item catalogue and prices from 27,555 BigBasket SKUs;
> replenishment priors fitted to 32.4M Instacart order rows; intent confidences are
> measured rule precision; the fuzzy threshold came from a sweep against a
> pre-registered constraint. Phonetic matching was implemented, measured, and
> switched off — the benchmark could measure its cost but not its benefit.
>
> Hindi needed verb-final rules; before them it scored 0.0%. Property-based testing
> found three bugs example tests could not, including undo silently losing an item's
> checked state.

_(197 words)_

---

## Data sources and licences

| Dataset | Licence | Used for |
|---|---|---|
| [MASSIVE](https://github.com/alexa/massive) (Amazon Science) | CC BY 4.0 | Evaluation, verb and framing frequencies |
| [BigBasket Products](https://www.kaggle.com/datasets/surajjha101/bigbasket-entire-product-list-28k-datapoints) | CC BY-NC-SA 4.0 | Catalogue, categories, ₹ prices, discounts |
| [Instacart 2017](https://www.instacart.com/datasets/grocery-shopping-2017) | CC0 mirror; original terms non-commercial | Replenishment priors, complement lift |
| [Open Food Facts](https://world.openfoodfacts.org/) | ODbL | Live product search |

**Non-commercial use only**, inherited from BigBasket and Instacart. Share-alike
propagates to the derived files in `src/data/*.generated.json`.

Raw datasets (1.4 GB) are not committed. Regenerate with:

```bash
kaggle datasets download -d surajjha101/bigbasket-entire-product-list-28k-datapoints --unzip -p data-raw/bigbasket
kaggle datasets download -d psparks/instacart-market-basket-analysis --unzip -p data-raw/instacart
curl -sSL -o data-raw/massive.tar.gz https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz

npm run build:catalog && npm run build:priors
```

---

## Project layout

```
src/
  domain/          pure TypeScript — no browser or React imports
    parser/        normalisation, intent grammar, LLM fallback
    resolve/       phonetic index, distance metrics, linear scorer
    list/          reducer, undo, unit ontology
    recommend/     Bayesian replenishment, complements, deals
    agent/         compositional planning, read-only tools
  ports/           SpeechPort · CatalogPort · LlmPort · StoragePort
  adapters/        Web Speech, Fake, Open Food Facts, localStorage, proxy
  data/            generated artifacts + the one hand-authored alias file
  ui/              React
api/llm.ts         server-side model proxy
scripts/           eval harness, ablation, dataset derivation, threshold sweep
```

Dependencies are deliberately minimal: React, Zod, `double-metaphone`. Styling is
plain CSS with custom properties — no utility framework.
