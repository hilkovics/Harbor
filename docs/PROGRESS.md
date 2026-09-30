# PROGRESS.md — Modular Harbor

Stav fáz a checklist medzi reláciami. Detail kariet: `docs/tasks/phase-NN.md`.

## Fáza 0 — Bootstrap
Karty: `docs/tasks/phase-00.md`

- [x] `pnpm create vite` (react-ts), `strict: true`, path aliasy `@sim/*`, `@render/*`, `@ui/*`, `@app/*`, `@data/*`.
- [x] Nainštalovať `pixi.js@8`, `vitest`, `@playwright/test`, `eslint` + `no-restricted-imports` pravidlo pre `src/sim/**` (zákaz `pixi.js`, `react`, `@render`, `@ui`, `window`, `document`).
- [x] Adresáre podľa `CLAUDE.md`; prázdne `index.ts` barrel súbory; `docs/DECISIONS.md` (ADR-001..006 z §18), `docs/BACKLOG.md`, `docs/PROGRESS.md`.
- [x] `data/defs/time.json`, `economy.json` + JSON schémy + `tools/validate-defs.ts` (`ajv`).
- [x] `src/sim/core/rng.ts` (xoshiro128**, `range`, `pick`, `weighted`), `sim-clock.ts`, `entity-id.ts`, `event-bus.ts`, `ring-buffer.ts`.
- [x] `src/sim/defs/def-registry.ts` — typované načítanie všetkých defov, fail-fast.
- [x] `tools/simrun.ts` kostra (načíta mapu + scenár, `world.tick()` N×, vypíše JSON report).
- [x] `.claude/commands/{phase,delegate,review-sim,sim-check,adr,new-cargo,ui-from-design}.md` (šablóny nižšie), `.claude/settings.json` (`"model": "opusplan"`, permissions allowlist, hooky — presné znenie v AGENTIC_WORKFLOW §8).
- [x] `.claude/agents/{sim-architect,sim-reviewer,implementer,ui-builder,test-writer,test-runner,docs-keeper}.md` — obsah **doslova** z AGENTIC_WORKFLOW §7 (každý s explicitným `model:`). `balance-analyst` až vo F13.
- [x] `docs/tasks/` adresár + `docs/tasks/_template.md` (formát task karty z AGENTIC_WORKFLOW §3); prvá reálna sada kariet vznikne až vo F1.
- [x] Playwright config so screenshotom `tests/e2e/__screenshots__/boot.png`.

Akceptácia: `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs` zelené; `pnpm test:e2e` uloží screenshot prázdnej stránky s textom „Modular Harbor"; Rng test: rovnaký seed → rovnaká sekvencia 1 000 čísel.

Stav: **hotová** · vetva `claude/laughing-galileo-2ctnlq`
- typecheck, lint, test (205 testov), validate:defs, simrun smoke (lostUnits 0), test:e2e — zelené (T00-13)
- sim-reviewer: MERGE, 0 blocking, 2 major + 10 minor → BACKLOG (T00-12)
- boot.png prezretý orchestrátorom
- Odchýlky od plánu: simrun používa `data/scenarios/smoke.json` namiesto `vertical_slice` (vznikne vo F5); `World` je zatiaľ stub v tools/simrun.ts (F1).
- Dodatočné karty z review (T00-15 až T00-18): hranica src/sim je trojvrstvová (sim tsconfig bez DOM/Node, ESLint allowlist + zákazy obchvatov vrátane inline `eslint-disable` a `@ts-expect-error`, len `.ts`), `tickGameSeconds` len delitele 60 (schéma = DefRegistry = SimClock). Pipeline zelená, 500 testov.
- Rozhodnutia pred F1 (T00-19, delegované používateľom): ADR-007 trojvrstvová hranica src/sim, ADR-008 cesty/koľaje aj na verejných bunkách, ADR-009 konfiguračné vs katalógové defy, ADR-010 `infrastructure.json` + `logistics.json`, ADR-011 pobyt vozidla = internalTicks + load/unload za jednotku. Overené proti GDD (bez rozporu).

