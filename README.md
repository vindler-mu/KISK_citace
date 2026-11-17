# RefTrace

Ověřovač citací pro učitele: vložíte seznam literatury a aplikace u každé citace zjistí, jestli zdroj existuje, jestli sedí jeho údaje a jestli článek nebyl stažen.

Je to pomocník, ne soudce: může chybovat a jeho výsledky nesmí sloužit k přímému hodnocení studujících.

Autor: Vojtěch Velísek, KISK FF MU. Vytvořeno ve spolupráci s AI asistentem Claude Opus 5.5 (rodina modelů Claude 5, Anthropic).

## Pro kolegy

**Odkaz na aplikaci:** https://UZIVATEL.github.io/REPOZITAR/ (po nasazení doplnit)

- **Vyplňte si vlastní e-mail pro Crossref** (Nastavení vpravo nahoře, nepovinné). Ve škole máte všichni stejnou IP adresu a Crossref počítá limit rychlejšího režimu podle e-mailu.
- **Ověřujete hodně?** Založte si bezplatný klíč k OpenAlex a vložte ho tamtéž.
- **Soukromí:** aplikace běží jen ve vašem prohlížeči a citace posílá jen do veřejných databází. Na žádný server nic neukládá. E-mail, klíč i výsledky posledního ověření platí jen v otevřené kartě a zavřením zmizí. Text citací se posílá do veřejných databází (Crossref, OpenAlex a další) jako vyhledávací dotaz.

## Co aplikace dělá a nedělá

Dělá:
- hledá citace v databázích Crossref, DataCite, OpenAlex, Semantic Scholar, ERIC, Google Books, Open Library a Knihovny.cz a DOI ověřuje v registru doi.org;
- porovnává název, autory, rok, časopis, ročník, číslo a strany;
- upozorní na stažené články a na DOI, které neexistuje nebo patří jinému dílu.

Nedělá:
- neověřuje, jestli zdroj obsahuje to, co studující cituje;
- neotevírá odkazy z citací, jen je zobrazí;
- „Nenalezeno“ neznamená automaticky podvod: české knihy a šedá literatura v databázích často chybí.

## Vývoj

Stačí Node.js 18 nebo novější. Projekt nemá žádné balíčky, `npm install` není potřeba. Technický popis fungování je přímo v aplikaci (odkaz „Jak to funguje technicky“ v zápatí).

| Příkaz | Co udělá |
|---|---|
| `npm run dev` | spustí stránku na http://127.0.0.1:5173 bez buildu |
| `npm test` | spustí testy, síť je v nich vždy simulovaná (testy jsou jen v lokální kopii autora) |
| `npm run build` | vytvoří jeden soubor `docs/index.html` |
| `npm run eval -- eval/skutecne.txt [eval/vymyslene.txt]` | změří přesnost na vaší sadě citací (skutečné databáze): kolik skutečných citací dostane falešný poplach a kolik vymyšlených se zachytí |

Sady pro měření dávejte do složky `eval/` (citace oddělené prázdným řádkem). Složka je v `.gitignore`, protože může obsahovat citace z prací studujících.

Kde co je:
- `lib/`: logika bez přístupu ke stránce (čtení citací, síť, databáze, porovnání, ověření, přehled)
- `src/`: šablona stránky a uživatelské rozhraní
- `scripts/`: build, vývojový server a měření přesnosti (`evaluate.js`)
- `docs/`: hotová stránka, tu publikuje GitHub Pages. Needitujte ji ručně, build ji přepíše.
- Testy (`test/`), zadání (`SPEC.md`) a interní poznámky zůstávají jen v lokální kopii autora (jsou v `.gitignore`).

Nikdy do kódu nedávejte klíče ani e-maily, repozitář je veřejný.

## Po každé změně

1. `npm test` a `npm run build` (vytvoří nový `docs/index.html`).
2. V GitHub Desktop zkontrolujte seznam změněných souborů (nic tajného, nezapomeňte na `docs/index.html`).
3. Napište krátké shrnutí, klikněte **Commit to main** a pak **Push origin**.

Stránka se pak sama aktualizuje za pár minut.

## První nasazení na GitHub Pages (GitHub Desktop)

1. Na github.com zapněte u účtu dvoufázové ověření a v *Settings → Emails* volbu **Keep my email addresses private**. Pro git použijte adresu `…@users.noreply.github.com`, ne svůj e-mail.
2. Nainstalujte GitHub Desktop z oficiální stránky desktop.github.com a přihlaste se.
3. *File → Add local repository* → složka projektu → **create a repository** (Git ignore: *None*, vlastní `.gitignore` už existuje).
4. Zkontrolujte seznam souborů, napište shrnutí a dejte **Commit to main**.
5. **Publish repository**, odškrtněte „Keep this code private“ (GitHub Pages zdarma vyžaduje veřejný repozitář).
6. Na github.com v repozitáři: **Settings → Pages → Deploy from a branch → main → /docs → Save**.
7. Za pár minut stránka poběží na `https://UZIVATEL.github.io/REPOZITAR/`. Odkaz doplňte nahoru do části „Pro kolegy“.

Soubor `docs/index.html` funguje i otevřený z disku dvojklikem, takže ho jde poslat kolegům e-mailem.
