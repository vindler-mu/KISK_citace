// Uživatelské rozhraní: tři kroky (Vložit → Zkontrolovat → Výsledky). Veškerá logika je v lib/.
// Data z citací a databází vkládáme jen jako text, nikdy jako HTML.
import { norm, safeHref } from "../lib/text.js";
import { MAX_INPUT, cleanCitations, cleanRaw, extractBibliography, isBackReference, isStructured, parseInput, stripPageArtifacts, suspicion } from "../lib/parse.js";
import { createClient, sourceAdvice } from "../lib/net.js";
import { dbTests, enc } from "../lib/sources.js";
import { plausible } from "../lib/compare.js";
import { verifyEntry } from "../lib/verify.js";
import { fmtCand, reportRows, retryable, toAPA, toCsv, toISO, toText } from "../lib/report.js";

// ---------- Pomocné funkce ----------
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const $ = id => document.getElementById(id);
const icon = name => $("ic-" + name).content.firstElementChild.cloneNode(true);

// Odkaz z dat: jen http a https, jinak se ukáže obyčejný text
function link(url, text, title) {
  const href = safeHref(url);
  if (!href) return document.createTextNode(text);
  const attrs = { href, target: "_blank", rel: "noopener noreferrer", text };
  if (title) attrs.title = title;
  return el("a", attrs);
}

let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- Kroky ----------
// Kam lze kliknout v hlavičce: vložení vždy, kontrola jen s rozdělenými citacemi, výsledky a zpětná vazba jen když existují
const canGo = k => k === 1 || (k === 2 && items.length > 0 && !structured) || ((k === 3 || k === 4) && rows.length > 0);
// Krok 0 je úvodní stránka, 1–4 jsou kroky práce, 5 je technický popis (odkaz v zápatí)
function goStep(n) {
  $("step0").hidden = n !== 0;
  $("step5").hidden = n !== 5;
  if (n === 4) fillFeedback();
  [1, 2, 3, 4].forEach(k => {
    $("step" + k).hidden = k !== n;
    const li = $("st" + k);
    if (k === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    li.classList.toggle("done", k < n);
    li.querySelector("button").disabled = k !== n && !canGo(k);
  });
  showResume(n === 3);
  if (n === 1) syncPasteHint();
  window.scrollTo({ top: 0 });
  const h = $("h" + n);
  h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true });
}

// ---------- Krok 1 → 2: rozdělení na citace ----------
let items = [];        // citace jako text, jedna položka = jedna citace
let structured = null; // BibTeX nebo RIS: rozdělení je dané, krok 2 přeskočíme

function toReview(opts = {}) {
  const text = $("src").value;
  if (!text.trim()) { toast("Nejprve vložte seznam literatury."); $("src").focus(); return; }
  if (text.length > MAX_INPUT) { toast("Text je příliš dlouhý (přes milion znaků). Vložte jen seznam literatury."); return; }
  if (isStructured(text)) {
    structured = parseInput(text);
    if (!structured.length) { toast("V exportu se nenašla žádná citace."); return; }
    run(structured);
    return;
  }
  structured = null;
  // Vložená celá práce: vezmeme jen seznam literatury (učitel to může vrátit)
  const ex = opts.whole ? { text, heading: "" } : extractBibliography(text);
  // Čísla stran, záhlaví a zápatí z PDF (počítáme je, ať to učitel ví)
  const pages = stripPageArtifacts(ex.text);
  items = cleanCitations(pages.text).split(/\n\s*\n/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  // Odkazy z poznámek pod čarou ("Tamtéž, s. 12") nejsou samostatné zdroje
  const back = items.filter(isBackReference).length;
  items = items.filter(t => !isBackReference(t));
  const msgs = [];
  if (ex.heading) msgs.push("Text vypadá jako celá práce. Beru jen část za nadpisem „" + ex.heading + "“.");
  if (pages.removed) msgs.push("Odstranil jsem " + pages.removed + " " + plural(pages.removed, "řádek", "řádky", "řádků") + " s čísly stran, záhlavím nebo zápatím z PDF.");
  if (back) msgs.push("Vynechal jsem " + back + " " + plural(back, "odkaz", "odkazy", "odkazů") + " typu „Tamtéž“ nebo „op. cit.“, které jen opakují dřívější citaci.");
  $("bibNote").hidden = !msgs.length;
  $("bibNoteText").textContent = msgs.join(" ");
  $("useWhole").hidden = !ex.heading;
  renderSplit();
  goStep(2);
}

// Podezřelé kousky: velmi krátké (rozdělená citace) nebo velmi dlouhé s více roky (slepené citace)

// Klíč pro hledání duplicit: text bez interpunkce, diakritiky a čísla v seznamu
const dupKey = t => norm(cleanRaw(String(t).replace(/^\s*(\[\d+\]|\d+[.)])\s*/, "")));
function duplicatesOf(texts) {
  const seen = new Map();
  return texts.map((t, i) => {
    const k = dupKey(t);
    if (k.length < 15) return null;
    if (seen.has(k)) return seen.get(k);
    seen.set(k, i);
    return null;
  });
}

