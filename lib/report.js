// Přehled výsledků: text ke zkopírování a CSV pro Excel
import { plausible } from "./compare.js";

export function fmtCand(c) {
  const au = c.authorsFull.slice(0, 4).join("; ") + (c.authorsFull.length > 4 ? " a další" : "");
  const parts = [au, c.years.length ? "(" + c.years[0] + ")" : "", [c.title, c.subtitle].filter(Boolean).join(": "), c.journal || c.publisher].filter(Boolean);
  return parts.join(". ").replace(/\.\./g, ".");
}

// ---- Správná citace z nalezeného záznamu (APA 7 a ISO 690) ----
// Jméno z databáze na [příjmení, křestní]: "Braun, Virginia" i "Virginia Braun"
export function splitName(full) {
  const s = String(full || "").trim();
  if (s.includes(",")) { const [f, ...g] = s.split(","); return [f.trim(), g.join(",").trim()]; }
  const p = s.split(/\s+/);
  return p.length > 1 ? [p[p.length - 1], p.slice(0, -1).join(" ")] : [s, ""];
}
const initials = given => given.split(/[\s-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + ".").join(" ");
const pagesTxt = p => p && p[0] != null ? p.filter(x => x != null).join("–") : "";
const isBookRec = c => /book|monograph/i.test(c.type || "");
const fullTitle = c => [c.title, c.subtitle].filter(Boolean).join(": ");

export function toAPA(c) {
  const names = c.authorsFull.slice(0, 20).map(n => { const [f, g] = splitName(n); return g ? f + ", " + initials(g) : f; });
  const au = names.length <= 1 ? (names[0] || "") : names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
  const year = c.years.length ? "(" + c.years[0] + ")" : "(b.r.)";
  let src = "";
  if (isBookRec(c)) src = c.publisher ? c.publisher + "." : "";
  else if (c.journal) {
    src = c.journal + (c.volume ? ", " + c.volume : "") + (c.issue ? "(" + c.issue + ")" : "") + (pagesTxt(c.pages) ? ", " + pagesTxt(c.pages) : "") + ".";
  }
  return [au && au + " " + year + ".", fullTitle(c) + ".", src, c.doi ? "https://doi.org/" + c.doi : ""].filter(Boolean).join(" ").replace(/\.\./g, ".").replace(/^\s+/, "");
}

export function toISO(c) {
  const names = c.authorsFull.slice(0, 3).map(splitName);
  const fmt = ([f, g], first) => first ? f.toUpperCase() + (g ? ", " + g : "") : (g ? g + " " : "") + f.toUpperCase();
  // ISO 690: do tří autorů všichni ("A, B a C"), víc autorů = první a "et al."
  const au = c.authorsFull.length > 3 ? fmt(names[0], true) + " et al"
    : names.map((n, i) => fmt(n, i === 0)).join(", ").replace(/, ([^,]+)$/, names.length > 1 ? " a $1" : ", $1");
  const year = c.years[0] || "";
  let src;
  if (isBookRec(c)) src = [c.publisher, year].filter(Boolean).join(", ") + ".";
  else src = [c.journal && c.journal + ".", [year, c.volume && "roč. " + c.volume, c.issue && "č. " + c.issue, pagesTxt(c.pages) && "s. " + pagesTxt(c.pages)].filter(Boolean).join(", ") + "."].filter(Boolean).join(" ");
  return [au && au + ".", fullTitle(c) + ".", src, c.doi ? "Dostupné z: https://doi.org/" + c.doi : ""].filter(Boolean).join(" ").replace(/\.\./g, ".");
}

// Citace, u kterých výsledek zkazila nedostupná databáze, selhal program, nebo se ještě neověřily (zastaveno)
export function retryable(results) {
  return results.map((r, i) => (!r || r.netNote || r.appError ? i : -1)).filter(i => i >= 0);
}

export function reportRows(results) {
  return results.filter(Boolean).map(r => {
    const c = plausible(r.best) ? r.best.cand : null;
    const notes = [];
    if (r.doiProblem === "missing") notes.push("DOI " + r.entry.doi + " neexistuje");
    if (r.doiProblem === "dead") notes.push("DOI " + r.entry.doi + " není registrované, dílo ale existuje");
    if (r.appError) notes.push("Chyba aplikace: " + r.appError);
    if (r.doiTruncated) notes.push("DOI v citaci je neúplné (pravděpodobně chyba při kopírování), celé DOI: " + r.doiTruncated);
    if (r.isbnNote) notes.push(r.isbnNote);
    if (r.futureNote) notes.push(r.futureNote);
    if (r.dupOf != null) notes.push("Stejná citace jako č. " + (r.dupOf + 1));
    if (r.review === "ok") notes.push("Ručně zkontrolováno: v pořádku");
    if (r.review === "confirmed") notes.push("Ručně zkontrolováno: problém potvrzen");
    if (r.doiFixed) notes.push("Opravené DOI: " + r.doiFixed);
    if (r.infoNote) notes.push(r.infoNote);
    if (r.netNote) notes.push(r.netNote);
    if (r.doiProblem === "mismatch") notes.push("DOI vede na: " + fmtCand(r.doiRec));
    if (r.retracted) notes.push("STAŽENÝ ČLÁNEK (retracted)");
    if (plausible(r.best)) notes.push(...r.best.issues, ...(r.best.notes || []));
    return {
      n: results.indexOf(r) + 1, status: r.label, raw: r.entry.raw,
      title: c ? [c.title, c.subtitle].filter(Boolean).join(": ") : "",
      authors: c ? c.authorsFull.slice(0, 6).join("; ") : "",
      year: c && c.years.length ? c.years[0] : "",
      journal: c ? (c.journal || c.publisher) : "",
      doi: c ? c.doi : "", source: c ? c.source : "", notes: notes.join(" | ")
    };
  });
}

// Buňka CSV. Text začínající znakem = + - @ by Excel mohl spustit jako vzorec, proto před něj patří apostrof.
// Kontroluje se první znak po úvodních mezerách a zalomeních, včetně plnošířkových variant (＝ ＋ － ＠).
function csvCell(v) {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[\s 　]*[=+\-@\t\r＝＋－＠]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// UTF-8 s BOM a středníky, aby to otevřel český Excel
export function toCsv(rows) {
  const head = ["Č.", "Výsledek", "Citace", "Nalezený název", "Autoři (databáze)", "Rok (databáze)", "Časopis / vydavatel", "DOI", "Zdroj", "Poznámky"];
  return "﻿" + [head, ...rows.map(r => [r.n, r.status, r.raw, r.title, r.authors, r.year, r.journal, r.doi, r.source, r.notes])]
    .map(r => r.map(csvCell).join(";")).join("\r\n");
}

export function toText(rows) {
  return rows.map(r => r.n + ". [" + r.status + "] " + r.raw + (r.notes ? "\n   " + r.notes : "") + (r.doi && r.status !== "Ověřeno" ? "\n   Nalezeno: " + r.title + " (DOI " + r.doi + ")" : "")).join("\n\n");
}
