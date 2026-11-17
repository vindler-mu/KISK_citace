// Převod odpovědí databází na jednotný tvar záznamu
import { stripTags, surname } from "./text.js";

// Jednotný úklid textů ze všech databází: HTML značky a entity ("&amp;" → "&"), zbytečné mezery
function tidyRec(r) {
  const t = v => typeof v === "string" ? stripTags(v) : v;
  return { ...r, title: t(r.title), subtitle: t(r.subtitle), journal: t(r.journal), publisher: t(r.publisher),
    authors: (r.authors || []).map(t), authorsFull: (r.authorsFull || []).map(t) };
}
import { parsePages } from "./parse.js";

// Převod záznamů z různých databází na jednotný tvar
export function fromCrossref(it) {
  const years = new Set();
  for (const k of ["issued", "published-print", "published-online", "published"]) {
    const y = it[k] && it[k]["date-parts"] && it[k]["date-parts"][0] && it[k]["date-parts"][0][0];
    if (y) years.add(y);
  }
  const au = it.author || it.editor || [];
  return tidyRec({
    source: "Crossref",
    title: stripTags((it.title || [])[0]), subtitle: stripTags((it.subtitle || [])[0]),
    authors: au.map(a => a.family || surname(a.name)).filter(Boolean),
    authorsFull: au.map(a => a.family ? (a.family + (a.given ? ", " + a.given : "")) : a.name).filter(Boolean),
    years: [...years], journal: stripTags((it["container-title"] || [])[0]),
    doi: it.DOI || "", url: it.DOI ? "https://doi.org/" + it.DOI : it.URL,
    type: it.type || "", publisher: it.publisher || "",
    volume: it.volume || "", issue: it.issue || "", pages: parsePages(it.page),
    retracted: (it["updated-by"] || []).some(u => /retract/i.test(u.type || "")) || /^\s*retracted\b/i.test((it.title || [])[0] || "")
  });
}
export function fromOpenAlex(w) {
  const au = w.authorships || [];
  const src = w.primary_location && w.primary_location.source;
  return tidyRec({
    source: "OpenAlex",
    title: stripTags(w.title || w.display_name), subtitle: "",
    authors: au.map(a => surname((a.author && a.author.display_name) || a.raw_author_name)).filter(Boolean),
    authorsFull: au.map(a => (a.author && a.author.display_name) || a.raw_author_name).filter(Boolean),
    years: w.publication_year ? [w.publication_year] : [],
    journal: src ? src.display_name : "",
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, "") : "",
    url: w.doi || w.id, type: w.type || "", publisher: "",
    volume: (w.biblio && w.biblio.volume) || "", issue: (w.biblio && w.biblio.issue) || "",
    pages: w.biblio && w.biblio.first_page ? parsePages(w.biblio.first_page + (w.biblio.last_page ? "-" + w.biblio.last_page : "")) : null,
    retracted: !!w.is_retracted
  });
}
export function fromDataCite(d) {
  const a = d.attributes || {};
  return tidyRec({
    source: "DataCite",
    title: stripTags(a.titles && a.titles[0] && a.titles[0].title), subtitle: "",
    authors: (a.creators || []).map(c => c.familyName || surname(c.name)).filter(Boolean),
    authorsFull: (a.creators || []).map(c => c.name).filter(Boolean),
    years: a.publicationYear ? [Number(a.publicationYear)] : [],
    journal: (a.container && a.container.title) || "",
    doi: a.doi || "", url: "https://doi.org/" + a.doi,
    type: (a.types && a.types.resourceTypeGeneral) || "",
    publisher: typeof a.publisher === "string" ? a.publisher : (a.publisher && a.publisher.name) || ""
  });
}
export function fromGBooks(v) {
  const i = v.volumeInfo || {};
  const y = parseInt(i.publishedDate, 10);
  return tidyRec({
    source: "Google Books",
    title: i.title || "", subtitle: i.subtitle || "",
    authors: (i.authors || []).map(surname), authorsFull: i.authors || [],
    years: y ? [y] : [], journal: "", doi: "",
    url: i.infoLink || i.canonicalVolumeLink || "", type: "book", publisher: i.publisher || ""
  });
}

export function fromOpenLibrary(d) {
  const years = [...new Set([d.first_publish_year, ...(d.publish_year || [])].filter(Boolean))];
  return tidyRec({
    source: "Open Library",
    title: d.title || "", subtitle: d.subtitle || "",
    authors: (d.author_name || []).map(surname), authorsFull: d.author_name || [],
    years, journal: "", doi: "",
    url: d.key ? "https://openlibrary.org" + d.key : "", type: "book",
    publisher: (d.publisher || [])[0] || ""
  });
}

export function fromSemanticScholar(p) {
  return tidyRec({
    source: "Semantic Scholar", title: p.title || "", subtitle: "",
    authors: (p.authors || []).map(a => surname(a.name)), authorsFull: (p.authors || []).map(a => a.name),
    years: p.year ? [p.year] : [], journal: (p.journal && p.journal.name) || p.venue || "",
    doi: (p.externalIds && p.externalIds.DOI) || "",
    url: p.externalIds && p.externalIds.DOI ? "https://doi.org/" + p.externalIds.DOI : "https://www.semanticscholar.org/paper/" + p.paperId,
    type: (p.publicationTypes || []).includes("Book") ? "book" : "", publisher: "",
    volume: (p.journal && p.journal.volume) || "", issue: "", pages: parsePages(p.journal && p.journal.pages)
  });
}

export function fromERIC(d) {
  const au = Array.isArray(d.author) ? d.author : (d.author ? [d.author] : []);
  const pt = [].concat(d.publicationtype || []).join(" ");
  return tidyRec({
    source: "ERIC", title: d.title || "", subtitle: "",
    authors: au.map(surname), authorsFull: au,
    years: d.publicationdateyear ? [Number(d.publicationdateyear)] : [],
    journal: /Journal/i.test(pt) ? (d.source || "") : "",
    doi: "", url: "https://eric.ed.gov/?id=" + d.id, type: /Book/i.test(pt) ? "book" : "", publisher: d.source || ""
  });
}

// Tvar autorů v API Knihovny.cz zatím neznáme jistě, proto zkoušíme obě možnosti
function knihovnyNames(a) {
  if (!a) return [];
  const out = [];
  for (const part of ["primary", "secondary", "corporate"]) {
    const v = a[part];
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v.map(x => typeof x === "string" ? x : (x.name || "")));
    else out.push(...Object.keys(v));
  }
  return out.map(n => n.replace(/,?\s*\d{4}-?(\d{4})?\.?$/, "").trim()).filter(Boolean);
}

export function fromKnihovny(d) {
  const au = knihovnyNames(d.authors);
  const y = parseInt([].concat(d.publicationDates || [])[0], 10);
  return tidyRec({
    source: "Knihovny.cz", title: (d.title || "").split(" / ")[0].replace(/\s+:\s+/g, ": ").trim(), subtitle: "",
    authors: au.map(surname), authorsFull: au, years: y ? [y] : [], journal: "", doi: "",
    url: d.id ? "https://www.knihovny.cz/Record/" + encodeURIComponent(d.id) : "", type: "book", publisher: ""
  });
}