function renderSplit() {
  const ol = $("split");
  ol.replaceChildren();
  const dups = duplicatesOf(items);
  items.forEach((t, i) => {
    const flag = dups[i] != null ? "Stejná citace jako č. " + (dups[i] + 1) + ". Ověří se jen jednou." : suspicion(t);
    const li = el("li", {},
      el("span", { class: "n", text: (i + 1) + "." }),
      el("span", { class: "t" }, t, flag ? el("span", { class: "flag", text: flag }) : null),
      el("span", { class: "acts" },
        i > 0 ? iconBtn("merge", "Spojit s předchozí citací", () => { items[i - 1] += " " + items[i]; items.splice(i, 1); renderSplit(); focusRow(i - 1); }) : null,
        iconBtn("edit", "Upravit nebo rozdělit", () => editItem(li, i)),
        iconBtn("del", "Odebrat ze seznamu", () => { items.splice(i, 1); renderSplit(); focusRow(Math.min(i, items.length - 1)); })));
    ol.append(li);
  });
  $("run").textContent = "Ověřit " + items.length + " " + plural(items.length, "citaci", "citace", "citací");
  $("run").disabled = !items.length;
  // Dlouhý seznam: hrubý odhad doby (Crossref bez e-mailu je nejpomalejší článek řetězu)
  const hasMail = !!client.crMail("?");
  const mins = Math.ceil(items.length * (hasMail ? 2 : 4) / 60);
  const long = $("longNote");
  long.hidden = items.length < 40;
  long.textContent = "Ověření " + items.length + " citací potrvá asi " + mins + " min." +
    (hasMail ? "" : " Rychlejší to bude s e-mailem pro Crossref (Nastavení vpravo nahoře).");
}
function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function iconBtn(name, label, fn) {
  const b = el("button", { type: "button", class: "ghost small", "aria-label": label, title: label }, icon(name));
  b.onclick = fn;
  return b;
}
function focusRow(i) {
  const li = $("split").children[i];
  if (li) { const b = li.querySelector("button"); if (b) b.focus(); }
}
function editItem(li, i) {
  li.classList.add("editing");
  const ta = el("textarea", { "aria-label": "Text citace " + (i + 1) + ". Prázdný řádek ji rozdělí na dvě." });
  ta.value = items[i];
  const save = el("button", { type: "button", class: "small" }, "Hotovo");
  save.onclick = () => {
    const parts = ta.value.split(/\n\s*\n/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    items.splice(i, 1, ...parts);
    renderSplit(); focusRow(i);
  };
  li.children[1].replaceChildren(ta, el("span", { class: "flag", style: "color:var(--muted);font-weight:400", text: "Prázdný řádek rozdělí text na dvě citace." }));
  li.children[2].replaceChildren(save);
  ta.focus();
}

// ---------- Krok 3: výsledky ----------
const client = createClient({
  getEmail: () => $("crmail").value,
  getOpenAlexKey: () => $("oakey").value,
  onSourceChange: () => showSourceBanner()
});
let entries = [], results = [], rows = [], dupOf = [], stopFlag = false, running = false, filter = "all";
let runStart = 0, runStartDone = 0, offlinePause = false, runName = "";

const isOutage = r => r.label === "Neúplné hledání" || r.label === "Nelze ověřit";
// Skupina: problém (červená), nesrovnalost (okrová), ručně, ověřeno.
// Citace, kterou učitel ručně označil „v pořádku“, patří mezi ověřené.
const groupOf = r => !r ? "wait" : r.review === "ok" ? "ok" : r.status;
// Stav a štítek, jak se zobrazí (s ohledem na ruční kontrolu učitele)
const shownStatus = r => r.review === "ok" ? "ok" : r.status;
const shownLabel = r => r.review === "ok" ? "Zkontrolováno: v pořádku" : r.review === "confirmed" ? r.label + " · potvrzeno" : r.label;
// Pořadí v seznamu: nejzávažnější nahoře, výpadky až za nesrovnalostmi
const SEVERITY = { bad: 0, warn: 1, info: 3, ok: 4, wait: 5 };
const rank = r => !r ? SEVERITY.wait : isOutage(r) ? 2 : SEVERITY[r.status];

// Krátké označení citace do seznamu: "Smith 2020", "Kahneman 2011"
function shortName(e) {
  let who = e.kind === "structured" ? (e.authors[0] || "").split(",")[0] : "";
  if (!who) {
    const m = cleanRaw(e.raw).match(/^\s*(?:\[\d+\]\s*)?([\p{L}][\p{L}'’\-]+)/u);
    who = m ? m[1] : cleanRaw(e.raw).slice(0, 24);
  }
  if (who === who.toUpperCase()) who = who.charAt(0) + who.slice(1).toLowerCase(); // KAHNEMAN → Kahneman
  return who + (e.years && e.years.length ? " " + e.years[0] : "");
}

// Položka v seznamu vlevo: číslo, kdo a kdy, stav
function makeRow(e, i) {
  const item = el("button", { type: "button", class: "item s-wait", "data-i": String(i) },
    el("span", { class: "num", text: String(i + 1) }),
    el("span", { class: "who" }, el("span", { class: "nm", text: shortName(e) }), el("span", { class: "lab", text: "Čeká" })),
    el("span", { class: "mk" }, icon("wait")));
  item.onclick = () => { userPicked = true; select(i, true); };
  return item;
}

function setRowState(item, status, label) {
  item.className = "item s-" + status + (item.getAttribute("aria-current") ? " sel" : "");
  item.querySelector(".lab").textContent = label;
  item.querySelector(".mk").replaceChildren(icon(status === "bad" ? "bad" : status));
}

// Vybraná citace a panel s podrobnostmi vpravo
let sel = -1, userPicked = false;
function select(i, fromUser) {
  if (sel >= 0 && rows[sel]) { rows[sel].removeAttribute("aria-current"); rows[sel].classList.remove("sel"); }
  sel = i;
  if (!rows[i]) return;
  rows[i].setAttribute("aria-current", "true"); rows[i].classList.add("sel");
  renderPanel();
  // Na telefonu je panel pod seznamem: posunout se k němu
  if (fromUser && window.matchMedia("(max-width: 760px)").matches) $("panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderPanel() {
  const p = $("panel"), e = entries[sel], res = results[sel];
  if (!e) { p.replaceChildren(); return; }
  const status = res ? shownStatus(res) : "wait";
  p.replaceChildren(
    el("p", { class: "pstate s-" + status }, icon(status === "bad" ? "bad" : status), " ", res ? shownLabel(res) : "Čeká na ověření"),
    el("h3", { class: "pcite" }, (sel + 1) + ". ", ...(res ? markedCitation(e.raw, res) : [e.raw])));
  if (res) { renderDetail(p, res); p.append(reviewBox(sel)); }
}

// Text citace se zvýrazněnými chybami (rok, slova navíc v názvu, chybné DOI, neplatné ISBN, strany).
// Vrací textové uzly a <mark>, nikdy HTML z dat.
function markedCitation(raw, res) {
  const ranges = [], r = res.best, e = res.entry;
  const add = (re, cls) => { for (const m of raw.matchAll(re)) ranges.push([m.index, m.index + m[0].length, cls]); };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const good = plausible(r) && !res.doiProblem && !res.weakMatch;
  if (good && r.checks.year && ["warn", "bad"].includes(r.checks.year[0])) for (const y of e.years) add(new RegExp("\\b" + y + "\\b", "g"), r.checks.year[0]);
  if (good && r.extraWords && r.extraWords.length) {
    const set = new Set(r.extraWords);
    for (const m of raw.matchAll(/[\p{L}\p{N}]+/gu)) if (set.has(norm(m[0]))) ranges.push([m.index, m.index + m[0].length, "warn"]);
  }
  if (good && r.checks.biblio && r.checks.biblio[0] === "warn" && e.biblio && e.biblio.pages && e.biblio.pages[1] != null)
    add(new RegExp("\\b" + e.biblio.pages[0] + "\\s*[-–—]\\s*" + e.biblio.pages[1] + "\\b", "g"), "warn");
  if ((res.doiProblem === "mismatch" || res.doiProblem === "missing" || res.doiProblem === "dead") && e.doi) add(new RegExp(esc(e.doi), "gi"), res.doiProblem === "dead" ? "warn" : "bad");
  if (res.doiTruncated && e.doi) add(new RegExp(esc(e.doi), "gi"), "warn");
  if (e.isbnInvalid) add(/ISBN[\s:\-]*[\dXx][\dXx\- ]{8,16}[\dXx]/g, "bad");
  if (!ranges.length) return [raw];
  ranges.sort((a, b) => a[0] - b[0]);
  const out = []; let pos = 0;
  for (const [s, t, cls] of ranges) {
    if (s < pos) continue; // překryv: první vyhrává
    if (s > pos) out.push(raw.slice(pos, s));
    out.push(el("mark", { class: cls === "bad" ? "bad" : null, text: raw.slice(s, t) }));
    pos = t;
  }
  if (pos < raw.length) out.push(raw.slice(pos));
  return out;
}

// Co má učitel udělat dál
function nextStep(res) {
  if (res.review === "ok") return "";
  if (res.appError) return "Zkuste citaci ověřit znovu. Pokud chyba trvá, pošlete autorovi text chyby.";
  if (isOutage(res)) return "Až databáze zase odpovídají, použijte „Zopakovat neověřené“.";
  if (res.retracted) return "Upozorněte studujícího, že článek byl stažen, a doporučte jiný zdroj.";
  // U DOI vždy nejdřív vyloučit chybu při kopírování: zalomení řádku v PDF DOI zkrátí nebo poškodí
  const checkOriginal = "Nejdřív porovnejte DOI s originálem práce, při kopírování z PDF se může zkrátit nebo poškodit. ";
  if (res.doiTruncated) return "Podívejte se do originálu práce, jestli je DOI celé. Pokud ano, šlo jen o chybu při kopírování a citace je v pořádku.";
  if (res.doiProblem === "mismatch") return checkOriginal + "Pokud v práci je stejné, otevřete ho a porovnejte, kam vede, a zeptejte se studujícího, odkud citaci převzal(a).";
  if (res.doiProblem === "dead") return checkOriginal + "Pokud v práci je stejné, studujícímu stačí DOI opravit nebo odebrat.";
  if (res.doiProblem === "missing") return checkOriginal + "Pokud v práci je stejné, vyhledejte název ručně (odkazy dole) a případně požádejte o doložení zdroje.";
  if (res.status === "info") return "";
  if (res.label === "Nenalezeno, možná mimo databáze") return "Vyhledejte zdroj v Knihovny.cz nebo Google Scholar (odkazy dole). Teprve když se nenajde ani tam, požádejte studujícího o doložení.";
  if (res.label === "Nalezen jen preprint") return "Ověřte na webu časopisu, že článek v uvedeném čísle opravdu vyšel.";
  if (res.label === "Nejistá shoda") return "Otevřete nalezený záznam a porovnejte ho s citací.";
  if (res.status === "warn") return "Porovnejte údaje níže a doporučte studujícímu opravu citace.";
  if (res.status === "bad") return "Vyhledejte název ručně (odkazy dole). Pokud se zdroj nenajde, požádejte studujícího o jeho doložení.";
  return "";
}

// Ruční kontrola učitelem: potvrdit problém, nebo označit jako v pořádku
function reviewBox(i) {
  const res = results[i];
  const box = el("div", { class: "review" });
  const set = v => { res.review = v; renderResult(i); updateSummary(); arrange(); saveState(); renderPanel(); };
  if (res.review) {
    box.append(el("span", { class: "state", text: res.review === "ok" ? "Zkontrolováno: v pořádku" : "Problém potvrzen" }));
    const undo = el("button", { type: "button", class: "plain" }, "Zrušit označení"); undo.onclick = () => set(null);
    box.append(undo);
  } else {
    box.append(el("span", { class: "state", text: "Zkontrolovali jste ručně?" }));
    const ok = el("button", { type: "button", class: "small" }, icon("ok"), "Je v pořádku"); ok.onclick = () => set("ok");
    box.append(ok);
    if (res.status !== "ok") { const bad = el("button", { type: "button", class: "small" }, icon("bad"), "Potvrzuji problém"); bad.onclick = () => set("confirmed"); box.append(bad); }
  }
  return box;
}

// Jedna věta: co je s citací a proč
function verdictLine(res) {
  const e = res.entry, r = res.best;
  if (res.dupOf != null) return "Stejná citace jako č. " + (res.dupOf + 1) + ". " + verdictLine({ ...res, dupOf: null });
  if (res.appError) return "Při ověřování selhal program (" + res.appError + "). Nejde o výsledek citace.";
  if (res.retracted) return "Článek existuje, ale vydavatel ho stáhl (retracted). Bez upozornění by se neměl citovat.";
  if (res.doiTruncated) return "DOI v citaci je neúplné (" + e.doi + "), celé DOI je " + res.doiTruncated + ". Nejčastěji jde o chybu při kopírování z PDF, kde se DOI zalomí na konci řádku, ne nutně o chybu v práci.";
  if (res.doiProblem === "mismatch") return "Uvedené DOI vede na úplně jiné dílo: " + fmtCand(res.doiRec);
  if (res.doiProblem === "dead") return "Dílo existuje, ale DOI " + e.doi + " není registrované. Časopis ho možná ještě nezaregistroval, nebo je v něm překlep.";
  if (res.isbnNote) return res.isbnNote + " Podle názvu se dílo také nenašlo.";
  if (res.futureNote && res.label === "Nenalezeno") return res.futureNote + " Dílo se v databázích nenašlo.";
  if (res.doiProblem === "missing") return "DOI " + e.doi + " nezná ani registr doi.org a podle názvu se dílo také nenašlo.";
  if (res.netNote) return res.netNote;
  if (res.infoNote) return res.infoNote;
  if (plausible(r)) {
    if (r.issues.length) return r.issues[0];
    if (res.label === "Nejistá shoda") return "Databáze zná podobné dílo, shoda ale není jistá.";
    if (r.notes && r.notes.length) return r.notes[0];
    return "Název, autoři a rok odpovídají záznamu v " + r.cand.source + (res.confirmedIn ? " (potvrzeno i v " + res.confirmedIn[1] + ")" : "") + ".";
  }
  return "Žádná z dostupných databází nezná záznam, který by odpovídal této citaci." + (res.notFoundNote ? " " + res.notFoundNote : "");
}

const CHECKS = [["title", "Název"], ["authors", "Autoři"], ["year", "Rok"], ["journal", "Časopis"], ["biblio", "Ročník, číslo, strany"]];
const ST_ICON = { ok: "ok", warn: "warn", bad: "bad" };

// Hodnoty z citace a z databáze vedle sebe
function cmpTable(e, r) {
  const c = r.cand, b = e.biblio || {};
  const bib = (v, i, p) => [v && "roč. " + v, i && "č. " + i, p && "s. " + p.filter(x => x != null).join("–")].filter(Boolean).join(", ");
  const vals = {
    title: [e.titleGuess || "", [c.title, c.subtitle].filter(Boolean).join(": ")],
    authors: [e.kind === "structured" ? e.authors.join("; ") : "", c.authorsFull.slice(0, 5).join("; ") + (c.authorsFull.length > 5 ? " a další" : "")],
    year: [e.years.join(", "), c.years.slice(0, 5).join(" / ")],
    journal: [e.kind === "structured" ? e.journal : "", c.journal || c.publisher || ""],
    biblio: [bib(b.volume, b.issue, b.pages), bib(c.volume, c.issue, c.pages)]
  };
  // V tabulce jen to, co nesedí; shodné údaje shrne jedna věta pod ní
  const tb = el("tbody"), same = [];
  for (const [k, name] of CHECKS) {
    const v = r.checks[k];
    if (!v || v[0] === "na") continue;
    const st = v[0];
    if (st === "ok") { same.push(name.toLowerCase()); continue; }
    tb.append(el("tr", {},
      el("th", { scope: "row", text: name }),
      el("td", { class: "c1", text: vals[k][0] || "—" }),
      el("td", { class: "c2", text: vals[k][1] || "—" }),
      el("td", { class: "st t-" + st }, ST_ICON[st] ? icon(ST_ICON[st]) : null, v[1])));
  }
  const frag = document.createDocumentFragment();
  if (tb.children.length) frag.append(el("table", { class: "cmp" },
    el("thead", {}, el("tr", {}, el("th", { text: "" }), el("th", { scope: "col", text: "V citaci" }), el("th", { scope: "col", text: "V databázi" }), el("th", { scope: "col", text: "Výsledek" }))),
    tb));
  if (same.length) frag.append(el("p", { class: "same" }, icon("ok"), "Shoduje se: " + same.join(", ") + "."));
  return frag;
}

function renderDetail(d, res) {
  const e = res.entry, r = res.best;
  d.append(el("p", { class: "verdict", text: verdictLine(res) }));
  const next = nextStep(res);
  if (next) d.append(el("p", { class: "next" }, el("strong", { text: "Co dál:" }), next));

  const extra = [];
  if (res.doiFixed) extra.push("DOI v citaci bylo poškozené (mezera po kopírování). Správné DOI: " + res.doiFixed);
  // U chybného DOI jde o jiné, jen podobné dílo: jeho rozdíly by učitele zbytečně zahltily
  if (plausible(r) && !res.doiProblem && !res.weakMatch) extra.push(...r.issues.slice(1), ...(r.issues.length ? (r.notes || []) : (r.notes || []).slice(1)));
  // DOI navrhneme jen u jisté shody (sedí celý název i autoři) a opatrně: nalezený záznam nemusí být totéž dílo
  const sureMatch = plausible(r) && !res.weakMatch && !res.doiProblem && r.titleScore >= 0.999 && r.checks.authors && r.checks.authors[0] === "ok";
  if (!e.doi && sureMatch && r.cand.doi && res.status !== "bad") extra.push("Citace neuvádí DOI. Nalezený záznam má DOI " + r.cand.doi + ", pokud jde o stejné dílo.");
  if (extra.length) d.append(el("ul", { class: "notes" }, extra.map(t => el("li", { text: t }))));
  if (res.infoNote && e.urls && e.urls.length) d.append(el("ul", { class: "notes" }, e.urls.map(u => el("li", {}, "Odkaz: ", link(u, u)))));

  if (res.doiProblem === "mismatch") {
    d.append(el("div", { class: "alt" }, el("strong", { text: "DOI ve skutečnosti vede na" }), fmtCand(res.doiRec), " ", res.doiRec.doi ? link("https://doi.org/" + res.doiRec.doi, "otevřít") : null));
  }
  // Odkaz na nalezený záznam (DOI, jinak stránka záznamu)
  const recLink = c => c.doi ? link("https://doi.org/" + c.doi, "DOI " + c.doi) : c.url ? link(c.url, "otevřít záznam") : null;
  if (plausible(r) && !res.doiProblem && !res.weakMatch) {
    d.append(el("div", { class: "found-src" }, "Nalezeno v " + r.cand.source + ": ", recLink(r.cand) || "bez odkazu"));
    d.append(cmpTable(e, r));
    // Správná citace podle databáze, ke zkopírování (např. do zpětné vazby)
    const copyBtn = (label, fn) => {
      const b = el("button", { type: "button", class: "small" }, label);
      b.onclick = () => copyText(fn(r.cand), "Citace " + label + " zkopírována. Údaje pocházejí z databáze, zkontrolujte je.");
      return b;
    };
    d.append(el("div", { class: "copyref" }, "Kopírovat správnou citaci podle databáze:", copyBtn("APA", toAPA), copyBtn("ISO 690", toISO)));
  } else if (r && !res.netNote && (!res.infoNote || res.weakMatch)) {
    // Co to asi je: nejpodobnější záznam, který databáze znají (u chybných citací pomůže odhalit, odkud studující čerpal/a)
    const heading = res.weakMatch && r.titleScore >= 0.999 ? "Záznam se stejným názvem v databázi (nemusí jít o stejné dílo)"
      : plausible(r) && !res.weakMatch ? "Podle názvu se nejvíc podobá" : "Nejbližší nalezený záznam (spíš jiné dílo)";
    d.append(el("div", { class: "alt" }, el("strong", { text: heading + " · " + r.cand.source }), fmtCand(r.cand), " ", recLink(r.cand)));
  }

  // Postup hledání a ruční ověření (sbalené)
  const more = el("details", { class: "more" }, el("summary", { text: "Kde se hledalo a jak ověřit ručně" }));
  if (res.trail && res.trail.length) {
    const sym = { found: "nalezeno", similar: "podobný záznam", none: "nic", error: "neodpověděla" };
    const t = el("p", { class: "trail" });
    res.trail.forEach((x, k) => {
      if (k) t.append(" → ");
      t.append(el("span", { class: x.res === "found" ? "t-ok" : x.res === "error" ? "t-warn" : "", text: x.name + " (" + sym[x.res] + ")" }));
    });
    more.append(t);
  }
  const title = e.titleGuess || cleanRaw(e.raw).slice(0, 200), q = enc(title);
  const lista = link("https://www.libraryresearch.com", "LISTA", "Otevře databázi LISTA a zkopíruje název do schránky");
  lista.addEventListener("click", () => {
    try { navigator.clipboard.writeText(title).then(() => toast("Název zkopírován, vložte ho do vyhledávání v LISTA.")).catch(() => {}); } catch { /* nic */ }
  });
  more.append(el("div", { class: "manual" },
    link("https://scholar.google.com/scholar?q=" + q, "Google Scholar"),
    link("https://www.knihovny.cz/Search/Results?type=AllFields&lookfor=" + q, "Knihovny.cz"),
    link("https://www.google.com/search?tbm=bks&q=" + q, "Google Knihy"),
    lista));
  d.append(more);
}

function renderResult(i) {
  const res = results[i], item = rows[i];
  setRowState(item, shownStatus(res), shownLabel(res));
  if (res.review) item.querySelector(".nm").append(el("span", { class: "rv", text: "zkontrolováno" }));
  if (i === sel) renderPanel();
  // Krátké zvýraznění právě dokončené položky
  item.classList.remove("flash"); void item.offsetWidth; item.classList.add("flash");
}

// Seznam vlevo ve skupinách (pozornost → ručně → v pořádku).
// Během ověřování se neřadí, aby položky neskákaly.
const GROUPS = [
  ["Potřebuje pozornost", g => g === "bad" || g === "warn"],
  ["Ověřit ručně", g => g === "info"],
  ["V pořádku", g => g === "ok"],
  ["Neověřeno", g => g === "wait"]
];
function visibleOrder() {
  const order = rows.map((r, i) => i);
  if (!running) order.sort((a, b) => rank(results[a]) - rank(results[b]) || a - b);
  // Hledání v seznamu (u dlouhých seznamů): podle textu citace, bez diakritiky
  const q = norm($("listFilter").value);
  return q ? order.filter(i => norm(entries[i].raw).includes(q)) : order;
}
function arrange() {
  const box = $("results");
  box.replaceChildren();
  $("listFilter").hidden = entries.length < 15;
  const order = visibleOrder();
  if (running) box.append(...order.map(i => rows[i]));
  else for (const [title, test] of GROUPS) {
    const members = order.filter(i => test(groupOf(results[i])));
    if (!members.length) continue;
    box.append(el("p", { class: "group" }, title, el("span", { class: "count", text: String(members.length) })));
    box.append(...members.map(i => rows[i]));
  }
  // Po dokončení vybrat nejzávažnější citaci, pokud si učitel sám nic nevybral
  if (!running && !userPicked && order.length) select(order[0]);
}
// Šipky nahoru a dolů v seznamu
$("results").addEventListener("keydown", ev => {
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  const order = visibleOrder(), k = order.indexOf(sel);
  const next = order[Math.max(0, Math.min(order.length - 1, k + (ev.key === "ArrowDown" ? 1 : -1)))];
  if (next == null) return;
  ev.preventDefault(); userPicked = true; select(next); rows[next].focus();
});

function updateSummary() {
  const c = { bad: 0, warn: 0, info: 0, ok: 0, wait: 0 };
  results.forEach(r => c[groupOf(r)]++);
  const total = entries.length, done = total - c.wait;
  $("barWrap").hidden = !running;
  $("bar").style.transform = "scaleX(" + (total ? done / total : 0) + ")";
  const outages = results.filter(r => r && isOutage(r)).length;
  // Odhad zbývajícího času podle dosavadního tempa (až po pár citacích, ať není divoký)
  let eta = "";
  const batchDone = done - runStartDone;
  if (running && batchDone >= 3 && total > done) {
    const mins = Math.ceil(((Date.now() - runStart) / batchDone) * (total - done) / 60000);
    eta = mins <= 1 ? ", zbývá asi minuta" : ", zbývá asi " + mins + " min";
  }
  // Hlavní věta: kolik citací chce pozornost učitele (bez těch, které už ručně potvrdil)
  const confirmed = results.filter(r => r && r.review === "confirmed").length;
  const reviewed = results.filter(r => r && r.review).length;
  const attention = c.bad + c.warn - confirmed;
  const h = $("h3"), sub = $("progressText");
  $("runTitle").hidden = !runName; $("runTitle").textContent = runName;
  if (running) {
    h.textContent = "Ověřuji citace…";
    sub.textContent = "Hotovo " + done + " z " + total + eta + ". Výsledky se seřadí, až bude vše ověřeno." +
      (client.crMail("?") ? " Crossref běží v rychlejším režimu (s e-mailem)." : "");
  } else if (done < total) {
    h.textContent = "Ověřování je pozastavené";
    sub.textContent = "Ověřeno " + done + " z " + total + ". Zbytek dokončíte tlačítkem „Pokračovat v ověřování“.";
  } else {
    h.textContent = attention
      ? attention + " " + plural(attention, "citace potřebuje", "citace potřebují", "citací potřebuje") + " vaši pozornost"
      : confirmed ? "Hotovo: " + confirmed + " " + plural(confirmed, "potvrzený problém", "potvrzené problémy", "potvrzených problémů")
      : c.info ? "Žádná citace nemá problém" : "Všechny citace sedí";
    sub.textContent = "Celkem " + total + ": " + [
      c.bad && c.bad + " " + plural(c.bad, "problém", "problémy", "problémů"),
      c.warn && c.warn + " " + plural(c.warn, "nesrovnalost", "nesrovnalosti", "nesrovnalostí"),
      c.info && c.info + " ověřit ručně",
      c.ok && c.ok + " v pořádku"
    ].filter(Boolean).join(", ") + "." + (outages ? " U " + outages + " " + plural(outages, "citace", "citací", "citací") + " neodpověděly databáze." : "") +
      (reviewed ? " Ručně zkontrolováno: " + reviewed + "." : "");
  }
}

// Zkusí jeden známý článek. Když to nejde, je problém ve spojení, ne v citacích.
async function testConnection() {
  try {
    const d = await client.getJSON("https://api.crossref.org/works/10.1191/1478088706qp063oa" + client.crMail("?"), 2, true);
    if (d && d.message) return true;
  } catch { /* níže */ }
  const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const b = $("netBanner");
  b.replaceChildren(icon("bad"), el("div", {},
    el("strong", { text: "Aplikace se nemůže spojit s databázemi, proto zatím nic neověřila." }),
    el("p", { text: inFrame || location.protocol === "blob:" || location.protocol === "about:"
      ? "Soubor je nejspíš otevřený v náhledu (například v e-mailu). Náhled připojení blokuje. Uložte soubor do počítače a otevřete ho dvojklikem v prohlížeči."
      : "Zkontrolujte připojení k internetu. Ve školní síti může přístup na api.crossref.org blokovat firewall nebo blokátor reklam. Zkuste jiný prohlížeč nebo síť." })));
  b.hidden = false;
  return false;
}

// Žlutá hláška: které databáze během ověřování nefungují a co s tím
function showSourceBanner() {
  const b = $("srcBanner");
  const bad = Object.entries(client.sourceState).filter(([, st]) => st.disabled || st.consec > 0);
  if (!running) return;
  if (!bad.length) { b.hidden = true; return; }
  // Krátce: které databáze vázne; podrobnosti a rady až pod rozklikem
  const ul = el("ul");
  for (const [src, st] of bad) {
    const why = st.kind === "limit" ? "vyčerpaný limit dotazů" : st.kind === "server" ? "chyba na straně databáze" : "neodpovídá";
    ul.append(el("li", {}, el("b", { text: src }), ": " + why + (st.disabled ? " (do konce ověřování vypnuto)" : " (zkouším znovu)") + ". " + sourceAdvice(src)));
  }
  b.replaceChildren(icon("warn"), el("div", {},
    el("strong", { text: "Pomalu nebo vůbec neodpovídá: " + bad.map(([s]) => s).join(", ") + "." }), " Ověřování pokračuje.",
    el("details", { class: "more" }, el("summary", { text: "Proč a co s tím" }), ul)));
  b.hidden = false;
}

async function run(list) {
  entries = list || parseInput(items.join("\n\n"), { exact: true });
  if (!entries.length) { toast("Žádná citace k ověření."); return; }
  runName = $("runName").value.trim();
  $("listFilter").value = ""; fbEdited = false;
  goStep(3);
  $("netBanner").hidden = true; $("srcBanner").hidden = true;
  $("results").replaceChildren();
  rows = []; results = new Array(entries.length).fill(null);
  $("progressText").textContent = "Zkouším spojení s databázemi…";
  const ok = await testConnection();
  if (!ok) { $("progressText").textContent = ""; return; }
  client.netErrors.length = 0;
  client.resetSources();
  dupOf = duplicatesOf(entries.map(e => e.raw));
  rows = entries.map(makeRow);
  sel = -1; userPicked = false;
  arrange();
  select(0);
  await processIndices(entries.map((_, i) => i));
}

// Ověří vybrané citace. Dvě se zpracovávají souběžně, dotazy na každou databázi ale
// jdou díky frontě po jednom, takže limity zůstanou dodržené.
async function processIndices(list) {
  stopFlag = false; running = true;
  $("retry").hidden = true; $("stop").hidden = false; $("back2").disabled = true; $("newRun").disabled = true; $("toStep4").disabled = true;
  // Duplicity se neověřují zvlášť: ověří se první výskyt a výsledek se zkopíruje
  const copies = i => dupOf.map((d, j) => d === i ? j : -1).filter(j => j >= 0);
  list = [...new Set(list.map(i => dupOf[i] != null ? dupOf[i] : i))];
  for (const i of list.flatMap(i => [i, ...copies(i)])) { results[i] = null; setRowState(rows[i], "wait", "Čeká"); }
  runStart = Date.now(); runStartDone = results.filter(Boolean).length; offlinePause = false;
  updateSummary(); arrange();
  let k = 0;
  async function worker() {
    while (k < list.length && !stopFlag) {
      const i = list[k++];
      const lab = rows[i].querySelector(".lab");
      lab.textContent = "Ověřuji…";
      let res;
      try {
        res = await verifyEntry(client, entries[i], { onStep: t => { lab.textContent = t.charAt(0).toUpperCase() + t.slice(1) + "…"; } });
      } catch (err) {
        // Chyba programu, ne výpadek sítě. Vypíšeme ji, aby šla nahlásit.
        console.error("Ověření citace " + (i + 1) + " selhalo:", err);
        res = { entry: entries[i], status: "bad", label: "Chyba aplikace", best: null, trail: [], appError: String(err && err.message || err) };
      }
      results[i] = res;
      renderResult(i);
      for (const j of copies(i)) { results[j] = { ...res, entry: entries[j], dupOf: i }; renderResult(j); }
      updateSummary(); arrange();
      saveState();
    }
  }
  await Promise.all([worker(), worker()]);
  running = false;
  $("stop").hidden = true; $("back2").disabled = false; $("newRun").disabled = false; $("toStep4").disabled = false;
  updateRetry();
  $("srcBanner").hidden = true;
  updateSummary(); arrange();
  saveState();
  showResume(!$("step3").hidden); // tlačítko v hlavičce: z „běží“ na „Poslední výsledky“
  if (stopFlag && !offlinePause) toast("Ověřování zastaveno.");
}

function updateRetry() {
  const again = retryable(results);
  const unfinished = results.filter(r => !r).length;
  $("retry").hidden = !again.length;
  $("retry").textContent = (unfinished ? "Pokračovat v ověřování (" : "Zopakovat neověřené (") + again.length + ")";
}

// ---------- Uložení výsledků v kartě (přežije obnovení stránky, zmizí se zavřením karty) ----------
const STATE_KEY = "overovac-stav";
const setsToArrays = (k, v) => v instanceof Set ? [...v] : v;
function saveState() {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ items, structured: !!structured, entries, results, dupOf, runName, savedAt: Date.now() }, setsToArrays));
  } catch { /* plné nebo zakázané úložiště: nevadí, jen se výsledky nepamatují */ }
}
function loadState() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    if (!s || !Array.isArray(s.entries) || !Array.isArray(s.results) || s.entries.length !== s.results.length) return null;
    for (const e of s.entries) e.hay = new Set(e.hay || []);
    return s;
  } catch { return null; }
}
function restoreState(s) {
  items = s.items || []; structured = s.structured ? s.entries : null;
  entries = s.entries; results = s.results; dupOf = s.dupOf || [];
  runName = s.runName || ""; $("runName").value = runName;
  goStep(3);
  $("netBanner").hidden = true; $("srcBanner").hidden = true;
  $("results").replaceChildren();
  rows = entries.map(makeRow);
  sel = -1; userPicked = false;
  results.forEach((r, i) => { if (r) renderResult(i); });
  running = false; stopFlag = false;
  updateRetry(); updateSummary(); arrange();
}

