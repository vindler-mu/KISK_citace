// Měření přesnosti RefTrace na vlastní sadě citací (skutečné databáze, žádná simulace).
//
//   npm run eval -- eval/skutecne.txt                     jen skutečné citace: kolik falešných poplachů
//   npm run eval -- eval/skutecne.txt eval/vymyslene.txt  navíc vymyšlené: kolik jich nástroj zachytí
//
// Soubory: prostý text, citace oddělené prázdným řádkem (jako po vložení do aplikace a kontrole v kroku 2).
// Skutečné citace = ty, které jste ručně ověřili, že existují a jsou správně.
// Citace se posílají do stejných veřejných databází jako z aplikace. Složka eval/ je v .gitignore,
// ať se citace z prací studujících nedostanou do veřejného repozitáře.
// Volitelně: proměnná prostředí CROSSREF_EMAIL zrychlí Crossref (stejně jako e-mail v Nastavení aplikace).
import fs from "node:fs";
import { createClient } from "../lib/net.js";
import { parseInput } from "../lib/parse.js";
import { verifyEntry } from "../lib/verify.js";

const [realFile, fakeFile] = process.argv.slice(2);
if (!realFile) {
  console.error("Použití: npm run eval -- <soubor se skutečnými citacemi> [soubor s vymyšlenými citacemi]");
  process.exit(1);
}

const client = createClient({ getEmail: () => process.env.CROSSREF_EMAIL || "" });

function load(file) {
  const text = fs.readFileSync(file, "utf8");
  return parseInput(text, { exact: !/@\w+\s*\{|^TY {2}- /m.test(text) });
}

// Dvě citace souběžně, stejně jako v aplikaci (limity databází hlídá síťová vrstva)
async function runAll(entries, label) {
  const results = new Array(entries.length);
  let k = 0, done = 0;
  async function worker() {
    while (k < entries.length) {
      const i = k++;
      try { results[i] = await verifyEntry(client, entries[i]); }
      catch (err) { results[i] = { entry: entries[i], status: "bad", label: "Chyba aplikace: " + err.message }; }
      process.stderr.write("\r" + label + ": " + (++done) + " / " + entries.length + "   ");
    }
  }
  await Promise.all([worker(), worker()]);
  process.stderr.write("\n");
  return results;
}

const isOutage = r => r.label === "Neúplné hledání" || r.label === "Nelze ověřit";
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + " %" : "–";
function byLabel(results) {
  const m = {};
  for (const r of results) m[r.label] = (m[r.label] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([l, n]) => "  " + String(n).padStart(4) + "  " + l).join("\n");
}

const real = await runAll(load(realFile), "Skutečné citace");
const realOut = real.filter(isOutage).length;
const counted = real.filter(r => !isOutage(r));
const redFalse = counted.filter(r => r.status === "bad");
const anyFalse = counted.filter(r => r.status === "bad" || r.status === "warn");

console.log("\n=== Skutečné citace (" + real.length + ") ===");
console.log(byLabel(real));
console.log("\nNeověřeno kvůli výpadku databází: " + realOut + " (do výpočtu se nepočítají)");
console.log("Falešný poplach, červený (Problém): " + redFalse.length + " z " + counted.length + " = " + pct(redFalse.length, counted.length));
console.log("Falešný poplach, červený nebo okrový: " + anyFalse.length + " z " + counted.length + " = " + pct(anyFalse.length, counted.length));
if (redFalse.length) {
  console.log("\nČervené u skutečných citací (projděte, proč):");
  for (const r of redFalse) console.log("  [" + r.label + "] " + r.entry.raw);
}

if (fakeFile) {
  const fake = await runAll(load(fakeFile), "Vymyšlené citace");
  const fCounted = fake.filter(r => !isOutage(r));
  const caughtRed = fCounted.filter(r => r.status === "bad");
  const caughtAny = fCounted.filter(r => r.status === "bad" || r.status === "warn");
  console.log("\n=== Vymyšlené citace (" + fake.length + ") ===");
  console.log(byLabel(fake));
  console.log("\nZachyceno červeně: " + caughtRed.length + " z " + fCounted.length + " = " + pct(caughtRed.length, fCounted.length));
  console.log("Zachyceno červeně nebo okrově: " + caughtAny.length + " z " + fCounted.length + " = " + pct(caughtAny.length, fCounted.length));
  const missed = fCounted.filter(r => r.status === "ok" || r.status === "info");
  if (missed.length) {
    console.log("\nProšly jako v pořádku nebo „ověřte ručně“ (projděte, proč):");
    for (const r of missed) console.log("  [" + r.label + "] " + r.entry.raw);
  }
}
