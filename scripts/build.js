// Build: spojí moduly do jednoho souboru docs/index.html s CSP a hashem skriptu.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_HOSTS } from "../lib/net.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pořadí je důležité: každý modul až za tím, co používá
const MODULES = ["lib/text.js", "lib/parse.js", "lib/net.js", "lib/records.js", "lib/compare.js",
  "lib/sources.js", "lib/verify.js", "lib/report.js", "src/app.js"];

const read = f => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");

// Klasický skript místo modulů: moduly se z disku (dvojklikem) nespustí
function bundle() {
  const parts = MODULES.map(f => "// ----- " + f + " -----\n" + read(f)
    .replace(/^import [\s\S]*?;\n/gm, "")
    .replace(/^export /gm, ""));
  return '(() => {\n"use strict";\n' + parts.join("\n") + "\n})();\n";
}

export const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("base64");

export function cspFor(script) {
  const connect = ALLOWED_HOSTS.map(h => "https://" + h).join(" ");
  return "default-src 'none'; script-src 'sha256-" + sha256(script) + "'; style-src 'unsafe-inline'; " +
    "img-src data:; connect-src " + connect + "; base-uri 'none'; form-action 'none'";
}

export function build() {
  const script = bundle();
  if (/<\/script/i.test(script)) throw new Error("Skript obsahuje </script, stránka by se rozbila.");
  const tag = '<script type="module" src="app.js"></script>';
  const tpl = read("src/index.html");
  if (!tpl.includes(tag)) throw new Error("V šabloně chybí značka skriptu.");
  const meta = '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + cspFor(script) + '">';
  // Náhrady funkcí: znak $ v kódu se nesmí chápat jako speciální vzor
  // Logo vložené přímo do stránky (CSP povoluje obrázky jen jako data:), funguje i otevřené z disku
  const logo = "data:image/png;base64," + fs.readFileSync(path.join(root, "src/logo-kisk.png")).toString("base64");
  const html = tpl.replace('<meta charset="utf-8">', () => meta).replace(tag, () => "<script>" + script + "</script>")
    .replace(/src="logo-kisk\.png"/g, () => 'src="' + logo + '"')
    // Datum poslední aktualizace do zápatí (den sestavení stránky)
    .replace("{{BUILD_DATE}}", () => { const d = new Date(); return d.getDate() + ". " + (d.getMonth() + 1) + ". " + d.getFullYear(); });
  return { html, script };
}

// Spuštěno přímo (npm run build), ne importem z testu
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { html } = build();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/index.html"), html);
  console.log("Hotovo: docs/index.html (" + Math.round(html.length / 1024) + " kB)");
}
