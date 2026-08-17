/**
 * ISO 3166-1 alpha-2, and everything a model might write instead of it.
 *
 * `index.json.country` is a machine token (`VD-COUNTRY`, L3): the reader renders
 * it through a locale-aware region-name facility, so `"Spain"`, `"Испания"` and
 * `"esp"` are all non-conforming — and all three are what an LLM produces when
 * it is not in the mood to follow instructions. Repairing that here costs
 * nothing; a retry costs a round trip and usually produces the same answer.
 *
 * Four tiers, cheapest and safest first:
 *
 *  1. it is already an alpha-2 code;
 *  2. it is an alpha-3 code (`ESP` → `es`);
 *  3. it is the country's name in one of the deployment languages, resolved
 *     through `Intl.DisplayNames` — no vendored name table to go stale;
 *  4. it is a demonym (`Spanish`, `испанский`, `Spanier`), matched by unique
 *     prefix against those same names, with a short hand table for the ones no
 *     prefix rule reaches (`American`, `British`, `Dutch`).
 *
 * A value that survives none of these is dropped, because a wrong country is a
 * visible, permanent error on a card and an absent one merely omits a row.
 */

/**
 * Every officially assigned alpha-3 code with its alpha-2 counterpart. One
 * table serves both jobs: the alpha-3 lookup, and the set of admissible alpha-2
 * codes (`INV-9` wants a *known* region, not merely two letters).
 */
const ALPHA3_TO_ALPHA2 =
  'ABW:AW AFG:AF AGO:AO AIA:AI ALA:AX ALB:AL AND:AD ARE:AE ARG:AR ARM:AM ASM:AS ATA:AQ ATF:TF ATG:AG ' +
  'AUS:AU AUT:AT AZE:AZ BDI:BI BEL:BE BEN:BJ BES:BQ BFA:BF BGD:BD BGR:BG BHR:BH BHS:BS BIH:BA BLM:BL ' +
  'BLR:BY BLZ:BZ BMU:BM BOL:BO BRA:BR BRB:BB BRN:BN BTN:BT BVT:BV BWA:BW CAF:CF CAN:CA CCK:CC CHE:CH ' +
  'CHL:CL CHN:CN CIV:CI CMR:CM COD:CD COG:CG COK:CK COL:CO COM:KM CPV:CV CRI:CR CUB:CU CUW:CW CXR:CX ' +
  'CYM:KY CYP:CY CZE:CZ DEU:DE DJI:DJ DMA:DM DNK:DK DOM:DO DZA:DZ ECU:EC EGY:EG ERI:ER ESH:EH ESP:ES ' +
  'EST:EE ETH:ET FIN:FI FJI:FJ FLK:FK FRA:FR FRO:FO FSM:FM GAB:GA GBR:GB GEO:GE GGY:GG GHA:GH GIB:GI ' +
  'GIN:GN GLP:GP GMB:GM GNB:GW GNQ:GQ GRC:GR GRD:GD GRL:GL GTM:GT GUF:GF GUM:GU GUY:GY HKG:HK HMD:HM ' +
  'HND:HN HRV:HR HTI:HT HUN:HU IDN:ID IMN:IM IND:IN IOT:IO IRL:IE IRN:IR IRQ:IQ ISL:IS ISR:IL ITA:IT ' +
  'JAM:JM JEY:JE JOR:JO JPN:JP KAZ:KZ KEN:KE KGZ:KG KHM:KH KIR:KI KNA:KN KOR:KR KWT:KW LAO:LA LBN:LB ' +
  'LBR:LR LBY:LY LCA:LC LIE:LI LKA:LK LSO:LS LTU:LT LUX:LU LVA:LV MAC:MO MAF:MF MAR:MA MCO:MC MDA:MD ' +
  'MDG:MG MDV:MV MEX:MX MHL:MH MKD:MK MLI:ML MLT:MT MMR:MM MNE:ME MNG:MN MNP:MP MOZ:MZ MRT:MR MSR:MS ' +
  'MTQ:MQ MUS:MU MWI:MW MYS:MY MYT:YT NAM:NA NCL:NC NER:NE NFK:NF NGA:NG NIC:NI NIU:NU NLD:NL NOR:NO ' +
  'NPL:NP NRU:NR NZL:NZ OMN:OM PAK:PK PAN:PA PCN:PN PER:PE PHL:PH PLW:PW PNG:PG POL:PL PRI:PR PRK:KP ' +
  'PRT:PT PRY:PY PSE:PS PYF:PF QAT:QA REU:RE ROU:RO RUS:RU RWA:RW SAU:SA SDN:SD SEN:SN SGP:SG SGS:GS ' +
  'SHN:SH SJM:SJ SLB:SB SLE:SL SLV:SV SMR:SM SOM:SO SPM:PM SRB:RS SSD:SS STP:ST SUR:SR SVK:SK SVN:SI ' +
  'SWE:SE SWZ:SZ SXM:SX SYC:SC SYR:SY TCA:TC TCD:TD TGO:TG THA:TH TJK:TJ TKL:TK TKM:TM TLS:TL TON:TO ' +
  'TTO:TT TUN:TN TUR:TR TUV:TV TWN:TW TZA:TZ UGA:UG UKR:UA UMI:UM URY:UY USA:US UZB:UZ VAT:VA VCT:VC ' +
  'VEN:VE VGB:VG VIR:VI VNM:VN VUT:VU WLF:WF WSM:WS YEM:YE ZAF:ZA ZMB:ZM ZWE:ZW';

