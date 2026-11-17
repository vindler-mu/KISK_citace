// Čtení citací: prostý text, BibTeX, RIS (bez přístupu k DOM)
import { STOP, norm, tidy, tokens } from "./text.js";

export const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;

export function cleanDoi(d) {
  return d.replace(/[.,;:)\]]+$/, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

// Odstraní URL, DOI, ISBN a podobné části, které ruší porovnání textu
export function cleanRaw(s) {
  return s
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/doi:\s*\S+/gi, " ")
    .replace(/10\.\d{4,9}\/\S+/g, " ")
    .replace(/\b(ISBN|ISSN|eISSN)[\s:]*[\dXx\- ]{8,20}/g, " ")
    .replace(/\[(online|cit\.?[^\]]*|vid\.[^\]]*)\]/gi, " ")
    .replace(/(Dostupné z|Dostupné online|Retrieved from|Available (from|at))[:\s]*/gi, " ")
    .replace(/\s+/g, " ").trim();
}

// Rozdělí text na segmenty podle teček, ale ne za iniciálami (J.) nebo zkratkami
export function segments(s) {
  const parts = s.split(/(?<=[.?!])\s+/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + " " + p : p;
    // Poslední slovo stačí vzít z nové části (dřív se pokaždé dělil celý dosavadní text, což u obřích vstupů trvalo minuty)
    const last = p.trim().split(/\s+/).pop();
    if (/^(\p{Lu}\.|\p{Lu}\.-\p{Lu}\.|\p{Lu}\p{Ll}?\.|eds?\.|vyd\.|s\.|č\.|roč\.|no\.|vol\.|pp?\.|tr\.|přel\.|aj\.)$/u.test(last)) continue;
    out.push(cur.trim().replace(/\.$/, ""));
    cur = "";
  }
  if (cur.trim()) out.push(cur.trim().replace(/\.$/, ""));
  return out.filter(Boolean);
}

