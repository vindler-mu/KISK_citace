// Lokální vývojový server: jen pro tento počítač a jen pro soubory stránky.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5173;

// Povolené cesty. Nic jiného se nevydá, takže přes adresu nejde číst jiné soubory.
function resolve(url) {
  if (url === "/") return ["src/index.html", "text/html; charset=utf-8"];
  if (url === "/app.js") return ["src/app.js", "text/javascript; charset=utf-8"];
  if (url === "/logo-kisk.png") return ["src/logo-kisk.png", "image/png"];
  if (/^\/lib\/[a-z]+\.js$/.test(url)) return [url.slice(1), "text/javascript; charset=utf-8"];
  return null;
}

http.createServer((req, res) => {
  const hit = resolve(req.url.split("?")[0]);
  if (!hit) { res.writeHead(404); res.end("Nenalezeno"); return; }
  fs.readFile(path.join(root, hit[0]), (err, data) => {
    if (err) { res.writeHead(404); res.end("Nenalezeno"); return; }
    res.writeHead(200, { "Content-Type": hit[1], "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log("Běží na http://127.0.0.1:" + PORT + " (ukončíš Ctrl+C)"));
