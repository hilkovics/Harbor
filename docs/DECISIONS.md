# DECISIONS.md — Modular Harbor (ADR log)

ADR log (Architecture Decision Records) zaznamenáva záväzné architektonické rozhodnutia projektu: každé s kontextom, rozhodnutím, zváženými alternatívami a dôsledkami.
Nový záznam pridáva príkaz `/adr "názov"` s ďalším voľným číslom (ADR-007, ADR-008, …).
`docs/ARCHITECTURE.md` sa mení výlučne cez ADR v tomto súbore.

---

## ADR-001: Stack TypeScript + PixiJS + React

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §1, §2, §15; CLAUDE.md „Stack", „Tvrdé pravidlá" 1

**Kontext:** Hra spája simuláciu tisícok entít na gride, svet s kamerou, zoomom a vrstvami a dátovo bohaté UI (panely, grafy, metriky); sim musí byť deterministický a testovateľný bez prehliadača. Vývoj vedú agenti Claude Code, ktorí si musia vedieť výsledok sami overiť.

**Rozhodnutie:** TypeScript 5.x so `strict: true`; sim jadro je čistý TS v `src/sim/` bez DOM/Pixi/React importov, svet renderuje PixiJS v8 (WebGL/WebGPU) v `src/render/`, UI je React 18 s CSS custom properties z `design/tokens.css` v `src/ui/`. Build Vite, testy Vitest (unit + scenáre) a Playwright (smoke + screenshoty), desktopové balenie cez Tauri až vo fáze 13.

**Alternatívy:** Herný engine (napr. Godot) ako hlavná platforma: CLAUDE.md ho ponecháva len ako možný cieľ prenosu sim jadra, lebo webový stack umožňuje priamu reuse UI návrhov z Claude Design a samooverenie cez Vitest/Playwright. UI kreslené v Pixi by sťažilo dátovo bohaté panely a vlastné SVG grafy, svet kreslený cez DOM/SVG by zase neuniesol tisíce spritov s kamerou a zoomom.

**Dôsledky:** ESLint `no-restricted-imports` vynucuje, že `src/sim/` neimportuje `pixi.js`, `react`, `src/render`, `src/ui` ani `window`/`document`; prezentácia sim iba číta (`WorldSnapshot` + `SimEvent[]`) a posiela `Command`. Sim beží a testuje sa v Node a keďže je celý serializovateľný, dá sa neskôr presunúť do Web Workera (samostatné otvorené rozhodnutie). Zmena ktorejkoľvek vrstvy stacku vyžaduje nový ADR.

## ADR-002: Tick = 10 herných sekúnd, 10 tickov/s

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §3, §6; CLAUDE.md „Tvrdé pravidlá" 3

**Kontext:** Simulácia musí byť deterministická (fixný tick, jediný `Rng`, replay príkazov) a zároveň mať tycoon tempo, pri ktorom herný deň trvá minúty, nie hodiny. Trvania dejov (cyklus žeriavu, brána, státie lode) potrebujú spoločnú celočíselnú jednotku.

**Rozhodnutie:** Fixný tick s hodnotami v `data/defs/time.json`: `tickGameSeconds = 10` (1 tick = 10 herných sekúnd), `ticksPerRealSecond = 10` pri 1×, `speeds = [0, 1, 2, 4, 8]` (0 = pauza). Odvodené: 6 tickov = herná minúta, 360 = hodina, 8 640 = deň, 259 200 = mesiac (30 dní); herný deň ≈ 14,4 min reálneho času pri 1× a 3,6 min pri 4×.

**Alternatívy:** Premenlivý `dt` by porušil determinizmus a replay (v `src/sim/` sú zakázané `Date.now` aj `performance.now`). Jemnejší tick by násobil počet tickov na herný deň, hrubší by zrnil krátke deje ako 2-minútový cyklus žeriavu (`cycleTicks 12`) či 3-minútové odbavenie na bráne (`processTicks 18`).

**Dôsledky:** Všetky trvania v defoch sú v tickoch, nie v sekundách (napr. `berthAllowanceTicks 17 280` = 2 dni) a `SimClock` emituje `HourClosed`/`DayClosed`/`MonthClosed`. `GameLoop` v `src/app` používa akumulátor `dt` s limitom 64 tickov/frame proti spirále smrti a render interpoluje polohy cez `alpha = acc / tickDuration`. Pri 8× beží 80 tickov/s, čo určuje výkonový rozpočet ticku (presun simu do Web Workera pri ticku > 8 ms je otvorené rozhodnutie).

