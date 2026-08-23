/**
 * Derive replenishment priors and complement rules from real purchase histories.
 *
 * The suggestion engine needs two things it cannot invent:
 *
 *   1. How often people rebuy a category, so "you're probably low on milk" is a
 *      prediction rather than a guess. Derived here as a Gamma prior over the
 *      purchase rate, fitted per category from observed inter-purchase gaps.
 *
 *   2. Which categories go together, so complements come from what shoppers
 *      actually put in one basket rather than from someone's intuition about
 *      cooking. Derived as association-rule lift.
 *
 * Source: Instacart Online Grocery Shopping Dataset 2017 — 3.4M orders, 206k
 * users, 32M order-product rows. Obtained via Kaggle mirror psparks/
 * instacart-market-basket-analysis (published CC0-1.0); Instacart's own release
 * terms are non-commercial, so the stricter reading is recorded in the output.
 *
 * WHY THIS MATTERS FOR COLD START
 * A brand-new user has no history at all. A frequency-counting recommender has
 * nothing to say and returns an empty list, which is why most implementations
 * special-case it away. A Gamma-Poisson model does not need the special case:
 * the population prior answers on day one and the user's own data progressively
 * overrides it as evidence arrives. Cold start stops being an edge case and
 * becomes the ordinary behaviour of the model at n = 0.
 *
 * Run: npx vite-node scripts/build-priors.ts
 */

import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import type { Category } from '../src/domain/types.ts'

const ROOT = join(import.meta.dirname, '..')
const RAW = join(ROOT, 'data-raw', 'instacart')
const OUTPUT = join(ROOT, 'src', 'data', 'priors.generated.json')
const CATALOG = join(ROOT, 'src', 'data', 'catalog.generated.json')

/**
 * Users sampled from the 206k available.
 *
 * Per-category statistics converge long before the full set, and streaming every
 * user's basket history would cost gigabytes of resident memory for digits that
 * do not move. The sample is deterministic (user_id modulo), so re-running the
 * script reproduces the same artifact.
 */
const USER_SAMPLE_DIVISOR = 20