## Fáza 1 — Grid, mapa, kamera, príkazy, cesty
Karty: `docs/tasks/phase-01.md` · vetva `phase/01-grid-roads` (stacked nad PR #1)

- [x] `Grid`, `Cell`, `TerrainType`, `MapDef` loader (`data/maps/harbor_01.json`, 96×64, pobrežie na severe, 3 parcely, 1 road portal, 1 rail portal, sea lane, anchorage).
- [x] `Command` infra: `CommandQueue`, `ValidationResult`, `PlaceRoadCommand`, `RemoveRoadCommand` (cena, terén, parcela, footprint).
- [x] `World` s `tick()` obsahujúcim kroky 1, 13 (§6) a `serialize/deserialize` kostru.
- [x] `SimBridge` (snapshot + events), `GameLoop` (fixed tick, speed, max 64 tickov/frame).
- [x] Render: `WorldRenderer`, `TerrainLayer` (dočasné farebné tiles podľa DESIGN_BRIEF paliety), `RoadLayer` s autotile podľa 4 susedov, `Camera`.
- [x] `InputController`: pan (drag/WASD), zoom (wheel, pivot pod kurzorom), build mode „cesta" (drag-paint), `Esc`.
- [x] UI: `TopHUD` (cash placeholder, tick/čas, speed tlačidlá, pauza).

Akceptácia: screenshot ukazuje pobrežie + nakreslenú cestu; `SetGameSpeed(4)` zrýchli hodiny v HUD.

### Stav
Stav: **hotová** (T01-01..T01-17). Plná pipeline T01-14 zelená: typecheck, lint, 1797 vitest testov, validate:defs, build, `simrun f1_roads --ticks 20000` (cashEnd 108 300 000 ¢, 85 buniek cesty, lostUnits 0), e2e `boot.png` + `f1-road.png` (orchestrátor screenshot prezrel: pobrežie, nábrežie, obrysy parciel, nakreslená cesta, HUD $1,180,000).
- Review T01-13 (sim-reviewer): MERGE, 0 blocking, 0 major, 11 minor → BACKLOG / ADR-013 (T01-17).
- Rozhodnutia: ADR-012 (refundácia ciest → kategória `road_sale`), ADR-013 (zosúladenie ARCHITECTURE s implementáciou: `maxTicksPerFrame`, `removalRefundRate`, `ValidationResult.costCents`, `deserialize(defs, map, state)`, `applyPending`, poradie udalostí v ticku).
- Odchýlky od plánu: TerrainLayer a RoadLayer používajú namiesto dočasných farebných tiles rovno sprity z Claude Design (T01-16, `assets/manifest.json`), farebné kreslenie ostáva ako fallback; pridané obrysy parciel a portály (len vizuál); `simrun` beží nad `f1_roads.json` namiesto `vertical_slice` (vznikne vo F5); úvodná kamera zameraná na pobrežie.

## Fáza 2 — Root modul, loď, žeriav, apron
Karty: `docs/tasks/phase-02.md` · vetva `phase/02-berth-ship-crane` (stacked nad hilkovics/Harbor#2)

- [x] `cargo_types.json` (`container_teu`), `modules.json` (`berth_standard`, `crane_container_gantry`), `ships.json` (`feeder`).
- [x] `Module` (abstract), `ModuleRegistry`, `BerthModule` + `BerthGroup` prepočet, `ApronBuffer`, `CraneModule` FSM (§7.2), `StatResolver` (bez modifikátorov zatiaľ).
- [x] `PlaceModuleCommand` / `RemoveModuleCommand` s pravidlami §8 (1–4, 7, 8); rotácia `R`; ghost s farbou validácie + zoznam dôvodov v tooltipe.
- [x] `CargoUnit`, `CargoLocation`, `CargoLedger` s tabuľkou povolených prechodov (§7.1) a `assertConservation`.
- [x] `Ship` FSM: `inbound → waiting_anchorage → berthing → docked → undocking → outbound → despawned`; pohyb po sea lane; `BerthAllocator`.
- [x] Debug príkaz `SpawnShipDebugCommand(shipClass, cargoType, units)` (len DEV) — kontrakty prídu vo F5.
- [x] Render: `ModuleView`, `ShipView` (rotácia podľa segmentu), `CraneView` (boom rotácia podľa fázy), `CargoSprite` na palube a na aprone; `BuildLayer` ghost + konektory.
- [x] UI: `BuildBar` (kategória Terminál: berth, crane), `ModuleInspector` (názov, stav, apron obsadenosť).

Akceptácia: v hre vidím loď doplávať, zakotviť, žeriav presúva kontajnery na quay; po vyložení odpláva.

### Stav
Stav: **hotová** (T02-01..T02-16). Plná pipeline T02-15 je zelená:
  - typecheck, lint, 3495 vitest testov (113 súborov), validate:defs (8 súborov vrátane `assets/manifest.json`), build;
  - `simrun f2_unload --ticks 5000`: 1 loď spawnutá aj odplávala, 4 TEU na aprone, 4 cykly žeriavu, lostUnits 0;
  - `simrun f1_roads --ticks 20000`: cashEnd 108 300 000 ¢, lostUnits 0;
  - e2e 9/9. Orchestrátor prezrel screenshoty `f2-docked.png`, `f2-departed.png` a `f2-inspector.png`: feeder pri Root kotvisku, výložník nad loďou, kontajnery na aprone, po odplávaní 4 TEU, inspector žeriavu s obrysom výberu.
- Review T02-13 (sim-reviewer): MERGE, 0 blocking, 1 major, 10 minor. Opravené v T02-14 boli major (odstránenie žeriavu pri lodi pri kotvisku) a 9 minor; zvyšok je v BACKLOG.
- Rozhodnutia:
  - ADR-014: moduly, kotviská, žeriav na bunkách berthu, WorldState v2 + migrate, exportované jednotky len počtom;
  - ADR-015: PlaceModule/RemoveModule, refund zo zaplatenej ceny v bázických bodoch, starter moduly zadarmo bez refundu;
  - ADR-016: lode po seaLane bez trigonometrie, alokácia kotvísk (úsek so žeriavom, hĺbka per berth), cyklus žeriavu s rezerváciou slotu, throttle `CraneBlocked`, krok 12 `assertInvariants`.
  - ARCHITECTURE je zosúladená s F1 + F2 (§3–§18).
- Odchýlky od plánu:
  - `ships.json` obsahuje aj `handy` (kvôli testu alokácie).
  - Scenár `f1_roads` obchádza Root kotvisko.
  - E2E beží sériovo (`workers: 1`), lebo test rýchlosti hodín pri súbehu so SwiftShader zlyhával.
  - Karty T02-10 a T02-12 robil jeden agent.
  - Dva commity T02-04 mali dočasne červené testy mimo rozsahu agenta; orchestrátor ich hneď opravil ďalším commitom.
  - Pridané navyše: `selection_ring` a blokovanie stavby kotviska loďou v páse vody.

## Fáza 3 — Vozidlá, pathfinding, dispatcher, sklad
Karty: `docs/tasks/phase-03.md` · vetva `phase/03-vehicles-yard` (stacked nad hilkovics/Harbor#3)

- [x] `vehicles.json` (`straddle_carrier`), `modules.json` (`container_yard_small`, `vehicle_depot`), konektory modulov.
- [x] `StorageModule` (abstract, `reserve/store/take`, fill %), `ContainerYard extends StorageModule`.
- [x] `VehicleDepot`, `BuyVehicleCommand`/`SellVehicleCommand` (vyžaduje voľné miesto v depe).
- [x] `Pathfinder` (A*, binárna halda, `Int32Array`, bez alokácií), `PathCache` s invalidáciou na `RoadChanged`, `DistanceMatrix` konektor↔konektor (lazy).
- [x] `TransportJob`, `Dispatcher` (§7.3 kroky 1 a 3), `StorageAllocator` (kompatibilita + najbližší), `Vehicle` FSM s `internalTicks` pri konektore, `traffic++`.
- [x] Render: `VehicleView` (interpolácia, rotácia podľa smeru, empty/loaded), `ModuleView` fill stavy 0/25/50/75/100 %.
- [x] UI: BuildBar kategórie Sklady/Logistika; `ModuleInspector` pre sklad (fill %, reserved, throughput) a depo (nákup vozidiel); notifikácia `NoStorageAvailable`, „modul nepripojený k ceste`.
- [x] Doplnok od používateľa: vozidlá v pravom pruhu, jazda po oblúku v zákrute, typy ciest dvojpruhová / jednopruhová / jednosmerná (BuildBar Landside, smer ťahom, prestavba).

Akceptácia: v hre vidím vozidlá jazdiť po cestách a dvor sa vizuálne zapĺňa.

### Stav
Stav: **hotová** (T03-01..T03-20).
- Plná pipeline T03-15 je zelená:
  - typecheck, lint, 5 213 vitest testov (172 súborov), validate:defs (10 súborov), build;
  - `simrun apron_to_yard --ticks 15000`: 120 TEU v dvoroch, všetko uložené v ticku 5 332, 2 vozidlá, vyťaženie vozidiel 34,2 %, lostUnits 0;
  - `f2_unload` a `f1_roads` bez zmeny (cashEnd 108 300 000 ¢);
  - e2e 19/19. Orchestrátor prezrel screenshoty `f3-vehicles.png`, `f3-yard-filled.png`, `f3-lanes.png`, `f3-road-kinds.png` a `f3-road-build.png`: vozidlá v pravom pruhu, dvor sa zapĺňa, tri typy ciest, šípky jednosmerky, oblúky v zákrutách.
- Review T03-13 (sim-reviewer): MERGE, 0 blocking, 1 major (šum progresu vozidla pri otočke → nenačítateľný save) a 12 minor. V T03-14 bol opravený major a väčšina minor nálezov, zvyšok ide do BACKLOG. Cena ticku v produkcii je 11–19 µs (20 vozidiel naplno), v DEV s krokom 12 zhruba 390 µs.
- Rozhodnutia:
  - ADR-017: sklad (rezervácie v module, obsadenie v ledgeri), pripojenie modulov, §8 bod 5;
  - ADR-018: dispatcher, alokátor, A*;
  - ADR-019: vozidlá (pohyb, pobyt v module, `no_path`, traffic, save);
  - ADR-020: typy ciest, pruhy ako prezentácia;
  - ADR-021: šum progresu, ceny ciest z PathCache, krok 12 bez alokácií.
  - ARCHITECTURE je zosúladená s F3.
- Odchýlky od plánu:
  - doplnok od používateľa (karty T03-17..T03-20);
  - karty T03-03 + T03-04 a T03-05 + T03-06 robil vždy jeden agent;
  - `testTimeout` testov je 15 s a kalendárne testy bežia bez invariantov;
  - ceny dvora a depa sú podľa ARCHITECTURE §5.3 (prototyp UI má iné);
  - úzke cesty sú zatiaľ procedurálne (sprity z Claude Design sú v BACKLOG s promptom).

## Fáza 4 — Export reťazec: brána, stojiská, rampa, kamióny
Karty: `docs/tasks/phase-04.md` · vetva `phase/04-export-trucks` (stacked nad hilkovics/Harbor#4)

- [x] `modules.json`: `truck_gate`, `truck_waiting_area`, `loading_ramp_container`; `trucks.json` (`truck_container`: capacity 1, speed 0.6).
- [x] `LandExportModule` (abstract), `TruckGate` (FIFO fronta, `processTicks`), `WaitingArea` (bays), `LoadingRamp` (docks, `at_ramp` sloty).
- [x] Validácia §8 bod 5 + „cesta portál → brána → rampa existuje" (prevádzkovosť rampy, ADR-022).
- [x] `Dispatcher` krok 2 (outbound joby `in_storage → at_ramp`) — zatiaľ pre všetky jednotky (kontrakty vo F5).
- [x] `TruckSpawner` + `Truck` FSM (§7.5), `RoadPortal` vstup/výstup, `CargoLedger` prechody `at_ramp → in_truck → exported`.
- [x] Render: `TruckView`, stojiská s obsadenosťou, fronta pred bránou ako číslo.
- [x] UI: inspector pre bránu (fronta, priepustnosť), rampu (docks), stojisko (bays).

Akceptácia: vidím kamióny prichádzať bránou, čakať, nakladať a odchádzať z mapy.

### Stav
Stav: **hotová** (T04-01..T04-14). Plná pipeline T04-13 je zelená:
  - typecheck, lint, 5 951 vitest testov (199 súborov), validate:defs (11 súborov), build;
  - `simrun full_import_chain --ticks 40000`: 120 TEU exportovaných v ticku 9 836, 120 kamiónov spawnutých aj odídených, najdlhšia fronta pred bránou 2, všetko uložené v ticku 3 644, lostUnits 0;
  - `apron_to_yard`, `f2_unload`, `f1_roads` bez regresie (cashEnd 108 300 000 ¢);
  - e2e 24/24;
  - orchestrátor prezrel screenshoty `f4-trucks-gate.png`, `f4-exported.png`, `f4-render-demo.png`, `f4-ui-demo.png` a sériu 15 záberov z bežiacej hry.
- Review T04-11 (sim-reviewer): MERGE, 0 blocking, 2 major a 9 minor. Nálezy:
  1. prevádzkovosť rampy neoverovala cestu späť — pri jednosmerke kamióny uviazli;
  2. kamión za bránou závisel od cesty pred bránou.

  T04-12 opravila oba majory aj minor nálezy: nový dôvod `no_return_path`, register pozemných modulov namiesto `instanceof`, krok 12 v O(n), `trucksProcessed` počíta len dokončené prechody, krížová kontrola kamión × rampa, validácia obnovy brány a kamióna. Zvyšok ide do BACKLOG.
- Rozhodnutia:
  - ADR-022: pozemné moduly, priechody, prevádzkovosť rampy namiesto validácie pri stavbe;
  - ADR-023: outbound joby, priorita inbound, zrušenie `open` jobu;
  - ADR-024: kamióny, zdieľaný `Carrier`, brána, stojisko, spawner, export, WorldState v4 + dodatok po review;
  - ARCHITECTURE je zosúladená s F4.
- Odchýlky od plánu:
  - rampa je neplatná prevádzkovo, nie pri stavbe (ADR-022);
  - brána púšťa 1 kamión za `processTicks + internalTicks`;
  - spätný priechod stojiskom je okamžitý;
  - fronta sa kreslí pri vstupe brány, nie pri portáli;
  - T04-08 bola rozdelená na časti A a B;
  - reštart kontajnera prerušil T04-08B a T04-11 — práca bola obnovená z patchu, resp. spustená znova;
  - ADR kamiónov má číslo 024, lebo T04-03 potrebovala vlastné ADR-023;
  - PR hilkovics/Harbor#5 založil používateľ proti `main`, obsahuje fázy 0–4.
