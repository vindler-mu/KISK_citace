// Dotazy do jednotlivých databází. Každá funkce dostává klienta ze síťové vrstvy.
import { surname, tokens } from "./text.js";
import { cleanRaw } from "./parse.js";
import { compare, verdict } from "./compare.js";
import {
  fromCrossref, fromDataCite, fromERIC, fromGBooks, fromKnihovny, fromOpenAlex, fromOpenLibrary, fromSemanticScholar
} from "./records.js";

export const enc = encodeURIComponent;
// DOI do cesty URL. Lomítka zůstávají (patří k DOI), ale úseky "." a ".." by mohly změnit cestu dotazu
// (10.1234/../../members → jiný endpoint), proto se takové DOI zakóduje celé.
export function encDoi(doi) {
  const s = String(doi || "");
  if (/(^|\/)\.\.?(\/|$)/.test(s)) return encodeURIComponent(s);
  return encodeURIComponent(s).replace(/%2F/gi, "/");
}

const CR_SEL = "DOI,title,subtitle,author,editor,issued,published-print,published-online,container-title,type,publisher,URL,volume,issue,page,updated-by";

export const crossrefDoiUrl = (client, doi) => "https://api.crossref.org/works/" + encDoi(doi) + client.crMail("?");
export const openAlexDoiUrl = (client, doi) => "https://api.openalex.org/works/doi:" + encDoi(doi) + client.oaKey().replace("&", "?");

// Výsledek: {rec} když DOI existuje, {rec:null, definitive:true} když všechny databáze řekly "neznám",
// {rec:null, definitive:false} když se některou databázi nepodařilo zeptat.
export async function lookupDoi(client, doi) {
  let errors = 0;
  const cr = await client.tryJSON(crossrefDoiUrl(client, doi));
  if (cr.data && cr.data.message) return { rec: fromCrossref(cr.data.message) };
  if (cr.err) errors++;
  const dc = await client.tryJSON("https://api.datacite.org/dois/" + encDoi(doi));
  if (dc.data && dc.data.data) return { rec: fromDataCite(dc.data.data) };
  if (dc.err) errors++;
  const oa = await client.tryJSON(openAlexDoiUrl(client, doi));
  if (oa.data && oa.data.id) return { rec: fromOpenAlex(oa.data) };
  if (oa.err) errors++;
  // Rozhodující slovo má registr DOI. Zná i DOI od jiných agentur (mEDRA, JaLC, CNKI…),
  // u kterých metadata nemáme, ale víme, že DOI existuje.
  const reg = await client.tryJSON("https://doi.org/api/handles/" + encDoi(doi));
  if (reg.data && reg.data.responseCode === 1) return { rec: null, definitive: true, registered: true, errors };
  if (!reg.err) return { rec: null, definitive: true, errors };
  return { rec: null, definitive: errors === 0, errors };
}

