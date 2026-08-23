/**
 * Derive the item catalog from a real product dataset.
 *
 * Replaces a hand-written lexicon whose `prior` values were invented. Every
 * number this emits has a stated source:
 *
 *   name      head noun of real product names ("Cabbage - Red" -> cabbage)
 *   category  BigBasket category/sub_category, mapped to our enum
 *   prior     SKU count for that item, log-normalised
 *   price     median sale_price in rupees across that item's SKUs
 *
 * Source: BigBasket Products dataset, ~27.5k SKUs (Kaggle: surajjha101).
 * Licence CC-BY-NC-SA-4.0 — non-commercial, and share-alike propagates to this
 * derived artifact. Recorded in the output and in the README.
 *
 * The SKU-count-as-prior step carries an assumption worth stating: a retailer
 * stocking more variants of an item reflects more demand for it. That is a proxy,
 * not a measurement of what shoppers say. It is defensible because it is derived
 * and reproducible, which invented numbers were not.
 *
 * Run: npx vite-node scripts/build-catalog.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Category } from '../src/domain/types.ts'
import { canonicalKey } from '../src/domain/parser/normalize.ts'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'data-raw', 'bigbasket', 'BigBasket Products.csv')
const OUTPUT = join(ROOT, 'src', 'data', 'catalog.generated.json')

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal RFC4180 reader — product names contain commas inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const [header, ...body] = rows
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]])))
}

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

/**
 * Retail taxonomy -> the brief's categories.
 *
 * A schema mapping between two fixed vocabularies, not invented data: the left
 * side is enumerable from the dataset, the right side from `Category`.
 * Sub-category is checked first because BigBasket's top-level buckets are broad
 * ("Bakery, Cakes & Dairy" spans three of our categories).
 */
const SUB_CATEGORY_MAP: ReadonlyArray<readonly [RegExp, Category]> = [
  [/dairy|cheese|paneer|butter|milk|curd|yoghurt/i, 'dairy'],
  [/bread|bakery|cakes|cookies|rusks|biscuit/i, 'bakery'],
  [/fruits|vegetables|herbs|salad|exotic/i, 'produce'],
  [/eggs|meat|fish|poultry|seafood/i, 'meat'],
  [/frozen|ice cream/i, 'frozen'],
  [/beverage|drinks|juice|tea|coffee|water/i, 'beverages'],
  [/namkeen|chocolate|chips|nuts|dry fruit|snacks, dry fruits/i, 'snacks'],
  [/foodgrain|oil|masala|spice|atta|rice|dal|pulses|staples|cooking|baking|sauces|spreads/i, 'pantry'],
  [/cleaning|household|detergent|utensil|bins|mops|pooja|stationery/i, 'household'],
  [/skin|hair|bath|oral|grooming|fragrance|feminine|baby|health|medicine/i, 'personal-care'],
]

const CATEGORY_MAP: ReadonlyArray<readonly [RegExp, Category]> = [
  [/fruits & vegetables/i, 'produce'],
  [/eggs, meat & fish/i, 'meat'],
  [/bakery, cakes & dairy/i, 'dairy'],
  [/beverages/i, 'beverages'],
  [/snacks & branded foods/i, 'snacks'],
  [/foodgrains, oil & masala/i, 'pantry'],
  [/gourmet & world food/i, 'pantry'],
  [/cleaning & household|kitchen, garden & pets/i, 'household'],
  [/beauty & hygiene|baby care/i, 'personal-care'],
]

