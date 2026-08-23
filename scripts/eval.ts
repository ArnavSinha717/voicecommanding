/**
 * Ablation harness.
 *
 * Answers one question: does each layer we added actually improve the output, or
 * does it just add complexity and new failure modes? Every configuration is run
 * over the same public data and reported side by side, so components earn their
 * place on evidence or get removed.
 *
 * Data: MASSIVE (Amazon, CC BY 4.0) — 16,521 utterances per locale, professionally
 * localised from SLURP. We did not author any of it, which is the point: a corpus
 * we wrote ourselves could not tell us anything we had not already assumed.
 *
 * Two metrics, measuring opposite failure modes:
 *
 *   RECALL      of the 793 `lists` utterances, how many get a plausible command?
 *   PRECISION   of the 15,728 out-of-domain utterances ("wake me up at five am",
 *               "what's the weather"), how many wrongly trigger one?
 *
 * Reporting only the first would reward a parser that fires on everything.
 * Loosening the matcher almost always trades one against the other, and the whole
 * purpose of this script is to make that trade visible rather than assumed.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ItemResolver, type ResolverConfig, DEFAULT_WEIGHTS } from '../src/domain/resolve/resolver.ts'
import { parseTranscript } from '../src/domain/parser/parse.ts'
import type { CommandKind } from '../src/domain/types.ts'

const DATA_DIR = join(import.meta.dirname, '..', 'data-raw', '1.1', 'data')

interface MassiveRow {
  readonly id: string
  readonly locale: string
  readonly partition: 'train' | 'dev' | 'test'
  readonly scenario: string
  readonly intent: string
  readonly utt: string
  readonly annot_utt: string
}

function loadLocale(locale: string): MassiveRow[] {
  return readFileSync(join(DATA_DIR, `${locale}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as MassiveRow)
}

/**
 * MASSIVE's list intents do not line up cleanly with ours.
 *
 * `lists_createoradd` conflates creating a named list ("create a new to do list")
 * with adding an item to one ("put bread on the grocery list"); `lists_remove`
 * likewise covers deleting a whole list and removing a single item. We only
 * implement the item-level halves, so the mapping is to a coarse *family* and the
 * label noise is reported rather than hidden.
 */
const INTENT_FAMILY: Readonly<Record<string, readonly CommandKind[]>> = {
  lists_createoradd: ['add'],
  lists_remove: ['remove', 'clear'],
  lists_query: ['search'],
}

