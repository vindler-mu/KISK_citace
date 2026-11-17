# RefTrace

Pomocník pro kontrolu bibliografických údajů. Vyučující vloží seznam literatury ze studentské práce a aplikace u každé citace zjistí, jestli zdroj existuje ve veřejných databázích, jestli sedí jeho údaje a jestli článek nebyl stažen.

**Aplikace:** https://vindler-mu.github.io/KISK_citace/

Autor: Vojtěch Velísek, KISK FF MU. Vytvořeno ve spolupráci s AI asistentem Claude Opus 5.5 (rodina modelů Claude 5, Anthropic).

## Pomocník, ne soudce

RefTrace nekontroluje za vyučujícího. Zrychluje práci a umožňuje projít celý seznam literatury místo několika namátkou vybraných citací. Ukáže, kam se podívat. Rozhodnutí i samotné ověření zůstávají na člověku:

- může chybovat a databáze nejsou úplné, proto jeho výsledky **nesmí sloužit k přímému hodnocení studujících**;
- u označených citací je potřeba zdroj ověřit ručně (originál práce, katalog, web vydavatele);
- „Nenalezeno“ neznamená automaticky podvod: české knihy, sborníky a šedá literatura v databázích často chybí;
- neověřuje, jestli zdroj obsahuje to, co studující cituje.

## Co aplikace dělá

- Rozdělí vložený text (z Wordu, PDF nebo exportu BibTeX/RIS) na citace a ukáže je ke kontrole.
- Hledá v databázích Crossref, DataCite, OpenAlex, Semantic Scholar, ERIC, Google Books, Open Library a Knihovny.cz. DOI ověřuje v registru doi.org.
- Porovná název, autory, rok, časopis, ročník, číslo a strany a výsledek ověří ve druhé databázi.
- Upozorní na stažené články, na DOI, které neexistuje nebo patří jinému dílu, a na neplatné ISBN.
- Rozumí české citační praxi (ČSN ISO 690) a české šedé literatuře (zákony, normy, závěrečné práce, dokumenty institucí).
- Připraví text zpětné vazby pro studující, do kterého jdou nejisté nálezy jen po ručním potvrzení.

Podrobný popis fungování (pořadí databází, prahy shody, ošetření výpadků) je přímo v aplikaci pod odkazem **„Jak to funguje technicky“** v zápatí.

## Soukromí a bezpečnost

- Aplikace je jeden soubor HTML, který běží jen v prohlížeči. Nemá server ani databázi a nepoužívá knihovny třetích stran.
- Text citací se posílá jen do veřejných databází ze seznamu výše, jako vyhledávací dotaz. Bezpečnostní pravidla stránky (Content Security Policy) jiná spojení nedovolí.
- Na žádný server se nic neukládá. E-mail pro Crossref, klíč k OpenAlexu i výsledky platí jen v otevřené kartě prohlížeče.
- Kód prošel bezpečnostním auditem (listopad 2026), bez kritických a vážných nálezů.

**Doporučení pro uživatele:** v Nastavení si vyplňte vlastní e-mail pro Crossref (nepovinný). Ve škole mají všichni stejnou IP adresu a Crossref počítá limit rychlejšího režimu podle e-mailu. Kdo ověřuje hodně, může si založit bezplatný klíč k OpenAlex.

## Omezení

- **Přesnost zatím není změřená** na dostatečně velké sadě citací. Měření na pracích z KISK se připravuje (skript `npm run eval`).
- **Závislost na otevřených rozhraních databází.** Nástroj funguje, dokud databáze dovolují dotazy z prohlížeče bez placeného přístupu. Crossref (2025) i OpenAlex (2026) už své limity zpřísnily.
- Dělení textu zkopírovaného z PDF je vždy jen odhad, proto ho aplikace ukazuje ke kontrole.

## Inspirace a související nástroje

RefTrace vznikl nezávisle, z konkrétního požadavku vyučující na kontrolu citací ve studentských pracích. Při jeho dalším vývoji jsem se inspiroval principy podobných nástrojů a srovnávací studií jejich přesnosti. Kód z nich převzatý není. Převzaté myšlenky: rozlišení stupně jistoty u nenalezených citací, signál „autor není v databázi u žádného díla“, tolerance zápisu složených slov a měření vlastní míry falešných poplachů.

- CheckIfExist: [arXiv:2602.15871](https://arxiv.org/abs/2602.15871)
- RefChecker: [github.com/markrussinovich/refchecker](https://github.com/markrussinovich/refchecker)
- Srovnávací studie: *Detecting Hallucinated and Suspicious Citations: What Current Tools Can and Cannot Do*, [arXiv:2607.22693](https://arxiv.org/abs/2607.22693)

## Pro vývojáře

Stačí Node.js 18 nebo novější. Projekt nemá žádné balíčky, `npm install` není potřeba.

| Příkaz | Co udělá |
|---|---|
| `npm run dev` | spustí stránku na http://127.0.0.1:5173 bez buildu |
| `npm run build` | vytvoří jeden soubor `docs/index.html` s CSP |
| `npm run eval -- eval/skutecne.txt [eval/vymyslene.txt]` | změří přesnost na sadě citací (skutečné databáze): falešné poplachy a zachycené podvrhy |

Struktura:
- `lib/`: logika bez přístupu ke stránce (čtení citací, síť, databáze, porovnání, ověření, přehled)
- `src/`: šablona stránky a uživatelské rozhraní
- `scripts/`: build, vývojový server a měření přesnosti
- `docs/`: hotová stránka, publikuje ji GitHub Pages. Needitujte ji ručně, build ji přepíše.

Automatické testy (přes 170, se simulovanou sítí) a sady citací pro měření zůstávají jen v lokální kopii autora. Sady mohou obsahovat citace z prací studujících.

Do kódu nikdy nedávejte klíče ani e-maily, repozitář je veřejný.

Soubor `docs/index.html` funguje i otevřený z disku dvojklikem.

## Licence

[MIT](LICENSE). Nápady, chyby a připomínky posílejte autorovi e-mailem nebo přes MS Teams.
