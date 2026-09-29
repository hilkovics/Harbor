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

- [ ] `cargo_types.json` (`container_teu`), `modules.json` (`berth_standard`, `crane_container_gantry`), `ships.json` (`feeder`).
- [ ] `Module` (abstract), `ModuleRegistry`, `BerthModule` + `BerthGroup` prepočet, `ApronBuffer`, `CraneModule` FSM (§7.2), `StatResolver` (bez modifikátorov zatiaľ).
- [ ] `PlaceModuleCommand` / `RemoveModuleCommand` s pravidlami §8 (1–4, 7, 8); rotácia `R`; ghost s farbou validácie + zoznam dôvodov v tooltipe.
- [ ] `CargoUnit`, `CargoLocation`, `CargoLedger` s tabuľkou povolených prechodov (§7.1) a `assertConservation`.
- [ ] `Ship` FSM: `inbound → waiting_anchorage → berthing → docked → undocking → outbound → despawned`; pohyb po sea lane; `BerthAllocator`.
- [ ] Debug príkaz `SpawnShipDebugCommand(shipClass, cargoType, units)` (len DEV) — kontrakty prídu vo F5.
- [ ] Render: `ModuleView`, `ShipView` (rotácia podľa segmentu), `CraneView` (boom rotácia podľa fázy), `CargoSprite` na palube a na aprone; `BuildLayer` ghost + konektory.
- [ ] UI: `BuildBar` (kategória Terminál: berth, crane), `ModuleInspector` (názov, stav, apron obsadenosť).

Akceptácia: v hre vidím loď doplávať, zakotviť, žeriav presúva kontajnery na quay; po vyložení odpláva.
