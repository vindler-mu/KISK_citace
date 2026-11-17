// Porovnání citace se záznamem z databáze a výsledný stav
import { abbrContainment, containment, lev1, missingTokens, norm, skeletonIn, surnameKey, symSim, tokenIn, tokens } from "./text.js";

// Jméno z databáze v citaci: přesně, s jedním překlepem, nebo přepsané z jiného písma (Выготский = Vygotsky)
const nameIn = (k, set) => tokenIn(k, set) || skeletonIn(k, set);

export const BOOKISH = /book|monograph|reference-book|edited-book/i;

// Preprint: verze článku před recenzí (arXiv, SSRN, OSF, bioRxiv…). Časopis ani rok se s citací shodovat nemusí.
export function isPreprint(c) {
  return /posted-content|preprint/i.test(c.type || "") ||
    /\b(arxiv|ssrn|osf preprints|biorxiv|medrxiv|research square|preprints\.org|psyarxiv|edarxiv|socarxiv|zenodo)\b/i.test((c.journal || "") + " " + (c.publisher || "")) ||
    /^10\.(48550|2139|31219|1101|21203|31234|35542|20944|32942)\//.test(c.doi || "");
}

export function compare(e, c) {
  const checks = {};
  const issues = [], issueKeys = [];
  const add = (k, t) => { issues.push(t); issueKeys.push(k); };
  const fullTitle = (c.title + " " + (c.subtitle || "")).trim();
  const mainTitle = c.title.split(/[:?]/)[0];
  const variants = [...new Set([c.title, fullTitle, mainTitle].filter(v => tokens(v).length))];

  // ---- NÁZEV ----
  let titleScore = 0, missing = [], extraWords = []; // extraWords: slova názvu v citaci, která ve skutečném názvu nejsou
  if (e.kind === "structured" && e.title) {
    let best = 0;
    for (const v of variants) best = Math.max(best, symSim(tokens(e.title), tokens(v)));
    titleScore = best;
    missing = missingTokens(tokens(e.title), new Set(tokens(fullTitle)));
  } else {
    let bestV = variants[0] || "";
    for (const v of variants) {
      const s = containment(tokens(v), e.hay);
      if (s > titleScore) { titleScore = s; bestV = v; }
    }
    missing = missingTokens(tokens(bestV), e.hay);
    // Obsahuje název v citaci navíc slova, která ve skutečném názvu nejsou?
    if (e.titleGuess) {
      // Databáze často neuvádí podnázev; pak porovnáme jen část před dvojtečkou
      const dbHasSub = !!c.subtitle || /:/.test(c.title);
      const g = tokens(dbHasSub ? e.titleGuess : e.titleGuess.split(":")[0]);
      if (g.length && containment(tokens(mainTitle), new Set(g)) >= 0.7) {
        const rev = containment(g, new Set(tokens(fullTitle)));
        if (rev < 1) titleScore = titleScore * (0.5 + 0.5 * rev);
        const extra = missingTokens(g, new Set(tokens(fullTitle)));
        if (rev < 0.9 && extra.length) { add("title", "Název v citaci obsahuje slova, která ve skutečném názvu nejsou: " + extra.join(", ")); extraWords = extra; }
      }
    }
  }
  if (titleScore >= 0.999) checks.title = ["ok", "shoda"];
  else if (titleScore >= 0.85) {
    checks.title = ["warn", "téměř shodný (" + Math.round(titleScore * 100) + " %)"];
    if (missing.length && e.kind !== "structured") add("title", "Slova ze skutečného názvu, která v citaci chybí nebo se liší: " + missing.join(", "));
  } else if (titleScore >= 0.6) checks.title = ["warn", "částečná shoda (" + Math.round(titleScore * 100) + " %)"];
  else checks.title = ["bad", "neshoda (" + Math.round(titleScore * 100) + " %)"];

  // ---- AUTOŘI ----
  let authorScore = 0.5;
  const dbKeys = c.authors.map(surnameKey).filter(Boolean);
  // Databáze autory neuvádí, nebo jen ve tvaru, ze kterého nejde zjistit příjmení (např. jiné písmo)
  if (!dbKeys.length) checks.authors = ["na", "databáze autory neuvádí"];
  // Autorem citace je instituce (ACRL, WHO, MŠMT…): s osobami v databázi ji porovnat nejde
  else if (e.grey === "report") checks.authors = ["na", "autorem je instituce"];
  else {
    let firstOk, matched, n;
    if (e.kind === "structured") {
      const eKeys = e.authors.map(surnameKey).filter(Boolean);
      if (!eKeys.length) { checks.authors = ["na", "v citaci chybí"]; dbKeys.length = 0; }
      else {
        firstOk = lev1(eKeys[0], dbKeys[0]) || eKeys[0] === dbKeys[0] || skeletonIn(dbKeys[0], [eKeys[0]]);
        n = Math.min(3, dbKeys.length, eKeys.length);
        matched = dbKeys.slice(0, n).filter(k => eKeys.some(x => x === k || (k.length >= 5 && lev1(x, k))) || skeletonIn(k, eKeys)).length;
      }
    } else {
      firstOk = nameIn(dbKeys[0], e.hay);
      n = e.etAl ? 1 : Math.min(3, dbKeys.length);
      matched = dbKeys.slice(0, n).filter(k => nameIn(k, e.hay)).length;
    }
    if (dbKeys.length) {
      if (firstOk && matched === n) { checks.authors = ["ok", "shoda"]; authorScore = 1; }
      else if (firstOk) {
        checks.authors = ["warn", "první autor sedí, další ne"]; authorScore = 0.8;
        add("authors", "Podle databáze jsou autoři: " + c.authorsFull.slice(0, 5).join("; ") + (c.authorsFull.length > 5 ? " a další" : ""));
      } else if (matched > 0) {
        checks.authors = ["warn", "jiné pořadí nebo první autor chybí"]; authorScore = 0.5;
        add("authors", "První autor podle databáze: " + c.authorsFull[0]);
      } else {
        checks.authors = ["bad", "neshoda"]; authorScore = 0;
        add("authors", "Autoři podle databáze: " + c.authorsFull.slice(0, 5).join("; ") + ". V citaci se nevyskytují.");
      }
    }
  }

  // ---- ROK ----
  let yearScore = 0.5;
  const notes = [];
  const isBook = BOOKISH.test(c.type);
  if (!c.years.length) checks.year = ["na", "databáze rok neuvádí"];
  else if (!e.years.length) checks.year = ["na", "v citaci rok chybí"];
  else if (e.years.some(y => c.years.includes(y))) { checks.year = ["ok", "shoda"]; yearScore = 1; }
  else if (isBook && e.edition && e.years.some(y => c.years.some(z => z < y))) {
    // Citace uvádí pozdější vydání knihy, databáze zná jen starší: to není chyba citace
    checks.year = ["ok", "jiné vydání"]; yearScore = 0.8;
    notes.push("Citace uvádí vydání „" + e.edition + "“ z roku " + e.years.join(", ") + ", databáze zná vydání z roku " + c.years.slice(0, 5).join(" / ") + ". Rozdíl roku proto nepovažujeme za chybu.");
  }
  else {
    const dbY = c.years.slice(0, 5).join(" / "), ciY = e.years.join(", ");
    if (isPreprint(c) && e.years.some(y => c.years.some(z => z < y && y - z <= 3))) {
      checks.year = ["warn", "preprint vyšel dřív"]; yearScore = 0.6;
      add("year", "Rok v citaci " + ciY + ", preprint je z roku " + dbY + ". Preprint obvykle vychází dřív než článek v časopise.");
    } else if (isBook) {
      checks.year = ["warn", "jiný rok, možná jiné vydání"]; yearScore = 0.4;
      add("year", "Rok v citaci " + ciY + ", databáze zná vydání z roku " + dbY + ". Pravděpodobně jde o jiné vydání nebo dotisk; citace údaj o vydání neuvádí.");
    } else if (e.years.some(y => c.years.some(z => Math.abs(z - y) === 1))) {
      checks.year = ["warn", "liší se o 1 rok"]; yearScore = 0.7;
      add("year", "Rok v citaci " + ciY + ", v databázi " + dbY + ". Často jde o rozdíl mezi online a tištěným vydáním.");
    } else {
      checks.year = ["bad", "neshoda"]; yearScore = 0;
      add("year", "Rok v citaci " + ciY + ", v databázi " + dbY + ".");
    }
  }

  // ---- ČASOPIS ----
  const REPOSITORY = /\b(repositor(y|ium|io)|research portal|dspace|eprints|digital commons|institutional repository|archive ouverte|zenodo|figshare)\b|\b(university|universit[äéà]t?|univerzit[ay]|akademi|college|institut[eo]?)\b.*\b(portal|repository|research|archive|library|digital)\b/i;
  // „02“ = „2“; norm() navíc sjednotí pomlčky (1–2 = 1-2)
  const normNum = (v) => norm(String(v).trim().replace(/(^|\D)0+(?=\d)/g, "$1"));
  let journalScore = 0.5;
  const pre = isPreprint(c);
  // Zprávy institucí, zákony, normy a práce nevycházejí v časopisech (databáze tu často uvádí repozitář)
  if (pre && (e.kind === "structured" ? !!e.journal : /\d+\s*\(\d+\)|\b(vol|roč|journal|review|quarterly|časopis)\b/i.test(e.raw))) {
    // Citace uvádí časopis, databáze zná jen preprint
    checks.journal = ["warn", "jen preprint"]; journalScore = 0.6;
    add("journal", "Databáze zná jen preprint (" + (c.journal || c.publisher || "verze před recenzí") + "), ne článek v časopise uvedeném v citaci. Ověřte ručně, že v časopise opravdu vyšel.");
  }
  else if (!c.journal || isBook || e.grey || pre) checks.journal = ["na", "netýká se"];
  // Databáze místo časopisu uvádí repozitář (univerzitní portál, DSpace…): s časopisem to nesrovnávat
  else if (REPOSITORY.test(c.journal)) checks.journal = ["na", "databáze uvádí repozitář"];
  else {
    let s;
    if (e.kind === "structured") s = e.journal ? Math.max(symSim(tokens(e.journal), tokens(c.journal)), abbrContainment(tokens(c.journal), new Set(tokens(e.journal)))) : null;
    else s = abbrContainment(tokens(c.journal), e.hay);
    if (s === null) checks.journal = ["na", "v citaci chybí"];
    else if (s >= 0.7) { checks.journal = ["ok", "shoda"]; journalScore = 1; }
    else {
      checks.journal = ["warn", "neshoda"]; journalScore = 0;
      add("journal", "Časopis / sborník podle databáze: " + c.journal + " (v citaci se neobjevuje; může jít o zkratku).");
    }
  }

  // ---- ROČNÍK, ČÍSLO, STRANY (vymyšlené citace mívají skutečný název, ale smyšlené údaje) ----
  const b = e.biblio || {};
  if (!isBook && (b.volume || b.issue || b.pages)) {
    let compared = false, wrong = false;
    if (b.volume && c.volume) {
      compared = true;
      if (normNum(b.volume) !== normNum(c.volume)) { wrong = true; add("biblio", "Ročník (volume) v citaci " + b.volume + ", v databázi " + c.volume + "."); }
    }
    if (b.issue && c.issue) {
      compared = true;
      if (normNum(b.issue) !== normNum(c.issue)) { wrong = true; add("biblio", "Číslo (issue) v citaci " + b.issue + ", v databázi " + c.issue + "."); }
    }
    if (b.pages && c.pages) {
      compared = true;
      if (b.pages[0] !== c.pages[0] || (c.pages[1] && b.pages[1] && b.pages[1] !== c.pages[1])) {
        wrong = true; add("biblio", "Strany v citaci " + b.pages.join("–") + ", v databázi " + c.pages.filter(Boolean).join("–") + ".");
      }
    }
    checks.biblio = !compared ? ["na", "databáze neuvádí"] : wrong ? ["warn", "neshoda"] : ["ok", "shoda"];
  }

  const score = 0.6 * titleScore + 0.2 * authorScore + 0.1 * yearScore + 0.1 * journalScore;
  return { cand: c, checks, issues, issueKeys, notes, titleScore, score, extraWords };
}