async function* lines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(join(RAW, file), { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  let first = true
  for await (const line of reader) {
    if (first) {
      first = false
      continue // header
    }
    if (line !== '') yield line
  }
}

// ---------------------------------------------------------------------------
// Instacart taxonomy -> our categories
// ---------------------------------------------------------------------------

/**
 * Instacart department names, verbatim from departments.csv (space-separated,
 * not underscored — an earlier version guessed the format and silently dumped
 * dairy, meat and personal care into 'other', which showed up as a suspiciously
 * large 'other' bucket rather than as an error).
 */
const DEPARTMENT_TO_CATEGORY: Readonly<Record<string, Category>> = {
  produce: 'produce',
  'dairy eggs': 'dairy',
  bakery: 'bakery',
  'meat seafood': 'meat',
  deli: 'meat',
  frozen: 'frozen',
  beverages: 'beverages',
  alcohol: 'beverages',
  snacks: 'snacks',
  'dry goods pasta': 'pantry',
  'canned goods': 'pantry',
  pantry: 'pantry',
  breakfast: 'pantry',
  international: 'pantry',
  bulk: 'pantry',
  household: 'household',
  'personal care': 'personal-care',
  babies: 'personal-care',
  pets: 'household',
  other: 'other',
  missing: 'other',
}

/** Fail loudly if the source taxonomy changes rather than silently bucketing to 'other'. */
function categoryForDepartment(department: string): Category {
  const mapped = DEPARTMENT_TO_CATEGORY[department]
  if (mapped === undefined) {
    throw new Error(`Unmapped Instacart department: "${department}". Update DEPARTMENT_TO_CATEGORY.`)
  }
  return mapped
}

// ---------------------------------------------------------------------------

interface OrderMeta {
  readonly userId: number
  readonly orderNumber: number
  /** Cumulative days since that user's first order. */
  readonly dayOffset: number
}

console.log('pass 1/3  orders.csv — sampling users and building a day timeline')

const orderMeta = new Map<number, OrderMeta>()
const cumulativeDays = new Map<number, number>()
let orderRows = 0

for await (const line of lines('orders.csv')) {
  orderRows += 1
  // order_id,user_id,eval_set,order_number,order_dow,order_hour_of_day,days_since_prior_order
  const parts = line.split(',')
  const userId = Number(parts[1])
  if (userId % USER_SAMPLE_DIVISOR !== 0) continue

  const orderId = Number(parts[0])
  const orderNumber = Number(parts[3])
  const sincePrior = parts[6] === '' ? 0 : Number(parts[6])

  // days_since_prior_order is a gap, not a date; accumulating it reconstructs a
  // per-user timeline, which is what an inter-purchase interval needs.
  const running = (cumulativeDays.get(userId) ?? 0) + (Number.isFinite(sincePrior) ? sincePrior : 0)
  cumulativeDays.set(userId, running)
  orderMeta.set(orderId, { userId, orderNumber, dayOffset: running })
}

console.log(`          ${orderRows.toLocaleString()} orders, ${orderMeta.size.toLocaleString()} sampled`)

console.log('pass 2/3  products.csv + aisles/departments — product to category')

const departmentNames = new Map<number, string>()
for await (const line of lines('departments.csv')) {
  const [id, name] = line.split(',')
  departmentNames.set(Number(id), name.replace(/"/g, '').trim())
}

const productCategory = new Map<number, Category>()
for await (const line of lines('products.csv')) {
  // product_id,product_name,aisle_id,department_id — names may be quoted with commas
  const lastComma = line.lastIndexOf(',')
  const departmentId = Number(line.slice(lastComma + 1))
  const productId = Number(line.slice(0, line.indexOf(',')))
  const department = departmentNames.get(departmentId) ?? 'missing'
  productCategory.set(productId, categoryForDepartment(department))
}

console.log(`          ${productCategory.size.toLocaleString()} products mapped`)

// ---------------------------------------------------------------------------
// Reorder rate: how often someone who buys an item buys it again.
//
// This is the only *behavioural* signal available for a shopper with no history
// of their own. A discount is a property of a catalogue row and is identical for
// everyone who opens the app; a reorder rate is 32M purchase decisions telling
// you which items people actually keep coming back for. "9 in 10 shoppers rebuy
// this" is a claim about behaviour. "51% off" from a 2020 price snapshot is not.
//
// Instacart products are matched to our catalogue by head noun. The vocabularies
// only partly overlap — one is US, the other Indian — so coverage is reported
// rather than assumed, and items without a match simply carry no rate.
// ---------------------------------------------------------------------------

const catalogHeads: string[] = (
  JSON.parse(readFileSync(CATALOG, 'utf8')) as { items: Array<[string, string, ...unknown[]]> }
).items.map(([, key]) => key)

const headSet = new Set(catalogHeads)
const multiWordHeads = catalogHeads.filter((head) => head.includes(' '))

/** Head noun for an Instacart product name, or null when nothing matches. */
function headForProduct(name: string): string | null {
  const cleaned = name.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  for (const head of multiWordHeads) {
    if (cleaned.includes(head)) return head
  }
  for (const word of cleaned.split(' ')) {
    if (headSet.has(word)) return word
  }
  return null
}

const productHead = new Map<number, string>()
for await (const line of lines('products.csv')) {
  const firstComma = line.indexOf(',')
  const lastComma = line.lastIndexOf(',')
  const secondLast = line.lastIndexOf(',', lastComma - 1)
  const productId = Number(line.slice(0, firstComma))
  const name = line.slice(firstComma + 1, secondLast).replace(/^"|"$/g, '')
  const head = headForProduct(name)
  if (head !== null) productHead.set(productId, head)
}
console.log(`          ${productHead.size.toLocaleString()} products matched to a catalogue head`)

console.log('pass 3/3  order_products__prior.csv — intervals, co-occurrence and reorder rate (large)')

/** (userId, category) -> day offsets on which that user bought that category. */
const purchases = new Map<string, number[]>()
/** Categories present in each sampled order, for co-occurrence counting. */
const basketCategories = new Map<number, Set<Category>>()
/** head -> [reordered count, total purchases]. Counted across every row, not
 *  only sampled users: a rate wants all the evidence available. */
const reorderTally = new Map<string, [number, number]>()
let productRows = 0

for await (const line of lines('order_products__prior.csv')) {
  productRows += 1
  const firstComma = line.indexOf(',')
  const secondComma = line.indexOf(',', firstComma + 1)
  const productIdEarly = Number(line.slice(firstComma + 1, secondComma))

  // order_id,product_id,add_to_cart_order,reordered
  const head = productHead.get(productIdEarly)
  if (head !== undefined) {
    const reordered = line.charCodeAt(line.length - 1) === 49 ? 1 : 0
    const tally = reorderTally.get(head) ?? [0, 0]
    tally[0] += reordered
    tally[1] += 1
    reorderTally.set(head, tally)
  }

  const orderId = Number(line.slice(0, firstComma))
  const meta = orderMeta.get(orderId)
  if (meta === undefined) continue

  const productId = productIdEarly
  const category = productCategory.get(productId)
  if (category === undefined) continue

  const basket = basketCategories.get(orderId) ?? new Set<Category>()
  basket.add(category)
  basketCategories.set(orderId, basket)

  const key = `${meta.userId}|${category}`
  const days = purchases.get(key) ?? []
  days.push(meta.dayOffset)
  purchases.set(key, days)
}

console.log(`          ${productRows.toLocaleString()} rows scanned, ${basketCategories.size.toLocaleString()} baskets kept`)

// ---------------------------------------------------------------------------
// Replenishment: fit Gamma(alpha, beta) to observed inter-purchase gaps
// ---------------------------------------------------------------------------

const gapsByCategory = new Map<Category, number[]>()

for (const [key, days] of purchases) {
  const category = key.slice(key.indexOf('|') + 1) as Category
  const unique = [...new Set(days)].sort((a, b) => a - b)
  const bucket = gapsByCategory.get(category) ?? []
  for (let i = 1; i < unique.length; i += 1) {
    const gap = unique[i] - unique[i - 1]
    // Same-day repeats carry no timing information; year-plus gaps are lapsed
    // users rather than a replenishment cycle.
    if (gap > 0 && gap <= 365) bucket.push(gap)
  }
  gapsByCategory.set(category, bucket)
}

/**
 * Method-of-moments fit for a Gamma over the purchase *rate*.
 *
 * Gaps are Exponential if purchases are Poisson, so the conjugate prior on the
 * rate is Gamma. Matching mean and variance gives beta = mean/var, alpha =
 * mean^2/var — closed form, no optimiser, and reproducible.
 */
function fitGamma(gaps: number[]): { alpha: number; beta: number; meanDays: number; sd: number; n: number } | null {
  if (gaps.length < 30) return null
  const n = gaps.length
  const mean = gaps.reduce((sum, g) => sum + g, 0) / n
  const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / n
  if (variance <= 0) return null
  return {
    alpha: Number(((mean * mean) / variance).toFixed(4)),
    beta: Number((mean / variance).toFixed(4)),
    meanDays: Number(mean.toFixed(2)),
    sd: Number(Math.sqrt(variance).toFixed(2)),
    n,
  }
}

const replenishment: Record<string, ReturnType<typeof fitGamma>> = {}
for (const [category, gaps] of gapsByCategory) {
  const fit = fitGamma(gaps)
  if (fit !== null) replenishment[category] = fit
}

// ---------------------------------------------------------------------------
// Complements: association-rule lift between categories
// ---------------------------------------------------------------------------

const categoryCount = new Map<Category, number>()
const pairCount = new Map<string, number>()
const basketTotal = basketCategories.size

for (const categories of basketCategories.values()) {
  const list = [...categories].sort()
  for (const category of list) categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1)
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const key = `${list[i]}|${list[j]}`
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
    }
  }
}

