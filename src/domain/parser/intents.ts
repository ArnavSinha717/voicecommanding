/**
 * Intent grammar.
 *
 * Rules are ordered data, not branching code, so adding a phrasing is a one-line
 * change and every rule is individually attributable in the eval harness when it
 * misfires.
 *
 * Substring matching ("does the transcript contain 'add'?") fails on all of the
 * following, which is why each rule is anchored and captures an explicit item span:
 *
 *   "add 2 bottles of water"      item is "water", not "2 bottles of water"
 *   "take milk off the list"      a removal with no removal verb
 *   "I don't need milk anymore"   a removal phrased as a statement
 *   "don't add milk"              negation; substring matching adds the milk
 *   "add sugar to my coffee list" the verb is not the first token
 *   "I got the milk"              checks off rather than adds, same noun
 */

import type { CommandKind } from '../types'

export type RuleKind = Exclude<CommandKind, 'unknown' | 'undo' | 'clear'>

export interface IntentRule {
  /** Stable identifier, reported by the eval harness for per-rule precision. */
  readonly id: string
  readonly kind: RuleKind
  /** Anchored against normalised text. Captures `rest`, and `qty` where relevant. */
  readonly pattern: RegExp
  /**
   * MEASURED precision of this rule, not a hand-set prior.
   *
   * Computed by `scripts/eval.ts` as in-domain fires / all fires over MASSIVE
   * en-US (16,521 utterances, 793 in the `lists` scenario). Re-running the
   * harness regenerates these; `intents.precision.test.ts` fails if code and
   * measurement drift apart.
   *
   * Rules with no in-domain support in MASSIVE carry `null` — the benchmark
   * contains no check-off or product-search utterances at all, so their
   * precision is unmeasurable here even though both are required features.
   * Unmeasured rules are treated as low-precision until real data exists.
   */
  readonly precision: number | null
  readonly lang: 'en' | 'hi' | 'mixed'
}

/**
 * Precision below which a rule may only act on an exactly-resolved item.
 *
 * Derived, not chosen: measured per-rule precision falls into two clear groups
 * with nothing between 6.9% and 70.2%, so the boundary sits in that gap. The
 * effect is that confident phrasings ("add X to my list") tolerate fuzzy item
 * matching, while inferential ones ("I need X", "order X") must name something
 * the catalog actually knows. That single change is what stops "order two
 * cheeseburgers" resolving to cheese.
 */
export const EXACT_RESOLUTION_THRESHOLD = 0.5

export function requiresExactResolution(rule: IntentRule): boolean {
  return rule.precision === null || rule.precision < EXACT_RESOLUTION_THRESHOLD
}

/**
 * Phrasings that must never be treated as commands.
 * Checked before intent matching, since most negations embed a positive verb.
 */
export const NEGATION_PATTERNS: readonly RegExp[] = [
  /^do not (?:add|buy|get|put|include)\b/,
  /^never mind\b/,
  /^(?:no|nope) (?:do not|dont)\b/,
  /\bmat (?:lena|karo|kar)\b/,
]

/** Standalone commands that take no item argument. */
export const CLEAR_PATTERNS: readonly RegExp[] = [
  /^(?:clear|empty|reset|wipe) (?:my |the )?(?:whole |entire )?list$/,
  /^(?:start|create) (?:a )?new list$/,
  /^remove everything(?: from (?:my|the) list)?$/,
  /^(?:sab|sabkuch) (?:hata|nikal) (?:do|de|den)$/,
  /^list saaf kar(?:o|do|den)$/,
]

export const UNDO_PATTERNS: readonly RegExp[] = [
  /^undo(?: that| this)?$/,
  /^never ?mind$/,
  /^(?:oops|oh no|wait)$/,
  /^(?:wapas|wapis) (?:karo|kar do|le lo)$/,
]

/**
 * Ordered most-specific first. The first match wins, so a rule that would swallow
 * a more precise one must sit below it.
 */
