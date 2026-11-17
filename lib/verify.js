// Postup ověření jedné citace
import { BOOKISH, compare, pickBest, plausible, verdict } from "./compare.js";
import { fromCrossref, fromOpenAlex } from "./records.js";
import { sourceAdvice } from "./net.js";
import {
  authorCount, crossrefDoiUrl, firstAuthorGuess, lookupDoi, openAlexDoiUrl, searchBooks, searchCrossref, searchCrossrefTitle,
  searchERIC, searchKnihovny, searchOpenAlex, searchSemanticScholar
} from "./sources.js";

const czechText = e => /[áčďéěíňóřšťúůýž]/i.test(e.titleGuess || e.raw || "");
// Vypadá citace jako článek v časopise? (ročník, číslo nebo strany)
const journalLike = e => !!(e.biblio && (e.biblio.volume || e.biblio.issue || e.biblio.pages)) || /\b\d{1,4}\s*\(\d{1,4}\)/.test(e.raw || "");

// Proč zdroj nemusí být v odborných databázích, i když existuje (kniha, česká publikace, sborník…).
// Prázdný seznam = jde o článek v časopise, který by v databázích obvykle být měl.
export function outOfIndexReasons(e) {
  const raw = e.raw || "", why = [];
  if (e.isbn || e.isbnInvalid || e.edition || /\b(Praha|Brno|Olomouc|Ostrava|Plzeň|Bratislava|London|New York|Oxford|Cambridge|Berlin|Paris)\s*:/i.test(raw) ||
      /nakladatel|publisher|verlag|\bpress\b|\bnakl\./i.test(raw)) why.push("kniha");
  // Česká publikace je „mimo databáze“ jen tehdy, když nejde o článek v časopise (ročník, číslo, strany).
  // České časopisy v Crossrefu často jsou a vymyšlený český článek musí zůstat podezřelý.
  if (czechText(e) && !journalLike(e)) why.push("česká nebo slovenská publikace");
  // „In: Sborník…“ (velké I, rozlišujeme velikost písmen, ať nechytá běžné „in“), nebo klíčová slova sborníků
  if (/(^|[\s.])(In:|In [A-ZÁ-Ž])/.test(raw) || /sborník|proceedings|conference|konference|symposium|workshop/i.test(raw)) why.push("sborník nebo konference");
  if (e.years && e.years.length && Math.min(...e.years) < 1990) why.push("starší publikace");
  if (!e.titleGuess) why.push("z citace se nepodařilo přečíst název");
  return why;
}

