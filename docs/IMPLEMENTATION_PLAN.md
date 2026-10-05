# IMPLEMENTATION_PLAN.md — Modular Harbor

> Fázovaný postup pre Claude Code. Každá fáza má cieľ, úlohy, akceptačné kritériá a „Definition of Done".
> Odkazy `§n` smerujú do `docs/ARCHITECTURE.md`. Odhady sú v „session-dňoch" (SD) práce s Claude Code.

## Ako viesť projekt s Claude Code

1. **Jedna fáza = jedna vetva + jeden PR** (`phase/03-vehicles`). Začni `/phase N`, nechaj Claude navrhnúť plán v *plan mode*, schváľ, potom implementuj.
2. **Agentický režim (detail `docs/AGENTIC_WORKFLOW.md`):** hlavná relácia na `opusplan` je orchestrátor — rozloží fázu na **task karty** (`docs/tasks/phase-NN.md`, každá s modelom, agentom a akceptačnými príkazmi) a deleguje: Opus → plán, jadro simulácie, review; Sonnet → implementácia podľa návrhu; Haiku → beh testov a triáž, dokumentácia, boilerplate. Pod každou fázou nižšie je riadok **Model mix** s odporúčaným rozdelením; pri fázach 2, 3, 5, 12 zváž reláciu `claude --model opus`.
3. **Poradie v každej fáze:** defs (JSON + schéma) → sim + unit testy → scenárový test → render → UI → `simrun` + Playwright screenshot → ADR + checklist. Karty mimo `src/sim` bežia paralelne (worktree), karty v `src/sim` sériovo (single writer).
4. **Overovanie:** `pnpm test` po každom kroku; na konci fázy `/sim-check`. Vizuál Claude overí **sám** cez `pnpm test:e2e` (Read screenshot PNG). Keď niečo vidíš inak ako Claude, pošli mu svoj screenshot.
5. **Kontext:** pri ~50 % kontextu `/compact` so zhrnutím „čo je hotové, čo zostáva vo fáze". `docs/PROGRESS.md` drží odškrtnutý checklist medzi reláciami.
6. **Scope:** mimo-fázové nápady do `docs/BACKLOG.md`. Balans hodnôt sa nerieši do fázy 13 (len „dá sa to dohrať").
7. **Míľniky:** M1 Vertical slice (po F5–6) · M2 Ekonomika & progresia (F7–8) · M3 Všetky komodity + vlaky (F9–10) · M4 Analytika & polish (F11–13).

---

## Fáza 0 — Bootstrap (≈1 SD)
**Model mix:** hlavná relácia `sonnet` (mechanická práca), `docs-keeper` (haiku) na skeletony a agent súbory, `test-runner` (haiku) na overenie pipeline. Opus len na ADR-001..006 (`sim-architect`, jedna karta).
**Cieľ:** prázdny, ale plne funkčný repozitár s test/lint/build pipeline a Claude Code konfiguráciou.

Úlohy:
- [ ] `pnpm create vite` (react-ts), `strict: true`, path aliasy `@sim/*`, `@render/*`, `@ui/*`, `@app/*`, `@data/*`.
- [ ] Nainštalovať `pixi.js@8`, `vitest`, `@playwright/test`, `eslint` + `no-restricted-imports` pravidlo pre `src/sim/**` (zákaz `pixi.js`, `react`, `@render`, `@ui`, `window`, `document`).
- [ ] Adresáre podľa `CLAUDE.md`; prázdne `index.ts` barrel súbory; `docs/DECISIONS.md` (ADR-001..006 z §18), `docs/BACKLOG.md`, `docs/PROGRESS.md`.
- [ ] `data/defs/time.json`, `economy.json` + JSON schémy + `tools/validate-defs.ts` (`ajv`).
- [ ] `src/sim/core/rng.ts` (xoshiro128**, `range`, `pick`, `weighted`), `sim-clock.ts`, `entity-id.ts`, `event-bus.ts`, `ring-buffer.ts`.
- [ ] `src/sim/defs/def-registry.ts` — typované načítanie všetkých defov, fail-fast.
- [ ] `tools/simrun.ts` kostra (načíta mapu + scenár, `world.tick()` N×, vypíše JSON report).
- [ ] `.claude/commands/{phase,delegate,review-sim,sim-check,adr,new-cargo,ui-from-design}.md` (šablóny nižšie), `.claude/settings.json` (`"model": "opusplan"`, permissions allowlist, hooky — presné znenie v AGENTIC_WORKFLOW §8).
- [ ] `.claude/agents/{sim-architect,sim-reviewer,implementer,ui-builder,test-writer,test-runner,docs-keeper}.md` — obsah **doslova** z AGENTIC_WORKFLOW §7 (každý s explicitným `model:`). `balance-analyst` až vo F13.
- [ ] `docs/tasks/` adresár + `docs/tasks/_template.md` (formát task karty z AGENTIC_WORKFLOW §3); prvá reálna sada kariet vznikne až vo F1.
- [ ] Playwright config so screenshotom `tests/e2e/__screenshots__/boot.png`.

Akceptačné kritériá: `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs` zelené; `pnpm test:e2e` uloží screenshot prázdnej stránky s textom „Modular Harbor"; Rng test: rovnaký seed → rovnaká sekvencia 1 000 čísel.

---

## Fáza 1 — Grid, mapa, kamera, príkazy, cesty (≈1,5 SD)
**Model mix:** `opusplan` — Opus naplánuje Command infra a Grid; karty Grid/Command/World kostra → `sim-architect` (opus), render/kamera/HUD → `implementer` (sonnet, paralelne), testy rotácie/autotile → `test-runner` scaffold (haiku) z tabuľky.
**Cieľ:** vidím mapu s pobrežím, môžem panovať/zoomovať a stavať cesty s validáciou.

Úlohy:
- [ ] `Grid`, `Cell`, `TerrainType`, `MapDef` loader (`data/maps/harbor_01.json`, 96×64, pobrežie na severe, 3 parcely, 1 road portal, 1 rail portal, sea lane, anchorage).
- [ ] `Command` infra: `CommandQueue`, `ValidationResult`, `PlaceRoadCommand`, `RemoveRoadCommand` (cena, terén, parcela, footprint).
- [ ] `World` s `tick()` obsahujúcim kroky 1, 13 (§6) a `serialize/deserialize` kostru.
- [ ] `SimBridge` (snapshot + events), `GameLoop` (fixed tick, speed, max 64 tickov/frame).
- [ ] Render: `WorldRenderer`, `TerrainLayer` (dočasné farebné tiles podľa DESIGN_BRIEF paliety), `RoadLayer` s autotile podľa 4 susedov, `Camera`.
- [ ] `InputController`: pan (drag/WASD), zoom (wheel, pivot pod kurzorom), build mode „cesta" (drag-paint), `Esc`.
- [ ] UI: `TopHUD` (cash placeholder, tick/čas, speed tlačidlá, pauza).

Testy: rotácia footprintu 0/90/180/270; `PlaceRoad` odmietne vodu/obsadenú bunku/cudziu parcelu; autotile výber tvarov (unit test nad maskou susedov); GameLoop vykoná presne `n` tickov pri dt.
Akceptácia: screenshot ukazuje pobrežie + nakreslenú cestu; `SetGameSpeed(4)` zrýchli hodiny v HUD.

---

## Fáza 2 — Root modul, loď, žeriav, apron (≈2 SD)
**Model mix:** jadro fázy je Opus — `sim-architect` na BerthGroup, ApronBuffer, Crane FSM, CargoLedger prechody, Ship FSM (sériovo). Sonnet: defy, ModuleView/ShipView/CraneView, BuildBar, inspector (paralelne). Konzervačný test 5 000 tickov → `test-writer` (sonnet). Odporúčam spustiť reláciu `--model opus`.
**Cieľ:** loď pripláva, dokuje, žeriav vykladá kontajnery na apron. Iba kategória `container`, iba import.

Úlohy:
- [ ] `cargo_types.json` (`container_teu`), `modules.json` (`berth_standard`, `crane_container_gantry`), `ships.json` (`feeder`).
- [ ] `Module` (abstract), `ModuleRegistry`, `BerthModule` + `BerthGroup` prepočet, `ApronBuffer`, `CraneModule` FSM (§7.2), `StatResolver` (bez modifikátorov zatiaľ).
- [ ] `PlaceModuleCommand` / `RemoveModuleCommand` s pravidlami §8 (1–4, 7, 8); rotácia `R`; ghost s farbou validácie + zoznam dôvodov v tooltipe.
- [ ] `CargoUnit`, `CargoLocation`, `CargoLedger` s tabuľkou povolených prechodov (§7.1) a `assertConservation`.
- [ ] `Ship` FSM: `inbound → waiting_anchorage → berthing → docked → undocking → outbound → despawned`; pohyb po sea lane; `BerthAllocator`.
- [ ] Debug príkaz `SpawnShipDebugCommand(shipClass, cargoType, units)` (len DEV) — kontrakty prídu vo F5.
- [ ] Render: `ModuleView`, `ShipView` (rotácia podľa segmentu), `CraneView` (boom rotácia podľa fázy), `CargoSprite` na palube a na aprone; `BuildLayer` ghost + konektory.
- [ ] UI: `BuildBar` (kategória Terminál: berth, crane), `ModuleInspector` (názov, stav, apron obsadenosť).

Testy: BerthGroup z 2 susedných berthov má dĺžku 16; loď `handy` (10) dostane skupinu 16, `feeder` na 8; žeriav sa zablokuje pri plnom aprone a emitne `CraneBlocked` max 1×/h; `CargoLedger.move` odmietne `on_ship → in_storage`; konzervácia počas 5 000 tickov so spawnutou loďou.
Akceptácia: v hre vidím loď doplávať, zakotviť, žeriav presúva kontajnery na quay; po vyložení odpláva.

---

## Fáza 3 — Vozidlá, pathfinding, dispatcher, sklad (≈3 SD)
**Model mix:** Opus (`sim-architect`) na StorageModule, A* + PathCache, Dispatcher, Vehicle FSM — najrizikovejšia fáza, sériovo. Sonnet paralelne: defy, VehicleView + fill stavy, UI, scenár `apron_to_yard` (`test-writer`). Na konci povinný `sim-reviewer` (opus) so zameraním na alokácie v hot path. Podrobný príklad kariet: AGENTIC_WORKFLOW §9.
**Cieľ:** kontajnery z apronu fyzicky prevezú straddle carriers do kontajnerového dvora; dvor ukazuje zaplnenosť.

Úlohy:
- [ ] `vehicles.json` (`straddle_carrier`), `modules.json` (`container_yard_small`, `vehicle_depot`), konektory modulov.
- [ ] `StorageModule` (abstract, `reserve/store/take`, fill %), `ContainerYard extends StorageModule`.
- [ ] `VehicleDepot`, `BuyVehicleCommand`/`SellVehicleCommand` (vyžaduje voľné miesto v depe).
- [ ] `Pathfinder` (A*, binárna halda, `Int32Array`, bez alokácií), `PathCache` s invalidáciou na `RoadChanged`, `DistanceMatrix` konektor↔konektor (lazy).
- [ ] `TransportJob`, `Dispatcher` (§7.3 kroky 1 a 3), `StorageAllocator` (kompatibilita + najbližší), `Vehicle` FSM s `internalTicks` pri konektore, `traffic++`.
- [ ] Render: `VehicleView` (interpolácia, rotácia podľa smeru, empty/loaded), `ModuleView` fill stavy 0/25/50/75/100 %.
- [ ] UI: BuildBar kategórie Sklady/Logistika; `ModuleInspector` pre sklad (fill %, reserved, throughput) a depo (nákup vozidiel); notifikácia `NoStorageAvailable`, „modul nepripojený k ceste".

Testy: A* nájde najkratšiu cestu na známom bludisku a vráti `null` bez cesty; cache sa invaliduje po odstránení bunky; alokátor vyberie bližší z dvoch skladov a rešpektuje `reserved`; dispatcher nepriradí job vozidlu bez kompatibility; **scenár** `apron_to_yard.json`: 1 loď 120 TEU, 2 vozidlá, 2 dvory → po ≤ 15 000 tickoch všetky jednotky `in_storage`, konzervácia OK, žiadne vozidlo v stave `moving` bez cesty.
Akceptácia: v hre vidím vozidlá jazdiť po cestách a dvor sa vizuálne zapĺňa.

---

## Fáza 4 — Export reťazec: brána, stojiská, rampa, kamióny (≈2 SD)
**Model mix:** `opusplan` — Opus navrhne TruckGate/WaitingArea/Ramp/TruckSpawner a validáciu cesty portál→brána→rampa, implementáciu Truck FSM nechá `sim-architect`; Sonnet: defy, TruckView, inspektory; `test-writer` scenár `full_import_chain`.
**Cieľ:** kontajnery opustia mapu kamiónmi. Kompletný fyzický životný cyklus nákladu.

Úlohy:
- [ ] `modules.json`: `truck_gate`, `truck_waiting_area`, `loading_ramp_container`; `trucks.json` (`truck_container`: capacity 1, speed 0.6).
- [ ] `LandExportModule` (abstract), `TruckGate` (FIFO fronta, `processTicks`), `WaitingArea` (bays), `LoadingRamp` (docks, `at_ramp` sloty).
- [ ] Validácia §8 bod 5 + „cesta portál→brána→rampa existuje" (BFS po cestách s waypointom).
- [ ] `Dispatcher` krok 2 (outbound joby `in_storage → at_ramp`) — zatiaľ pre všetky jednotky (kontrakty vo F5).
- [ ] `TruckSpawner` + `Truck` FSM (§7.5), `RoadPortal` vstup/výstup, `CargoLedger` prechody `at_ramp → in_truck → exported`.
- [ ] Render: `TruckView`, stojiská s obsadenosťou, fronta pred bránou ako číslo/ikonka pri portáli.
- [ ] UI: inspector pre bránu (fronta, priepustnosť), rampu (docks), stojisko (bays).

Testy: bez brány rampa neplatná; kamión sa nespawnuje bez voľného bay; brána pustí max 1 kamión / `processTicks`; **scenár** `full_import_chain.json`: 120 TEU → všetky `exported` ≤ 40 000 tickov, konzervácia OK, `exported` je konečný (žiadny ďalší `move`).
Akceptácia: vidím kamióny prichádzať bránou, čakať, nakladať a odchádzať z mapy.

---

## Fáza 5 — Kontrakty, ledger, HUD → VERTICAL SLICE (≈2,5 SD)
**Model mix:** Opus (`sim-architect`) na Contract FSM, ekonomické vzorce a Ledger — chyby tu sú drahé. Sonnet: ContractsPanel, HUD, Toasts, scenár `vertical_slice` + golden report. Haiku: `test-runner` uloží golden report a odškrtne M1. Odporúčam `--model opus`.
**Cieľ:** hráč prijme kontrakt, splní ho, dostane peniaze a XP; penalizácie fungujú. Core loop uzavretý.

Úlohy:
- [ ] `contract_templates.json` (3 šablóny container), `economy.json` hodnoty.
- [ ] `Contract` FSM (§9.1), `ContractSystem` (pool denne, expiry, spawn lode pri prijatí, SLA, demurrage, late penalty, fail, completion payout, XP).
- [ ] `Economy` + `Ledger` (kategórie, `DaySummary`), `MoneyChanged`, `PenaltyApplied`; CAPEX pri stavaní, `module_sale` pri odstránení.
- [ ] Odstrániť debug spawn; `AcceptContractCommand`, `DeclineContractCommand`.
- [ ] Dispatcher krok 2 filtruje jednotky podľa kontraktu v stave `exporting`, prioritizuje podľa SLA.
- [ ] UI: `ContractsPanel` (karty: typ, objem, odmena, SLA, loď, stav, progres unloaded/exported), `TopHUD` skutočný cash + dnešný delta + XP, `Toasts` pre eventy, `GameOver` modal (dočasne len pri cash < 0 30 dní).
- [ ] `data/scenarios/vertical_slice.json`: stavba (cesty, dvor, depo+2 vozidlá, brána, stojisko, rampa), `AcceptContract` prvej ponuky, beh 60 000 tickov.

Testy: reward vzorec a urgency; demurrage po `berthAllowanceTicks`; late penalty po SLA; fail po 3 dňoch → odmena prepadne; completion → `cash += reward − penalties`, XP; pool má ≤ `offersPerDay` ponúk a expiruje; **golden report** `vertical_slice.json` (cash na konci, exported units, on-time) — uložený do `tests/sim/__golden__/`.
Akceptácia (**M1**): novú hru sa dá odohrať od prijatia kontraktu po výplatu bez debug príkazov; `/sim-check` zelený, `lostUnits = 0`.

---

## Fáza 5b — Spätná väzba z hrania (vložená, ≈1,5 SD)
Karty: `docs/tasks/phase-05b.md`. Tok kamiónov (dock až pri odchode zo stojiska), lode bez prekryvu, `harbor_01` s mólami a viac morom, 8 slotov apronu, depo 10 vozidiel, napojenie ciest na moduly, realistická mierka (bunka ≈ 6 m, TEU 64×26 px, pruhy ostávajú), animácia žeriavu dvora, cúvanie kamióna do docku.

---

## Fáza 6 — Save/Load, čas, nastavenia, stabilizácia (≈1,5 SD)
**Model mix:** prevažne Sonnet (`implementer`: serialize/deserialize, Settings, autosave, profiling) + Haiku (`test-runner`: roundtrip/determinizmus behy, e2e). Opus len pri zlyhaní determinizmu (eskalácia).
**Cieľ:** hra sa dá uložiť/načítať, ovládanie času je kompletné, technický dlh z M1 vyčistený.

Úlohy:
- [ ] `World.serialize/deserialize` kompletné pre všetky entity; `SaveGame v1`; autosave pri `DayClosed`; export/import `.json`; `Settings` modal (rýchlosť, autosave, zvuk placeholder).
- [ ] Determinizmus test (hash stavu po N tickoch, 2 svety), roundtrip test.
- [ ] Profiling: `world.tick()` < 2 ms pri vertical slice; hot-path bez alokácií (A*, dispatcher).
- [ ] Playwright flow: load save → HUD zobrazuje uložený cash.
- [ ] Prejsť `docs/BACKLOG.md`, opraviť P0/P1 bugy z M1.

Akceptácia: uloženie počas vykládky a načítanie → loď pokračuje presne tam, kde bola; testy zelené.

---

## Fáza 6a — Export a booking (vložená, ≈3 SD; presunuté export kontrakty z F12)
Referencia: `docs/PORT_OPERATIONS.md` §2.1. Booking (loď + cieľový prístav + cut-off), exporty prichádzajú kamiónmi rozložene počas dní pred loďou, brána s kontrolou a VGM hold, exportný sklad zoskupený podľa lode/prístavu/hmotnosti, nakládka lode podľa zjednodušeného stowage plánu, dual cycling žeriavu, lashing + papiere pred odchodom, dual transaction kamiónov (privezie export, odvezie import).
Akceptácia: scenár s importom aj exportom na jednej lodi — export príde pred cut-off, naloží sa v poradí plánu, loď odpláva po lashingu; `lostUnits = 0`.

---

## Fáza 6c — Prázdne kontajnery a tranship (vložená, ≈2,5 SD) → **M2 „živý terminál"** (spolu s 6a)
Referencia: `docs/PORT_OPERATIONS.md` §2.2–2.3. `lineId`, návrat prázdnych z vnútrozemia, depot prázdnych + empty handler, kontrola a M&R, výdaj prázdneho exportérovi, repositioning kontrakty, tranship loď → loď (nikdy cez bránu).
Akceptácia (M2): všetky štyri toky (import, export, prázdne, tranship) v jednom scenári, konzervácia OK.

---

## Terminál 2.0 — fázy R0–R7 (vložené 2026-10-05, ADR-036; detail `docs/TERMINAL_2.md` §12)
Prestavba prevádzky prístavu podľa reality. Ide **pred F7**. Každá fáza končí hrateľnou verziou, review `src/sim`, plnou e2e a PR. Vo všetkých scenároch platí `lostUnits = 0` a nulový prekryv vozidiel. Grafika podľa `docs/CLAUDE_DESIGN_TERMINAL_2.md`, ľudia sa nekreslia.

| Fáza | Obsah | ADR | Odhad |
|---|---|---|---|
| **R0** Rozhodnutia — **hotová** | ADR-036 až ADR-038, plán, CLAUDE.md, manuál pre Claude Design | 036 | 0,5 SD |
| **R1** Doprava bez prekrývania | pruhové sloty, dĺžka vozidiel, `TrafficSystem` v kroku 6, pravidlo voľného výjazdu, úseky `one_lane`, parkovanie nečinných, zápchy (detekcia, preplánovanie, toast), fyzické fronty, clean break savov (v10) | 037, 038 | 3 SD |
| **R2** Kontajnery a stohy | 20′ a 40′, typy (dry, empty), `YardBlock` + `StackGrid`, straddle blok, depo s ECH (výška 8), rehandling, `YardPlanner` s časom odchodu, termíny odvozu importu, inšpektor bloku | 039 | 3,5 SD |
| **R3** Ťahače, RTG a TOS | terminálový ťahač, RTG, kotvisko 8 × 4 s pruhmi pod žeriavom, `Move` + nohy, priority RTG, gang a pool, reach stacker | 040 | 3,5 SD |
| **R4** Landside bez rampy | modulárne pruhy vstupnej a výstupnej brány, predbránová a odstavná plocha, viac brán a portálov, lístok a TP pri bloku, lashing, prístup ciest; zrušenie rampy a stojiska | 041 | 3 SD |
| **R5** Reefery a špeciály | reefer bloky a zásuvky, energia, reklamácie; OOG, flat rack, tank; zmesi typov v kontraktoch | 042 | 2 SD |
| **R6** Železnica s RMG | koľaje, železničný terminál s RMG a bufferom, vlaky, ťahače do bufferu | 043 | 2,5 SD |
| **R7** (voliteľná) Automatizácia | AGV + automatizovaný RMG blok, pre-marshalling, CFS | — | 2 SD |

**Poradie po R6:** F7 → F8 (tech tree odomyká RTG, RMG, AGV, rýchle pruhy brány) → F11 → F12 → F13 → F9 (komodity, presunuté za release). **F10a** a **F14** sú rozpustené v R2 a R3; **F10** (železnica) nahrádza R6.

---

## Fáza 7 — Parcely, OPEX, mesačné zúčtovanie, finančné grafy (≈2 SD)
**Model mix:** `opusplan` — Opus na EconomySystem denné/mesačné zúčtovanie a bankrot; Sonnet: parcely príkazy, ParcelLayer, FinancePanel grafy (`ui-builder` z `design/ui/finance-panel.html`).
**Cieľ:** hráč rozširuje územie kúpou/prenájmom, platí prevádzku, vidí financie v grafoch.

Úlohy:
- [ ] `Parcel` ownership, `BuyParcelCommand`, `LeaseParcelCommand`, `ReleaseParcelCommand`; validácia §8 bod 2 na všetkých modulových príkazoch.
- [ ] `EconomySystem` `DayClosed`: údržba, mzdy (vozidlá, žeriavy), prenájmy; `MonthClosed`: `MonthSummary`, `MonthlyReport` event; bankrot podľa `bankruptcyDays`.
- [ ] `ParcelLayer` render (na predaj / vlastnené / prenajaté), klik na parcelu → `ParcelPanel` s cenou kúpy vs. mesačný prenájom.
- [ ] `FinancePanel`: `StackedBars` príjmy vs. výdaje po kategóriách (denne/mesačne prepínač), `LineChart` cash, tabuľka kategórií; `MonthlyReport` modal.

Testy: denné odpisy = Σ podľa defov; prenájom účtuje `price×0.015/30`; nemožno stavať na cudzej parcele; uvoľnenie prenájmu s modulmi zlyhá; bankrot po 30 dňoch v mínuse.
Akceptácia: graf ukazuje reálne dáta z ledgeru; kúpa parcely odomkne stavanie v jej rámci.

---

## Fáza 8 — XP a tech tree (≈1,5 SD)
**Model mix:** `opusplan` — Opus na StatResolver (add→mul, cache invalidácia); Sonnet: tech_tree.json, ResearchTechCommand, TechTree UI, filtre BuildBar; Haiku tabuľkové testy modifikátorov.
**Cieľ:** XP z kontraktov odomyká efektivitu a infraštruktúru; efekty sa reálne prejavia v sime.

Úlohy:
- [ ] `tech_tree.json` — vetva efficiency (crane_speed_1/2, gate_fast_lane, yard_medium, yard_large, vehicle_capacity_1 → `agv`), kostry cargo/infrastructure uzlov (unlock defy z F9–10 zatiaľ `hidden: true`).
- [ ] `TechSystem`, `ResearchTechCommand`, `StatResolver` modifikátory (add → mul), `TechChanged` invaliduje cache.
- [ ] `techRequired` v `PlaceModuleCommand`/`BuyVehicleCommand` a filtre v `BuildBar` (zamknuté položky s ikonou zámku a názvom uzla).
- [ ] UI `TechTree`: 3 stĺpce/vetvy, uzly `locked / available / researched`, tooltip s efektmi, tlačidlo Research (XP).

Testy: `crane_speed_1` skráti `cycleTicks` 12 → 10 (zaokrúhlenie definované: `Math.ceil`); prerequisites vynútené; XP sa odpočíta; unlock module sprístupní stavbu.
Akceptácia (**M2**): hra má rozpoznateľnú progresiu 0 → 3 herné mesiace bez debug príkazov.

---

## Fáza 9 — Nové komodity ako dedičné triedy (≈3–4 SD) — **presunutá za F13 (ADR-036)**
**Model mix:** Opus (`sim-architect`) len na `FlowSystem` (nový mechanizmus) a RoRo self-propelled prechody; **bulk a gas** ako čisto def + odvodené triedy → Sonnet (`implementer`) podľa `/new-cargo`. Property test FlowSystem → `test-writer`. Dôkaz rozšíriteľnosti (`dispatcher.ts` bez zmien) kontroluje `sim-reviewer`.
**Cieľ:** bulk, liquid, gas, RoRo — každá cez checklist §17, **bez úprav Dispatcher/CraneSystem**.

Poradie a špecifiká:
- [ ] **Bulk**: `grain` (25 t/batch), `crane_bulk_grab` (cycle 18), `silo_small`, `bulk_shuttle`, `loading_ramp_bulk`, `truck_bulk`. Scenár `bulk_flow.json`.
- [ ] **Liquid**: `crude_oil`, `crane_liquid_arm` ako `FlowLink` (flow/tick), `pipeline` modul (bunkový, autotile straight/corner/t/valve), `tank_farm_small`, `loading_ramp_liquid`, `truck_tanker`. `FlowSystem` (§6 krok 7): presun quantity po grafe potrubia s konzerváciou; jednotky `in_pipeline`. Scenár `liquid_flow.json`.
- [ ] **Gas**: `cng`, `crane_gas_arm`, `gas_holder_small` — reuse liquid tried s inými defmi (over, že stačí def bez novej triedy; ak nie, zapíš ADR).
- [ ] **RoRo**: `car`, `roro_ramp` (autá schádzajú samy: dočasné `Vehicle{selfPropelled}`), `vehicle_lot_small`, `truck_car_transporter` (capacity 8). Scenár `roro_flow.json`.
- [ ] Lode: `handy`, `panamax` s `cargoCategories`; sprity podľa kategórie.
- [ ] Šablóny kontraktov + tech uzly (cargo vetva) + `BuildBar` kategórie.

Testy: každý scenár prejde do `exported` s konzerváciou; `FlowSystem` nikdy nevytvorí ani nestratí quantity (property test s náhodnými grafmi); RoRo auto po vjazde na lot prestane byť `Vehicle`.
Akceptácia: všetky 5 kategórií hrateľné; `git diff src/sim/systems/dispatcher.ts` medzi F8 a F9 je prázdny (dôkaz rozšíriteľnosti).

---

## Fáza 10 — Železnica (≈2 SD) — **nahradená fázou R6 (ADR-036)**
**Model mix:** `opusplan` — Opus na TrainScheduler a výber rampa vs. stanica v dispatcheri (jediná povolená zmena dispatchera, cez ADR); Sonnet: PlaceRail, RailLayer, TrainView, RailStation.
**Cieľ:** vlaky ako vysokokapacitný export s vlastnou infraštruktúrou.

Úlohy:
- [ ] `PlaceRailCommand` (vrstva `rail`, autotile, nekríži cestu), `RailPortal`, `rail_station_small` (tracks, staging sloty ako `at_ramp`), `trains.json` (loco + wagons per kategória).
- [ ] `TrainScheduler`: spawn pri `staged ≥ 0.6×capacity` alebo hroziace SLA; `Train` FSM (`inbound → loading → outbound`); `RailStation extends LandExportModule`.
- [ ] Dispatcher krok 2 volí medzi rampou a stanicou podľa `distance × capacityFactor` (stanica preferovaná pre veľké objemy).
- [ ] Render: `RailLayer`, `TrainView` (loco + N wagons po koľaji), stanica s obsadenosťou tracks.
- [ ] Tech uzly `rail_link`, `rail_station_large`.

Testy: koľaj nesmie prekročiť cestu; vlak odvezie max `trainCapacity`; scenár `rail_export.json` — 700 TEU odvezené prevažne vlakom (> 60 %).
Akceptácia (**M3**): panamax loď s 700 TEU je zvládnuteľná do SLA s 2 žeriavmi + stanicou.

---

## Fáza 10a — Vybavenie skladu: RTG/RMG, ťahače, shuttle (vložená, ≈2,5 SD) — **rozpustená v R2 a R3 (ADR-036)**
Referencia: `docs/PORT_OPERATIONS.md` §2.5. Bloky s RTG/RMG (vysoká hustota, stoh 5–6), terminálové ťahače/AGV (dvojfázový systém: STS položí kontajner priamo na ťahač „pod hákom", RTG ho v sklade z ťahača zloží — variant B požiadavky z 2026-10-04; variant A, straddle carrier pod hákom, je vo Fáze 6a), shuttle carrier, priorita lode v bloku, pomalý presun RTG medzi blokmi.

---

## Fáza 11 — Analytika, heatmapa, kongescia (≈1,5 SD)
**Model mix:** prevažne Sonnet (MetricsSystem ring buffery, heatmap overlay, StatsPanel); Opus len na heuristiku bottleneck hint a congestion penalty v A*.
**Cieľ:** hráč vidí bottlenecky v dátach.

Úlohy:
- [ ] `MetricsSystem`: utilization ring buffery (žeriavy, vozidlá, brány), storage throughput, contract KPI (on-time %, avg berth time, avg dwell).
- [ ] Soft kongescia (§7.6): spomalenie na bunke, `congestionPenalty` v A*.
- [ ] Heatmap overlay (klávesa `H`): `Float32Array` → texture, legenda; `StatsPanel`: utilization bary, KPI, top 5 najzaťaženejších buniek/modulov, „bottleneck hint" (§11).
- [ ] `ModuleInspector` rozšírenie: graf vyťaženosti 24 h.

Testy: utilization = busy/(busy+idle+blocked) na syntetickom priebehu; decay traffic pri `HourClosed`; spomalenie pri 3 vozidlách na bunke = ×0.667.
Akceptácia: pri 1 vozidle a 2 žeriavoch hint hlási „málo vozidiel"; heatmapa svieti na hlavnej ceste.

---

## Fáza 12 — Lode a kotviská naplno, stowage plán, reputácia, móla (≈2,5 SD)
**Model mix:** Opus (`sim-architect`) na reverzný reťazec export kontraktov (rozšírenie tabuľky prechodov CargoLedger) a multi-crane obsluhu; Sonnet: deepwater defy, reputácia UI, SetStoragePolicy. Odporúčam `--model opus`.
Úlohy:
- [ ] `berth_deepwater`, `mega` loď, `deepwater_berth` tech; BerthGroup s viacerými žeriavmi obsluhujúcimi jednu loď; anchorage fronta a `ShipWaiting` notifikácia.
- [ ] *(presunuté do F6a)* ~~Export kontrakty (land → ship)~~; namiesto toho **stowage plán naplno** (40'/20', posledný prístav naspodok, prázdne navrch) a **stavanie móla/zásyp pobrežia hráčom** (drahé, ADR-028). Pôvodne: reverzný reťazec `RoadPortal → gate → ramp(inbound) → vehicle → storage → apron → crane → on_ship`; `CargoLedger` tabuľka prechodov rozšírená; kontrakt `direction: 'import' | 'export'`.
- [ ] Reputácia (§9.3) a jej vplyv na pool; `SetStoragePolicyCommand` (sklad vyhradený pre kontrakt).
- [ ] UI: contract karty s smerom, reputačný ukazovateľ v HUD.

Testy: export scenár končí s `on_ship` všetkými jednotkami a odplávaním lode; mega loď odmietnutá skupinou s `minDepth 1`.

---

## Fáza 13 — Balans, UX, tutoriál, výkon, release (≈3 SD)
**Model mix:** Sonnet (`balance-analyst` batch, `implementer` tutoriál/UX, Worker migrácia), Haiku (`test-runner` regresie, `docs-keeper` README/BACKLOG čistenie). Opus iba na ADR o Web Workeri a finálny `sim-reviewer`.
Úlohy:
- [ ] Balans cez `simrun` batch: `tools/balance.ts` spustí 20 scenárov s rôznymi stratégiami, vypíše ROI/dni; upraviť defy tak, aby návratnosť dvora bola 10–20 herných dní a mega loď dávala zmysel po 3. mesiaci.
- [ ] Starter scenár + kontextové hinty („postav cestu od portálu k bráne", „loď čaká — postav sklad"), prázdny stav panelov, hotkeys prehľad.
- [ ] Výkon: sim v Web Workeri ak `tick > 8 ms` pri 8× na referenčnom scenári (ADR); PixiJS culling; UI throttle.
- [ ] Zvuk (placeholder eventy), minimap (voliteľné), Tauri build (voliteľné).
- [ ] Vyčistiť `BACKLOG.md`, aktualizovať docs, `README.md` s GIF/screenshot z Playwright.

Akceptácia (**M4**): 2 herné mesiace bez pádu, FPS ≥ 60 pri 8× s 3 loďami/ 12 vozidlami/ 20 kamiónmi; e2e zelené; golden reporty aktualizované so zámerným diffom.

---

## Fáza 14 — Sklad: stohy, rehandling, pre-marshalling (voliteľná, po release, ≈2,5 SD) — **rozpustená v R2 a R7 (ADR-036)**
Presunuté na úplný koniec na žiadosť používateľa (nie je nevyhnutné). Do F14 sa sklad modeluje kapacitou bez poradia v stohu; RTG vo F10a bez rehandlingu. Referencia: `docs/PORT_OPERATIONS.md` §2.4. Pozície bay–row–tier, poradie v stohu, rehandling (čas stroja), pre-marshalling exportov k nábrežiu deň pred loďou, metriky `rehandlesPerMove`.

---

## Šablóny `.claude/commands/` (vytvoriť vo fáze 0)

`.claude/commands/phase.md` — orchestrácia fázy (beží v hlavnej relácii, `opusplan` → Opus v plan mode)
```markdown
---
description: Naplánuje fázu N ako sadu task kariet a spustí orchestráciu
---
Pracujeme na fáze $ARGUMENTS projektu Modular Harbor. Si ORCHESTRÁTOR (docs/AGENTIC_WORKFLOW.md §2).
1. Prečítaj docs/IMPLEMENTATION_PLAN.md — iba sekciu „Fáza $ARGUMENTS" vrátane riadku Model mix — a súvisiace § v docs/ARCHITECTURE.md. Skontroluj docs/PROGRESS.md.
2. Zapni plan mode. Rozlož fázu na task karty podľa šablóny docs/tasks/_template.md a smerovacej tabuľky AGENTIC_WORKFLOW §4:
   každá karta má model (opus/sonnet/haiku), agenta, inputs (§), outputs (súbory), acceptance (iba príkazy), do_not_touch, depends_on, parallel.
   Karty v src/sim sú sériové (single writer); ostatné označ parallel: yes.
3. Ulož karty do docs/tasks/phase-NN.md a ukáž mi tabuľku: id | názov | model | agent | parallel | závislosti. Počkaj na schválenie.
4. Po schválení deleguj karty v topologickom poradí cez /delegate; paralelné karty spúšťaj naraz. Sám nekóduj viac ako jednu kartu S.
5. Po poslednej sim karte spusti /review-sim; blocking nálezy → nové karty (opus). Na konci /sim-check, ADR-y, zhrnutie čo funguje / čo nie.
Nerozširuj scope fázy; nápady zapíš do docs/BACKLOG.md. Do svojho kontextu neťahaj surové výstupy testov — len zhrnutia agentov.
```

`.claude/commands/delegate.md`
```markdown
---
description: Deleguje task kartu jej agentovi a modelu, potom overí a odškrtne
---
Karta $ARGUMENTS z aktuálneho docs/tasks/phase-NN.md.
1. Načítaj kartu; over, že depends_on sú done. Ak nie, zastav sa.
2. Spusti subagenta uvedeného v `agent:` (model určuje jeho frontmatter) a odovzdaj mu: celú kartu, odkazy na § z inputs, do_not_touch, a požiadavku ukončiť odpoveď blokom „## Výsledok <id>" (AGENTIC_WORKFLOW §5). Pri parallel: yes použi worktree izoláciu.
3. Po návrate spusti subagenta test-runner s príkazmi z acceptance karty. Ak report obsahuje BLOCKING alebo padnutý acceptance test → vráť kartu vlastníkovi s triážou (max 2 kolá), potom eskaluj podľa §5.
4. Pri status: done spusti docs-keeper: odškrtni kartu, prenes open_questions/adr_candidates do BACKLOG.md alebo DECISIONS.md.
5. Vráť mi 5-riadkové zhrnutie: karta, status, zmenené súbory, testy, ďalšia karta na rade.
```

`.claude/commands/review-sim.md`
```markdown
---
description: Read-only review simulačného jadra pred merge (Opus)
---
Spusti subagenta sim-reviewer nad `git diff main...HEAD -- src/sim tests/sim data/defs`.
Výsledok (tabuľka nálezov + verdikt MERGE / FIX FIRST) zobraz celý. Pre každý blocking nález navrhni novú task kartu (model: opus, agent: sim-architect) a pridaj ju do docs/tasks/phase-NN.md; nič neopravuj sám.
```

`.claude/commands/sim-check.md`
```markdown
---
description: Kompletná kontrola cez test-runner (Haiku)
---
Spusti subagenta test-runner v plnom režime (typecheck, lint, test, validate:defs, simrun vertical_slice 60000 tickov, e2e ak sa menil render/UI).
Zobraz jeho tabuľku a metriky: cashEnd, exportedUnits, lostUnits (MUSÍ byť 0), onTimeRate, craneBlockedPct.
Ak niečo zlyhá, navrhni kartu na opravu (model podľa smerovacej tabuľky) a nič neopravuj bez potvrdenia.
```

`.claude/commands/adr.md`
```markdown
Pridaj do docs/DECISIONS.md nový záznam „ADR-NNN: $ARGUMENTS" (ďalšie voľné číslo) so sekciami
Kontext / Rozhodnutie / Alternatívy / Dôsledky (každá 1–3 vety). Odkáž na § v ARCHITECTURE.md, ak existuje.
```

`.claude/commands/new-cargo.md`
```markdown
Pridávame nový typ nákladu: $ARGUMENTS. Vytvor task karty podľa checklistu docs/ARCHITECTURE.md §17:
body 1–4, 6, 7, 9 → sonnet (implementer), bod 5 → sonnet ak stačí odvodená trieda + def, opus (sim-architect) ak treba nový mechanizmus; bod 8 → test-writer.
Dispatcher a CraneSystem sa NESMÚ meniť — ak to agent hlási ako nutné, zastav sa a vysvetli prečo.
Na konci: scenár data/scenarios/<id>_flow.json končí v 'exported' s konzerváciou; sim-reviewer potvrdí prázdny diff dispatcher.ts.
```

`.claude/commands/ui-from-design.md`
```markdown
Spusti subagenta ui-builder pre design/$ARGUMENTS → React komponent v src/ui/.
Požiadavky: výlučne CSS custom properties z design/tokens.css, zachovať triedy/rozloženie, statické dáta nahradiť useSimSnapshot(selector, 100),
demo v src/ui/__demo__/, Playwright screenshot porovnaný s prototypom. Rozdiely vymenovať v zhrnutí.
```

### Subagenty a nastavenia
Súbory `.claude/agents/*.md` (sim-architect · sim-reviewer · implementer · ui-builder · test-writer · test-runner · docs-keeper · balance-analyst) a `.claude/settings.json` sú **kompletne vypísané v `docs/AGENTIC_WORKFLOW.md` §7–8** — vo fáze 0 ich vytvor doslova, vrátane explicitného `model:` v každom frontmatter.

### Hooks (`.claude/settings.json`) — bez modelu, čistý shell
- `PostToolUse` (Edit/Write na `data/defs/**`) → `pnpm validate:defs`.
- `PostToolUse` (Edit/Write na `src/sim/**`) → `pnpm vitest run --changed --reporter=dot` (rýchla spätná väzba; plnú triáž robí `test-runner`).
