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

## Fáza 5 — Kontrakty, ledger, HUD → VERTICAL SLICE (M1)
Karty: `docs/tasks/phase-05.md` · vetva `phase/05-contracts-vertical-slice` (stacked nad hilkovics/Harbor#5)

- [x] `contract_templates.json` (3 šablóny container), `economy.json` hodnoty.
- [x] `Contract` FSM (§9.1), `ContractSystem` (pool denne, expiry, spawn lode pri prijatí, SLA, demurrage, late penalty, fail, completion payout, XP).
- [x] `Economy` + `Ledger` (kategórie, `DaySummary`), `MoneyChanged`, `PenaltyApplied`; CAPEX pri stavaní, `module_sale` pri odstránení.
- [x] Odstrániť debug spawn; `AcceptContractCommand`, `DeclineContractCommand`.
- [x] Dispatcher krok 2 filtruje jednotky podľa kontraktu v stave `exporting`, prioritizuje podľa SLA.
- [x] UI: `ContractsPanel`, `TopHUD` skutočný cash + dnešná delta + XP, `Toasts` pre eventy, `GameOver` modal.
- [x] `data/scenarios/vertical_slice.json` + golden report v `tests/sim/__golden__/`.

### Stav
Stav: **hotová (T05-01..T05-13), míľnik M1 splnený**. Novú hru možno odohrať od prijatia kontraktu v UI po výplatu bez debug príkazov.

**Pipeline T05-12 je zelená:**
- typecheck, lint, 6 540 testov (234 súborov), validate:defs, build.
- `simrun vertical_slice --ticks 60000`: kontrakt 78 TEU dokončený včas v ticku 15 011, `cashEnd` 40 617 000 ¢, tržba 4 563 000 ¢, penalizácie 0, údržba 1 980 000 ¢, mzdy 366 000 ¢, XP 78, `lostUnits` 0. Zhoda s golden `tests/sim/__golden__/vertical_slice.json`.
- Regresia bez chýb s novými hodnotami podľa ADR-025 (údržba a mzdy): `full_import_chain` 31 964 000, `apron_to_yard` 64 254 000, `f1_roads` 107 830 000.
- Plná e2e sada zelená (raz za fázu, úsporný režim). E2E M1 `f5-vertical-slice` prijme kontrakt cez UI a dôjde po výplatu (+$8,483, +13 XP) za približne 3 min.
- Orchestrátor prezrel screenshoty `f5-ui-demo-stage.png` a `f5-payout.png`.

**Review T05-10:** MERGE, 0 blocking, 3 major, 5 minor. Hlavný nález bol deadlock: kontrakt s objemom nad kapacitu skladu sa nemohol dokončiť. T05-11 ho opravila exportom počas vykládky a poistkou objemu ponuky (dodatok ADR-027). Ďalej opravila alokáciu v kroku 2, dispatcher, mŕtvu vetvu a konštanty. T05-08 dokončila metriky.

**Rozhodnutia:** ADR-025 (Economy, Ledger, údržba a mzdy, bankrot, v5), ADR-026 (kontrakty: FSM, vlastné id, pool, loď, penalizácie, výplata), ADR-027 (dispatcher podľa kontraktu, `failed` exportovateľné, centrálne `game_over`, dodatok). ARCHITECTURE je zosúladená.

**Odchýlky:**
- T05-06 (UI) sa robila v predstihu už počas F4;
- kontrakty majú vlastnú postupnosť id;
- ponuky expirujú pri dennej obnove;
- uskladnené jednotky kontraktu idú na rampu už počas vykládky;
- plná e2e beží raz za fázu (úsporný režim na žiadosť používateľa);
- PR hilkovics/Harbor#6 založil používateľ proti `claude/laughing-galileo-2ctnlq`.

## Fáza 5b — Spätná väzba z hrania
Karty: `docs/tasks/phase-05b.md` · vetva `phase/05b-playtest-feedback` (stacked nad hilkovics/Harbor#6)

Stav: **hotová** (T5B-01, T5B-02, T5B-03, T5B-04, T5B-04b, T5B-05, T5B-06, T5B-07)

**Výsledky:**
- review sim-reviewer: MERGE (0 blocking, 4 major opravené v T5B-04b)
- `pnpm test`: 248 súborov, 6784 testov zelených
- `pnpm test:e2e`: 34/34
- `simrun vertical_slice`: cashEnd 41 790 000, exportedUnits 78, lostUnits 0, onTimeRate 1, craneBlockedPct 3,8 %
- `simrun full_import_chain`: ticksToAllExported zlepšené z 9836 → 8166, lostUnits 0
- Zmeny: `data/maps/harbor_01.json` (viac móla a apronových slotov), `data/defs/modules.json` (balans veľkostí depa), `src/render/` (napojenie ciest na konektory, mierka vozidiel, manéver kamióna na rampe), `src/sim/ships/` (trasy lodí bez prekryvu), validácia trás lodí pri obnove (ADR-029)
- Hrateľná verzia zverejnená (artefakt „Fáza 5b")

Ďalej: **Fáza 6 — Save/Load, čas, nastavenia, stabilizácia**

## Fáza 6 — Save/Load, čas, nastavenia, stabilizácia
Karty: `docs/tasks/phase-06.md` · vetva `phase/06-save-load` (stacked nad hilkovics/Harbor#7)

Stav: **hotová** (T06-01, T06-02, T06-03, T06-04, T06-03b, T06-05, T06-06, T06-07, T06-08, T06-08b, T06-09, T06-09b, T06-10)

**Výsledky:**
- review sim-reviewer: MERGE (0 blocking; 1 major + 4 minor opravené v T06-08b)
- `pnpm test`: 274 súborov, 7300 testov
- `pnpm test:e2e`: 37/37 (9,4 min)
- `simrun vertical_slice`: 30 000 tickov — cashEnd 41 790 000, exportedUnits 78, lostUnits 0, stateHash 76d0cfba (zhodný s `--roundtrip-at 9000`)
- `simrun stress_f6`: exportedUnits 658, lostUnits 0
- `pnpm bench`: vertical_slice priemer 0,08 ms / p95 0,18 ms, stress_f6 (bez invariantov) 0,03 ms — cieľ < 2 ms splnený
- Zmeny: `src/app/save/**` (encode/decode, sloty, autosave, export/import), `src/sim/world/state-hash.ts` (FNV-1a hash na overu roundtripu), Settings úložisko v localStorage, UI panely Save/Load a Settings, `tools/bench.ts` s scenárom `stress_f6`, roundtrip test uprostred tokov, P1 bugy (dosiahnuteľnosť kotviska, validácia pri obnove, refill poolu), optimalizácia hot path
- Čo hráč dostal: 3 sloty na uloženie, automatické uloženie, export/import súboru, Ctrl+S rýchle uloženie do slotu 1, Nastavenia (predvolená rýchlosť a interval autosave), kontrakt sa nedá prijať, ak prístav nemá potrebný žeriav a dosiahnuteľné kotvisko, hra sa zastaví po načítaní savu
- ADR-030 (SaveGame v1 obálka v app), ADR-031 (P1 opravy, pripravenosť prístavu)

Ďalej: **Fáza 6a — Export a booking**

## Fáza 6a — Export a booking
Karty: `docs/tasks/phase-06a.md` · vetva `phase/06a-export-booking` (stacked nad hilkovics/Harbor#8)

Stav: **hotová** (T6A-01 … T6A-09b, T6A-10, T6A-10a, T6A-10b, T6A-11)

**Výsledky:**
- review sim-reviewer: MERGE po opravách T6A-09b (FIX FIRST: 1 blocking, 3 major, minor 5–9 opravené)
- `pnpm test`: 315 súborov, 7996 testov zelených
- `export_roundtrip` (40 000 tickov): lostUnits 0, shipped 35, exported 58, rolled 1, vgmHolds 4, dualCycleRate 5,75 %, stowageOrderViolations 0, oba kontrakty `completed`, hash 8f8bbdaf (zhodný s `--roundtrip-at 28000`)
- `vertical_slice` (30 000 tickov): cash 41 790 000, exported 78, lostUnits 0, hash c8a8fb43
- `stress_f6`: lostUnits 0
- `pnpm bench`: vertical_slice priemer 0,09 ms / tick
- e2e: 42/43 → zlyhanie výberu modulu vyriešené v T6A-10b (príčina: prerušený `locator.click` v Playwrighte nechal v stránke zachytávač pointer udalostí; spoločný `tests/e2e/dismiss-toasts.ts`, f2-ship-crane 40/40 pri `--repeat-each=10`)
- Hrateľná verzia zverejnená (artefakt „Fáza 6a“)

**Čo je hotové:**
- Návrh: ADR-032 (voyage, kontrakt `kind`, štítky a `hold` jednotky, reverzný reťazec ledgera so `shipped`, lashing, dual transaction, WorldState v7 + migrácia v6 → v7), ADR-033 (odovzdávanie pod hákom)
- Defy exportu: `contract_templates` (export/roundtrip), `economy` (booking a penalizácie), `logistics.exportFlow`, `modules` (apron reserve, handoverMode), `ships` (lashing)
- Sim jadro: booking/voyage v ContractSystem, plán príchodov, delivery kamióny, brána (VGM hold, rolled), vykládka na rampe, prijatie do skladu zoskupene, nakládka v poradí stowage, dual cycling, lashing, dual transaction, uzavretie bookingu s pomernou výplatou a penalizáciami
- Odovzdávanie pod hákom (režim `under_hook`, buffer 0–1, dispatch vopred, metriky čakania)
- Render, UI a app: naložený kamión pri príchode, nakládka žeriava, náklad na palube; ContractsPanel s bookingom, inšpektor skladu a lode, toasty exportu
- TDD a tooling: scenáre `export_inbound` a `export_roundtrip` (golden), metriky `simrun` (shippedUnits, rolledUnits, vgmHolds, dualCycleRate, dualTransactionRate, …)
- Dokumentácia: ARCHITECTURE (§5, §6, §7.1–7.5, §7.8, §9.1, §12, §14, §16, §18), PORT_OPERATIONS §1 a §3

**Režimy odovzdávania:** `under_hook` (predvolený, ADR-033), `apron` (starý, pripnutý v legacy testoch); savy v1 … v6 sa načítajú a migrujú na v7.

PR hilkovics/Harbor#9.

Ďalej: **Fáza 6c — Prázdne kontajnery a tranship** (spolu so 6a míľnik M2)

## Fáza 6c — Prázdne kontajnery a tranship (M2)
Karty: `docs/tasks/phase-06c.md` · vetva `phase/06c-empties-tranship` (stacked nad hilkovics/Harbor#9)

Stav: **hotová** (T6C-01 … T6C-09, vrátane T6C-06a, T6C-06b a T6C-07b), **míľnik M2 „živý terminál“ splnený**

**Výsledky:**
- review sim-reviewer: MERGE (2 major + 5 minor opravené v T6C-07b, m3 do BACKLOG, m7 ponechané)
- `pnpm test`: 355 súborov, 8 630 testov zelených
- `pnpm test:e2e`: 48/48
- `simrun live_terminal` (60 000 tickov): lostUnits 0, exported 116, shipped 96, emptyReturns 68, emptyRepaired 11, repositioned 24, transhipLoaded 36, stateHash 271a07cc (zhodný s `--roundtrip-at 37000`)
- `pnpm bench`: live_terminal priemer 0,11 ms / tick (cieľ < 2 ms)
- Hrateľná verzia zverejnená (artefakt „Fáza 6c“); oprava buildu: Vite `assetsInlineLimit: 0` — `data:` URL SVG assetov blokovala CSP artefaktu

**Čo je hotové:**
- Návrh: ADR-034 (linky, smery `empty` / `tranship` a stav kvality jednotky, depo prázdnych, kontrola a M&R, empty handler, `EmptyFlow`, druhy kontraktu `empty_repositioning` a `tranship`, `WorldState` v8 + migrácia v7 → v8) a dodatky T6C-02, T6C-03, T6C-07b
- Defy: `lines.json` (3 linky), `empty_depot`, `empty_handler`, ekonomika návratov / opráv / repositioningu / prekládky, `logistics.emptyFlow`, šablóny, schémy a `validate:defs`
- Sim jadro: `lineId` bez `Rng`, návrat prázdnych z vnútrozemia (len s voľným miestom v depe), depo s kontrolou a M&R (ledger `maintenance_repair`), empty handler prednostne, výdaj prázdneho exportérovi (misia `collect`), repositioning (nakládka prázdnych po plných), tranship A → B (loď B, zmeškanie, záchrana, predaj), invarianty (`checkEmptyFlow`), obnova a migrácia v8
- Render, UI a app: sivé prázdne kontajnery a odznak poškodených, depo prázdnych, empty handler, farby liniek, karty repositioningu a prekládky, inšpektor depa (dostupné / poškodené / v oprave podľa linky), toasty (návrat prázdnych, oprava hotová, tranship zmeškaný)
- TDD a tooling: scenáre `empty_cycle` a `live_terminal` (golden, `--roundtrip-at`), metriky `simrun` (emptyReturns, emptyRepaired, repositionedUnits, transhipLoaded, …), e2e `f6c-live-terminal`
- Dokumentácia: ARCHITECTURE (§5, §6, §7.1, §7.3, §7.5, §9.1, §9.2, §12, §14, §16, §18), PORT_OPERATIONS §1 a §3

**Odchýlky od plánu:** `lineId` bez `Rng` (deterministicky podľa voyage); empty handler len def (bez triedy); tok prázdnych, repositioning a tranship sa ponúkajú len v prístave s depom prázdnych; výdaj exportérovi je misia `collect` s poverením (nie `pickup`); pripravenosť repositioningu = existuje depo; záchrana zmeškanej prekládky zjednodušená (prepíše sa voyage B, inak predaj po `transhipRescueDays`); T6C-06 sa rozdelila na T6C-06a a T6C-06b a review T6C-07 si vyžiadalo opravy T6C-07b. Odložené nálezy z review sú v BACKLOG „Z Fázy 6c“.

Ďalej: **Fáza 6d — spätná väzba z hrania 2** (mesto a časové okná kamiónov, odovzdávanie priamo na vozidlo pod hákom, lode priamo na rejdu)