/** lift(A,B) = P(A,B) / (P(A)P(B)). Above 1 means more than chance. */
const complements: Array<{ a: string; b: string; lift: number; support: number }> = []
for (const [key, count] of pairCount) {
  const [a, b] = key.split('|') as [Category, Category]
  const pA = (categoryCount.get(a) ?? 0) / basketTotal
  const pB = (categoryCount.get(b) ?? 0) / basketTotal
  const pAB = count / basketTotal
  if (pA === 0 || pB === 0) continue
  const lift = pAB / (pA * pB)
  // Minimum support keeps rare pairings from producing enormous, meaningless lift.
  if (count < 200) continue
  complements.push({ a, b, lift: Number(lift.toFixed(4)), support: count })
}
complements.sort((x, y) => y.lift - x.lift)

// ---------------------------------------------------------------------------

/**
 * Kept only where there is enough evidence to mean anything.
 *
 * A head seen a handful of times produces a rate that is mostly noise; 200
 * purchases is where the estimate stops moving much.
 */
const MIN_PURCHASES = 200
const reorderRates = [...reorderTally.entries()]
  .filter(([, [, total]]) => total >= MIN_PURCHASES)
  .map(([head, [reordered, total]]) => ({
    head,
    rate: Number((reordered / total).toFixed(4)),
    purchases: total,
  }))
  .sort((a, b) => b.rate - a.rate)