const alpha3 = new Map<string, string>();
const alpha2 = new Set<string>();

for (const pair of ALPHA3_TO_ALPHA2.split(' ')) {
  const [three, two] = pair.split(':');
  if (!three || !two) continue;
  alpha3.set(three, two.toLowerCase());
  alpha2.add(two.toLowerCase());
}

/**
 * Demonyms and short forms no prefix rule reaches, because the adjective shares
 * no useful prefix with the country's name in any locale we consult.
 */
const ALIASES: Record<string, string> = {
  american: 'us',
  usa: 'us',
  'u.s.': 'us',
  'u.s.a.': 'us',
  'united states of america': 'us',
  'сша': 'us',
  американец: 'us',
  американский: 'us',
  british: 'gb',
  briton: 'gb',
  english: 'gb',
  englishman: 'gb',
  scottish: 'gb',
  welsh: 'gb',
  uk: 'gb',
  'u.k.': 'gb',
  england: 'gb',
  scotland: 'gb',
  wales: 'gb',
  britain: 'gb',
  'great britain': 'gb',
  великобритания: 'gb',
  англия: 'gb',
  британский: 'gb',
  англичанин: 'gb',
  dutch: 'nl',
  holland: 'nl',
  holländer: 'nl',
  голландия: 'nl',
  голландский: 'nl',
  нидерланды: 'nl',
  swiss: 'ch',
  danish: 'dk',
  dane: 'dk',
  finnish: 'fi',
  finn: 'fi',
  swedish: 'se',
  swede: 'se',
  norwegian: 'no',
  polish: 'pl',
  pole: 'pl',
  czech: 'cz',
  greek: 'gr',
  греция: 'gr',
  греческий: 'gr',
  turkish: 'tr',
  turk: 'tr',
  spanish: 'es',
  spaniard: 'es',
  испанец: 'es',
  frenchman: 'fr',
  french: 'fr',
  француз: 'fr',
  german: 'de',
  немец: 'de',
  немецкий: 'de',
  германия: 'de',
  irish: 'ie',
  scot: 'gb',
  chinese: 'cn',
  китай: 'cn',
  китайский: 'cn',
  japanese: 'jp',
  япония: 'jp',
  японский: 'jp',
  korean: 'kr',
  'south korea': 'kr',
  'north korea': 'kp',
  корея: 'kr',
  russian: 'ru',
  россия: 'ru',
  русский: 'ru',
  российский: 'ru',
  ussr: 'ru',
  'soviet union': 'ru',
  ссср: 'ru',
  советский: 'ru',
  ukrainian: 'ua',
  украина: 'ua',
  украинский: 'ua',
  serbian: 'rs',
  serb: 'rs',
  croatian: 'hr',
  portuguese: 'pt',
  brazilian: 'br',
  argentine: 'ar',
  argentinian: 'ar',
  mexican: 'mx',
  cuban: 'cu',
  venezuelan: 've',
  uruguayan: 'uy',
  paraguayan: 'py',
  chilean: 'cl',
  peruvian: 'pe',
  colombian: 'co',
  italian: 'it',
  austrian: 'at',
  belgian: 'be',
  hungarian: 'hu',
  romanian: 'ro',
  bulgarian: 'bg',
  israeli: 'il',
  indian: 'in',
  australian: 'au',
  canadian: 'ca',
  'new zealander': 'nz',
  'south african': 'za',
};

/** Locales whose country names are worth consulting: the deployment's ten. */
const NAME_LOCALES = ['en', 'ru', 'es', 'de', 'fr', 'it', 'pt', 'ja', 'zh', 'ko'];

/** Built once, on the first value that is not already a code. */
let nameIndex: Map<string, Set<string>> | undefined;

/** One `Intl.DisplayNames` per locale, built on first use. */
const displayNames = new Map<string, Intl.DisplayNames | undefined>();

export function isCountryCode(value: string): boolean {
  return alpha2.has(value.trim().toLowerCase());
}

/** Every admissible alpha-2 code, lowercase. */
export function countryCodes(): ReadonlySet<string> {
  return alpha2;
}