// Hledá postupně: jakmile zdroj v jedné databázi najde, další se už neptá.
// opts.onStep(název) průběžně hlásí, kde se právě hledá.
// opts.cache je vyhrazené pro sdílenou paměť ve fázi 2, zatím se nepoužívá.
export async function verifyEntry(client, e, opts = {}) {
  const out = { entry: e, status: "bad", label: "Nenalezeno", best: null, doiRec: null, doiProblem: null, failed: 0, asked: 0, trail: [] };
  const step = n => { if (opts.onStep) opts.onStep(n); };
  // 1) Pokud je uvedeno DOI, ověříme ho napřímo
  if (e.doi) {
    // Vyzkoušíme DOI i jeho opravené varianty (mezera místo spojovníku apod.)
    let d = { rec: null, definitive: true };
    for (const v of (e.doiVariants && e.doiVariants.length ? e.doiVariants : [e.doi])) {
      step("ověřuji DOI");
      const r = await lookupDoi(client, v);
      if (r.rec || r.registered) { d = r; if (v !== e.doi || e.doiHadSpace) out.doiFixed = v; break; }
      if (!r.definitive) d.definitive = false;
    }
    out.trail.push({ name: "DOI" + (d.rec ? " (" + d.rec.source + ")" : d.registered ? " (registr doi.org)" : ""), res: d.rec || d.registered ? "found" : (d.definitive ? "none" : "error") });
    if (d.rec) {
      const r = compare(e, d.rec);
      if (r.titleScore < 0.6) { out.doiProblem = "mismatch"; out.doiRec = d.rec; }
      else out.best = r;
    } else if (d.registered) out.doiRegisteredOnly = true; // DOI existuje, údaje k němu ale databáze nemají
    else out.doiProblem = d.definitive ? "missing" : "unknown";
  }
  // 2) Hledání podle textu citace
  if (!out.best) {
    let best = null;
    // Pořadí hledání. Skupiny: core = Crossref, general = velké obecné indexy, books = knihy, optional = doplňkové
    const S = {
      cr: [searchCrossref, "core", "Crossref"], cr2: [searchCrossrefTitle, "optional", "Crossref (název + autor)"], oa: [searchOpenAlex, "general", "OpenAlex"], s2: [searchSemanticScholar, "general", "Semantic Scholar"],
      eric: [searchERIC, "optional", "ERIC"], books: [searchBooks, "books", "Google Books / Open Library"], kn: [searchKnihovny, "optional", "Knihovny.cz"]
    };
    // České citace (diakritika v názvu) nejdřív v českých knihovnách a knižních databázích
    const czech = /[áčďéěíňóřšťúůýž]/i.test(e.titleGuess || e.raw);
    const order = e.isbn ? ["books", "kn", "cr", "cr2", "oa", "s2", "eric"]
      : czech ? ["cr", "cr2", "kn", "books", "oa", "s2", "eric"]
      : ["cr", "cr2", "oa", "s2", "eric", "books", "kn"];
    const groupFail = {}, groupAsked = {};
    for (const key of order) {
      const [fn, group, label] = S[key];
      step("hledám: " + label);
      const r = await fn(client, e);
      out.asked++;
      groupAsked[group] = (groupAsked[group] || 0) + 1;
      if (r.err) {
        out.failed++;
        groupFail[group] = (groupFail[group] || 0) + 1;
        (out.failedSources = out.failedSources || new Set()).add(r.err.source);
      }
      const b = pickBest(e, r.cands);
      if (b && (!best || b.score > best.score)) best = b;
      const hit = b && verdict(b)[0] === "ok";
      out.trail.push({ name: label, res: r.err ? "error" : hit ? "found" : (b && plausible(b)) ? "similar" : "none" });
      if (best && verdict(best)[0] === "ok") break;
      // Stejné dílo je jisté (sedí celý název i autoři): dál nehledáme, podrobnosti ověří druhá databáze.
      // Výjimka: u knihy s jiným rokem hledáme dál, jiná databáze může znát správné vydání.
      const sameWork = best && best.checks.title[0] === "ok" && best.checks.authors && best.checks.authors[0] === "ok";
      const otherEdition = sameWork && BOOKISH.test(best.cand.type) && best.checks.year && best.checks.year[0] !== "ok" && best.checks.year[0] !== "na";
      if (sameWork && !otherEdition) break;
    }
    out.best = best;
    // Hledání je neúplné, když selhal Crossref, všechny obecné indexy, nebo hledání knih
    out.incomplete = !!(groupFail.core || (groupAsked.general && groupFail.general === groupAsked.general) || groupFail.books);
  }
  // Křížová kontrola: nalezený článek s DOI dohledáme ještě v jiné databázi.
  // Když tam nesrovnalost není, jde spíš o chybu v metadatech jedné databáze než v citaci.
  if (plausible(out.best) && out.best.cand.doi) {
    step("kontroluji ve druhé databázi");
    const c1 = out.best.cand, doi = c1.doi;
    let other = null;
    if (c1.source !== "OpenAlex") {
      const r = await client.tryJSON(openAlexDoiUrl(client, doi));
      if (r.data && r.data.id) other = fromOpenAlex(r.data);
    }
    if (!other && c1.source !== "Crossref") {
      const r = await client.tryJSON(crossrefDoiUrl(client, doi));
      if (r.data && r.data.message) other = fromCrossref(r.data.message);
    }
    if (other) {
      out.confirmedIn = [c1.source, other.source];
      if (other.retracted) c1.retracted = true;
      const r2 = compare(out.entry, other);
      for (const k of ["authors", "year", "journal", "biblio"]) {
        const a = out.best.checks[k], b = r2.checks[k];
        if (a && (a[0] === "warn" || a[0] === "bad") && b && b[0] === "ok") {
          out.best.checks[k] = ["ok", "shoda podle " + other.source];
          const removed = out.best.issues.filter((_, n) => out.best.issueKeys[n] === k);
          const keep = out.best.issueKeys.map(kk => kk !== k);
          out.best.issues = out.best.issues.filter((_, n) => keep[n]);
          out.best.issueKeys = out.best.issueKeys.filter((_, n) => keep[n]);
          out.best.notes.push("Databáze se liší: " + c1.source + " uvádí jiný údaj (" + removed.join(" ") + "), " + other.source + " se s citací shoduje.");
        }
      }
    }
  }
  const [st, lab] = verdict(out.best);
  out.status = st; out.label = lab;
  if (plausible(out.best) && out.best.cand.retracted) {
    out.status = "bad"; out.label = "Stažený článek"; out.retracted = true;
  }
  // Zkrácené DOI: nalezené dílo má DOI, které začíná tím z citace (10.1108/LM-09-2020 × 10.1108/lm-09-2020-0131).
  // Typicky vzniká při kopírování z PDF, kde se DOI zalomí na konci řádku. Nesmí vypadat jako chyba studujícího.
  if ((out.doiProblem === "missing" || out.doiProblem === "mismatch") && plausible(out.best) && out.best.titleScore >= 0.85) {
    const cited = (e.doi || "").toLowerCase(), real = (out.best.cand.doi || "").toLowerCase();
    if (cited && real && real !== cited && real.startsWith(cited)) {
      out.doiTruncated = out.best.cand.doi; out.doiProblem = null; out.doiRec = null;
      if (!out.retracted) { out.status = "warn"; out.label = "Zkrácené DOI"; }
    }
  }
  if (out.doiProblem === "missing") {
    if (plausible(out.best) && out.best.titleScore >= 0.85 && out.best.checks.authors && out.best.checks.authors[0] === "ok" && !out.retracted) {
      // Dílo existuje, jen uvedené DOI není registrované (časopis ho ještě nezaregistroval, nebo je v něm překlep)
      out.status = "warn"; out.label = "Nefunkční DOI"; out.doiProblem = "dead";
    } else { out.status = "bad"; out.label = "DOI neexistuje"; }
  }
  if (out.doiProblem === "mismatch") { out.status = "bad"; out.label = "DOI patří jinému dílu"; }

  // Výpadek databází se týká jen citací, které se nenašly. Závažné výsledky
  // (Stažený článek, DOI neexistuje, DOI patří jinému dílu) nikdy nepřepisuje
  // a má přednost i před šedou literaturou: nesmíme tvrdit, že zdroj v databázích není.
  const notFound = out.label === "Nenalezeno";
  if (notFound && (out.doiProblem === "unknown" || out.incomplete)) {
    out.status = "warn"; out.label = "Nelze ověřit";
    const optional = ["ERIC", "Knihovny.cz"];
    const names = [...(out.failedSources || [])].filter(n => n && !optional.includes(n));
    if (out.failed >= out.asked) {
      out.netNote = "Nepodařilo se spojit s databázemi, výsledek proto nic neříká.";
    } else {
      out.label = "Neúplné hledání";
      out.netNote = "V dostupných databázích se zdroj nenašel, ale neodpověděl " + (names.join(" ani ") || "některá databáze") +
        ". " + (names.length ? sourceAdvice(names[0]) : "Zkuste to později.");
    }
  } else if (notFound && out.doiRegisteredOnly) {
    out.status = "info"; out.label = "Ověřte ručně";
    out.infoNote = "Uvedené DOI je platné (registr doi.org ho zná), ale databáze k němu nemají údaje, takže nejde porovnat název a autory. Otevřete DOI a zkontrolujte, že vede na citované dílo.";
  } else if (notFound && e.grey) {
    // Právní předpisy, normy a závěrečné práce v odborných databázích obvykle nejsou
    out.status = "info"; out.label = "Ověřte ručně";
    out.infoNote = {
      law: "Jde o právní předpis. Ty v odborných databázích nejsou; ověřte ho v Sbírce zákonů (e-sbirka.cz) nebo v EUR-Lex u předpisů EU.",
      standard: "Jde o technickou normu. Normy v odborných databázích nejsou; ověřte ji v katalogu norem (ČSN online, ISO.org).",
      thesis: "Jde o závěrečnou práci. Ty v odborných databázích často nejsou; ověřte ji v repozitáři školy, v Theses.cz nebo přes odkaz Knihovny.cz.",
      report: "Autorem je instituce (zpráva, doporučení, strategie, metodika). Takové dokumenty v odborných databázích často nejsou; ověřte ho na webu instituce nebo přes Google Scholar."
    }[e.grey];
  } else if (notFound && e.unpublished) {
    // Nepublikované zdroje a šedá literatura: nejsou v databázích, to ještě neznamená podvod
    out.status = "info"; out.label = "Ověřte ručně";
    out.infoNote = "Citace sama uvádí, že jde o nepublikovaný materiál (data, dotazník, rukopis, osobní sdělení). Automaticky ho ověřit nejde. Případně požádejte autora o doložení.";
  } else if (notFound && e.urls && e.urls.length) {
    out.status = "info"; out.label = "Ověřte ručně";
    out.infoNote = "Zdroj není v odborných databázích. U zpráv, metodik, webů a institucionálních dokumentů je to běžné. Otevřete odkaz a zkontrolujte, že vede na uvedený dokument.";
  } else if (!out.doiProblem && !out.retracted && (e.grey || (e.urls && e.urls.length)) && plausible(out.best) &&
             (out.label === "Nejistá shoda" || !out.best.checks.authors || out.best.checks.authors[0] !== "ok")) {
    // Šedá literatura nebo dokument s odkazem (repozitář, web instituce): když v databázi sedí jen název, ale ne autoři,
    // jde často o přetisk, kapitolu se stejným názvem nebo jiné dílo. Nabídneme ruční ověření,
    // nalezený záznam zůstane jen jako „nejbližší“ a nebudeme tvrdit, že je to totéž dílo.
    const sameTitle = out.label !== "Nejistá shoda";
    out.status = "info"; out.label = "Ověřte ručně"; out.weakMatch = true;
    out.infoNote = sameTitle
      ? "V databázi je záznam se stejným názvem, ale jiného druhu nebo od jiných autorů (např. přetisk, kapitola v knize nebo jiné dílo). Citace " +
        (e.grey === "report" ? "má jako autora instituci a " : "") + "odkazuje na dokument mimo odborné databáze. Otevřete odkaz a zkontrolujte, že vede na uvedený dokument."
      : e.grey === "report"
        ? "Autorem je instituce a citace odkazuje na dokument mimo odborné databáze (repozitář, web). Otevřete odkaz a zkontrolujte, že vede na uvedený dokument."
        : "Zdroj v odborných databázích s jistotou není, citace ale uvádí odkaz. Otevřete ho a zkontrolujte, že vede na uvedený dokument.";
  } else if (out.doiProblem === "unknown" && out.status !== "bad") {
    out.netNote = "Uvedené DOI se nepodařilo ověřit (databáze neodpověděla).";
  }

  // Rok vydání v budoucnosti (časopisy vydávají čísla s příštím rokem dopředu, ten tolerujeme)
  const thisYear = (opts.now ? new Date(opts.now()) : new Date()).getFullYear();
  if (e.years && e.years.length && Math.min(...e.years) > thisYear + 1) {
    const msg = "Rok vydání " + Math.min(...e.years) + " je v budoucnosti. Jde o překlep, nebo vymyšlenou citaci.";
    if (plausible(out.best)) {
      out.best.issues.push(msg); out.best.issueKeys.push("year");
      if (out.status === "ok") { out.status = "warn"; out.label = "Nesrovnalosti"; }
    } else out.futureNote = msg;
  }

  // ISBN s chybnou kontrolní číslicí nemůže existovat: překlep, nebo vymyšlené číslo
  if (e.isbnInvalid) {
    const msg = "ISBN " + e.isbnInvalid + " v citaci nemůže existovat (nesedí kontrolní číslice). Jde o překlep, nebo vymyšlené číslo.";
    if (out.label === "Nenalezeno") { out.label = "Neplatné ISBN"; out.isbnNote = msg; }
    else if (plausible(out.best)) {
      out.best.issues.push(msg); out.best.issueKeys.push("isbn");
      if (out.status === "ok") { out.status = "warn"; out.label = "Nesrovnalosti"; }
    }
  }

  // Dva druhy „Nenalezeno“: zdroj, který v databázích běžně chybí, není podezřelý.
  // Studie nástrojů na smyšlené citace ukazují, že právě tady vzniká nejvíc falešných poplachů.
  if (out.label === "Nenalezeno") {
    const why = outOfIndexReasons(e);
    if (why.length) {
      out.status = "warn"; out.label = "Nenalezeno, možná mimo databáze";
      out.notFoundNote = "Tento druh zdroje (" + why.join(", ") + ") v odborných databázích často chybí. Samotné nenalezení nic nedokazuje, ověřte zdroj ručně.";
    } else {
      out.notFoundNote = "Jde o článek v časopise, který by v odborných databázích obvykle být měl, a nenašlo se nic podobného. Je to silnější signál, ale stále jen podezření." +
        (czechText(e) ? " Česká časopisecká literatura v databázích ale někdy chybí, ověřte ji i v Knihovny.cz." : "");
      // Doplňkový signál: zná OpenAlex prvního autora u jakéhokoli díla?
      const au = firstAuthorGuess(e);
      if (au && au.length >= 3) {
        step("hledám autora");
        const a = await authorCount(client, au);
        if (!a.err && a.count === 0) out.notFoundNote += " Autora „" + au + "“ navíc OpenAlex nezná u žádného díla.";
      }
    }
  }
  return out;
}