const output = {
  _source: 'Instacart Online Grocery Shopping Dataset 2017 (Kaggle mirror psparks/instacart-market-basket-analysis, CC0-1.0)',
  _licence: "Mirror is published CC0-1.0; Instacart's original release terms are non-commercial. The stricter reading is assumed.",
  _generatedBy: 'scripts/build-priors.ts',
  _method: {
    sample: `every ${USER_SAMPLE_DIVISOR}th user by user_id (deterministic)`,
    replenishment: 'Gamma(alpha,beta) over purchase rate, method-of-moments fit to inter-purchase gaps per category; gaps capped at 365 days',
    complements: 'category co-occurrence lift within a basket, minimum support 200 baskets',
    basketsAnalysed: basketTotal,
  },
  replenishment,
  complements: complements.slice(0, 40),
  reorderRates,
}

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`)

console.log(`\nwritten: ${OUTPUT}\n`)
console.log('replenishment priors (mean days between purchases):')
for (const [category, fit] of Object.entries(replenishment)) {
  if (fit === null) continue
  console.log(`  ${category.padEnd(15)} ${fit.meanDays.toFixed(1)} ± ${fit.sd.toFixed(1)} days   (alpha=${fit.alpha}, beta=${fit.beta}, n=${fit.n.toLocaleString()})`)
}
console.log(`\nreorder rates: ${reorderRates.length} items with >= ${MIN_PURCHASES} purchases`)
console.log('most-rebought:')
for (const r of reorderRates.slice(0, 10)) {
  console.log(`  ${r.head.padEnd(22)} ${(r.rate * 100).toFixed(1)}% rebought  (${r.purchases.toLocaleString()} purchases)`)
}
console.log('least-rebought:')
for (const r of reorderRates.slice(-5)) {
  console.log(`  ${r.head.padEnd(22)} ${(r.rate * 100).toFixed(1)}% rebought  (${r.purchases.toLocaleString()} purchases)`)
}

console.log('\ntop category complements by lift:')
for (const c of complements.slice(0, 10)) {
  console.log(`  ${c.a.padEnd(14)} + ${c.b.padEnd(14)} lift ${c.lift.toFixed(3)}  (${c.support.toLocaleString()} baskets)`)
}
