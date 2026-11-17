// Síťová vrstva: pevný seznam databází, fronty, opakování a vypínání databází.
// Nesahá na stránku. E-mail, klíč i hodiny dostává jako parametry, aby šla testovat.

// Jediné adresy, kam smí aplikace posílat požadavky
export const ALLOWED_HOSTS = [
  "api.crossref.org", "api.datacite.org", "api.openalex.org", "api.semanticscholar.org",
  "api.ies.ed.gov", "www.googleapis.com", "openlibrary.org", "www.knihovny.cz", "doi.org"
];

// Adresy, které se objevují jen jako odkazy pro učitele. Aplikace na ně nikdy nic neposílá.
export const DISPLAY_ONLY_HOSTS = [
  "openalex.org", "eric.ed.gov", "www.semanticscholar.org",
  "scholar.google.com", "www.google.com", "www.libraryresearch.com"
];

// Chyba spojení nebo vyčerpaný limit. To NENÍ totéž co "nenalezeno".
export class NetError extends Error {
  constructor(msg, kind, source) { super(msg); this.kind = kind; this.source = source; }
}

// Názvy databází podle adresy
const HOSTS = {
  "api.crossref.org": "Crossref", "api.openalex.org": "OpenAlex", "api.datacite.org": "DataCite",
  "www.googleapis.com": "Google Books", "openlibrary.org": "Open Library",
  "api.semanticscholar.org": "Semantic Scholar", "api.ies.ed.gov": "ERIC", "www.knihovny.cz": "Knihovny.cz",
  "doi.org": "doi.org"
};

// Odmítne cokoli, co není https na povolenou adresu
export function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.includes(u.host)) throw new Error("Nepovolená adresa: " + u.host);
  return u;
}

export function sourceName(url) {
  const u = new URL(url);
  if (u.host === "api.openalex.org" && u.pathname.startsWith("/works/doi:")) return "OpenAlex (DOI)";
  return HOSTS[u.host] || u.host;
}

// Odstup mezi dotazy na jednu databázi
function gapFor(src, url) {
  if (src === "Crossref") {
    // Opatrně: stejný odstup pro všechny dotazy na Crossref (bez e-mailu 1 za sekundu, s e-mailem asi 3 za sekundu)
    return /[?&]mailto=/.test(url) ? 400 : 1100;
  }
  return { "OpenAlex": 150, "Semantic Scholar": 1500, "Google Books": 600, "Open Library": 400,
    "ERIC": 300, "Knihovny.cz": 300, "DataCite": 200 }[src] || 300;
}

// Databáze s denním limitem se po chybě 429 vypnou do konce ověřování
const DAILY_LIMIT = new Set(["OpenAlex", "Google Books"]);

// Co poradit, když databáze nefunguje
export function sourceAdvice(src) {
  if (src === "OpenAlex") return "Bez klíče má OpenAlex jen malý denní limit. Vložte bezplatný klíč v Nastavení (vpravo nahoře) a spusťte ověření znovu.";
  if (src === "Google Books") return "Google Books omezuje dotazy bez klíče. Knihy se místo toho hledají v Open Library. Limit se obnoví do druhého dne.";
  if (src === "Crossref") return "Crossref bez e-mailu povoluje jen 1 vyhledávání za sekundu, aplikace proto zpomalí a zkusí to znovu. Rychlejší je vyplnit e-mail v Nastavení (vpravo nahoře). Pokud problém trvá, může přístup blokovat síť nebo blokátor reklam.";
  if (src === "Semantic Scholar") return "Semantic Scholar sdílí limit mezi všechny uživatele bez klíče a v době velkého provozu odmítá dotazy. Ostatní databáze hledají dál.";
  if (src === "ERIC") return "Doplňková databáze. Hledá se dál bez ní.";
  if (src === "Knihovny.cz") return "Katalog Knihovny.cz se nepodařilo použít (jeho rozhraní nemusí být veřejně dostupné). Hledá se dál bez něj; české knihy ověřte ručně odkazem Knihovny.cz.";
  return "Zkuste to později.";
}