// Odhad názvu díla z citace (jen pomocný, nemusí být přesný). Zkouší postupně:
export function guessTitle(raw) {
  // Bez popisků v hranatých závorkách a bez údaje o vydání: (2., rozš. vyd.), (Vydání: první)
  const s = cleanRaw(raw).replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s*\((?:\d+\.|vydání|[^()]*\bvyd\.)[^()]*\)/gi, "");
  const YEAR = "(?:\\d{4}[a-z]?|n\\.\\s?d\\.|b\\.\\s?r\\.)(?:,[^)]*)?";
  const done = t => { t = (t || "").replace(/^[\s"“„‘']+|[\s"”“’'.,;:]+$/g, "").trim(); return tokens(t).length ? t : null; };
  // 1) APA: Autor, X. (2006). Název.
  let m = s.match(new RegExp("\\(" + YEAR + "\\)\\.\\s+(?=[\\p{L}\\d\"“„‘'])(.+)$", "u"));
  if (m && m.index < 250) return done(segments(m[1])[0]);
  // 2) Název v uvozovkách: MLA, Chicago, Harvard, IEEE
  m = s.match(/[“"„]([^“”"„]{6,}?)[”"“]/) || s.match(/(?:^|[\s(])[‘']([^‘’']{6,}?)[’'](?=[\s,.;:)]|$)/);
  if (m && tokens(m[1]).length >= 2) return done(m[1]);
  // 3) Harvard bez uvozovek: Autor, X. (2006) Název.
  m = s.match(new RegExp("\\(" + YEAR + "\\)\\s+(?=\\p{L})(.+)$", "u"));
  if (m && m.index < 250) return done(segments(m[1])[0]);
  // 4) Vancouver: Braun V, Clarke V. Název.
  m = s.match(/^(?:[\p{Lu}][\p{L}'’\-]+(?:[ \-][\p{Lu}][\p{L}'’\-]+)*\s\p{Lu}{1,3}(?:,\s|\.\s|\s(?=et al)))+(?:et al\.?\s)?/u);
  if (m && m[0].length < s.length) { const t = done(segments(s.slice(m[0].length))[0]); if (t) return t; }
  // 5) Autoři oddělení dvojtečkou: Braun V., Clarke V.: Název.
  m = s.match(/^([^:]{3,150}?\p{Lu}\.)\s*:\s+(.+)$/u);
  if (m) return done(segments(m[2])[0]);
  // 6) Ostatní (ISO 690, MLA bez uvozovek): druhý segment za autory
  const segs = segments(s);
  return segs.length >= 2 ? done(segs[1]) : null;
}

// Najde DOI nebo URL i tehdy, když se do něj při kopírování dostaly mezery.
// Vrací {parts:[kousky oddělené mezerou], start, end}.
export function findSpan(raw, startRe, isUrl) {
  const m = raw.match(startRe);
  if (!m) return null;
  const start = m.index;
  const rest = raw.slice(start);
  const chunks = rest.split(/(\s+)/);
  const parts = [chunks[0]];
  let len = chunks[0].length;
  for (let k = 1; k + 1 < chunks.length; k += 2) {
    const ws = chunks[k], c = chunks[k + 1];
    if (!c) break;
    const looksLikeCode = /^[\w.\-\/():;#%=?&~+]+$/.test(c) && !/^(https?:|www\.|doi:)/i.test(c);
    const hasCodeChars = isUrl ? /[\/.\-_=?&%]/.test(c) || /^\d+$/.test(c) : /[\d\/.\-]/.test(c);
    const prevOpen = isUrl && /[\-\/_=.]$/.test(parts[parts.length - 1]);
    if (!looksLikeCode || !(hasCodeChars || prevOpen) || /^[\p{Lu}][\p{Ll}]{2,}/u.test(c)) break;
    parts.push(c);
    len += ws.length + c.length;
  }
  return { parts, start, end: start + len };
}

// Varianty DOI k vyzkoušení: mezera mohla vzniknout ze spojovníku, nebo je navíc
export function doiVariants(parts) {
  const clean = d => cleanDoi(d.replace(/^.*?(10\.\d)/, "$1"));
  // Skutečné DOI nikdy neobsahuje úsek "." ani ".." (10.1234/../x), takové varianty zahodíme
  const safe = d => !/\/\.\.?(\/|$)/.test(d);
  if (!parts || !parts.length) return [];
  if (parts.length === 1) return [clean(parts[0])].filter(safe);
  const v = [];
  for (let n = parts.length; n >= 1; n--) {
    const p = parts.slice(0, n);
    v.push(clean(p.join("-")), clean(p.join("")));
  }
  return [...new Set(v)].filter(d => /^10\.\d{4,9}\/\S+/.test(d) && safe(d));
}

// Ročník, číslo a strany z textu citace. Raději nic než něco špatně: bere jen jasné vzory.
export function parsePages(p) {
  const m = String(p || "").match(/(\d{1,6})\s*[-–\u2014]\s*(\d{1,6})/) || String(p || "").match(/^\s*(\d{1,6})\s*$/);
  if (!m) return null;
  let a = +m[1], b = m[2] ? +m[2] : null;
  if (b != null && b < a && m[2].length < m[1].length) b = +(m[1].slice(0, m[1].length - m[2].length) + m[2]); // 436-44 = 436-444
  if (b != null && (b < a || b - a > 3000)) return null;
  return [a, b];
}
export function extractBiblio(s) {
  const out = {};
  const isYear = n => /^(1[5-9]\d\d|20\d\d)$/.test(n);
  let m;
  m = s.match(/\b(?:vol\.?|volume|roč\.?|ročník|jg\.?|bd\.?)\s*(\d{1,4})\b/i);
  if (m) out.volume = m[1];
  m = s.match(/(?:^|[\s,(])(?:no\.?|nr\.?|issue|č\.|číslo|heft)\s*(\d{1,4}(?:\s*[-–\/]\s*\d{1,4})?)\b/i);
  if (m) out.issue = m[1].replace(/\s/g, "");
  if (!out.volume) { m = s.match(/\b(\d{1,4}),?\s*(?:no\.|č\.|issue)\s*\d/i); if (m) out.volume = m[1]; }
  m = s.match(/(?:^|[\s,;:.])(\d{1,4})\s?\((\d{1,5}(?:[-–\/]\d{1,5})?)\)/);
  if (m) {
    if (!isYear(m[2])) { if (!out.volume) out.volume = m[1]; if (!out.issue) out.issue = m[2]; }
    else if (!isYear(m[1]) && !out.volume) out.volume = m[1];
  }
  m = s.match(/\b(?:pp?\.|s\.|str\.|pages?)\s*(\d{1,6}\s*[-–\u2014]\s*\d{1,6})/i);
  if (!m) {
    const all = [...s.matchAll(/(?:^|[\s:,;])(\d{1,6}\s*[-–\u2014]\s*\d{1,6})(?=[\s.,;)]|$)/g)]
      .filter(x => { const [a, b] = x[1].split(/\s*[-–\u2014]\s*/); return !(isYear(a) && isYear(b)); });
    m = all.length ? all[all.length - 1] : null;
  }
  if (m) { const pg = parsePages(m[1]); if (pg && pg[1] != null) out.pages = pg; }
  // Strany bez pomlčky hned za ročníkem a číslem: 41(2), 305 319.
  if (!out.pages) {
    m = s.match(/\d\),\s*(\d{1,6})\s+(\d{1,6})(?=[.,;\s]|$)/);
    if (m && !(isYear(m[1]) && isYear(m[2]))) { const pg = parsePages(m[1] + "-" + m[2]); if (pg) out.pages = pg; }
  }
  return out;
}

// Druhy zdrojů, které v odborných databázích obvykle nejsou: právní předpisy, normy, závěrečné práce
const GREY = [
  ["law", /\bzákon(a|u|em|ů|y)?\b|\bvyhlášk|\bnařízení (vlády|EU|Evropského|Komise)|\bč\.\s*\d{1,4}\s*\/\s*\d{4}\s*Sb\b|\b\d{1,4}\/\d{4}\s*Sb\.|\bSbírka zákonů|\bÚřední věstník|\bOfficial Journal of the European|\bDirective (\(EU\)\s*)?\d{4}\/\d+|\bRegulation \(E[UC]\)|\bsměrnic[ea] (EU|Evropského|Rady)|\bAct of (19|20)\d\d\b|\bU\.S\.C\.|\bPublic Law \d/i],
  ["standard", /\bČSN\b|\bISO(\/IEC)?\s*\d{3,5}(-\d+)?(:\d{4})?\b|\bEN\s+\d{3,5}\b|\bDIN\s+\d{3,5}\b|\bIEEE Std\b|\bANSI\/NISO\b/],
  ["thesis", /\b(diplomová|bakalářská|disertační|dizertační|rigorózní|závěrečná|habilitační|absolventská) práce\b|\b(master'?s|bachelor'?s|doctoral|PhD|Ph\.D\.) (thesis|dissertation)\b|\bdoctoral dissertation\b|\[(diplomová|bakalářská|disertační|dizertační|rigorózní)\b/i]
];
// Instituce jako autor (zprávy, doporučení, metodiky): "World Health Organization. (2021)…", "MŠMT. Strategie…"
const ORG_WORD = /(?:^|[\s,])(organi[sz]ation|ministry|ministerstvo|ministerstva|commission|komise|agency|agentura|institute|institut|úřad|office|council|rada|association|asociace|inspekce|inspectorate|foundation|nadace|department|bank|centre|center|centrum|united nations|european union|evropská unie|svaz|federation|federace|knihovn(?:a|y|u|ě|ou)|knihoven|library|libraries|univerzit[ay]|university|fakult[ay]|faculty|muzeum|museum|archiv|archive|škola|školy|college|akademie|academy)(?=[\s,.]|$)/i;
const ORG_ABBR = /^(WHO|UNESCO|UNICEF|OECD|OSN|UN|EU|IFLA|ALA|NÚV|NPI ČR|ČŠI|MŠMT|ČSÚ|Eurostat|Eurydice|Evropská komise|European Commission|Národní pedagogický institut|Česká školní inspekce)(?=[\s,.(]|$)/;
function corporateAuthor(s) {
  const head = String(s || "").replace(/^\s*(\[\d+\]|\d+[.)])\s*/, "").split(/\(\s*\d{4}|\.\s|,\s*\d{4}/)[0];
  // "Bank, J." nebo "Center, Anna" je člověk, ne instituce
  if (/^[\p{L}'’\- ]+,\s*\p{Lu}(?:\.|\s|$|\p{Ll}+(?:\s|$))/u.test(head.trim())) return false;
  return head.length < 120 && (ORG_ABBR.test(head.trim()) || ORG_WORD.test(head));
}

export function greyKind(s, type) {
  if (/thesis|^THES$/i.test(type || "")) return "thesis";
  if (/^(standard|STAND)$/i.test(type || "")) return "standard";
  if (/^(legislation|legal|STAT|BILL|LEGAL)$/i.test(type || "")) return "law";
  for (const [k, re] of GREY) if (re.test(s || "")) return k;
  if (corporateAuthor(s)) return "report";
  return "";
}

export const UNPUBLISHED_RE = /nepublikovan|unpublished|osobní sdělení|personal communication|rukopis|manuscript|surová data|raw data|interní (dokument|materiál)|internal (document|report)|\[dotazník|nepublikováno/i;

// Údaj o vydání knihy: "5., aktualiz. vyd.", "2nd ed.", "3rd edition", "rev. ed.", "2. Aufl."
export const EDITION_RE = /(?:\b\d{1,2}(?:\.|st|nd|rd|th)?|\b(?:rev|revised|aktualiz|dopl|rozš|přeprac|upr))[\s.,]*(?:[\p{L}]+\.?[\s,]*){0,4}?(?:vyd\b|vydání|ed\.|edn\b|edition|aufl)/iu;
export function editionOf(s) {
  const m = String(s || "").match(EDITION_RE);
  return m ? m[0].replace(/\s+/g, " ").trim() : "";
}

// Slovo rozdělené na konci řádku, když už jsou řádky spojené: "analy- sis" → "analysis".
// Nespojí "pre- and post-test", "středo- a východoevropský" ani odkazy.
const KEEP_HYPHEN = /^(and|or|und|oder|et|ou|a|i|nebo|či|ani|y|o|to|bis)$/i;
export function fixBrokenWords(s) {
  return String(s || "").replace(/(^|\s)([\p{L}]{2,})- (\p{Ll}[\p{L}]*)/gu, (m, sp, a, b) => KEEP_HYPHEN.test(b) ? m : sp + a + b);
}

// Slova rozdělená i podle spojovníku (norm ho bere jako mezeru): "Cruz-Aguilar" → "cruz", "aguilar"
const splitWords = s => norm(s).split(" ").filter(t => t.length > 1 && !STOP.has(t));

export const MAX_CITATION = 3000;   // znaků na jednu citaci
export const MAX_INPUT = 1000000;   // znaků na celý vložený text

export function plainEntry(raw) {
  // Podoba se spojovníkem pro porovnání: "self- regulated" může být i "self-regulated"
  // Skutečná citace má nanejvýš pár set znaků. Delší blok (nerozdělený text z PDF) se pro rozbor zkrátí,
  // aby obří vstup nezamrazil stránku.
  raw = String(raw || "").slice(0, MAX_CITATION);
  const hyphenKept = tidy(raw).replace(/([\p{L}]{2,})- (\p{Ll})/gu, "$1-$2");
  raw = fixBrokenWords(tidy(raw)).replace(/^\s*(\[\d+\]|\d+[.)]|[-•*–])\s*/, "").replace(/\s+/g, " ").trim();
  // DOI (i rozdělené mezerou)
  const doiSpan = findSpan(raw, /(?:https?:\/\/(?:dx\.)?doi\.org\/\s?|doi:\s?)?10\.\d{4,9}\/?/i, false);
  let rest = raw;
  let variants = [];
  if (doiSpan) {
    variants = doiVariants(doiSpan.parts);
    rest = raw.slice(0, doiSpan.start) + " " + raw.slice(doiSpan.end);
  }
  // Ostatní odkazy (URL), také slepené z kousků
  const urls = [];
  for (let guard = 0; guard < 5; guard++) {
    const sp = findSpan(rest, /https?:\/\/|www\./i, true);
    if (!sp) break;
    urls.push(sp.parts.join("").replace(/[.,;)\]]+$/, ""));
    rest = rest.slice(0, sp.start) + " " + rest.slice(sp.end);
  }
  const isbnM = raw.match(/ISBN[\s:\-]*((?:97[89][\s\-]?)?(?:\d[\s\-]?){9}[\dXx])/i);
  const clean = cleanRaw(rest);
  const years = [...new Set((clean.match(/\b(1[5-9]\d\d|20\d\d)\b/g) || []).map(Number))];
  return {
    kind: "plain", raw,
    doi: variants[0] || "", doiVariants: variants, doiHadSpace: !!(doiSpan && doiSpan.parts.length > 1),
    urls,
    // Neplatné ISBN (chybná kontrolní číslice) nehledáme, ale zapamatujeme si ho jako varovný signál
    isbn: isbnM && isbnValid(isbnM[1]) ? isbnM[1].replace(/[\s\-]/g, "") : "",
    isbnInvalid: isbnM && !isbnValid(isbnM[1]) ? isbnM[1].replace(/[\s\-]/g, "") : "",
    years, titleGuess: guessTitle(rest), biblio: extractBiblio(clean),
    edition: editionOf(rest),
    // Slova citace v obou podobách: spojená ("cruzaguilar", "pretrained") pro názvy
    // i rozdělená podle spojovníku ("cruz", "aguilar") pro příjmení se spojovníkem
    hay: new Set([...tokens(clean), ...tokens(cleanRaw(hyphenKept)), ...splitWords(clean)]),
    etAl: /\bet al\b|\ba kol\b|\baj\.|\bet\. al/i.test(raw),
    unpublished: UNPUBLISHED_RE.test(raw),
    grey: greyKind(raw)
  };
}

// Řádek, který nezačíná novou citací (odkaz, pokračování), patří k předchozí
export function isContinuation(line) {
  return /^(https?:\/\/|www\.|doi:|10\.\d{4}|\(|[\p{Ll}\d])/u.test(line.trim());
}

// Číslování nebo odrážka na začátku řádku: vždy nová citace
const NUMBERED_RE = /^(\[\d+\]|\d{1,3}[.)]|[•*–-])\s/;

// Vypadá řádek jako začátek citace? (Text z PDF má konce řádků i uprostřed citace.)
function looksLikeStart(line) {
  return /^\p{Lu}[\p{L}'’\-]+,\s\p{Lu}/u.test(line)     // Braun, V.
    || /^\p{Lu}[\p{L}'’\-]+\s\p{Lu}{1,3}[,.\s]/u.test(line) // Braun V, (Vancouver)
    || /^\p{Lu}{2,}[\p{Lu}\s\-]*[,.(]/u.test(line)      // BRAUN, nebo UNESCO.
    || /^\p{Lu}\.\s/u.test(line)                        // V. Braun (IEEE)
    || /^[^.]{0,80}\((\d{4}|n\.\s?d\.|b\.\s?r\.)/u.test(line); // Ministerstvo školství (2020)
}

// PDF rozdělí strany "305–319" na konec řádku a začátek dalšího a pomlčku zahodí.
// "319. https://..." pak není položka číslo 319, ale zbytek stran.
function looksLikeSplitPages(prev, line) {
  const a = prev.match(/,\s*(\d{1,6})$/), b = line.match(/^(\d{1,6})[.,;]?(\s|$)/);
  if (!a || !b || /^(1[5-9]\d\d|20\d\d)$/.test(a[1])) return false;
  return +b[1] > +a[1];
}

// Patří kousek textu k předchozí citaci?
// afterBlank: kousky oddělil prázdný řádek, takže spojujeme jen zjevně nedokončenou citaci.
function joinsPrevious(prev, line, afterBlank) {
  if (looksLikeSplitPages(prev, line)) return true;
  if (NUMBERED_RE.test(line)) return false;
  if (/([,;:&\-]|,["”’]|\b(a|and|in|of|the|und|et|ve|na|pro))$/.test(prev)) return true;
  if (/(^|[\s(])\p{Lu}\.$/u.test(prev)) return true; // končí iniciálou: "In B." pokračuje jménem
  if (!afterBlank && isContinuation(line)) return true;
  if (looksLikeStart(line)) return false;
  if (!/[.?!)\]"”’]$/.test(prev)) return true;
  // Předchozí řádek končí tečkou. Nová citace je to, jen když řádek má rok
  // a předchozí citace ho už taky má. Jinak jde o její zbytek (časopis, strany).
  const year = /\b(1[5-9]\d\d|20\d\d)\b/;
  return !afterBlank && !(year.test(line) && year.test(prev));
}

// Spojí dva kousky. Slovo rozdělené spojovníkem na konci řádku složí zpět,
// ale ne u odkazů a DOI, kde spojovník patří do adresy.
function joinLines(a, b) {
  if (!a) return b;
  const lastWord = a.split(/\s+/).pop();
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b) && !/[\/:]|^10\.|^www\./i.test(lastWord)) return a.slice(0, -1) + b;
  return a + " " + b;
}

// Rozdělí blok, ve kterém jsou omylem dvě citace APA za sebou
export function splitMerged(block) {
  const re = /\.\s+(?=[\p{Lu}][\p{L}'’\-]+,\s(?:\p{Lu}\.\s?(?:-\s?\p{Lu}\.)?\s?)+[^()]{0,160}?\((?:\d{4}[a-z]?|n\.\s?d\.|b\.\s?r\.)\))/gu;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(block))) {
    const piece = block.slice(last, m.index + 1).trim();
    if (piece.length > 15) { out.push(piece); last = m.index + 1; }
  }
  out.push(block.slice(last).trim());
  return out.filter(Boolean);
}

export function parsePlain(text) {
  return splitCitations(text).map(plainEntry);
}

// BibTeX a RIS mají citace rozdělené samy, ty se nečistí
// Vložená celá práce: najde nadpis seznamu literatury a vrátí jen text za ním.
// Bere poslední výskyt (první bývá v obsahu) a končí u příloh. Krátký text nechá být.
const BIB_HEAD = /^[ \t]*(?:\d{1,2}(?:\.\d{1,2})*\.?[ \t]+)?(seznam (?:použité |citované )?literatury|seznam (?:použitých |citovaných )?(?:zdrojů|pramenů)(?: a literatury)?|použitá literatura|použité zdroje|literatura|bibliografie|prameny a literatura|zdroje|references|reference list|bibliography|works cited|literature cited|literatur(?:verzeichnis)?)[ \t]*:?[ \t]*$/gim;
const AFTER_HEAD = /^[ \t]*(?:\d{1,2}(?:\.\d{1,2})*\.?[ \t]+)?(přílohy|příloha(?: [\dA-Z]+)?|seznam (?:příloh|obrázků|tabulek|zkratek)|appendix(?:es)?(?: [\dA-Z]+)?|appendices|anhang|rejstřík|index|summary|abstrakt|abstract|resumé)[ \t]*:?[ \t]*$/im;
export function extractBibliography(text) {
  const t = String(text || "").replace(/\r/g, "");
  if (t.length < 3000) return { text: t, heading: "" };
  let last = null;
  for (const m of t.matchAll(BIB_HEAD)) last = m;
  if (!last) return { text: t, heading: "" };
  let rest = t.slice(last.index + last[0].length);
  const end = rest.search(AFTER_HEAD);
  if (end > 0) rest = rest.slice(0, end);
  // Za nadpisem musí být aspoň trochu textu, jinak šlo o nadpis v obsahu na konci
  if (rest.trim().length < 80) return { text: t, heading: "" };
  return { text: rest.trim(), heading: last[1].trim() };
}

// Odkaz na už citovaný zdroj z poznámek pod čarou: "Tamtéž, s. 12.", "Ibid.", "Novák, op. cit., s. 5"
export function isBackReference(s) {
  const t = String(s || "").replace(/^\s*(\[\d+\]|\d+[.)])\s*/, "").trim();
  if (/^(tamtéž|tamže|tamt\.|ibid\.?|ibidem|dtto|tamtiež)(?=[\s,.;:]|$)/i.test(t)) return true;
  return t.length < 90 && /\b(op\.\s?cit|loc\.\s?cit|cit\.\s?d(í|i)lo|c\.\s?d\.)/i.test(t);
}

// Kontrolní číslice ISBN-10 a ISBN-13
export function isbnValid(isbn) {
  const s = String(isbn || "").replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : +s[i]) * (10 - i);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += +s[i] * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  return false;
}

export function isStructured(text) {
  return /@\w+\s*\{/.test(text) || /^TY  - /m.test(text);
}

// Vyčištění vloženého textu: každá citace jako jeden odstavec, bez číslování.
// Učitel výsledek vidí a může ho opravit, než se začne hledat.
export function cleanCitations(text) {
  if (isStructured(text)) return text;
  return splitCitations(text).map(c => fixBrokenWords(c.replace(/^\s*(\[\d+\]|\d+[.)]|[-•*–])\s*/, ""))).join("\n\n");
}

// Text už vyčištěný: co odstavec, to citace. Nic se nedomýšlí.
function parseExact(text) {
  return tidy(text).replace(/\r/g, "").split(/\n\s*\n/)
    .map(b => b.replace(/\s*\n\s*/g, " ").trim()).filter(b => b.length > 8).map(plainEntry);
}

// Čísla stran, záhlaví a zápatí z PDF, které se při kopírování více stránek vloží mezi citace (i doprostřed citace).
// Číslo stránky: "12", "– 12 –", "Strana 12", "s. 12", "12 / 45", "12 z 45", "Page 3 of 10".
// Nejvýš 3 číslice: samotný rok na řádku ("2011" po zalomení citace) číslo stránky není.
const PAGE_NUM = /^\s*[-–—]?\s*(?:str(?:ana|\.)?\s*|page\s*|s\.\s*)?\d{1,3}(?:\s*(?:\/|z|ze|of)\s*\d{1,3})?\s*[-–—]?\s*$/i;
// Záhlaví/zápatí: řádek, který se opakuje (s případným číslem stránky na začátku nebo na konci).
// Odstraní se, jen když stojí u čísla stránky, nebo se opakuje aspoň třikrát, aby nezmizel úsek citace.
export function stripPageArtifacts(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const key = l => l.trim().replace(/^\d{1,4}\s+|\s+\d{1,4}$/g, "").replace(/\s+/g, " ").toLowerCase();
  const isPage = lines.map(l => l.trim() !== "" && PAGE_NUM.test(l));
  const counts = new Map();
  lines.forEach((l, i) => { if (!isPage[i] && l.trim()) counts.set(key(l), (counts.get(key(l)) || 0) + 1); });
  const nearPage = i => { for (let d = -3; d <= 3; d++) if (isPage[i + d]) return true; return false; };
  let removed = 0;
  const out = lines.filter((l, i) => {
    if (isPage[i]) { removed++; return false; }
    const k = key(l), n = counts.get(k) || 0;
    // Bez čísla stránky poblíž musí řádek nevypadat jako kus citace (bez koncové interpunkce a bez roku)
    const fragment = /[,.;:]$/.test(k) || /\b(1[5-9]\d\d|20\d\d)\b/.test(k);
    if (k && k.length <= 150 && n >= 2 && (nearPage(i) || (n >= 3 && !fragment))) { removed++; return false; }
    return true;
  });
  return { text: out.join("\n"), removed };
}

function splitCitations(text) {
  text = stripPageArtifacts(tidy(text)).text;
  // S prázdnými řádky jsou kousky celé odstavce, jinak jednotlivé řádky
  const hasBlank = /\n\s*\n/.test(text);
  const pieces = hasBlank
    ? text.split(/\n\s*\n/).map(b => b.split("\n").map(l => l.trim()).filter(Boolean).reduce(joinLines, ""))
    : text.split("\n").map(l => l.trim());
  const blocks = [];
  for (const piece of pieces) {
    if (!piece || PAGE_NUM.test(piece)) continue; // prázdno nebo zbylé číslo stránky z PDF
    const last = blocks.length - 1;
    if (last >= 0 && joinsPrevious(blocks[last], piece, hasBlank)) blocks[last] = joinLines(blocks[last], piece);
    else blocks.push(piece);
  }
  return blocks.flatMap(splitMerged).map(b => b.trim()).filter(b => b.length > 8);
}

// LaTeX akcenty v BibTeXu: {\'a} -> á, {\v{c}} -> č ...
export function delatex(s) {
  const marks = { "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "v": "\u030C", "u": "\u0306", "H": "\u030B", "c": "\u0327", "r": "\u030A", "=": "\u0304", ".": "\u0307" };
  return (s || "")
    .replace(/\\([`'^"~=.uvHcr])\s*\{?\\?([a-zA-Z])\}?/g, (m, a, ch) => ch + (marks[a] || ""))
    .replace(/\\&/g, "&").replace(/[{}]/g, "").replace(/\\[a-zA-Z]+\s?/g, "")
    .normalize("NFC").replace(/\s+/g, " ").trim();
}

export function parseBibtex(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf("@", i)) !== -1) {
    const head = text.slice(i).match(/^@(\w+)\s*\{/);
    if (!head) { i++; continue; }
    const type = head[1].toLowerCase();
    let j = i + head[0].length, depth = 1;
    const start = j;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++; else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(start, j - 1);
    i = j;
    if (["comment", "string", "preamble"].includes(type)) continue;
    const f = {};
    const re = /(\w[\w-]*)\s*=\s*/g;
    re.lastIndex = body.indexOf(",") + 1;
    let m;
    while ((m = re.exec(body))) {
      let k = m.index + m[0].length, val = "";
      if (body[k] === "{") {
        let d = 1, q = k + 1;
        while (q < body.length && d > 0) { if (body[q] === "{") d++; else if (body[q] === "}") d--; q++; }
        val = body.slice(k + 1, q - 1); re.lastIndex = q;
      } else if (body[k] === '"') {
        const q = body.indexOf('"', k + 1); val = body.slice(k + 1, q); re.lastIndex = q + 1;
      } else {
        const q = body.slice(k).search(/[,\n]/); val = body.slice(k, q < 0 ? undefined : k + q); re.lastIndex = k + (q < 0 ? body.length : q);
      }
      f[m[1].toLowerCase()] = delatex(val);
    }
    out.push(structuredEntry({
      title: f.title, authors: (f.author || f.editor || "").split(/\s+and\s+/i).filter(Boolean),
      year: f.year || (f.date || "").slice(0, 4), journal: f.journal || f.journaltitle || f.booktitle || "",
      doi: f.doi, isbn: f.isbn, publisher: f.publisher, type, url: f.url, edition: f.edition,
      volume: f.volume, issue: f.number || f.issue, pages: (f.pages || "").replace(/--/g, "-"), note: (f.note || "") + " " + (f.howpublished || "")
    }));
  }
  return out;
}

export function parseRis(text) {
  const out = [];
  let cur = null;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9])  -\s?(.*)$/);
    if (!m) continue;
    const [, tag, val] = m;
    if (tag === "TY") { cur = { authors: [], type: val.trim() }; continue; }
    if (!cur) continue;
    if (tag === "ER") { out.push(structuredEntry(cur)); cur = null; continue; }
    if (["AU", "A1", "A2"].includes(tag)) cur.authors.push(val);
    else if (["TI", "T1"].includes(tag)) cur.title = val;
    else if (["T2", "JO", "JF", "JA", "BT"].includes(tag) && !cur.journal) cur.journal = val;
    else if (["PY", "Y1", "DA"].includes(tag) && !cur.year) cur.year = (val.match(/\d{4}/) || [""])[0];
    else if (tag === "DO") cur.doi = val;
    else if (tag === "UR" && !cur.url) cur.url = val;
    else if (tag === "VL") cur.volume = val.trim();
    else if (tag === "IS") cur.issue = val.trim();
    else if (tag === "SP") cur.pages = val.trim() + (cur.pages && cur.pages.includes("-") ? "" : "");
    else if (tag === "EP") cur.pages = (cur.pages || "") + "-" + val.trim();
    else if (tag === "N1") cur.note = (cur.note || "") + " " + val;
    else if (tag === "SN") cur.isbn = val;
    else if (tag === "PB") cur.publisher = val;
    else if (tag === "ET") cur.edition = val.trim();
  }
  if (cur) out.push(structuredEntry(cur));
  return out;
}

export function structuredEntry(f) {
  const authors = (f.authors || []).map(a => a.trim()).filter(Boolean);
  const year = parseInt(f.year, 10) || null;
  const doiSp = findSpan(tidy(f.doi || ""), /10\.\d{4,9}\/?/, false);
  const dv = doiSp ? doiVariants(doiSp.parts) : [];
  const isbn = (f.isbn || "").replace(/[^\dXx]/g, "");
  const raw = [authors.join("; "), year ? "(" + year + ")" : "", f.title, f.journal, f.publisher].filter(Boolean).join(". ").replace(/\.\./g, ".");
  return {
    kind: "structured", raw,
    title: f.title || "", authors, year, journal: f.journal || "",
    doi: dv[0] || "", doiVariants: dv, doiHadSpace: !!(doiSp && doiSp.parts.length > 1),
    urls: f.url ? [f.url] : [], unpublished: UNPUBLISHED_RE.test(f.note || ""),
    grey: greyKind([f.title, f.journal, f.publisher, f.note].join(" "), f.type),
    isbn: (isbn.length === 10 || isbn.length === 13) && isbnValid(isbn) ? isbn : "",
    isbnInvalid: (isbn.length === 10 || isbn.length === 13) && !isbnValid(isbn) ? isbn : "",
    years: year ? [year] : [], titleGuess: f.title || null, edition: (f.edition || "").trim(),
    biblio: { volume: f.volume || "", issue: f.issue || "", pages: (() => { const pg = parsePages(f.pages); return pg && pg[1] != null ? pg : null; })() },
    hay: new Set([...tokens(raw), ...splitWords(raw)]), etAl: false
  };
}

// opts.exact: text prošel čištěním, odstavce jsou přesně citace
export function parseInput(text, opts = {}) {
  if (/@\w+\s*\{/.test(text)) return parseBibtex(text);
  if (/^TY  - /m.test(text)) return parseRis(text);
  return opts.exact ? parseExact(text) : parsePlain(text);
}