interface Metrics {
  readonly label: string
  readonly inDomainTotal: number
  readonly inDomainFired: number
  readonly inDomainCorrectFamily: number
  readonly outOfDomainTotal: number
  readonly outOfDomainFalsePositives: number
  readonly medianLatencyMs: number
  readonly p95LatencyMs: number
  /** In-domain adds that matched a real catalog entry. */
  readonly resolvedToCatalog: number
  /** In-domain adds that fell through to open-vocabulary passthrough. */
  readonly openVocabulary: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

function evaluate(label: string, config: ResolverConfig, rows: readonly MassiveRow[]): Metrics {
  const resolver = new ItemResolver(config)
  const latencies: number[] = []

  let inDomainTotal = 0
  let inDomainFired = 0
  let inDomainCorrectFamily = 0
  let outOfDomainTotal = 0
  let outOfDomainFalsePositives = 0
  let resolvedToCatalog = 0
  let openVocabulary = 0

  for (const row of rows) {
    const result = parseTranscript(row.utt, { resolver, listVersion: 1 })
    latencies.push(result.latencyMs)

    const kind = result.commands[0]?.kind ?? 'unknown'
    const fired = kind !== 'unknown'

    if (row.scenario === 'lists') {
      inDomainTotal += 1
      if (fired) inDomainFired += 1
      // Once unknown items pass through, every high-precision rule fires whether
      // or not the catalog recognised anything — so `fired` alone can no longer
      // separate the resolver configurations. Resolution quality is what they
      // actually differ on, so it is measured directly.
      const command = result.commands[0]
      if (command?.kind === 'add') {
        if (command.item.category === 'other' && command.item.confidence === 0.4) openVocabulary += 1
        else resolvedToCatalog += 1
      }
      const expected = INTENT_FAMILY[row.intent]
      if (expected !== undefined && expected.includes(kind)) inDomainCorrectFamily += 1
    } else {
      // Anything outside the lists scenario is a command a shopping app must not
      // act on. No label mapping needed, so this half of the benchmark is clean.
      outOfDomainTotal += 1
      if (fired) outOfDomainFalsePositives += 1
    }
  }

  latencies.sort((a, b) => a - b)
  return {
    label,
    inDomainTotal,
    inDomainFired,
    inDomainCorrectFamily,
    outOfDomainTotal,
    outOfDomainFalsePositives,
    medianLatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    resolvedToCatalog,
    openVocabulary,
  }
}

const base = { weights: DEFAULT_WEIGHTS, minScore: 0.35, fuzzyThreshold: 0.84 }

/** Each config adds exactly one capability to the one above it. */
const CONFIGS: ReadonlyArray<{ label: string; config: ResolverConfig }> = [
  { label: 'A  exact only', config: { ...base, useFuzzy: false, usePhonetic: false, useNBest: false } },
  { label: 'B  + fuzzy', config: { ...base, useFuzzy: true, usePhonetic: false, useNBest: false } },
  { label: 'C  + phonetic', config: { ...base, useFuzzy: false, usePhonetic: true, useNBest: false } },
  { label: 'D  fuzzy + phonetic', config: { ...base, useFuzzy: true, usePhonetic: true, useNBest: false } },
]

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '  n/a'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function report(locale: string, partition: string | null): void {
  const all = loadLocale(locale)
  const rows = partition === null ? all : all.filter((r) => r.partition === partition)

  const listsCount = rows.filter((r) => r.scenario === 'lists').length
  console.log(
    `\n${'='.repeat(78)}\n${locale}  partition=${partition ?? 'all'}  ` +
      `${rows.length} utterances (${listsCount} in-domain, ${rows.length - listsCount} out-of-domain)\n${'='.repeat(78)}`,
  )
  console.log(
    'config                 fired   family-ok   false-pos   resolved   open-vocab      p95',
  )
  console.log('-'.repeat(78))

  for (const { label, config } of CONFIGS) {
    const m = evaluate(label, config, rows)
    console.log(
      `${label.padEnd(22)} ${pct(m.inDomainFired, m.inDomainTotal).padStart(6)}` +
        `  ${pct(m.inDomainCorrectFamily, m.inDomainTotal).padStart(9)}` +
        `  ${pct(m.outOfDomainFalsePositives, m.outOfDomainTotal).padStart(9)}` +
        `  ${String(m.resolvedToCatalog).padStart(8)}` +
        `  ${String(m.openVocabulary).padStart(10)}` +
        `  ${m.p95LatencyMs.toFixed(3).padStart(6)}ms`,
    )
  }
}

console.log(`
Ablation over MASSIVE (Amazon Science, CC BY 4.0).

  fired      in-domain utterances that produced any command   (higher is better)
  family-ok  in-domain utterances mapped to the right family  (higher is better)
  false-pos  out-of-domain utterances that wrongly fired      (LOWER is better)
  resolved   in-domain adds matched to a real catalog entry   (higher is better)
  open-vocab in-domain adds passed through unrecognised       (lower is better)

Label noise, stated up front: MASSIVE's lists_createoradd merges "create a new
to-do list" with "put bread on the grocery list", and lists_query is mostly
read-back requests we do not implement. family-ok is therefore a floor, not a
ceiling. false-pos carries no such caveat and is the metric to trust.`)

report('en-US', 'test')
report('en-US', null)
report('hi-IN', 'test')