function searchText(e) {
  const s = cleanRaw(e.raw).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 250);
}
function cleanQ(t) { return (t || "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200); }
function titleQuery(e) { return cleanQ(e.titleGuess && tokens(e.titleGuess).length >= 2 ? e.titleGuess : searchText(e)); }

async function crossrefQuery(client, base) {
  let r = await client.tryJSON(base + "&select=" + CR_SEL);
  if (r.bad) r = await client.tryJSON(base); // Chyba 400: zkusíme to bez select
  return { cands: r.data && r.data.message && r.data.message.items ? r.data.message.items.map(fromCrossref).filter(x => x.title) : [], err: r.err };
}

export function searchCrossref(client, e) {
  return crossrefQuery(client, "https://api.crossref.org/works?rows=10" + client.crMail("&") + "&query.bibliographic=" + enc(searchText(e)));
}

export function firstAuthorGuess(e) {
  if (e.kind === "structured") return surname(e.authors[0] || "");
  const m = cleanRaw(e.raw).match(/^\s*(?:\[\d+\]\s*)?(?:\p{Lu}\.\s*)*([\p{L}'’\-]{2,})/u);
  return m && !/^(in|the|a|an)$/i.test(m[1]) ? m[1] : "";
}

export async function searchCrossrefTitle(client, e) {
  if (!e.titleGuess || tokens(e.titleGuess).length < 2) return { cands: [], err: null };
  const au = firstAuthorGuess(e);
  return crossrefQuery(client, "https://api.crossref.org/works?rows=10" + client.crMail("&") + "&query.bibliographic=" + enc(cleanQ(e.titleGuess)) + (au ? "&query.author=" + enc(au) : ""));
}

export async function searchOpenAlex(client, e) {
  const tq = e.titleGuess && tokens(e.titleGuess).length >= 2
    ? e.titleGuess.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim() : searchText(e);
  const r = await client.tryJSON("https://api.openalex.org/works?per_page=10&search=" + enc(tq) + client.oaKey());
  return { cands: r.data && r.data.results ? r.data.results.map(fromOpenAlex).filter(x => x.title) : [], err: r.err };
}

// Zná OpenAlex autora s tímto příjmením u jakéhokoli díla? Vrací {count} (počet autorů), nebo {err}.
// Slouží jen jako doplňkový signál u nenalezeného článku: 0 = autor v databázi vůbec není.
export async function authorCount(client, surname) {
  const r = await client.tryJSON("https://api.openalex.org/authors?per_page=1&search=" + enc(surname) + client.oaKey());
  if (r.err) return { err: r.err };
  return { count: r.data && r.data.meta ? r.data.meta.count : null };
}

// Semantic Scholar: velký obecný index článků
export async function searchSemanticScholar(client, e) {
  const r = await client.tryJSON("https://api.semanticscholar.org/graph/v1/paper/search?limit=10&fields=title,authors,year,venue,journal,externalIds,publicationTypes&query=" + enc(titleQuery(e)));
  return { cands: (r.data && r.data.data || []).map(fromSemanticScholar).filter(x => x.title), err: r.err };
}

// ERIC: pedagogický výzkum (články, zprávy, šedá literatura)
export async function searchERIC(client, e) {
  const base = "https://api.ies.ed.gov/eric/?format=json&rows=10&search=" + enc(titleQuery(e));
  let r = await client.tryJSON(base + "&fields=id,title,author,source,publicationdateyear,publicationtype,isbn,url");
  if (r.bad) r = await client.tryJSON(base);
  const docs = (r.data && r.data.response && r.data.response.docs) || [];
  return { cands: docs.map(fromERIC).filter(x => x.title), err: r.err };
}

// Knihovny.cz: katalogy českých knihoven (experimentální, API nemusí být veřejně dostupné)
export async function searchKnihovny(client, e) {
  const q = e.isbn || titleQuery(e);
  const base = "https://www.knihovny.cz/api/v1/search?type=AllFields&limit=10&lookfor=" + enc(q);
  let r = await client.tryJSON(base + "&field[]=id&field[]=title&field[]=authors&field[]=publicationDates&field[]=formats");
  if (r.bad) r = await client.tryJSON(base);
  return { cands: ((r.data && r.data.records) || []).map(fromKnihovny).filter(x => x.title), err: r.err };
}

// Knihy: Google Books, a když nefunguje nebo nic nenajde, Open Library.
// Za chybu se počítá, jen když selžou obě.
export async function searchBooks(client, e) {
  const q = e.isbn ? "" : (e.titleGuess || searchText(e)).replace(/[^\p{L}\p{N}\s]/gu, " ").trim().slice(0, 150);
  const gb = await client.tryJSON("https://www.googleapis.com/books/v1/volumes?maxResults=10&q=" + enc(e.isbn ? "isbn:" + e.isbn : q));
  const cands = gb.data && gb.data.items ? gb.data.items.map(fromGBooks).filter(x => x.title) : [];
  // Open Library se ptáme i tehdy, když Google Books zná jen jiné vydání (jiný rok)
  const gbGood = cands.some(c => { const r = compare(e, c); return verdict(r)[0] === "ok" && (!r.checks.year || r.checks.year[1] !== "jiné vydání"); });
  if (gbGood) return { cands, err: null };
  const ol = await client.tryJSON("https://openlibrary.org/search.json?limit=10&fields=key,title,subtitle,author_name,first_publish_year,publish_year,publisher" +
    (e.isbn ? "&isbn=" + enc(e.isbn) : "&q=" + enc(q)));
  if (ol.data && ol.data.docs) cands.push(...ol.data.docs.map(fromOpenLibrary).filter(x => x.title));
  return { cands, err: gb.err && ol.err ? gb.err : null, partialErr: gb.err || ol.err || null };
}

// Jeden zkušební dotaz do každé databáze (tlačítko Otestovat databáze)
export function dbTests(client) {
  return [
    ["Crossref", "články (hlavní zdroj)", "https://api.crossref.org/works?rows=1&query.bibliographic=thematic%20analysis%20psychology" + client.crMail("&")],
    ["DataCite", "DOI z repozitářů (Zenodo apod.)", "https://api.datacite.org/dois/10.5281/zenodo.15623449"],
    ["OpenAlex", "obecný index", "https://api.openalex.org/works?per_page=1&search=thematic%20analysis" + client.oaKey()],
    ["Semantic Scholar", "obecný index", "https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title&query=thematic%20analysis%20psychology"],
    ["ERIC", "pedagogický výzkum", "https://api.ies.ed.gov/eric/?format=json&rows=1&search=formative%20assessment"],
    ["Google Books", "knihy", "https://www.googleapis.com/books/v1/volumes?q=isbn:9780374275631"],
    ["Open Library", "knihy", "https://openlibrary.org/search.json?limit=1&q=thinking%20fast%20and%20slow"],
    ["Knihovny.cz", "české knihovny (experimentální)", "https://www.knihovny.cz/api/v1/search?type=AllFields&limit=1&lookfor=Babi%C4%8Dka%20N%C4%9Bmcov%C3%A1"]
  ];
}