export function pickBest(e, cands) {
  let best = null;
  for (const c of cands) {
    const r = compare(e, c);
    if (!best || r.score > best.score) best = r;
  }
  return best;
}

// Je nalezený záznam aspoň pravděpodobně totéž dílo?
export function plausible(r) {
  if (!r || r.titleScore < 0.6) return false;
  if (r.checks.authors && r.checks.authors[0] === "bad") {
    // Autoři vůbec nesedí: totéž dílo jen tehdy, když sedí celý název a není příliš obecný.
    // Krátké názvy ("Deep learning", "Emotions") a podobné, ale ne shodné názvy jsou jiné dílo.
    if (r.titleScore < 0.999) return false;
    if (tokens(r.cand.title).length < 3) return false;
  }
  return true;
}

export function verdict(r) {
  if (!plausible(r)) return ["bad", "Nenalezeno"];
  if (r.titleScore < 0.85) return ["warn", "Nejistá shoda"];
  const vals = Object.values(r.checks).map(x => x[0]);
  // Sedí název i autoři a liší se jen údaje, které se u preprintu lišit mají
  if (isPreprint(r.cand) && r.checks.title[0] === "ok" && (!r.checks.authors || ["ok", "na"].includes(r.checks.authors[0])) &&
      !vals.includes("bad") && r.issueKeys.every(k => ["journal", "year", "biblio"].includes(k)) && r.checks.journal && r.checks.journal[1] === "jen preprint") return ["warn", "Nalezen jen preprint"];
  if (vals.includes("bad") || vals.includes("warn") || r.issues.length) return ["warn", "Nesrovnalosti"];
  if (r.checks.year && r.checks.year[1] === "jiné vydání") return ["ok", "Ověřeno (jiné vydání)"];
  return ["ok", "Ověřeno"];
}
