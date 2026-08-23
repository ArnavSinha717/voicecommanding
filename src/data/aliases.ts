/**
 * Multilingual alias layer.
 *
 * THIS IS THE ONE HAND-AUTHORED DATA FILE IN THE PROJECT, and it is deliberate.
 *
 * Everything else — item names, categories, frequency priors, prices, rule
 * precisions, verb inventories — is derived from a public dataset and
 * regenerable by a script. This file cannot be, because no public dataset maps
 * romanised Hindi to grocery items. Searched for one: MASSIVE hi-IN is
 * Devanagari with no item-level slot annotation; L3Cube-HingCorpus is 52M
 * romanised Hinglish sentences but unlabelled; Hi-DSTC2 is code-mixed but
 * restaurant-booking. Product catalogs list products ("Amul Taaza Toned Milk
 * 500ml"), never the word a person says ("doodh").
 *
 * So this is domain knowledge, entered explicitly and kept small, rather than
 * fabricated measurements. It contains no numbers — only word equivalences,
 * which are verifiable by anyone who speaks the language.
 *
 * The derived catalog already covers Hindi terms that appear in Indian product
 * names (atta, paneer, ghee, dal, namkeen, papad, masala), so only words absent
 * from retail English need to be here.
 */

/** canonicalId in the derived catalog -> additional spoken forms. */
export const MULTILINGUAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // dairy
  milk: ['doodh', 'dudh'],
  curd: ['dahi'],
  butter: ['makhan', 'makkhan'],
  egg: ['anda', 'ande', 'aanda'],
  cheese: ['cheez'],

  // produce
  tomato: ['tamatar', 'tamaatar'],
  onion: ['pyaz', 'pyaaz', 'kanda'],
  potato: ['aloo', 'alu', 'aaloo'],
  banana: ['kela', 'kele'],
  apple: ['seb'],
  orange: ['santra', 'santara'],
  lemon: ['nimbu', 'neembu'],
  garlic: ['lehsun', 'lahsun'],
  ginger: ['adrak'],
  spinach: ['palak'],
  coriander: ['dhania', 'dhaniya', 'kothmir'],
  cauliflower: ['gobi', 'phool gobi', 'phoolgobi'],
  cabbage: ['patta gobi', 'pattagobi'],
  carrot: ['gajar'],
  cucumber: ['kheera', 'khira'],
  brinjal: ['baingan', 'baigan'],
  okra: ['bhindi'],
  mango: ['aam'],
  grape: ['angoor'],
  watermelon: ['tarbooz', 'tarbuj'],
  papaya: ['papita'],
  pea: ['matar', 'mattar'],
  fenugreek: ['methi'],
  radish: ['mooli', 'muli'],
  pumpkin: ['kaddu'],
  bottle: ['botal'],

  // pantry
  rice: ['chawal', 'chaval'],
  sugar: ['cheeni', 'chini', 'shakkar'],
  salt: ['namak'],
  oil: ['tel'],
  turmeric: ['haldi'],
  cumin: ['jeera', 'zeera'],
  wheat: ['gehun', 'gehu'],
  flour: ['aata'],
  tea: ['chai', 'chai patti'],
  honey: ['shahad'],
  chickpea: ['chana', 'chhole', 'chole'],
  lentil: ['dal', 'daal'],

  // bakery
  bread: ['double roti', 'dabal roti', 'roti', 'rotee', 'bred'],
  biscuit: ['biskut'],

  // meat
  chicken: ['murgi', 'murga'],
  fish: ['machhli', 'machli'],
  mutton: ['bakre ka gosht'],

  // beverages
  water: ['pani', 'paani'],
  buttermilk: ['chaas', 'chhaas', 'chhach'],
  juice: ['ras'],

  // household / personal care
  soap: ['sabun', 'saabun'],
  matches: ['maachis', 'machis'],
  broom: ['jhadu', 'jhaadu'],
}

/**
 * Long-vowel folding for romanised Hindi.
 *
 * The transliterator emits scholarly long vowels ("aa", "ee", "oo") while people
 * write Hinglish with short ones — दूध becomes "doodh" from Devanagari but
 * "dudh" when typed. Folding both sides to the short form lets one alias cover
 * both spellings instead of enumerating every variant.
 */
export function foldLongVowels(text: string): string {
  return text
    .replace(/aa+/g, 'a')
    .replace(/ee+/g, 'i')
    .replace(/oo+/g, 'u')
    .replace(/ii+/g, 'i')
    .replace(/uu+/g, 'u')
}