export const INTENT_RULES: readonly IntentRule[] = [
  // --- check off -----------------------------------------------------------
  // Placed above `add` because "I got milk" and "I need milk" share a shape but
  // mean opposite things. Pragmatics, not syntax.
  {
    kind: 'check',
    id: 'check-1',
    pattern: /^(?:check|tick|mark) (?:off )?(?<rest>.+?)(?: (?:off|as done|as bought))?$/,
    precision: 0.0,
    lang: 'en',
  },
  {
    kind: 'check',
    id: 'check-2',
    pattern: /^i (?:already )?(?:got|have got|picked up|bought|grabbed) (?<rest>.+)$/,
    precision: null,
    lang: 'en',
  },
  {
    kind: 'check',
    id: 'check-3',
    pattern: /^(?<rest>.+?) (?:mil gaya|mil gayi|le liya|kharid liya)$/,
    precision: null,
    lang: 'hi',
  },
  {
    kind: 'uncheck',
    id: 'uncheck-1',
    pattern: /^(?:uncheck|unmark|undo) (?<rest>.+)$/,
    precision: null,
    lang: 'en',
  },

  // --- remove --------------------------------------------------------------
  // Verb inventory taken from MASSIVE en-US `lists_remove` frequency rather than
  // guessed: remove 95, delete 58, erase 11, "get rid of" 9, take 8, clear 6,
  // trash 3, scratch 2, "cross out" 1. Hand-written rules had covered only the
  // first two and missed a fifth of real removals.
  {
    kind: 'remove',
    id: 'remove-1',
    pattern: /^(?:remove|delete|erase|drop|trash|scratch|cross out|cross off) (?<rest>.+?)(?: (?:from|off|on|in) (?:my |the )?(?:\w+ )?list)?$/,
    precision: 0.714,
    lang: 'en',
  },
  {
    kind: 'remove',
    id: 'remove-2',
    pattern: /^get rid of (?<rest>.+?)(?: (?:from|on|in) (?:my |the )?(?:\w+ )?list)?$/,
    precision: 1.0,
    lang: 'en',
  },
  {
    kind: 'remove',
    id: 'remove-3',
    pattern: /^take (?<rest>.+?) (?:off|out)(?: of| from)?(?: (?:my|the) (?:\w+ )?list)?$/,
    precision: 1.0,
    lang: 'en',
  },
  {
    kind: 'remove',
    id: 'remove-4',
    pattern: /^i (?:do not|no longer) (?:need|want) (?<rest>.+?)(?: any ?more)?$/,
    precision: 1.0,
    lang: 'en',
  },
  {
    kind: 'remove',
    id: 'remove-5',
    pattern: /^(?<rest>.+?) (?:hata|nikal) (?:do|de|den|dijiye)$/,
    precision: null,
    lang: 'hi',
  },

  // --- set quantity --------------------------------------------------------
  // "make that two" carries no item; the target comes from dialogue state.
  {
    kind: 'setQuantity',
    id: 'setQuantity-1',
    pattern: /^make (?:that|it|them) (?<qty>.+)$/,
    precision: null,
    lang: 'en',
  },
  {
    kind: 'setQuantity',
    id: 'setQuantity-2',
    pattern: /^(?:change|set|update) (?<rest>.+?) to (?<qty>.+)$/,
    precision: null,
    lang: 'en',
  },

  // --- search --------------------------------------------------------------
  {
    kind: 'search',
    id: 'search-1',
    pattern: /^(?:find|search for|look for|show me|search) (?:me )?(?<rest>.+)$/,
    precision: 0.0,
    lang: 'en',
  },
  {
    kind: 'search',
    id: 'search-2',
    pattern: /^(?<rest>.+?) (?:dhundo|dikhao|search karo)$/,
    precision: null,
    lang: 'hi',
  },

  // --- add -----------------------------------------------------------------
  // `create`/`make`/`start` are deliberately absent: in MASSIVE they overwhelmingly
  // introduce a whole new named list ("create a new to do list"), which is a
  // feature this product does not have. Matching them would inflate recall while
  // doing something the user did not ask for.
  {
    kind: 'add',
    id: 'add-1',
    pattern: /^(?:add|include) (?<rest>.+?)(?: (?:to|on|in) (?:my |the )?(?:shopping |grocery |groceries )?list)?$/,
    precision: 0.702,
    lang: 'en',
  },
  // `put` split off from `add`: on real data it is overwhelmingly a media verb
  // ("put the radio on", "put on some coldplay"), so it only counts as an add
  // when an explicit list is named.
  {
    kind: 'add',
    id: 'add-9',
    pattern: /^put (?<rest>.+?) (?:to|on|in) (?:my |the )?(?:shopping |grocery |groceries )?list$/,
    precision: 1.0,
    lang: 'en',
  },
  {
    kind: 'add',
    id: 'add-2',
    pattern: /^(?:i am|we are) (?:out of|running low on|almost out of) (?<rest>.+)$/,
    precision: null,
    lang: 'en',
  },
  {
    kind: 'add',
    id: 'add-3',
    pattern: /^i (?:need|want|require) (?:to (?:buy|get|purchase|pick up) )?(?<rest>.+)$/,
    precision: 0.069,
    lang: 'en',
  },
  {
    kind: 'add',
    id: 'add-4',
    pattern: /^(?:buy|get|grab|order|pick up) (?<rest>.+)$/,
    precision: 0.043,
    lang: 'en',
  },
  {
    kind: 'add',
    id: 'add-5',
    pattern: /^(?:we|i) need (?<rest>.+)$/,
    precision: 1.0,
    lang: 'en',
  },
  {
    kind: 'add',
    id: 'add-6',
    pattern: /^(?<rest>.+?) add kar(?:o|do|na|dena| do)$/,
    precision: null,
    lang: 'mixed',
  },
  {
    kind: 'add',
    id: 'add-7',
    pattern: /^(?<rest>.+?) (?:chahiye|chaahiye|chahiye hai|lena hai|leni hai|le lo)$/,
    precision: null,
    lang: 'hi',
  },
  {
    kind: 'add',
    id: 'add-8',
    pattern: /^(?:list mein|list me) (?<rest>.+?) (?:daal|dal|add) (?:do|den|dena)$/,
    precision: null,
    lang: 'mixed',
  },
  // --- Hindi (Devanagari, transliterated before matching) ------------------
  //
  // Hindi is verb-final, so every English-anchored rule above structurally
  // cannot match it: "सूची से अंडे हटाओ" is [list] se [item] remove. Measured
  // against MASSIVE hi-IN, the English rules scored 0.0% on all 793 list
  // utterances — the multilingual claim was unsupported until these existed.
  //
  // Shapes taken from the corpus after transliteration:
  //   "soochee se ande hataao"                  [list] se [item] VERB
  //   "shoping soochee men se ande hataa do"    [list] men se [item] VERB
  //   "bred ko khareedadaaree kee soochee se hataa do"   [item] ko [list] se VERB
  //   "dabal rotee ko kiraane kee soochee men daalen"    [item] ko [list] men VERB
  {
    kind: 'remove',
    id: 'remove-hi-1',
    pattern: /^(?<rest>.+?)\s+ko\s+.*?\bse\s+(?:hataa|hataao|hataayen|hataaen|nikaalen|nikaalo|dileet kar)(?:\s+(?:do|den|de|dijiye|karo|karen))?$/,
    precision: 1.0,
    lang: 'hi',
  },
  {
    kind: 'remove',
    id: 'remove-hi-2',
    pattern: /^(?:.*\bse\s+)?(?<rest>.+?)\s+(?:hataa|hataao|hataayen|hataaen|nikaalen|nikaalo|nikaal|dileet kar)(?:\s+(?:do|den|de|dijiye|karo|karen))?$/,
    precision: 1.0,
    lang: 'hi',
  },
  {
    kind: 'add',
    id: 'add-hi-1',
    pattern: /^(?<rest>.+?)\s+ko\s+.*?(?:soochee|list)\s+(?:men|mein)\s+(?:daalen|daalo|daal|joden|jodo|add kar(?:en|o))(?:\s+(?:do|den|dena))?$/,
    precision: 1.0,
    lang: 'hi',
  },
  {
    kind: 'add',
    id: 'add-hi-2',
    pattern: /^(?<rest>.+?)\s+(?:daalen|daalo|daal do|joden|jodo|jod do)$/,
    precision: 1.0,
    lang: 'hi',
  },
]

