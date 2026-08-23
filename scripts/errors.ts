/**
 * Error analysis for the ablation.
 *
 * Aggregate rates say a configuration is worse; they do not say why. This prints
 * the actual utterances behind each number so the failure modes can be named.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ItemResolver, DEFAULT_CONFIG } from '../src/domain/resolve/resolver.ts'
import { parseTranscript } from '../src/domain/parser/parse.ts'

const DATA_DIR = join(import.meta.dirname, '..', 'data-raw', '1.1', 'data')

interface Row {
  partition: string
  scenario: string
  intent: string
  utt: string
  annot_utt: string
}

const rows: Row[] = readFileSync(join(DATA_DIR, 'en-US.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Row)

// Use the shipping configuration, so error analysis reflects what users get.
const resolver = new ItemResolver(DEFAULT_CONFIG)

const parse = (utt: string) => parseTranscript(utt, { resolver, listVersion: 1 })

// ---------------------------------------------------------------------------
// How much of the `lists` scenario is even addressable by this product?
// ---------------------------------------------------------------------------
const lists = rows.filter((r) => r.scenario === 'lists')

/**
 * MASSIVE conflates list-level and item-level operations under one intent.
 * "create a new to do list" manages a list; "put bread on the grocery list"
 * manages an item. We only implement the latter, so recall over the whole
 * scenario understates performance on the part we actually target.
 */
function isListLevel(utt: string): boolean {
  return /\b(create|make|start|prepare|new|delete|remove|clean|clear)\b[^.]*\blists?\b/.test(utt)
    && !/\b(from|off|on|to)\b.*\blists?\b/.test(utt)
}

const listLevel = lists.filter((r) => isListLevel(r.utt))
const queries = lists.filter((r) => r.intent === 'lists_query')
const addressable = lists.filter((r) => !isListLevel(r.utt) && r.intent !== 'lists_query')

console.log('=== composition of the 793 `lists` utterances ===')
console.log(`  list-level ops (create/delete a whole list) : ${listLevel.length}`)
console.log(`  read-back queries (not implemented)         : ${queries.length}`)
console.log(`  addressable item-level operations           : ${addressable.length}`)

const addressableFired = addressable.filter((r) => parse(r.utt).commands[0]?.kind !== 'unknown')
console.log(
  `\n  recall on the addressable subset: ${addressableFired.length}/${addressable.length}` +
    ` = ${((addressableFired.length / addressable.length) * 100).toFixed(1)}%`,
)

console.log('\n=== addressable utterances we MISS (first 25) ===')
for (const r of addressable.filter((x) => parse(x.utt).commands[0]?.kind === 'unknown').slice(0, 25)) {
  console.log(`  [${r.intent}] ${r.utt}`)
}

// ---------------------------------------------------------------------------
// Are the out-of-domain fires garbage, and does phonetic matching cause them?
// ---------------------------------------------------------------------------
const ood = rows.filter((r) => r.scenario !== 'lists')

console.log('\n=== out-of-domain FALSE POSITIVES (first 30) ===')
let shown = 0
for (const r of ood) {
  const result = parse(r.utt)
  const command = result.commands[0]
  if (command === undefined || command.kind === 'unknown') continue
  const resolved =
    command.kind === 'add'
      ? command.item.canonicalId
      : 'target' in command
        ? command.target.canonicalId
        : '-'
  console.log(
    `  [${r.scenario}/${r.intent}] "${r.utt}"\n       -> ${command.kind} ${resolved}  (rule ${result.matchedRule}, conf ${result.confidence.toFixed(2)})`,
  )
  if ((shown += 1) >= 30) break
}

// Which resolver stage is producing the false positives?
const stages = { exact: 0, phonetic: 0, fuzzy: 0, none: 0 }
for (const r of ood) {
  const command = parse(r.utt).commands[0]
  if (command === undefined || command.kind === 'unknown') continue
  const res = resolver.resolve(r.utt)
  stages[res?.stage ?? 'none'] += 1
}
console.log('\n=== resolver stage behind out-of-domain fires ===')
console.log(' ', stages)

// ---------------------------------------------------------------------------
// Per-rule precision.
//
// A rule's confidence should be a measured quantity, not a number someone typed.
// Precision here = in-domain fires / all fires. Rules below the keep threshold
// are costing more in false positives than they return in coverage.
// ---------------------------------------------------------------------------
const perRule = new Map<string, { inDomain: number; outOfDomain: number }>()
for (const r of rows) {
  const result = parse(r.utt)
  if (result.commands[0]?.kind === 'unknown') continue
  const rule = result.matchedRule ?? '(none)'
  const bucket = perRule.get(rule) ?? { inDomain: 0, outOfDomain: 0 }
  if (r.scenario === 'lists') bucket.inDomain += 1
  else bucket.outOfDomain += 1
  perRule.set(rule, bucket)
}

console.log('\n=== per-rule precision (in-domain fires / all fires) ===')
const ranked = [...perRule.entries()]
  .map(([rule, b]) => ({ rule, ...b, total: b.inDomain + b.outOfDomain, precision: b.inDomain / (b.inDomain + b.outOfDomain) }))
  .sort((a, b) => a.precision - b.precision)
console.log('rule                       fires   in-dom   out-dom   precision')
for (const r of ranked) {
  console.log(
    `${r.rule.padEnd(26)} ${String(r.total).padStart(5)}  ${String(r.inDomain).padStart(7)}  ${String(r.outOfDomain).padStart(7)}   ${(r.precision * 100).toFixed(1)}%`,
  )
}