// Vytvoří klienta s vlastními frontami a stavem databází.
// Testy si sem předají simulovaný fetch a simulované hodiny.
export function createClient(opts = {}) {
  const fetchFn = opts.fetchFn || ((...a) => globalThis.fetch(...a));
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const getEmail = opts.getEmail || (() => "");
  const getOpenAlexKey = opts.getOpenAlexKey || (() => "");
  const onSourceChange = opts.onSourceChange || (() => {});

  const netErrors = [];
  const hostQueue = {}, hostNext = {};
  const sourceState = {};

  function crMail(sep) {
    const m = (getEmail() || "").trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m) ? sep + "mailto=" + encodeURIComponent(m) : "";
  }
  function oaKey() {
    const k = (getOpenAlexKey() || "").trim();
    return k ? "&api_key=" + encodeURIComponent(k) : "";
  }

  // Každá databáze má vlastní frontu: dotazy na ni jdou po jednom a s odstupem
  function schedule(src, url, fn) {
    const prev = hostQueue[src] || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const wait = (hostNext[src] || 0) - now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); }
      finally { hostNext[src] = Math.max(hostNext[src] || 0, now() + gapFor(src, url)); }
    });
    hostQueue[src] = run;
    return run;
  }

  function resetSources() { for (const k of Object.keys(sourceState)) delete sourceState[k]; }
  function srcState(src) { return sourceState[src] || (sourceState[src] = { fails: 0, ok: 0, consec: 0 }); }

  function markFail(src, kind, status) {
    const st = srcState(src);
    st.fails++; st.consec++; st.kind = kind; st.status = status;
    if (kind === "limit" && DAILY_LIMIT.has(src)) st.disabled = true;
    else if (st.consec >= 6) st.disabled = true;
    else hostNext[src] = now() + Math.min(30000, 2000 * Math.pow(2, st.consec - 1));
    onSourceChange();
  }
  function markOk(src) {
    const st = srcState(src);
    const was = st.consec;
    st.ok++; st.consec = 0;
    if (was) onSourceChange();
  }

  // Paměť úspěšných odpovědí na dobu běhu stránky: stejný dotaz se nepošle dvakrát
  // (opakované ověření, stejné DOI u více citací, křížová kontrola). Chyby se nepamatují.
  const cache = new Map();

  // Vrací data, nebo null když databáze odpoví "nenalezeno".
  // Při chybě spojení nebo vyčerpaném limitu vyhodí chybu.
  // fresh = true: zeptat se doopravdy (test spojení a test databází)
  async function getJSON(url, tries, fresh) {
    assertAllowed(url);
    if (!fresh && cache.has(url)) return cache.get(url);
    const data = await fetchJSON(url, tries);
    if (cache.size > 5000) cache.clear();
    cache.set(url, data);
    return data;
  }

  async function fetchJSON(url, tries) {
    const src = sourceName(url);
    if (tries == null) tries = src === "Crossref" ? 3 : 2;
    let lastErr = null;
    for (let a = 0; a < tries; a++) {
      if (sourceState[src] && sourceState[src].disabled) throw new NetError(src + " je vypnutý (opakovaně neodpověděl)", sourceState[src].kind, src);
      const outcome = await schedule(src, url, async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        try {
          const r = await fetchFn(url, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.status === 404) return { data: null };
          if (r.status === 400) return { data: { __badRequest: true } };
          if (r.ok) return { data: await r.json() };
          return { status: r.status, kind: (r.status === 429 || r.status === 409 || r.status === 403 || r.status === 401) ? "limit" : "server" };
        } catch (e) {
          clearTimeout(t);
          // Odpověď na překročený limit často nemá potřebné hlavičky a prohlížeč ji ohlásí jako chybu spojení
          return { status: 0, kind: "network" };
        }
      });
      if (!outcome.kind) { markOk(src); return outcome.data; }
      lastErr = new NetError(src + (outcome.status ? " vrátil chybu " + outcome.status : " neodpověděl"), outcome.kind, src);
      markFail(src, outcome.kind, outcome.status);
      if (outcome.kind === "limit" && DAILY_LIMIT.has(src)) break;
    }
    netErrors.push(lastErr);
    throw lastErr;
  }

  // Zavolá getJSON a místo vyhození chyby vrátí {data, err}
  async function tryJSON(url) {
    try {
      const d = await getJSON(url);
      return { data: d && d.__badRequest ? null : d, bad: !!(d && d.__badRequest), err: null };
    } catch (e) { return { data: null, err: e }; }
  }

  return { getJSON, tryJSON, crMail, oaKey, resetSources, sourceState, netErrors, clearCache: () => cache.clear() };
}