/**
 * Conjunctions that split a compound item span.
 * "add apples and bananas" is two commands, not one item called "apples and bananas".
 */
/**
 * Destinations that are lists, but not *this* list.
 *
 * On real data "add tom to my contact list", "add podcast favorites to playlist"
 * and "add mike and jack to festival calendar" all matched the add rule and put
 * a contact or a podcast onto the shopping list. An utterance naming one of these
 * is addressed to a different feature and must not be acted on — they use exactly
 * the same verbs we do, so the discriminator has to be the destination.
 */
export const FOREIGN_DESTINATIONS = new RegExp(
  [
    // Any qualified list that is not a shopping list. Enumerating the foreign
    // qualifiers was brittle — "favourite list" slipped through and put a song
    // on the shopping list — so the rule is inverted: a qualifier before "list"
    // must be a shopping word, or the utterance is not addressed to us.
    String.raw`\b(?!shopping\b|grocery\b|groceries\b|market\b|my\b|the\b|a\b|an\b|this\b|that\b|whole\b|entire\b|new\b)\w+\s+list\b`,
    // Destinations that are not lists at all.
    String.raw`\b(?:calendar|playlist|diary|agenda|schedule|reminder|alarm|inbox|menu|radio|queue|contacts?)\b`,
  ].join('|'),
)

