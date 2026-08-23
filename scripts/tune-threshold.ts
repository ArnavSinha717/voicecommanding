/**
 * Sweep the fuzzy-match threshold.
 *
 * PRE-REGISTERED OBJECTIVE, fixed before looking at any result:
 *   maximise in-domain recall subject to out-of-domain false positives <= 0.3%.
 *
 * The constraint comes first because the two move together — loosening the
 * matcher always buys recall by firing on more things, so an unconstrained sweep
 * would just pick the loosest value. Writing the rule down beforehand is what
 * stops the number being chosen to flatter the result.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ItemResolver, DEFAULT_CONFIG } from '../src/domain/resolve/resolver.ts'
import { parseTranscript } from '../src/domain/parser/parse.ts'

const MAX_FALSE_POSITIVE_RATE = 0.003

/**
 * Swept per locale, because the two are not interchangeable: Hindi reaches the
 * matcher through transliteration, which introduces systematic vowel-length
 * variation ("doodh"/"dudh") that English input never has. A single value tuned
 * on English collapsed hi-IN recall from 11.3% to 2.1%, which is what surfaced
 * the need to separate them.
 */
function sweep(locale: string): void {
  const rows = readFileSync(join(import.meta.dirname, '..', `data-raw/1.1/data/${locale}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // Tune on dev only. The test partition stays untouched until the final report.
  const dev = rows.filter((r: any) => r.partition === 'dev')

  console.log(`\nsweep on ${locale} dev split (${dev.length} utterances)`)
  console.log('threshold   recall   false-pos   meets constraint')
  const results: { t: number; recall: number; fp: number }[] = []
  for (let t = 0.74; t <= 0.96001; t += 0.02) {
    const resolver = new ItemResolver({ ...DEFAULT_CONFIG, fuzzyThreshold: t })
    let inTot = 0, inFire = 0, outTot = 0, outFire = 0
    for (const r of dev) {
      const fired = parseTranscript(r.utt, { resolver, listVersion: 1 }).commands[0]?.kind !== 'unknown'
      if (r.scenario === 'lists') { inTot++; if (fired) inFire++ }
      else { outTot++; if (fired) outFire++ }
    }
    const recall = inFire / inTot, fp = outFire / outTot
    results.push({ t, recall, fp })
    console.log(`   ${t.toFixed(2)}    ${(recall * 100).toFixed(1)}%      ${(fp * 100).toFixed(2)}%       ${fp <= MAX_FALSE_POSITIVE_RATE ? 'yes' : 'no'}`)
  }
  const feasible = results.filter((r) => r.fp <= MAX_FALSE_POSITIVE_RATE)
  const best = feasible.sort((a, b) => b.recall - a.recall)[0]
  console.log(best === undefined
    ? `  no threshold meets the constraint for ${locale}`
    : `  selected for ${locale}: ${best.t.toFixed(2)}  (recall ${(best.recall * 100).toFixed(1)}%, fp ${(best.fp * 100).toFixed(2)}%)`)
}

sweep('en-US')
sweep('hi-IN')
