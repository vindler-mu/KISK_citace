// Pomocné funkce pro práci s textem (bez přístupu k DOM)

// Slova, která při porovnávání ignorujeme (spojky, předložky, členy)
export const STOP = new Set(("an the of and or in on at to for from by with into about as is are be its their our your this that these those " +
  "der die das und von zu mit im fur ein eine " +
  "ve na do od po pro pri pod nad mezi jako ze se si je jsou ci nebo by bez jeho jejich " +
  "le la les de des du et en un une pour sur dans " +
  "el los las del con por para").split(/\s+/));

// Písmena, která se rozkladem na základ + diakritiku nezjednoduší
const FOLD = { "ł": "l", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "đ": "d", "þ": "th", "ı": "i" };
// Normalizace: malá písmena, bez diakritiky, jen písmena a čísla jakékoli abecedy (latinka, azbuka, řečtina, čínština…)
export function norm(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[łøßæœđþı]/g, c => FOLD[c])
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
// Čínština a japonština nepíšou mezery mezi slovy: rozložíme je na dvojice znaků
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
function cjkPieces(t) {
  const out = [];
  for (const run of t.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)/u)) {
    if (!run) continue;
    if (!CJK.test(run) || run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}
// Slova pro porovnání názvů. Spojovník mezi písmeny slovo nedělí: "pre-trained" = "pretrained", "e-learning" = "elearning".
// (Jména autorů se porovnávají přes norm() zvlášť, tam spojovník zůstává oddělovačem.)
export function tokens(s) {
  return norm(String(s || "").replace(/(\p{L})[-‐‑](\p{L})/gu, "$1$2")).split(" ").flatMap(t => CJK.test(t) ? cjkPieces(t) : [t])
    .filter(t => (t.length > 1 || CJK.test(t)) && !STOP.has(t));
}
// Databáze (hlavně Crossref) občas posílají v názvech HTML entity: "Gemini, &amp; Copilot".
// Dekódujeme je čistě textově (bez innerHTML). Dvakrát kvůli dvojitému zakódování "&amp;amp;".
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
export function decodeEntities(s) {
  let out = String(s || "");
  for (let k = 0; k < 2; k++) {
    out = out.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    });
  }
  return out;
}
export function stripTags(s) { return decodeEntities((s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

// Je vzdálenost dvou slov nejvýš 1 (jeden překlep)?
export function lev1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, ed = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++ed > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return ed + (la - i) + (lb - j) <= 1;
}
export function tokenIn(t, set) {
  if (!t) return false;
  if (set.has(t)) return true;
  if (t.length < 5) return false;
  for (const s of set) if (Math.abs(s.length - t.length) <= 1 && lev1(s, t)) return true;
  // Složené slovo napsané s mezerou na druhé straně: "pretrained" × "pre trained", "elearning" × "e learning"
  for (let i = 1; i < t.length - 2; i++) if (set.has(t.slice(0, i)) && set.has(t.slice(i))) return true;
  return false;
}
// Jako containment, ale slovo se počítá i jako zkratka (Qual. Res. Psychol. = Qualitative Research in Psychology)
export function abbrContainment(needle, hay) {
  const n = [...new Set(needle)];
  if (!n.length) return 0;
  const set = hay instanceof Set ? hay : new Set(hay);
  const shorts = [...set].filter(h => h.length >= 3 && /^[a-z]+$/.test(h));
  let m = 0;
  for (const t of n) if (tokenIn(t, set) || shorts.some(h => h.length < t.length && t.startsWith(h))) m++;
  return m / n.length;
}

// Slova z "needle", která jsou v "hay". Dvě sousední slova se počítají i jako jedno složené
// ("pre" + "training" = "pretraining"), needle proto musí zůstat v původním pořadí.
function foundTokens(needle, set) {
  const found = new Set();
  needle.forEach((t, i) => {
    if (tokenIn(t, set)) found.add(t);
    const next = needle[i + 1];
    if (next && set.has(t + next)) { found.add(t); found.add(next); }
  });
  return found;
}
// Jaký podíl slov z "needle" se vyskytuje v "hay" (0 až 1)
export function containment(needle, hay) {
  const n = [...new Set(needle)];
  if (!n.length) return 0;
  const set = hay instanceof Set ? hay : new Set(hay);
  const found = foundTokens([...needle], set);
  return n.filter(t => found.has(t)).length / n.length;
}
export function missingTokens(needle, hay) {
  const set = hay instanceof Set ? hay : new Set(hay);
  const found = foundTokens([...needle], set);
  return [...new Set(needle)].filter(t => !found.has(t));
}
export function symSim(a, b) { return (containment(a, b) + containment(b, a)) / 2; }

// Azbuka do latinky (zjednodušeně), aby šla porovnat jména napříč písmy: Выготский = Vygotsky
const CYR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "i", є: "e", ґ: "g", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz" };
export function translit(s) { return String(s || "").replace(/[Ѐ-ӿ]/g, c => CYR[c] ?? c); }
// Kostra jména: bez samohlásek a zdvojených písmen, sjednocené přepisy (w/v, kh/ch/h).
// Vygotskij, Vygotsky, Wygotski i Выготский dají "vgtsk".
export function skeleton(word) {
  return translit(word).replace(/w/g, "v").replace(/kh|ch|h/g, "h").replace(/[aeiouyj]/g, "").replace(/(.)\1+/g, "$1");
}
// Je jméno v množině slov aspoň podle kostry? Jen pro jména s aspoň 4 souhláskami, ať nevznikají náhodné shody.
export function skeletonIn(word, set) {
  const k = skeleton(word);
  if (k.length < 4) return false;
  for (const s of set) if (skeleton(s) === k) return true;
  return false;
}

export function surname(name) {
  name = (name || "").trim();
  if (!name) return "";
  if (name.includes(",")) return name.split(",")[0].trim();
  const parts = name.split(/\s+/);
  return parts[parts.length - 1];
}
// Nejdelší slovo z příjmení (kvůli "van der Berg" apod.)
export function surnameKey(name) {
  const t = norm(surname(name)).split(" ").filter(Boolean);
  return t.sort((a, b) => b.length - a.length)[0] || "";
}

// Úklid textu zkopírovaného z PDF nebo Wordu: ligatury, tvrdé mezery, neviditelné znaky
export function tidy(s) {
  return (s || "").normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\u2010\u2011]/g, "-");
}

// Bezpečná adresa pro odkaz: jen http a https. Jinak null a odkaz se nevykreslí.
export function safeHref(url) {
  const s = String(url || "").trim();
  try {
    const u = new URL(/^www\./i.test(s) ? "https://" + s : s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}