// ---------- Výpadek internetu během ověřování ----------
window.addEventListener("offline", () => {
  if (!running) return;
  offlinePause = true; stopFlag = true;
  const b = $("netBanner");
  b.replaceChildren(icon("bad"), el("div", {},
    el("strong", { text: "Připojení k internetu se přerušilo." }),
    el("p", { text: "Ověřování jsem pozastavil, aby citace nedostaly mylný výsledek. Až bude připojení zpět, klikněte na „Pokračovat v ověřování“." })));
  b.hidden = false;
});
window.addEventListener("online", () => {
  if (!offlinePause) return;
  $("netBanner").hidden = true;
  toast("Připojení je zpět. Pokračujte tlačítkem „Pokračovat v ověřování“.");
});
// Během ověřování se zeptat, než stránka zmizí
window.addEventListener("beforeunload", ev => { if (running) { ev.preventDefault(); ev.returnValue = ""; } });

// ---------- Nastavení a test databází ----------
async function testDatabases() {
  const out = $("testOut");
  out.hidden = false; out.replaceChildren();
  client.resetSources();
  await Promise.all(dbTests(client).map(async ([name, what, url]) => {
    const v = el("span", { class: "t-na", text: "zkouším…" });
    out.append(el("span", { text: name + " (" + what + ")" }), v);
    try {
      const d = await client.getJSON(url, 1, true);
      if (d && !d.__badRequest) { v.className = "t-ok"; v.replaceChildren(icon("ok"), " funguje"); }
      else { v.className = "t-warn"; v.replaceChildren(icon("warn"), " bez výsledku"); }
    } catch (err) {
      v.className = "t-bad";
      v.replaceChildren(icon("bad"), " " + (err.kind === "limit" ? "vyčerpaný limit" : err.kind === "server" ? "chyba databáze" : "neodpovídá"));
    }
  }));
  client.resetSources();
}