function toCategory(category: string, subCategory: string, type: string): Category {
  for (const [pattern, mapped] of SUB_CATEGORY_MAP) {
    if (pattern.test(subCategory) || pattern.test(type)) return mapped
  }
  for (const [pattern, mapped] of CATEGORY_MAP) {
    if (pattern.test(category)) return mapped
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Head-noun extraction
// ---------------------------------------------------------------------------

/**
 * Reduce a product name to the words a person would actually say.
 *
 * "Cabbage - Red" -> cabbage.  "Sapota - Organically Grown" -> sapota.
 * Retail names put the item first and qualify it after a dash or comma, so the
 * head is a reliable spoken form.
 */
interface Head {
  /** Matching key: lowercased, singularised, qualifiers stripped. */
  readonly key: string
  /** Display form: the same cleaned words, title-cased. */
  readonly display: string
}

function headNoun(product: string): Head | null {
  let name = product
    .replace(/ /g, ' ')
    .split(/\s+-\s+|,|\(|\//)[0]
    .trim()

  // Combo packs ("Coriander 100 g + Garlic 250 g") name several items at once
  // and belong to none of them.
  if (name.includes('+')) return null

  name = name
    .replace(/\b\d+(\.\d+)?\s*(g|kg|ml|l|ltr|gm|mg|pcs?|pack|n)\b/gi, ' ')
    .replace(/\b(organically grown|organic|fresh|premium|assorted|imported)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const key = canonicalKey(name)
  if (key.length < 3 || key.length > 28) return null
  if (/\d/.test(key)) return null
  if (key.split(' ').length > 3) return null

  // Display is derived from the same cleaned words rather than from whichever
  // SKU happened to be seen first. Taking the raw product name made "paneer"
  // render as "Organic Paneer" purely because an organic variant led the file —
  // the label was arbitrary, and it disagreed with the key used to match it.
  const display = name
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  return { key, display }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ---------------------------------------------------------------------------

interface Aggregate {
  skus: number
  prices: number[]
  /** sale_price / market_price per SKU; below 1 means discounted. */
  discounts: number[]
  categories: Map<Category, number>
  display: string
}

const rows = parseCsv(readFileSync(SOURCE, 'utf8'))
const byItem = new Map<string, Aggregate>()

for (const row of rows) {
  const head = headNoun(row.product ?? '')
  if (head === null) continue
  const { key } = head

  const category = toCategory(row.category ?? '', row.sub_category ?? '', row.type ?? '')
  const price = Number(row.sale_price)

  const entry = byItem.get(key) ?? {
    skus: 0,
    prices: [],
    discounts: [],
    categories: new Map<Category, number>(),
    display: head.display,
  }
  entry.skus += 1
  if (Number.isFinite(price) && price > 0) entry.prices.push(price)
  // The brief asks for items "on sale". BigBasket ships both the marked price
  // and the selling price, so a genuine discount is measurable rather than
  // something the app has to invent.
  const marketPrice = Number(row.market_price)
  if (Number.isFinite(price) && Number.isFinite(marketPrice) && marketPrice > 0 && price > 0) {
    entry.discounts.push(price / marketPrice)
  }
  entry.categories.set(category, (entry.categories.get(category) ?? 0) + 1)
  byItem.set(key, entry)
}

/** Single-SKU heads are mostly parse noise rather than real items. */
const MIN_SKUS = 2
const kept = [...byItem.entries()].filter(([, v]) => v.skus >= MIN_SKUS)
const maxSkus = Math.max(...kept.map(([, v]) => v.skus))

const catalog = kept
  .map(([key, v]) => {
    const dominant = [...v.categories.entries()].sort((a, b) => b[1] - a[1])[0][0]
    return {
      canonicalId: key.replace(/\s+/g, '-'),
      key,
      name: v.display,
      category: dominant,
      // Log-normalised: SKU counts are heavy-tailed, so raw counts would let one
      // item swamp every other feature in the resolution scorer.
      prior: Number((Math.log1p(v.skus) / Math.log1p(maxSkus)).toFixed(4)),
      skus: v.skus,
      medianPriceInr: v.prices.length > 0 ? Number(median(v.prices).toFixed(2)) : null,
      // Fraction off the marked price, median across SKUs. 0 means never discounted.
      discount:
        v.discounts.length > 0 ? Number(Math.max(0, 1 - median(v.discounts)).toFixed(3)) : 0,
    }
  })
  .sort((a, b) => b.prior - a.prior)

/**
 * Emitted as positional tuples rather than objects.
 *
 * 2,479 records repeating six key names cost ~150 KB of the bundle on their own.
 * The field order is declared once in `_fields` and decoded in data/catalog.ts,
 * which halves the payload for a file the browser must download before the app
 * can resolve anything.
 */
const output = {
  _source: 'BigBasket Products dataset (Kaggle: surajjha101/bigbasket-entire-product-list-28k-datapoints)',
  _licence: 'CC-BY-NC-SA-4.0 — non-commercial; share-alike applies to this derived file',
  _generatedBy: 'scripts/build-catalog.ts',
  _fields: ['canonicalId', 'key', 'name', 'category', 'prior', 'medianPriceInr', 'discount'],
  _method: {
    name: 'head noun of product name, before the first dash/comma',
    category: 'BigBasket category+sub_category+type mapped to the app Category enum',
    prior: 'log1p(SKU count) / log1p(max SKU count) — assumes stock breadth tracks demand',
    medianPriceInr: 'median sale_price across that item\'s SKUs',
    minSkus: MIN_SKUS,
  },
  _counts: { sourceRows: rows.length, items: catalog.length },
  items: catalog.map((i) => [i.canonicalId, i.key, i.name, i.category, i.prior, i.medianPriceInr, i.discount]),
}

// One record per line: compact, but still diffable in review.
writeFileSync(
  OUTPUT,
  `{\n${Object.entries(output)
    .filter(([k]) => k !== 'items')
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')},\n  "items": [\n${output.items.map((i) => `    ${JSON.stringify(i)}`).join(',\n')}\n  ]\n}\n`,
)

console.log(`source rows      : ${rows.length}`)
console.log(`distinct heads   : ${byItem.size}`)
console.log(`kept (>=${MIN_SKUS} SKUs) : ${catalog.length}`)
console.log(`written          : ${OUTPUT}`)
console.log('\ntop 25 by derived prior:')
for (const item of catalog.slice(0, 25)) {
  console.log(
    `  ${item.key.padEnd(24)} ${String(item.skus).padStart(4)} SKUs  prior=${item.prior.toFixed(3)}  ` +
      `${item.category.padEnd(14)} ₹${item.medianPriceInr ?? '-'}`,
  )
}
