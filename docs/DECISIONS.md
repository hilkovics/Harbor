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