/**
 * `"es"` | `"ESP"` | `"Spain"` | `"Испания"` | `"Spanish"` → `"es"`.
 *
 * Returns `undefined` rather than a guess: `external/07` §7.2 rule 5 is "do not
 * invent facts", and an absent `country` degrades to a card without a flag,
 * while a wrong one is a claim about a person.
 */
export function resolveCountry(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const lower = value.toLowerCase();
  // Two letters are alpha-2 by intent — but only the alias table knows that
  // `uk` means `gb`, and returning early here made its own entry unreachable.
  if (/^[a-z]{2}$/.test(lower) && alpha2.has(lower)) return lower;

  const upper = value.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) {
    const mapped = alpha3.get(upper);
    if (mapped) return mapped;
  }

  const key = fold(value);
  const alias = ALIASES[key] ?? ALIASES[lower];
  if (alias) return alias;

  const names = countryNameIndex();
  const exact = names.get(key);
  if (exact?.size === 1) return [...exact][0];

  return byUniquePrefix(key, names);
}

/**
 * `("au", "ru")` → `"Австралия"`. The reverse of {@link resolveCountry}.
 *
 * `country` is a machine token, but a *place* is prose: `birthplace` is read by
 * a human off a card, in the language of the edition it belongs to. A code that
 * leaks into one — `"Melbourne, au"` — is not a terse spelling of the country,
 * it is a value from the wrong domain, and it is exactly what a model produces
 * when it has been told, once, that countries are ISO codes. ICU already knows
 * every region's name in every deployment language, so repairing it is free.
 *
 * Falls back to English, then to `undefined` on a runtime without the locale
 * data — never to the code itself, so a caller can tell "no name" from a name.
 */
export function countryName(code: string, language: string): string | undefined {
  const value = code.trim().toLowerCase();
  if (!alpha2.has(value)) return undefined;

  const region = value.toUpperCase();
  for (const locale of [language.trim().toLowerCase(), 'en']) {
    const display = displayNamesFor(locale);
    if (!display) continue;
    try {
      const name = display.of(region);
      if (name && name !== region) return name;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The region-name facility for one locale, or nothing.
 *
 * An unsupported locale does **not** throw: `new Intl.DisplayNames(['zz'], …)`
 * quietly resolves to the host's default locale, which would make the country
 * name in a published dossier depend on which machine produced it. Asking
 * `supportedLocalesOf` first is the only way to tell "ICU knows this language"
 * from "ICU substituted yours".
 */
function displayNamesFor(locale: string): Intl.DisplayNames | undefined {
  if (!locale) return undefined;
  if (displayNames.has(locale)) return displayNames.get(locale);

  let display: Intl.DisplayNames | undefined;
  try {
    display =
      Intl.DisplayNames.supportedLocalesOf([locale]).length > 0
        ? new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' })
        : undefined;
  } catch {
    display = undefined;
  }
  displayNames.set(locale, display);
  return display;
}

/**
 * A demonym shares a long prefix with the country's own name in the same
 * language (`Spanish`/`Spain`, `испанский`/`Испания`, `Spanier`/`Spanien`), and
 * the rule is only allowed to fire when exactly one country matches — otherwise
 * `Ind…` would have to choose between India and Indonesia.
 */
function byUniquePrefix(key: string, names: ReadonlyMap<string, Set<string>>): string | undefined {
  const MIN_PREFIX = 4;
  if (key.length < MIN_PREFIX) return undefined;

  const hits = new Set<string>();
  for (const [name, codes] of names) {
    const shared = commonPrefix(key, name);
    if (shared < MIN_PREFIX) continue;
    // The query must cover nearly the whole country name, or "Central" would
    // answer "Central African Republic" and every long name would be a magnet.
    if (shared < name.length - 3) continue;
    for (const code of codes) hits.add(code);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * name (folded) → codes, across every consulted locale.
 *
 * Built lazily and once. `Intl.DisplayNames` carries ICU's own region names, so
 * this stays correct without a vendored table; a runtime without full ICU simply
 * yields a smaller index and falls back to the alias table.
 */
function countryNameIndex(): ReadonlyMap<string, Set<string>> {
  if (nameIndex) return nameIndex;
  const index = new Map<string, Set<string>>();

  for (const locale of NAME_LOCALES) {
    let display: Intl.DisplayNames;
    try {
      display = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    } catch {
      continue;
    }
    for (const code of alpha2) {
      let name: string | undefined;
      try {
        name = display.of(code.toUpperCase());
      } catch {
        continue;
      }
      if (!name) continue;
      const key = fold(name);
      if (!key) continue;
      const bucket = index.get(key) ?? new Set<string>();
      bucket.add(code);
      index.set(key, bucket);
    }
  }

  nameIndex = index;
  return index;
}

/** Lowercase, diacritic-free, punctuation-free — the shape both sides compare in. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