// E-mail a klíč platí jen v otevřené kartě (sessionStorage), zavřením zmizí. Natrvalo (localStorage) se neukládají:
// na github.io sdílí úložiště všechny stránky jednoho účtu a mohly by je přečíst.
function rememberInTab(id) {
  try { localStorage.removeItem(id); } catch { /* úklid po starších verzích, které ukládaly natrvalo */ }
  try { const v = sessionStorage.getItem(id); if (v) $(id).value = v; } catch { /* soukromé okno */ }
  $(id).addEventListener("change", () => { try { sessionStorage.setItem(id, $(id).value.trim()); } catch { /* nic */ } });
}
rememberInTab("crmail"); rememberInTab("oakey");

// Stav e-mailu pro Crossref hned pod polem: přijala ho aplikace, nebo ne?
// (Stejná kontrola jako při skutečných dotazech: client.crMail vrátí parametr jen pro platný tvar.)
function showMailState() {
  const v = $("crmail").value.trim(), st = $("crmailState");
  if (!v) { st.textContent = ""; st.className = "field-state"; return; }
  const ok = !!client.crMail("?");
  st.className = "field-state " + (ok ? "ok" : "bad");
  st.textContent = ok ? "✓ Platný e-mail. Crossref poběží v rychlejším režimu." : "Neplatný tvar e-mailu, Crossref ho nepoužije (hledání poběží pomaleji).";
}
$("crmail").addEventListener("input", showMailState);
showMailState();