## ADR-003: Sypké/tekuté komodity diskretizované do `CargoUnit` batchov

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §4.1, §5.3, §7.1, §7.7; CLAUDE.md „Tvrdé pravidlá" 2

**Kontext:** Princíp „nič sa neteleportuje" vyžaduje, aby každá jednotka nákladu mala práve jednu fyzickú polohu vedenú v `CargoLedger`, no sypké, tekuté a plynné komodity sa merajú v tonách a m³. Sledovať každú tonu či m³ ako samostatnú entitu by znamenalo milióny entít.

**Rozhodnutie:** Každá komodita sa diskretizuje do `CargoUnit` s `quantity = unitsPerBatch` z `cargo_types.json` (kontajner = 1 TEU, sypké = 25 t; kapacity v §5.3 zodpovedajú 25 m³ na batch aj pre tekuté a plynné). Jedna `CargoUnit` = jeden úchop žeriavu = jedna dávka pre vozidlo a kapacity lodí, skladov aj vozidiel sa udávajú v `CargoUnit`.

**Alternatívy:** Kontinuálne množstvá (číslo s pohyblivou čiarkou na module či vozidle) by nedali jednotke jednoznačnú polohu a obišli by `CargoLedger.move`, a tým aj invariant konzervácie. Entitu na každú tonu/m³ vylučuje §4.1 („bez miliónov entít").

**Dôsledky:** `CargoLedger.move` a `assertCargoConservation` fungujú rovnako pre všetky kategórie a nová komodita je nový def + trieda (§17), nie nový mechanizmus sledovania. Prietoky v `CargoUnit`/tick (`flowUnitsPerTick` pri armoch, §5.3) sa týkajú tých istých jednotiek (`in_pipeline`, §7.1); ako sa zlomkový prietok premietne na celé jednotky, zatiaľ nie je určené.

## ADR-004: Vnútorný pohyb v moduloch abstrahovaný na `internalTicks`

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §4.2, §7.3

**Kontext:** Vozidlá sa po prístave pohybujú A* po cestách, ale moduly (dvory, silá, rampy) majú vlastnú vnútornú plochu so slotmi. Modelovať jazdu vnútri každého modulu by znamenalo ďalšiu úroveň navigácie pod sieťou ciest.

**Rozhodnutie:** Vozidlá vchádzajú do modulu a vychádzajú z neho výlučne cez bunky konektorov (`ModuleDef.connectors`); pri vstupe do konektora je vozidlo „vnútri", čaká `internalTicks` (`params.internalTicks`, default 6 = 1 herná minúta) a vykoná load/unload. Vnútorný pohyb sa nemodeluje, ide o zámernú abstrakciu.

**Alternatívy:** Navigácia po bunkách vnútri footprintu až k slotu by vyžadovala vnútorné cesty modulov, pathfinding pri každom jobe a riešenie zápch vo vnútri modulov. GDD požaduje zloženie na konkrétny slot, čo pokrýva logická lokácia `in_storage { moduleId, slot }` aj bez vnútornej trasy.

**Dôsledky:** Vehicle FSM (fáza 3) má pri konektore stav čakania na `internalTicks`, po ktorom prebehne `CargoLedger.move` (napr. `in_vehicle → in_storage { moduleId, slot }`); poloha vozidla počas čakania zostáva na bunke konektora. Default `internalTicks` patrí podľa pravidla 4 do defu a schémy, nie do kódu.

## ADR-005: Soft kongescia namiesto kolízií

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §7.5, §7.6, §7.8, §11; CLAUDE.md „Čo NEROBIŤ"

**Kontext:** GDD chce heatmapy dopravných zápch a tlak na optimalizáciu bottleneckov, no fyzické kolízie a vzájomné čakanie vozidiel na bunkách otvárajú riziko gridlocku a deadlockov (§7.8). CLAUDE.md fyzikálne kolízie vozidiel výslovne vylučuje.

**Rozhodnutie:** Vozidlá sa navzájom neblokujú; každý tick, kým vozidlo stojí na bunke, `cell.traffic += 1` a pri `HourClosed` `traffic *= 0.9`. Rýchlosť na bunke je `speed / (1 + 0.25 × max(0, vehiclesOnCell − 1))` a A* pridáva k cene bunky `congestionPenalty = clamp(traffic / 200, 0, 3)`.

**Alternatívy:** Fyzické kolízie alebo rezervácie buniek (jedno vozidlo na bunku) by umožnili vzájomné zablokovanie vozidiel a vyžadovali by riešenie deadlockov; CLAUDE.md ich vylučuje. Úplné ignorovanie zápch by neposkytlo dáta pre heatmapu ani tlak na lepšiu cestnú sieť.

**Dôsledky:** Invariant §7.8 bod 2 (vozidlo nikdy nečaká na inú entitu na bunke) platí vždy a fronta kamiónov pred bránou je virtuálna mimo mapy (§7.5), takže gridlock nevznikne. Heatmapa v UI = normalizované `traffic` (`Float32Array` 0..1, §11) a konštanty 0.9 / 0.25 / 200 / 3 patria podľa pravidla 4 do defov. `traffic++` prichádza vo fáze 3, spomalenie a `congestionPenalty` v A* vo fáze 11.

## ADR-006: Cesty/koľaje ako vrstva bunky, nie moduly

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §5.1, §5.3, §8, §12.2

**Kontext:** Cesty a koľaje sú lineárna infraštruktúra, ktorú hráč kreslí po bunkách a nad ktorou beží A* a autotile. Na rozdiel od modulov nemajú footprint, konektory ani parametre ako kapacita či cyklus.

**Rozhodnutie:** Doprava je vrstva na bunke `Cell.road: 'none' | 'road' | 'rail'`, stavaná príkazmi `PlaceRoad`/`PlaceRail` (a `RemoveRoad`/`RemoveRail`) s cenou za bunku 2k / 6k a nulovou údržbou; nesmie ležať na vode ani cez footprint modulu. Cesta a koľaj sa v MVP nekrižujú (level crossing = backlog) a potrubie (`kind: 'pipeline'`) zostáva modulom (§4.2).

**Alternatívy:** Cesta ako modul 1×1 s vlastným `ModuleDef` by pre každú bunku vytvárala entitu a zaťažila `ModuleRegistry`, validáciu umiestnenia aj konektory. Vrstva v bunke je lacná na pamäť a pathfinding ju číta priamo (`road === 'road'`).

**Dôsledky:** Jedno pole `road` na bunku znamená, že cesta a koľaj nemôžu byť na tej istej bunke; `PlaceModule.validate` vyžaduje `road === 'none'` na celom footprinte a konektory modulov sa pripájajú k susedným bunkám `road`. Zmena vrstvy emituje `RoadChanged`, ktorý invaliduje `PathCache` aj maticu vzdialeností konektorov; render ju kreslí v `RoadLayer` s autotile a ledger ju účtuje v kategórii `road_capex`.

## ADR-007: Trojvrstvová hranica `src/sim`

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §2; CLAUDE.md „Tvrdé pravidlá" 1, 3; karty T00-15, T00-17, T00-18

**Kontext:** ARCHITECTURE §2 a ADR-001 vynucovali hranicu sim/prezentácia len ESLint pravidlom `no-restricted-imports`, ktoré nechytí DOM/Node globály, nedeterministické API ani ich obchvaty (alias `const m = Math`, `eval`, `declare const fetch`, inline `eslint-disable`, `@ts-expect-error`). Reviewy T00-15 a T00-17 takéto úniky potvrdili sondami.

**Rozhodnutie:** Hranicu tvoria tri vrstvy: (1) kompilátor — `src/sim/tsconfig.json` s `lib: ["ES2023"]`, `types: []`, `noUncheckedSideEffectImports` a aliasmi len `@sim/*` a `@data/*`, spúšťaný v `pnpm typecheck`; (2) `eslint.config.js` pre `src/sim/**/*.ts` — allowlist importov (`@sim/…`, `@data/…` a relatívne cesty, ktoré neopustia `src/sim`, najviac 5× `../`, vzdialenejšie ciele cez `@sim/…`), zakázané globály (DOM, Node, časovače, `eval`/`Function`, `Intl`, `WeakRef`, `SharedArrayBuffer`, `fetch`, …), `Math.random`/`Date.now`/`performance.now`/locale API, aliasy `Math`/`Date`, `globalThis`, `.constructor`, dynamický `import()`, ambientné `declare`, triple-slash direktívy, `linterOptions.noInlineConfig` a zákaz `@ts-expect-error`/`@ts-ignore`/`@ts-nocheck`; (3) test, že `src/sim/**` obsahuje len súbory `.ts` (okrem `tsconfig.json`), lebo iné prípony by ESLint globy obišli.

**Alternatívy:** Len `no-restricted-imports` (pôvodný text §2) nechal globály aj obchvaty nedeterminizmu nestrážené a samotný kompilátor nechytí API, ktoré ES2023 lib pozná (`Math.random`, `Date.now`, `Intl`). Type-aware ESLint (`projectService`) by nefungoval pre `--stdin` sondy nad súbormi, ktoré na disku neexistujú (BACKLOG P2, F6).

**Dôsledky:** Regresné testy `tests/tools/sim-tsconfig.test.ts` (vrstva 1: konfigurácia + `tsc --noEmit -p` nad dočasnou fixtúrou s `window`, `fetch`, `node:fs`) a `tests/tools/sim-boundary.test.ts` (vrstva 2 cez ESLint Node API s tabuľkami `VIOLATIONS`/`ALLOWED`, vrstva 3 detektor prípon) musia ostať zelené a každý nový obchvat sa pridáva ako sonda. Hranica chytá neúmyselné porušenia, nie zámerné obchádzanie — známe zvyšky (`Math[k]` s premenným kľúčom, `x['constructor']`, destrukturovanie `constructor`, `toLocaleUpperCase`) a falošné poplachy (`this.constructor`, `{ Math: 1 }`, import `'./'`) sú v BACKLOG P2. Spresňuje ADR-001 a ARCHITECTURE §2; text pravidla 1 v CLAUDE.md treba zosúladiť mimo tohto ADR.

## ADR-008: Cesty/koľaje aj na verejných bunkách, moduly len na vlastnej/prenajatej parcele

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §4.2, §5.1, §5.2, §8; ADR-006; BACKLOG P1 (T00-05)

**Kontext:** §4.2 pripúšťal `requiresParcelOwnership = false` „pre cesty na verejných bunkách", hoci podľa ADR-006 cesty nie sú moduly, a §5.2 dovoľoval stavať len na vlastnej/prenajatej parcele. Nebolo teda určené, či `PlaceRoad`/`PlaceRail` smie stavať na bunky bez parcely (`parcelId === null`).

**Rozhodnutie:** `PlaceRoad`/`PlaceRail` sú povolené na bunkách parcely s `ownership: 'owned' | 'leased'` a na verejných bunkách (`parcelId === null`), zakázané na parcele s `ownership: 'none'` (na predaj). Moduly vždy vyžadujú vlastnú/prenajatú parcelu pre celý footprint, `requiresParcelOwnership` je `true` pre všetky moduly (cesty nie sú moduly, ADR-006).

**Alternatívy:** Cesty len na vlastnej/prenajatej parcele by nútili kupovať parcely iba kvôli prepojeniu so vstupmi na mapu (`roadPortals`/`railPortals`, §4.7). Cesty kdekoľvek, aj na parcelách na predaj, by obchádzali ekonomiku parciel (§5.2) a zaberali bunky, ktoré hráč ešte nevlastní.

**Dôsledky:** `PlaceRoad`/`PlaceRail.validate` kontroluje pre každú bunku `parcelId === null || ownership !== 'none'` popri pravidlách ADR-006 (nie voda, nie footprint modulu); F1 test „`PlaceRoad` odmietne cudziu parcelu" zodpovedá parcele s `ownership: 'none'`. §8 bod 2 platí pre všetky moduly bez výnimky. Čo sa stane s cestami na prenajatej parcele pri `ReleaseParcel`, tento ADR neurčuje.

## ADR-009: Konfiguračné vs katalógové defy

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §3, §4, §4.6; BACKLOG P1 (T00-12)

**Kontext:** §4 predpisoval každému `data/defs/*.json` `schemaVersion` a pole položiek s `id`, no `time.json` a `economy.json` z F0 sú jeden objekt parametrov bez `items[]` (T00-12). Ďalšie defy potrebujú jednoznačný tvar pre JSON schému aj `DefRegistry`.

**Rozhodnutie:** Konfiguračné defy (`time`, `economy`, budúce `infrastructure` a `logistics`) sú jeden objekt `{ schemaVersion, …parametre }`. Katalógové defy (`cargo_types`, `modules`, `ships`, `vehicles`, `tech_tree`, `contract_templates`, …) majú tvar `{ schemaVersion, items: [...] }`, kde každá položka má `id` v snake_case.

**Alternatívy:** Všetko ako katalóg by pre globálne parametre vyžadovalo umelé `items: [{ id: 'default', … }]`. Katalóg ako mapa `{ [id]: def }` by držal `id` mimo položky, takže typované rozhrania z §4.1–§4.5 (s poľom `id`) by nezodpovedali JSON-u.

**Dôsledky:** `DefRegistry` validuje konfiguračný def ako objekt s pevnou sadou kľúčov (stav F0) a katalóg ako pole položiek s `id`, podľa ktorého poskytuje typované gettery; rozhrania v §4.1–§4.5 opisujú jednu položku katalógu. Každý nový def sa pri vzniku zaradí do jednej z dvoch skupín a jeho schéma v `data/schemas/` tomu zodpovedá.

## ADR-010: Domov konštánt bez defu — `infrastructure.json` a `logistics.json`

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §4.6, §5.1, §5.3, §7.3, §7.6; CLAUDE.md „Tvrdé pravidlá" 4; ADR-004, ADR-005, ADR-006; BACKLOG P1 (T00-05)

**Kontext:** Pravidlo 4 zakazuje magické čísla, no cena cesty/koľaje (2k / 6k za bunku, §5.3), default `internalTicks` 6 (§7.3) a konštanty kongescie 0.9 / 0.25 / 200 / 3 (§7.6) nemali žiadny def. ADR-004 až ADR-006 len konštatovali, že patria do defov.

**Rozhodnutie:** Konfiguračný def (ADR-009) `data/defs/infrastructure.json` má kľúče `road` a `rail`, každý s `costPerCellCents` (200 000 / 600 000) a `maintenancePerDayCents` (0 / 0). Konfiguračný def `data/defs/logistics.json` má `defaultInternalTicks` 6 (modul ho môže prepísať `params.internalTicks`) a objekt `congestion` s `trafficDecayPerHour` 0.9, `slowdownPerExtraVehicle` 0.25, `penaltyTrafficDivisor` 200 a `penaltyMax` 3.

**Alternatívy:** Konštanty v kóde porušujú pravidlo 4 a pseudo-moduly ciest v `modules.json` vylučuje ADR-006. Pridanie do `economy.json`/`time.json` by miešalo stavebné ceny a logistiku s parametrami kontraktov, financií a času.

**Dôsledky:** Súbory, schémy v `data/schemas/` a gettery v `DefRegistry` vzniknú až vo fáze, ktorá ich použije: `infrastructure` vo F1 (`PlaceRoad`, `road_capex`), `logistics` vo F3 (Vehicle FSM, `internalTicks`) a hodnoty `congestion` sa použijú vo F3/F11 (ADR-005). Dovtedy sú hodnoty záväzné len v ARCHITECTURE §4.6 a kód na ne nesmie siahať ako na konštanty.

## ADR-011: Pobyt vozidla pri konektore = `internalTicks` + load/unload za jednotku

Stav: prijaté (F0) · Zdroj: ARCHITECTURE §4.4, §7.1, §7.3; ADR-004; BACKLOG P1 (T00-05)

**Kontext:** §7.3 (ADR-004) dáva vozidlu pri konektore čakanie `internalTicks` modulu a §4.4 zároveň `loadTicks`/`unloadTicks` vozidla (3 / 3), no nebolo určené, či sa sčítavajú, alebo platí len jedno z nich. Vehicle FSM (F3) potrebuje jednoznačné trvanie pobytu a okamih `CargoLedger.move`.

**Rozhodnutie:** Pobyt pri konektore je sekvenčný: najprv `internalTicks` modulu (vnútorný presun, ADR-004), potom za každú nakladanú/vykladanú jednotku `loadTicks`/`unloadTicks` vozidla (manipulácia), spolu `internalTicks + k × loadTicks` (resp. `unloadTicks`) pre `k` jednotiek. `CargoLedger.move` jednotky nastane až po dokončení jej load/unload, nie hromadne po `internalTicks`.

**Alternatívy:** Len `internalTicks` s manipuláciou v ňom by zneplatnilo `loadTicks`/`unloadTicks` a rozdiely medzi vozidlami. Súbežná manipulácia viacerých jednotiek alebo `max(internalTicks, …)` by zvýhodnili vozidlá s väčšou kapacitou (AGV 2) bez času na manipuláciu a hromadný presun by ukazoval jednotky vo vozidle ešte pred dokončením nakládky.

**Dôsledky:** Vehicle FSM (F3) po `internalTicks` vykoná `k` sekvenčných krokov load/unload a po každom emituje `CargoMoved` (napr. `on_apron → in_vehicle`, `in_vehicle → in_storage`), takže každá jednotka má v každom ticku jednoznačnú polohu; `internalTicks` sa platí raz za návštevu modulu. Spresňuje dôsledok ADR-004 (presun nenastáva hneď po `internalTicks`). Platí pre interné vozidlá (§4.4); kamióny a vlaky nakladajú podľa `loadTicksPerUnit` rampy/stanice (§7.5).
