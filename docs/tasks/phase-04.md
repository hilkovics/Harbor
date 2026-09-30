# Fáza 4 — Export reťazec: brána, stojiská, rampa, kamióny · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 4" (+ riadok Model mix), ARCHITECTURE §4.2, §5.3, §6 (kroky 5, 6, 8, 12), §7.1, §7.3 (bod 2), §7.5, §7.8, §8 (bod 5), §12, §13, §14; ADR-011, ADR-017..021.
> Vetva: `phase/04-export-trucks` (stacked nad `phase/03-vehicles-yard`, PR hilkovics/Harbor#4). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> Assety: `assets/manifest.json`:
> - `sprites.truck_gate`: `parts.barrier` s `openDeg`/`closedDeg`; konektory `(0,0,n)` a `(0,1,s)` tvoria priechod.
> - `sprites.truck_waiting_area`: 6× `stalls`; konektory `(0,2,w)` a `(3,2,e)` tvoria priechod.
> - `sprites.loading_ramp_container`: 2× `docks`; konektory `(1,1,s)` a `(2,1,s)`.
> - `entities.truck_container.states.{empty,loaded}` (1×2).
> - `overlay.queue_badge` (číslo kreslí engine).
> UI prototyp: `design/ui/game-ui.source.html` (`insp_gate`, BuildBar `landside`).

**Cieľ:** kontajnery opustia mapu kamiónmi. Kompletný fyzický životný cyklus nákladu.
**Akceptácia fázy:** vidím kamióny prichádzať bránou, čakať, nakladať a odchádzať z mapy. Testy:
- bez brány je rampa neplatná;
- kamión sa nespawnuje bez voľného bay;
- brána pustí najviac 1 kamión za `processTicks`;
- **scenár** `full_import_chain.json`: 120 TEU sú všetky `exported` do 40 000 tickov, konzervácia platí a `exported` je konečný stav (žiadny ďalší `move`).

**Rozhodnutia orchestrátora (zapíšu sa do ADR-022..024 v kartách sim-architecta; ADR-023 = outbound joby z T04-03):**
1. **Rampa je neplatná prevádzkovo, nie pri stavbe.**
   - Rampu, bránu aj stojisko možno postaviť v ľubovoľnom poradí, ak spĺňajú §8 bod 5 (rovnako ako sklad, ADR-017).
   - Rampa je **prevádzková**, keď existuje cesta `road portal → vstupná strana brány`, `výstupná strana brány → stojisko (priechod) → konektor rampy`.
   - Neprevádzková rampa nedostane outbound joby ani kamióny; UI ukáže dôvod („chýba brána na ceste", „chýba stojisko"). Test „bez brány rampa neplatná" = `isRampOperational === false`, nevznikne outbound job ani kamión.
   - Stav sa prepočíta pri zmene `roadVersion` alebo množiny modulov.
2. **Brána je priechod.**
   - Z dvoch konektorov je vstupný ten, ktorý je z portálu dosiahnuteľný po cestách bez prechodu bránou; pri nejednoznačnosti ten bližší k portálu.
   - Kamión prejde bránou v oboch smeroch cez **spoločnú FIFO frontu**. Priepustnosť je 1 kamión za `processTicks` (tvrdý bottleneck).
   - Fronta pred bránou je **virtuálna** (§7.5): čakajúci kamión stojí na vonkajšej bunke konektora a render ukáže `queue_badge` s počtom. Nikdy nevznikne gridlock.
   - Prechod telom brány je abstrahovaný ako `internalTicks` (ADR-011): kamión sa po spracovaní objaví na druhej strane a náklad `in_truck` sa nemení.
3. **Stojisko (waiting area)** je tiež priechod s `bays`.
   - Kamión si pri spawne rezervuje bay (bez voľného bay sa nespawnuje, vznikne `NoWaitingBay`, najviac 1× za hodinu) a dock rampy s pripraveným nákladom.
   - Po bráne ide kamión do stojiska, čaká na povel do docku a uvoľní bay, keď odíde k rampe.
4. **Rampa má `docks` a na každom docku staging sloty** `at_ramp { rampId, dock }` s kapacitou `params.stagingPerDock`.
   - Outbound job (dispatcher krok 2, §7.3) = `in_storage → in_vehicle → at_ramp`, zatiaľ pre všetky uložené jednotky (kontrakty vo F5). Rezervuje staging slot pri vytvorení jobu.
   - **Priorita:** inbound pred outbound (uvoľnenie apronu chráni žeriav pred blokovaním).
5. **TruckSpawner (krok 8, `landsideSystem`):** pre každý dock prevádzkovej rampy s `at_ramp` ≥ `truck.capacityUnits` a s voľným bay → spawn kamióna na `roadPortals[0]` (deterministicky: rampy a docky podľa id).
6. **Truck FSM** (§7.5): `to_gate → gate_queue → to_bay → waiting → to_dock → loading → to_gate_out → gate_queue_out → to_portal → exited`.
   - Pohyb po cestách zdieľa kód s vozidlami (trasa, oblúky, pruhy, typy ciest, jednosmerky) bez duplikácie. Kamión je tiež „Carrier".
   - `loading`: `loadTicksPerUnit × units` z rampy; `at_ramp → in_truck` po dokončení každej jednotky.
   - `exited`: všetky jednotky `in_truck → exported`, kamión zmizne (`TruckExited`).
7. **WorldState v4** = v3 + `trucks` + stav brány (fronta, `processTicks` zostávajúce) + rezervácie bay/dock (ak sa nedajú odvodiť); `migrate(v3 → v4)`.

## Checklist
- [x] T04-01 · Defy: `trucks.json`, `truck_gate` + `truck_waiting_area` + `loading_ramp_container` v `modules.json`, schémy, DefRegistry, manifest krížovo pre kamióny
- [x] T04-02 · Sim: `LandExportModule` + `TruckGate` + `WaitingArea` + `LoadingRamp` (staging sloty), priechody, prevádzkovosť rampy; ADR-022
- [x] T04-03 · Sim: Dispatcher krok 2 — outbound joby `in_storage → at_ramp`, priorita, `recordTaken`
- [ ] T04-04 · Sim: `Truck` + `TruckSpawner` + Truck FSM + brána (fronta, priepustnosť) + `exported` + WorldState v4; ADR-024
- [ ] T04-05 · Testy (TDD): scenár `full_import_chain`, brána, bay, neplatná rampa
- [x] T04-06 · Render: `TruckView`, závora brány, `queue_badge`, obsadenosť stojísk, staging na rampe, badge „neprevádzková"
- [x] T04-07 · UI: inspector brány (fronta, priepustnosť/h), stojiska (bays), rampy (docks, staging, dôvod neprevádzkovosti); BuildBar Landside moduly
- [ ] T04-08 · App: snapshot v4 (kamióny, brána, stojiská, rampy), napojenie, toasty (`NoWaitingBay`, neprevádzková rampa)
- [ ] T04-09 · Tooling: `simrun` metriky kamiónov a exportu
- [ ] T04-10 · E2E: celý reťazec loď → dvor → rampa → kamión → export, screenshoty
- [ ] T04-11 · Review `src/sim/**`
- [ ] T04-12 · Opravy z review + ARCHITECTURE zosúladenie
- [ ] T04-13 · Plná pipeline + triáž
- [ ] T04-14 · Uzavretie fázy (PROGRESS, BACKLOG) + PR

Vlny: 01 → 02 → 03 → 04 (sim sériovo) ‖ {05 (TDD, worktree od 01), 06 (worktree od 01), 07 (worktree od 01)} → {08 ‖ 09} → 10 → 11 → 12 → 13 → 14.
Single writer `src/sim/**`: T04-01 (defs), potom T04-02..T04-04 sériovo, T04-12.

## Spoločné rozhrania (záväzné pre paralelné karty)

```ts
// src/sim/defs
interface TruckDef { id; displayName; capacityUnits; speedCellsPerTick; cargoCategories: CargoCategory[] }   // katalóg defs.trucks
interface GateParams { processTicks: number; internalTicks?: number }                  // kind 'gate'
interface WaitingAreaParams { bays: number; internalTicks?: number }                   // kind 'waiting_area'
interface RampParams { docks: number; stagingPerDock: number; loadTicksPerUnit: number; category: CargoCategory; internalTicks?: number }  // kind 'ramp'

// src/sim/modules
abstract class LandExportModule extends Module {}
class TruckGate extends LandExportModule { readonly params: GateParams; readonly queueLength: number; readonly busyTicksLeft: number;
  readonly entrySide: PlacedConnector | null; readonly exitSide: PlacedConnector | null; readonly trucksProcessed: number }
class WaitingArea extends LandExportModule { readonly params: WaitingAreaParams; readonly bays: number; readonly occupiedBays: number; readonly reservedBays: number }
class LoadingRamp extends LandExportModule { readonly params: RampParams; readonly docks: number;
  stagedAt(dock: number): number; reservedAt(dock: number): number; readonly operational: boolean; readonly inoperativeReason: 'no_gate' | 'no_waiting_area' | 'not_connected' | null }

// src/sim/trucks
type TruckState = 'to_gate' | 'gate_queue' | 'to_bay' | 'waiting' | 'to_dock' | 'loading' | 'to_gate_out' | 'gate_queue_out' | 'to_portal' | 'exited' | 'no_path';
class Truck { readonly id: EntityId; readonly defId: string; readonly def: TruckDef; readonly state: TruckState;
  x: number; y: number; heading: Rotation; readonly rampId: EntityId; readonly dock: number; readonly waitingAreaId: EntityId; readonly gateId: EntityId }
// World: readonly trucks: ReadonlyMap<EntityId, Truck>; isRampOperational(ramp): boolean
```

Nové `ValidationReason` (ak treba): `ramp_inoperative` (napr. pre UI tooltip), `has_trucks` (odstránenie modulu, ktorý používa kamión).
Nové `SimEvent`: `TruckSpawned { truckId, rampId, dock }` · `TruckStateChanged { truckId, from, to }` · `TruckExited { truckId, units }` · `NoWaitingBay { rampId }` (najviac 1×/h) · `RampOperationalChanged { rampId, operational, reason }`.

Render view-modely (T04-06 doplní, T04-08 plní):
```ts
interface TruckVM { id: number; defId: string; x: number; y: number; prevX: number; prevY: number; heading: 0|90|180|270;
  prevHeading?: 0|90|180|270; loaded: boolean; state: string }
// ModuleVM += gate?: { queueLength: number; open: boolean }            // open = práve púšťa kamión (závora hore)
//            + waitingArea?: { bays: number; occupied: readonly boolean[] }
//            + ramp?: { docks: number; staged: readonly number[]; operational: boolean }
// EntitiesVM += trucks?: readonly TruckVM[]
```

---

### T04-01 · Defy: `trucks.json`, gate/waiting area/ramp v `modules.json`, schémy, DefRegistry, manifest krížovo
- model: sonnet
- agent: implementer
- parallel: no (mení `src/sim/defs` — single writer)
- depends_on: –
- inputs: ARCHITECTURE §4.2, §5.3; „Spoločné rozhrania"; `assets/manifest.json` (`sprites.truck_gate`, `sprites.truck_waiting_area`, `sprites.loading_ramp_container`, `entities.truck_container`); `src/sim/defs/**`; `tools/validate-defs.ts`
- outputs: data/defs/trucks.json (+ schéma); data/defs/modules.json (+3); data/schemas/modules.schema.json; src/sim/defs/**; tools/validate-defs.ts (krížovo `trucks.json` → `entities[id]`); testy
- požiadavky:
  - `trucks.json`: `truck_container` { displayName „Kamión kontajnerový", capacityUnits 1, speedCellsPerTick 0.6, cargoCategories [container] }.
  - `truck_gate` { kind `gate`, „Brána kamiónov", 2×2, [land, quay], connectors z manifestu, costCents 8 000 000, maintenancePerDayCents 15 000, params { processTicks 18 } }.
  - `truck_waiting_area` { kind `waiting_area`, „Čakacia plocha", 4×3, connectors z manifestu, 6 000 000, 10 000, params { bays 6 } }. `bays` = počet `stalls` v manifeste (test).
  - `loading_ramp_container` { kind `ramp`, „Rampa · kontajnery", 4×2, connectors z manifestu, 10 000 000, 20 000, params { docks 2, stagingPerDock 2, loadTicksPerUnit 6, category container } }. `docks` = počet `docks` v manifeste (test).
  - `MODULE_PARAM_SPECS` pre `gate`, `waiting_area`, `ramp`; gettery `gateParams`, `waitingAreaParams`, `rampParams`; katalóg `defs.trucks`. `truck_container.footprint` (1×2) sedí s manifestom.
  - Rozloženie scenárov F1–F3 ostane platné.
- acceptance:
  - `pnpm validate:defs`
  - `pnpm vitest run tests/sim/defs tests/tools`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/{core,grid,cargo,modules,ships,vehicles,logistics,systems,world,commands,events}/**, src/render/**, src/ui/**, src/app/**
- estimate: S

### T04-02 · Sim: `LandExportModule` + `TruckGate` + `WaitingArea` + `LoadingRamp`, priechody, prevádzkovosť rampy; ADR-022
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T04-01
- inputs: ARCHITECTURE §5, §7.5, §8 (bod 5); ADR-017..021; „Rozhodnutia orchestrátora" 1–4; `src/sim/modules/**`, `src/sim/world/{connectivity,module-rules,world,world-invariants,world-state,world-restore}.ts`, `src/sim/logistics/**`
- outputs: src/sim/modules/{land-export-module,truck-gate,waiting-area,loading-ramp}.ts (+ registrácia); src/sim/world/** (prevádzkovosť rampy, invarianty); docs/DECISIONS.md (ADR-022); testy
- požiadavky:
  - Triedy podľa „Spoločné rozhrania", registrované v `ModuleRegistry`. Rampa má staging sloty cez `SlotReservations`, držiteľ `at_ramp` (ledger už pozná `rampId`/`dock`).
  - Určenie vstupnej a výstupnej strany brány (rozhodnutie 2). Prevádzkovosť rampy (rozhodnutie 1) cez `Pathfinder` (bez prechodu telom brány), cache podľa `roadVersion` a verzie modulov, udalosť `RampOperationalChanged` pri zmene.
  - `RemoveModule` gate/waiting/ramp s kamiónom alebo náklad na rampe → `has_trucks` alebo `has_cargo`. Pravidlo pripravené, kamióny prídu v T04-04.
  - WorldState: moduly v save (runtime napr. fronta brány je zatiaľ prázdna). Migrácia v3 → v4 môže prísť až s T04-04, zdokumentuj.
  - ADR-022: pozemné moduly, priechody, prevádzkovosť rampy.
- acceptance:
  - `pnpm vitest run tests/sim/modules tests/sim/world tests/sim/commands`
  - `grep -c '^## ADR-022:' docs/DECISIONS.md` = 1
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0 and .unitsInStorage == 120'`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/defs/**
- estimate: M

### T04-03 · Sim: Dispatcher krok 2 — outbound joby `in_storage → at_ramp`
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T04-02
- inputs: ARCHITECTURE §7.3 (bod 2), §7.7; ADR-018, ADR-019; „Rozhodnutia orchestrátora" 4
- outputs: src/sim/logistics/{dispatcher,…}.ts; src/sim/systems/{dispatcher-system,vehicle-system}.ts; testy
- požiadavky:
  - Outbound: pre uloženú jednotku bez jobu (sklady podľa id, jednotky FIFO) a prevádzkovú rampu kompatibilnej kategórie s voľným staging slotom (najbližšia podľa `DistanceMatrix` od skladu, pri zhode menšie id) vytvor job `in_storage(moduleId, slot) → at_ramp(rampId, dock)`, `JobCreated`.
  - **Inbound má prednosť** pri priradení vozidla. Outbound sa priraďuje až po inbound jobe (pri rovnakom ticku).
  - Vozidlo pri vyzdvihnutí zo skladu: `in_storage → in_vehicle` + `storage.recordTaken`; pri vyložení na rampe: `in_vehicle → at_ramp` + commit staging slotu.
  - Bez prevádzkovej rampy outbound joby nevznikajú. Pri zmene prevádzkovosti rampy sa `open` joby preradia alebo zrušia (uvoľnenie rezervácií), aby nevznikol trvalý `no_path` (BACKLOG P1).
  - Invarianty a save: joby majú `from` aj zo skladu, rezervácie staging slotov sú odvodené z jobov.
- acceptance:
  - `pnpm vitest run tests/sim/logistics tests/sim/systems tests/sim/scenarios`
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0 and .unitsInStorage == 120'` (bez rampy nič neodchádza)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T04-04 · Sim: `Truck` + `TruckSpawner` + Truck FSM + brána + `exported` + WorldState v4; ADR-024
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T04-03
- inputs: ARCHITECTURE §6 (krok 8), §7.1, §7.5, §7.8; ADR-011, ADR-019, ADR-020, ADR-021; „Rozhodnutia orchestrátora" 2, 3, 5, 6, 7; TDD testy T04-05 vo worktree
- outputs: src/sim/trucks/**; src/sim/systems/landside-system.ts; zdieľaný pohyb (refaktor z `src/sim/vehicles` do spoločného modulu, ak treba); src/sim/world/** (v4); docs/DECISIONS.md (ADR-024); testy; zlúčené TDD testy T04-05
- požiadavky:
  - `TruckSpawner` a Truck FSM podľa rozhodnutí 2, 3, 5, 6 s explicitnou tabuľkou prechodov. Brána má spoločnú FIFO frontu v oboch smeroch; priepustnosť je 1 kamión za `processTicks` (+ `internalTicks`, ak je v params).
  - Pohyb kamióna zdieľa kód s vozidlami (trasa, jednosmerky, rýchlosť podľa typu cesty, `no_path`, `replanPending`, `PROGRESS_NOISE`). Nevznikne druhá kópia pohybovej logiky.
  - Náklad: `at_ramp → in_truck` po jednej jednotke (`loadTicksPerUnit`), pri výjazde z portálu `in_truck → exported` a `TruckExited`. `exported` je konečný stav.
  - Krok 8 (`landsideSystem`) v `World.tick()` podľa §6. Invarianty: kamión s nákladom je v `loading`/`to_gate_out`/`gate_queue_out`/`to_portal`; bay/dock rezervácie sedia; fronta brány obsahuje len kamióny v `gate_queue*`.
  - WorldState v4 + `migrate(v3 → v4)`, roundtrip uprostred jazdy kamióna, vo fronte brány a pri nakládke.
  - TDD testy T04-05: `git checkout <vetva> -- <súbory>` a zazeleniť bez úprav, prípadné úpravy zdôvodniť.
  - ADR-024: kamióny, brána, spawner, export.
- acceptance:
  - `pnpm vitest run tests/sim`
  - `pnpm -s simrun data/scenarios/full_import_chain.json --ticks 40000 --report | jq -e '.lostUnits == 0 and .exportedUnits == 120'`
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.cashEnd == 108300000'`
  - `grep -c '^## ADR-024:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/defs/**, data/maps/**
- estimate: L

### T04-05 · Testy (TDD): scenár `full_import_chain`, brána, bay, neplatná rampa
- model: sonnet
- agent: test-writer
- parallel: yes (worktree od T04-01; zlúči sa v T04-04)
- depends_on: T04-01
- inputs: „Akceptácia fázy", „Rozhodnutia orchestrátora", „Spoločné rozhrania"; `tests/sim/helpers/{f3,f3-layout,harbor}.ts`; `data/scenarios/apron_to_yard.json`; mapa `harbor_01`:
  - starter parcela x 30–57, y 14–33;
  - road portál (44,63), štartová cesta x=44 y 34..63 (verejná);
  - moduly musia byť na parcele, takže bránu umiestni na južný okraj parcely tak, aby jej vstupná strana nadväzovala na štartovú cestu.
- outputs: data/scenarios/full_import_chain.json; tests/sim/scenarios/f4-full-import-chain.test.ts; tests/sim/scenarios/f4-landside.test.ts; tests/sim/invariants/f4-conservation.test.ts; helpery
- požiadavky:
  - `full_import_chain.json` (seed 4004): rozloženie `apron_to_yard` + brána + stojisko + rampa + cesty tak, aby rampa bola prevádzková; 2–3 vozidlá; feeder 120 TEU. Do 40 000 tickov `exportedCount === 120`, `in_storage + at_ramp + in_truck === 0`, `lostUnits 0`, `exported` bez ďalšieho `move`.
  - Brána: medzi dvoma po sebe idúcimi prechodmi tou istou bránou je ≥ `processTicks` tickov (sledovať `TruckStateChanged` `gate_queue → …`).
  - Bay: pri plných bays (napr. syntetické `bays 1`) sa ďalší kamión nespawnuje a vznikne `NoWaitingBay` (≤ 1×/h).
  - Neplatná rampa: bez brány (alebo bez cesty k bráne) `isRampOperational === false`, žiadny outbound job ani kamión, `RampOperationalChanged` po dostavaní brány.
  - Determinizmus a roundtrip uprostred reťazca.
  - Testy teraz padajú zo správneho dôvodu. Uveď hlášky.
- acceptance: `pnpm vitest run tests/sim/scenarios tests/sim/invariants` (po T04-04)
- do_not_touch: src/**, tools/**, data/defs/**, data/maps/**
- estimate: M

### T04-06 · Render: `TruckView`, závora brány, `queue_badge`, stojiská, staging na rampe
- model: sonnet
- agent: implementer
- parallel: yes (worktree od T04-01)
- depends_on: T04-01
- inputs: ARCHITECTURE §15.1; `assets/manifest.json` (`entities.truck_container` 1×2, `sprites.truck_gate.parts.barrier` s `pivot`/`openDeg`/`closedDeg`/`offset`, `sprites.truck_waiting_area.stalls`, `sprites.loading_ramp_container.docks`, `overlay.queue_badge`, `cargo.container_teu`); `src/render/{vehicle-view,lane,turn-arc,module-view,entity-layer,view-models}.ts`; „Render view-modely"
- outputs: src/render/{truck-view,…}.ts; tests/render/**; demo `f4-render` + e2e spec + screenshot `f4-render-demo.png`
- požiadavky:
  - `TruckView` používa pruhy, oblúky a typy ciest ako `VehicleView` (zdieľaná `vehiclePose`); sprite 1×2 orientovaný kabínou v smere jazdy a zmenšený na šírku pruhu; `empty`/`loaded`.
  - Brána: závora (`parts.barrier`) animovaná `closedDeg ↔ openDeg` podľa `gate.open`, `queue_badge` s číslom pri vstupnej strane, keď `queueLength > 0`.
  - Stojisko: obsadené `stalls` zvýraznené. Rampa: staged kontajnery na docks (`cargo.container_teu`); neprevádzková rampa má `warning_badge`.
  - Demo: brána s frontou 3, stojisko 4/6, rampa s 2 staged a 1 kamión v docku, kamióny na ceste a v zákrute. Prezri screenshot (Read) a popíš ho.
- acceptance:
  - `pnpm vitest run tests/render`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/ui/**, src/app/**, data/**, assets/**
- estimate: M

### T04-07 · UI: inspector brány, stojiska a rampy; BuildBar Landside moduly
- model: sonnet
- agent: ui-builder
- parallel: yes (worktree od T04-01)
- depends_on: T04-01
- inputs: design/ui/game-ui.source.html (`insp_gate`, BuildBar `landside`); `src/ui/{module-inspector,build-bar}.tsx`
- outputs: src/ui/**; demo + screenshot `f4-ui-demo.png`; tests/ui/**
- požiadavky:
  - `ModuleInspectorData` rozšíriť spätne kompatibilne:
    - `gate?: { queueLength; throughputPerHour; processTicks }`
    - `waitingArea?: { bays; occupied; reserved }`
    - `ramp?: { docks: { staged; capacity; truck: boolean }[]; operational; inoperativeReason?: string }`
  - Badge „Neprevádzková" s dôvodom (vzor `insp_gate` „Nepripojené").
  - BuildBar Landside: zástupné položky (Vrátnica, Čakacia plocha, Rampa) nahradí skutočnými položkami (kind gate/waiting_area/ramp z defov). To urobí T04-08, tu len overiť, že komponent to zvládne.
  - Demo + screenshot. Prezri ho (Read) a porovnaj s prototypom.
- acceptance:
  - `pnpm vitest run tests/ui`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/render/**, src/app/**, data/**
- estimate: S

### T04-08 · App: snapshot v4, napojenie, toasty
- model: sonnet
- agent: implementer
- parallel: yes (s T04-09)
- depends_on: T04-04, T04-06, T04-07
- inputs: src/app/** (F3); „Spoločné rozhrania", „Render view-modely"
- outputs: src/app/**; tests/app/**
- požiadavky:
  - `EntitiesVM.trucks` (prev poloha a kurz ako pri vozidlách), `ModuleVM.gate`, `waitingArea`, `ramp`. `revision` zvyšujú `Truck*`, `NoWaitingBay` a `RampOperationalChanged`.
  - BuildBar Landside: gate, waiting area a ramp z defov; zástupné položky odstráň.
  - Inspector brány, stojiska a rampy.
  - Toasty:
    - „Chýba čakacia plocha" / „Stojisko je plné" (`NoWaitingBay`);
    - „Rampa neprevádzková — ⟨dôvod⟩" (`RampOperationalChanged` na false) s akciou „Ukázať".
  - `REASON_TEXT` doplniť o nové dôvody.
- acceptance:
  - `pnpm vitest run tests/app`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T04-09 · Tooling: `simrun` metriky kamiónov a exportu
- model: sonnet
- agent: implementer
- parallel: yes (s T04-08)
- depends_on: T04-04, T04-05
- inputs: tools/simrun.ts; tests/tools/**; data/scenarios/full_import_chain.json
- outputs: tools/simrun.ts; tests/tools/*.test.ts
- požiadavky: nové kľúče `trucksSpawned`, `trucksExited`, `gateQueueMax`, `noWaitingBayEvents`, `ticksToAllExported` (prvý tick, keď po spawne lode platí `exportedCount === createdCount`, inak `null`). `exportedUnits` = `cargo.exportedCount` (už existuje).
- acceptance:
  - `pnpm -s simrun data/scenarios/full_import_chain.json --ticks 40000 --report | jq -e '.lostUnits == 0 and .exportedUnits == 120 and .ticksToAllExported != null'`
  - `pnpm vitest run tests/tools && pnpm typecheck && pnpm lint`
- do_not_touch: src/**, data/defs/**, data/maps/**
- estimate: S

### T04-10 · E2E: celý reťazec, screenshoty
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T04-08, T04-09
- inputs: tests/e2e/** (vzor `f3-vehicles-yard.spec.ts`); dev hook
- outputs: tests/e2e/f4-export-chain.spec.ts; screenshoty `f4-trucks-gate.png`, `f4-exported.png`
- požiadavky: cez UI (BuildBar) postaviť bránu, stojisko a rampu k rozloženiu F3 (zvyšok môže ísť cez `dispatchJSON`), spawn lode s 24 TEU. Čakať cez `window.__sim`: kamión vo fronte brány alebo v stojisku → `f4-trucks-gate.png`; všetko `exported` → `f4-exported.png`. Prezri ich (Read) a popíš.
- acceptance:
  - `CI=1 pnpm test:e2e`
  - `test -s tests/e2e/__screenshots__/f4-trucks-gate.png -a -s tests/e2e/__screenshots__/f4-exported.png`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T04-11 · Review `src/sim/**`
- model: opus
- agent: sim-reviewer
- parallel: no
- depends_on: T04-04, T04-05, T04-09
- inputs: `git diff phase/03-vehicles-yard..HEAD -- src/sim tests/sim data tools`
- acceptance: verdikt MERGE (0 blocking)
- do_not_touch: všetko
- estimate: S

### T04-12 · Opravy z review + ARCHITECTURE zosúladenie
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T04-11
- outputs: src/sim/** (opravy s testami); docs/ARCHITECTURE.md (§4.2 moduly landside, §5, §6 krok 8, §7.3 bod 2, §7.5, §12, §13, §14, §18 do ADR-024)
- acceptance:
  - `grep -n 'ADR-024' docs/ARCHITECTURE.md`
  - `pnpm -s simrun data/scenarios/full_import_chain.json --ticks 40000 --report | jq -e '.lostUnits == 0 and .exportedUnits == 120'`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T04-13 · Plná pipeline + triáž
- model: haiku
- agent: test-runner
- parallel: no
- depends_on: T04-01..T04-12
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs && pnpm build`
  - `pnpm -s simrun data/scenarios/full_import_chain.json --ticks 40000 --report | jq -e '.lostUnits == 0 and .exportedUnits == 120'` (namiesto `vertical_slice` do F5)
  - `apron_to_yard`, `f2_unload`, `f1_roads` bez regresie
  - `CI=1 pnpm test:e2e` + screenshoty `f4-trucks-gate.png`, `f4-exported.png`
- do_not_touch: všetko
- estimate: S

### T04-14 · Uzavretie fázy (PROGRESS, BACKLOG) + PR
- model: haiku
- agent: docs-keeper
- parallel: no
- depends_on: T04-13
- outputs: docs/tasks/phase-04.md (checklist); docs/PROGRESS.md; docs/BACKLOG.md
- acceptance: `! grep -n '^- \[ \] T04-' docs/tasks/phase-04.md`
- do_not_touch: všetko mimo outputs
- estimate: S