$("settingsBtn").onclick = () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  if (open) $("crmail").focus();
};
$("testdb").onclick = testDatabases;

// ---------- Ovládání ----------
const EXAMPLE = `Braun, V., & Clarke, V. (2006). Using thematic analysis in psychology. Qualitative Research in Psychology, 3(2), 77-101. https://doi.org/10.1191/1478088706qp063oa

LeCun, Y., Bengio, Y., & Hinton, G. (2016). Deep learning. Nature, 521(7553), 436-444.

Smith, J. (2020). Artificial intelligence in secondary education: A systematic review. Computers & Education, 150, 103-120. https://doi.org/10.1191/1478088706qp063oa

Horáková, M., & Dvořák, T. (2021). Vliv generativní umělé inteligence na akademickou integritu studentů středních škol. Československá psychologie, 65(2), 112-130.

KAHNEMAN, Daniel. Thinking, fast and slow. New York: Farrar, Straus and Giroux, 2011. ISBN 978-0-374-27563-1.

Průcha, J., Walterová, E., & Mareš, J. (2013). Pedagogický slovník (7., aktualiz. a rozš. vyd). Portál.

VASWANI, Ashish et al. Attention is all you need. In: Advances in Neural Information Processing Systems 30. 2017, s. 5998-6008.`;