/**
 * "or" is treated as a separator despite reading as exclusive in writing.
 *
 * Spoken to a shopping list it is nearly always additive — "get bananas or some
 * apples" means bring both, or bring whichever you find. Separating can add one
 * item too many, which a tap removes; keeping it inside an item name loses the
 * request silently, and a user cannot recover what they never saw appear.
 */
export const CONJUNCTION_PATTERN = /\s+(?:and|aur|plus|as well as|or)\s+/

/**
 * Price filters for voice search.
 *
 * The currency word can land on either side of the number depending on phrasing
 * and on how the recognizer expanded the symbol — "under 5 dollars", "under $5"
 * (normalised to "under dollars 5"), "200 rupees se kam". Both positions are
 * consumed so the currency never leaks into the free-text query.
 */
const CURRENCY = '(?:rupees|rupee|dollars|dollar|rs|bucks)'

export const PRICE_PATTERNS = {
  under: new RegExp(
    `\\b(?:under|below|less than|cheaper than)\\s+(?:${CURRENCY}\\s+)?(?<value>\\d+(?:\\.\\d+)?)(?:\\s+${CURRENCY})?`,
  ),
  over: new RegExp(
    `\\b(?:over|above|more than|at least)\\s+(?:${CURRENCY}\\s+)?(?<value>\\d+(?:\\.\\d+)?)(?:\\s+${CURRENCY})?`,
  ),
} as const

/** Product qualifiers worth lifting out of the item span into structured filters. */
export const LABEL_WORDS: readonly string[] = [
  'organic', 'fresh', 'frozen', 'diet', 'sugar free', 'sugar-free', 'gluten free',
  'gluten-free', 'low fat', 'full cream', 'toned', 'whole wheat', 'brown', 'vegan',
]