$("example").onclick = () => { $("src").value = EXAMPLE; syncPasteHint(); $("src").focus(); };
$("toStep2").onclick = toReview;
// Nápověda Ctrl + V jen u prázdného pole (sleduje i vložení ukázky, souboru nebo návrat z kroku 2)
function syncPasteHint() { $("pasteHint").hidden = !!$("src").value.trim(); }
$("src").addEventListener("input", syncPasteHint);
// Nejčastější postup: zkopírovat ve Wordu/PDF a vložit. Vložení do prázdného pole rovnou rozdělí citace (krok 2).
$("src").addEventListener("paste", () => {
  if ($("src").value.trim()) return;
  setTimeout(() => {
    syncPasteHint();
    if ($("src").value.trim().length > 20) toReview();
  }, 0);
});

$("back1").onclick = () => goStep(1);
$("useWhole").onclick = () => toReview({ whole: true });
$("editAll").onclick = () => { $("src").value = items.join("\n\n"); goStep(1); $("src").focus(); };
$("run").onclick = () => run();
$("back2").onclick = () => { if (structured) goStep(1); else { renderSplit(); goStep(2); } };
$("newRun").onclick = () => {
  $("src").value = ""; items = []; structured = null;
  try { sessionStorage.removeItem(STATE_KEY); } catch { /* nic */ }
  rows = []; entries = []; results = [];
  goStep(1); $("src").focus();
};
// Tlačítko „Poslední výsledky“ v hlavičce: návrat k výsledkům v paměti, nebo uloženým v kartě (po obnovení stránky)
function showResume(onResults) {
  const btn = $("restoreBtn");
  const inMemory = rows.length > 0;
  const saved = inMemory ? null : loadState();
  const n = inMemory ? entries.length : saved && saved.results.some(Boolean) ? saved.entries.length : 0;
  // Výsledky otevřené v aplikaci jsou dostupné přes kroky 3 a 4 v hlavičce; tlačítko je jen pro uložené výsledky po obnovení stránky
  btn.hidden = !n || onResults || inMemory;
  if (btn.hidden) return;
  $("restoreText").textContent = running ? "Ověřování běží" : "Poslední výsledky";
  btn.title = (running ? "Ověřování běží" : "Výsledky posledního ověření") + " (" + n + " " + plural(n, "citace", "citace", "citací") + ")";
  btn.onclick = () => { if (inMemory) goStep(3); else restoreState(saved); };
}
$("home").onclick = () => goStep(0);
$("techLink").onclick = () => goStep(5);
$("techBack").onclick = () => goStep(0);
// Ze stránky výsledků na vysvětlivky v úvodu
$("howToRead").onclick = () => { goStep(0); $("legend").scrollIntoView({ block: "start" }); };
$("start").onclick = () => { goStep(1); $("src").focus(); };
document.querySelectorAll(".steps button").forEach(b => {
  b.onclick = () => {
    const k = +b.dataset.step;
    if (k === 2) renderSplit();
    goStep(k);
  };
});
goStep(0);
$("stop").onclick = () => { stopFlag = true; };
$("retry").onclick = async () => {
  const list = retryable(results);
  if (!list.length) return;
  client.resetSources();
  toast("Znovu ověřuji " + list.length + " " + plural(list.length, "citaci", "citace", "citací") + ".");
  await processIndices(list);
};
// Zkopírování textu do schránky (se zálohou pro prohlížeče bez Clipboard API)
async function copyText(txt, msg) {
  try { await navigator.clipboard.writeText(txt); }
  catch { const t = el("textarea", {}); t.value = txt; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast(msg);
}
const slug = s => norm(s).replace(/\s+/g, "-").slice(0, 40);

$("csv").onclick = () => {
  const r = reportRows(results);
  if (!r.length) return;
  const name = "overeni-citaci" + (runName ? "-" + slug(runName) : "") + ".csv";
  const a = el("a", { href: URL.createObjectURL(new Blob([toCsv(r)], { type: "text/csv;charset=utf-8" })), download: name });
  document.body.append(a); a.click(); a.remove();
};
$("copy").onclick = () => {
  const r = reportRows(results);
  if (!r.length) return;
  copyText((runName ? runName + "\n\n" : "") + toText(r), "Přehled zkopírován.");
};

// Zpětná vazba pro studující: jen citace s problémem, srozumitelně a bez technických detailů
function feedbackText() {
  // Zkrácené DOI (skoro vždy chyba kopírování) a „možná mimo databáze“ (kniha, česká publikace…) jdou do zpětné vazby,
  // jen když je učitel ručně potvrdí. Jinak by zpětná vazba mohla studujícího křivě obvinit.
  const list = results.map((r, i) => [r, i]).filter(([r]) => r && r.review !== "ok" && (r.status === "bad" || r.status === "warn") && !isOutage(r) && !r.appError &&
    ((!r.doiTruncated && r.label !== "Nenalezeno, možná mimo databáze") || r.review === "confirmed"));
  if (!list.length) return "";
  const lines = list.map(([r, i]) => {
    let t = (i + 1) + ". " + r.entry.raw + "\n   → " + verdictLine(r);
    if (plausible(r.best) && !r.doiProblem && !r.weakMatch && r.status === "warn") t += "\n   Správně podle databáze: " + toAPA(r.best.cand);
    return t;
  });
  return "Při kontrole seznamu literatury" + (runName ? " (" + runName + ")" : "") + " se u " + list.length + " " +
    plural(list.length, "citace", "citací", "citací") + " objevily nejasnosti:\n\n" + lines.join("\n\n") +
    "\n\nProsím o opravu nebo doložení těchto zdrojů.";
}
// Náhled v kroku 4. Vlastní úpravy učitele se nepřepíšou, dokud nezvolí „Obnovit původní text“.
let fbEdited = false;
function fillFeedback(force) {
  if (fbEdited && !force) return;
  const txt = feedbackText();
  $("fbText").value = txt || "Žádná citace nemá problém ani nesrovnalost, zpětná vazba není potřeba.";
  $("feedback").disabled = !txt;
  fbEdited = false;
}
$("fbText").addEventListener("input", () => { fbEdited = true; $("feedback").disabled = !$("fbText").value.trim(); });
$("fbReset").onclick = () => fillFeedback(true);
$("feedback").onclick = () => copyText($("fbText").value, "Zpětná vazba zkopírována.");
$("toStep4").onclick = () => goStep(4);
$("back3").onclick = () => goStep(3);

// Tisk / PDF: přehled všech citací seřazený podle závažnosti
function buildPrintReport() {
  const box = $("printReport");
  const order = rows.map((r, i) => i).sort((a, b) => rank(results[a]) - rank(results[b]) || a - b);
  box.replaceChildren(
    el("h2", { class: "title", text: (runName ? runName + ": " : "") + $("h3").textContent }),
    el("p", { text: $("progressText").textContent + " Vytištěno " + new Date().toLocaleDateString("cs-CZ") + " v nástroji RefTrace. Výsledky jsou orientační a nenahrazují ruční ověření." }),
    ...order.map(i => {
      const r = results[i];
      return el("div", { class: "pr-item" },
        el("p", { class: "st", text: (i + 1) + ". " + (r ? shownLabel(r) : "Neověřeno") }),
        el("p", { text: entries[i].raw }),
        r ? el("p", { text: "→ " + verdictLine(r) }) : null);
    }));
}
window.addEventListener("beforeprint", () => { if (rows.length) buildPrintReport(); });
$("print").onclick = () => { buildPrintReport(); window.print(); };
$("listFilter").addEventListener("input", arrange);
