# Fáza 3 — Vozidlá, pathfinding, dispatcher, sklad · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 3" (+ riadok Model mix), AGENTIC_WORKFLOW §9 (vzorový priebeh F3), ARCHITECTURE §4.2, §4.4, §4.6 (`logistics.json`), §5.3, §6 (kroky 5, 6, 11, 12), §7.1, §7.3, §7.4, §7.6, §7.7, §7.8, §8 (bod 5), §12, §13, §15; ADR-004, ADR-010, ADR-011, ADR-014..016.
> Vetva: `phase/03-vehicles-yard` (stacked nad `phase/02-berth-ship-crane`, PR hilkovics/Harbor#3). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> Assety: `assets/manifest.json` — `sprites.container_yard_small` (`states.fill00..fill100`, `connectors`, `slots 32`, `layers 2`), `sprites.vehicle_depot` (`stalls 6`, `connectors`), `entities.straddle_carrier.states.{empty,loaded}`, `overlay.{warning_badge,path_arrow,queue_badge}`. UI prototyp: `design/ui/game-ui.source.html` (BuildBar Sklady/Logistika, `insp_yard`, `insp_depot`, toasty).

**Cieľ:** kontajnery z apronu fyzicky prevezú straddle carriers do kontajnerového dvora; dvor ukazuje zaplnenosť.
**Akceptácia fázy:** v hre vidím vozidlá jazdiť po cestách a dvor sa vizuálne zapĺňa. Testy: A* nájde najkratšiu cestu na známom bludisku a bez cesty vráti `null`; cache sa po odstránení bunky invaliduje; alokátor vyberie bližší z dvoch skladov a rešpektuje `reserved`; dispatcher nepriradí job vozidlu bez kompatibility; **scenár** `apron_to_yard.json` (1 loď 120 TEU, 2 vozidlá, 2 dvory) → po ≤ 15 000 tickoch sú všetky jednotky `in_storage`, konzervácia platí a žiadne vozidlo nie je v pohybe bez cesty.

**Rozhodnutia orchestrátora (zapíšu sa do ADR-017..019 v kartách sim-architecta):**
1. **Pohyb vozidla** ide po bunkách s `road === 'road'` (4-susednosť). Vozidlo má float polohu (stred bunky = `x + 0.5`) a progres v rámci úseku bunka → bunka rýchlosťou `speedCellsPerTick`; zvyšok kroku sa prenáša do ďalšieho úseku. Kurz je kardinálny podľa smeru úseku. Žiadna trigonometria, soft kongescia bez kolízií (§7.6); spomalenie od hustoty až vo F11.
2. **Vstup do modulu:** cieľ cesty je **vonkajšia bunka konektora**, t. j. bunka susediaca s konektorom na strane `side`, mimo footprintu. Po príchode je vozidlo „vnútri" (§7.3 bod 4): najprv čaká `internalTicks` (`params.internalTicks` modulu, inak `logistics.defaultInternalTicks`), potom sekvenčne po jednotkách `loadTicks`/`unloadTicks`; `CargoLedger.move` jednotky nastane až po dokončení jej load/unload. Potom vozidlo stojí znova na vonkajšej bunke.
3. **Pripojenie modulu:** modul je pripojený, ak vonkajšia bunka aspoň jedného jeho konektora typu `road` má cestu. Nepripojený modul dispatcher ignoruje, UI ukáže „Nepripojené". §8 bod 5: vonkajšia bunka konektora musí mať cestu alebo byť voľná pre cestu (v mape, terén unesie cestu, bez footprintu modulu), inak by modul nešiel pripojiť nikdy (`connector_blocked`).
4. **Vozidlá a depo:**
   - `BuyVehicle { vehicleDefId, depotId }` vyžaduje voľný stall v depe (`params.capacity`, `depot_full`). Vozidlo sa objaví ako `idle` na vonkajšej bunke konektora depa; depo musí byť pripojené (`not_connected`).
   - `SellVehicle { vehicleId }` je povolený len pre vozidlo v stave `idle` a bez nákladu. Refund = `refundCents(purchaseCostCents, removalRefundRate)`; kategórie ledgera `vehicle_capex` a `vehicle_sale`.
   - Vozidlo patrí depu (`depotId`). Depo s vozidlami nejde odstrániť (`has_vehicles`). Voľné vozidlo ostane tam, kde skončilo; návrat do depa ide do backlogu.
5. **Pathfinder:** A* na road bunkách s Manhattan heuristikou a cenou bunky 1 (penalizácia kongescie až vo F11). Binárna halda nad `Int32Array`, znovupoužiteľné polia s generačným počítadlom, bez alokácie na volanie okrem výsledného poľa. `PathCache: Map<key(from,to), readonly number[]>` sa pri `RoadChanged` celá invaliduje. `DistanceMatrix` medzi vonkajšími bunkami konektorov je lazy a invaliduje sa rovnako. `Grid.neighbors4` sa v A* nepoužíva, iteruje sa `DIRECTIONS_4` + `index`.
6. **Dispatcher (krok 5):** inbound (§7.3 bod 1) + priradenie (§7.3 bod 3). Outbound príde vo F4.
   - `StorageAllocator` vyberie sklad s kompatibilnou kategóriou, ktorý je pripojený, má voľnú kapacitu (`stored + reserved < capacity`) a je najbližší podľa `DistanceMatrix` od kotviska; pri zhode rozhoduje menšie id. Rezervácia vzniká pri vytvorení jobu.
   - Keď sklad chýba, vznikne `NoStorageAvailable { berthId, cargoTypeId }`, najviac 1× za hernú hodinu na berth.
   - Priradenie: voľné kompatibilné vozidlo s najmenšou cenou cesty k vyzdvihnutiu; pri zhode rozhoduje menšie id. Vozidlo s kapacitou 1 berie 1 job.
7. **Vehicle FSM:** stavy `idle → to_pickup → loading → to_dropoff → unloading → idle` + `no_path`.
   - `no_path`: vozidlo čaká a skúša znova každých `logistics.repathIntervalTicks`. Žiadne vozidlo v `to_*` nie je bez platnej cesty.
   - Pri `RoadChanged` sa preplánuje z aktuálnej bunky.
   - `RemoveRoad` odmietne bunku, na ktorej je vozidlo (`occupied`).
8. **Náklad:**
   - Pri vyzdvihnutí ide `on_apron → in_vehicle`, slot apronu sa uvoľní a žeriav sa odblokuje. Pri vyložení ide `in_vehicle → in_storage(moduleId, slot)`.
   - `StorageModule` drží len rezervácie; obsadenie číta z ledgera (review T02-13). `ApronBuffer` sa zosúladí rovnako.
9. **Traffic:** `cell.traffic += 1` za každý tick, kým je vozidlo na bunke. Pri `HourClosed` sa násobí `logistics.congestion.trafficDecayPerHour` (krok 11, minimálny `MetricsSystem`).
10. **WorldState v3** = v2 + `vehicles` + `jobs` (+ čo sa nedá odvodiť); `migrate(v2 → v3)`.

**Doplnok od používateľa (2026-09-30): pruhy a typy ciest.** Vozidlá dnes jazdia stredom cesty cez oba pruhy. Požiadavka: nech jazdia v jednom pruhu, a potom nech sú aj jednosmerná, dvojpruhová a jednopruhová cesta. Rozhodnutia orchestrátora (→ ADR-020 v T03-18):
11. **Pruh je prezentačný.** Sim modeluje cestu ako graf buniek (vozidlo ide stredom bunky, determinizmus aj pathfinding ostávajú); pruh je offset v renderi. Premávka je **pravostranná**.
    - Sprite `road_*` má asfalt 52 px (x 6–58) a stredovú čiaru na x 32. Jeden pruh má teda 26 px a jeho stred je ±13/64 bunky od osi. Vozidlo sa škáluje na šírku pruhu.
    - V zákrute sa poloha interpoluje medzi offsetom predchádzajúceho a aktuálneho úseku (`prevHeading` vo VM).
12. **Typy ciest** (`roadKind` na bunke s `road === 'road'`), parametre v `infrastructure.json → roadKinds`:
    - `two_lane`: obojsmerná dvojpruhová (dnešná cesta, štartové cesty mapy), vozidlá v pravom pruhu.
    - `one_lane`: obojsmerná jednopruhová (úzka, lacnejšia, pomalšia: `speedFactor < 1`), vozidlá v strede.
    - `one_way`: jednosmerná jednopruhová (úzka), vozidlá v strede. Bunka má smer `roadDir` (N/E/S/W) daný smerom ťahu myšou; v rohu platí smer do ďalšej bunky, na poslednej bunke smer z predchádzajúcej.
    - Pathfinding: prechod A → B je povolený, ak `A` nie je `one_way` alebo `dir(A→B) === A.roadDir`, a zároveň `B` nie je `one_way` alebo `dir(A→B) !== opačný(B.roadDir)`. Cena bunky = `1 / speedFactor` (≥ 1, heuristika ostáva prípustná). Rýchlosť vozidla na bunke = `speedCellsPerTick × speedFactor`.
    - `PlaceRoad { cells, kind?, dirs? }`: `kind` je predvolene `two_lane`, `dirs` sú len pri `one_way`.
    - Položenie na bunku s cestou iného typu alebo smeru ju **prestavia** v jednom atomickom kroku, ekvivalentnom `RemoveRoad + PlaceRoad`: cena = nový typ − `refundCents(starý typ)`. Rovnaký typ aj smer sa preskočí zadarmo (ako doteraz). Bunka s vozidlom → `occupied`.
    - Grafika: úzke cesty a šípky jednosmerky zatiaľ procedurálne z tokenov + `overlay.path_arrow`. Sprity z Claude Design ide do BACKLOG s promptom v DESIGN_BRIEF §8.

## Checklist
- [x] T03-01 · Defy: `vehicles.json`, `logistics.json`, `container_yard_small` + `vehicle_depot` v `modules.json`, schémy, DefRegistry, manifest krížovo pre vozidlá
- [x] T03-02 · Sim: `StorageModule` + `ContainerYard` + `VehicleDepot`, pripojenie k ceste, §8 bod 5; ApronBuffer len rezervácie; ADR-017
- [x] T03-03 · Sim: `Pathfinder` (A*) + `PathCache` + `DistanceMatrix`
- [x] T03-04 · Sim: `Vehicle` + `BuyVehicle`/`SellVehicle` + WorldState v3 (vozidlá)
- [x] T03-05 · Sim: `TransportJob` + `StorageAllocator` + `Dispatcher` (krok 5) + `NoStorageAvailable`; ADR-018
- [x] T03-06 · Sim: Vehicle FSM + pohyb + load/unload + traffic (kroky 6, 11) + preplánovanie; ADR-019
- [x] T03-07 · Testy (TDD): scenár `apron_to_yard`, A*/cache/alokátor/dispatcher cez verejné API
- [x] T03-08 · Render: `VehicleView` + fill stavy dvora + badge „nepripojené"
- [x] T03-09 · UI: BuildBar Sklady/Logistika, inspector skladu a depa, `Toasts`
- [x] T03-10 · App: snapshot v3 (vozidlá, sklady), napojenie renderu a UI, nákup/predaj vozidla, notifikácie
- [x] T03-11 · Tooling: `simrun` metriky vozidiel a skladov
- [ ] T03-12 · E2E: loď → apron → vozidlá → dvor, screenshot
- [x] T03-13 · Review `src/sim/**` (hot path alokácie)
- [x] T03-14 · Opravy z review + ARCHITECTURE zosúladenie
- [ ] T03-15 · Plná pipeline + triáž
- [ ] T03-16 · Uzavretie fázy (PROGRESS, BACKLOG) + PR
- [x] T03-17 · Render: vozidlá v pravom pruhu (offset, škála na šírku pruhu, plynulá zákruta) — doplnok používateľa
- [x] T03-18 · Sim: typy ciest `two_lane` / `one_lane` / `one_way` (defy, PlaceRoad, prestavba, pathfinding so smerom a cenou, rýchlosť, save); ADR-020 — doplnok používateľa
- [x] T03-19 · Render: úzke cesty, šípky jednosmerky, pruh podľa typu cesty — doplnok používateľa
- [x] T03-20 · App/UI: výber typu cesty (BuildBar Landside), smer jednosmerky ťahom, tooltip ceny prestavby — doplnok používateľa

Vlny: 01 → 02 → 03 → 04 → 05 → 06 (sim sériovo) ‖ {07 (TDD, worktree od 01), 08 (worktree od 01), 09 (worktree od 01), 17 (worktree)} → {10 ‖ 11 ‖ 18 (sim)} → {19 ‖ 20} → 12 → 13 → 14 → 15 → 16.
Single writer `src/sim/**`: T03-01 (defs), potom T03-02..T03-06 sériovo, T03-18, T03-14.

## Spoločné rozhrania (záväzné pre paralelné karty)

```ts
// src/sim/defs
interface VehicleDef { id; displayName; capacityUnits; speedCellsPerTick; loadTicks; unloadTicks;
  cargoCategories: CargoCategory[]; purchaseCents; wagePerDayCents; techRequired?: string }   // katalóg defs.vehicles
interface LogisticsDef { schemaVersion: 1; defaultInternalTicks: number; repathIntervalTicks: number;
  congestion: { trafficDecayPerHour: number; slowdownPerExtraVehicle: number; penaltyTrafficDivisor: number; penaltyMax: number } }
interface StorageParams { capacityUnits: number; category: CargoCategory; internalTicks?: number }   // kind 'storage'
interface DepotParams { capacity: number; internalTicks?: number }                                   // kind 'depot'

// src/sim/modules
abstract class StorageModule extends Module { readonly params: StorageParams; readonly capacity: number;
  readonly storedCount: number; readonly reservedCount: number; readonly freeCount: number;   // free = capacity − stored − reserved
  readonly unitsIn: number; readonly unitsOut: number }                                           // kumulatívne počítadlá
class ContainerYard extends StorageModule {}
class VehicleDepot extends Module { readonly params: DepotParams; readonly vehicleIds: readonly EntityId[] }
// World: isConnected(module): boolean; connectorCells(module): readonly { connector, outside: CellCoord, hasRoad: boolean }[]

// src/sim/logistics
class Pathfinder { findPath(fromIndex: number, toIndex: number): readonly number[] | null }   // indexy road buniek vrátane from a to
type JobState = 'open' | 'assigned' | 'picking' | 'moving' | 'dropping' | 'done';
interface TransportJob { readonly id: EntityId; readonly unitIds: readonly EntityId[]; readonly from: CargoLocation; readonly to: CargoLocation;
  readonly fromModuleId: EntityId; readonly toModuleId: EntityId; vehicleId: EntityId | null; state: JobState; readonly createdTick: number }
// World: readonly jobs: ReadonlyMap<EntityId, TransportJob>

// src/sim/vehicles
type VehicleState = 'idle' | 'to_pickup' | 'loading' | 'to_dropoff' | 'unloading' | 'no_path';
class Vehicle { readonly id: EntityId; readonly defId: string; readonly def: VehicleDef; readonly depotId: EntityId;
  readonly state: VehicleState; x: number; y: number;          // stred v bunkách (float)
  heading: Rotation; jobId: EntityId | null; readonly purchaseCostCents: number }
// World: readonly vehicles: ReadonlyMap<EntityId, Vehicle>
```

Príkazy (JSON):
- `{ "type": "BuyVehicle", "vehicleDefId": "straddle_carrier", "depotId": 3 }`
- `{ "type": "SellVehicle", "vehicleId": 7 }`

Nové `ValidationReason`: `unknown_vehicle_def`, `unknown_depot`, `depot_full`, `not_connected`, `unknown_vehicle`, `vehicle_busy`, `has_vehicles`, `connector_blocked`.

Nové `SimEvent`: `VehicleBought { vehicleId, defId, depotId }` · `VehicleSold { vehicleId }` · `JobCreated { jobId, unitIds, fromModuleId, toModuleId }` · `JobAssigned { jobId, vehicleId }` · `JobDone { jobId }` · `VehicleStateChanged { vehicleId, from, to }` · `NoStorageAvailable { berthId, cargoTypeId }`. `MoneyChanged.reason` += `vehicle_capex`, `vehicle_sale`.

Render view-modely (`src/render/view-models.ts`, T03-08 ich doplní, T03-10 plní):
```ts
interface VehicleVM { id: number; defId: string; x: number; y: number; prevX: number; prevY: number;
  heading: 0 | 90 | 180 | 270; loaded: boolean; state: string }
// ModuleVM += storage?: { capacity: number; stored: number; reserved: number }; connected?: boolean   (moduly s konektormi)
// EntitiesVM += vehicles: readonly VehicleVM[]
// fillState (render): stored === 0 → 0; stored >= capacity → 100; inak pomer < 0.375 → 25, < 0.625 → 50, inak 75
```

---

### T03-01 · Defy: `vehicles.json`, `logistics.json`, `container_yard_small` + `vehicle_depot`, schémy, DefRegistry, manifest krížovo
- model: sonnet
- agent: implementer
- parallel: no (mení `src/sim/defs` — single writer)
- depends_on: –
- inputs: ARCHITECTURE §4.2, §4.4, §4.6, §5.3; ADR-009, ADR-010; „Spoločné rozhrania"; `assets/manifest.json` (`sprites.container_yard_small`, `sprites.vehicle_depot`, `entities.straddle_carrier`); `design/ui/game-ui.source.html` (ceny vozidiel v BuildBar Logistika); data/defs/*.json; data/schemas/*.json; src/sim/defs/**; tools/validate-defs.ts
- outputs: data/defs/{vehicles,logistics}.json; data/defs/modules.json (+2 položky); data/schemas/{vehicles,logistics}.schema.json; data/schemas/modules.schema.json; src/sim/defs/{types,def-registry,module-def,…}.ts; tools/validate-defs.ts (krížovo `vehicles.json` → `entities[id]`); testy v tests/sim/defs, tests/tools
- požiadavky:
  - `vehicles.json`: `straddle_carrier` { displayName „Straddle carrier", capacityUnits 1, speedCellsPerTick 0.4, loadTicks 3, unloadTicks 3, cargoCategories [container], purchaseCents 4 800 000, wagePerDayCents 18 000 }.
  - `logistics.json` (konfiguračný, ADR-010): { defaultInternalTicks 6, repathIntervalTicks 30, congestion { trafficDecayPerHour 0.9, slowdownPerExtraVehicle 0.25, penaltyTrafficDivisor 200, penaltyMax 3 } }.
  - `modules.json`:
    - `container_yard_small` { kind `storage`, displayName „Kontajnerový dvor S", footprint 4×4, placement { requiredTerrain [land, quay], requiresParcelOwnership true }, connectors z manifestu (`{x:1,y:3,side:'s',type:'road'}`), costCents 15 000 000, maintenancePerDayCents 30 000, params { capacityUnits 64, category container } }
    - `vehicle_depot` { kind `depot`, displayName „Depo vozidiel", footprint 3×3, [land, quay], connectors z manifestu (`{x:1,y:2,side:'s',type:'road'}`), costCents 9 000 000, maintenancePerDayCents 15 000, params { capacity 6 } }
    - `capacityUnits` musí sedieť so `slots × layers` v manifeste (32 × 2 = 64) a `capacity` so `stalls` (6). Otestuj to.
  - `MODULE_PARAM_SPECS` doplniť o `storage` (`StorageParams`) a `depot` (`DepotParams`), typované gettery `storageParams(def)`, `depotParams(def)`; katalóg `defs.vehicles`, singleton `defs.logistics`. Fail-fast `DefError` s cestou.
- acceptance:
  - `pnpm validate:defs` (vrátane `vehicles`, `logistics` a manifestu)
  - `pnpm vitest run tests/sim/defs tests/tools`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/{core,grid,cargo,modules,ships,systems,world,commands,events}/**, src/render/**, src/ui/**, src/app/**, eslint.config.js, .claude/**
- estimate: S

### T03-02 · Sim: `StorageModule` + `ContainerYard` + `VehicleDepot`, pripojenie k ceste, §8 bod 5; ApronBuffer len rezervácie; ADR-017
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-01
- inputs: ARCHITECTURE §5, §7.7, §8 (bod 5); ADR-014, ADR-015; „Rozhodnutia orchestrátora" 3, 4, 8; review T02-13 (ApronBuffer druhý zápis polohy); `src/sim/modules/**`, `src/sim/world/{module-rules,world,world-state,world-restore,world-invariants}.ts`
- outputs: src/sim/modules/{storage-module,container-yard,vehicle-depot,…}.ts; src/sim/modules/apron-buffer.ts; src/sim/world/**; docs/DECISIONS.md (ADR-017); tests/sim/modules/**, tests/sim/world/**
- požiadavky:
  - `StorageModule` (abstraktná, pravidlo 7) + `ContainerYard` + `VehicleDepot` registrované v `ModuleRegistry`. Sklad drží len **rezervácie slotov**, obsadenie sa číta z ledgera (`in_storage`). `ApronBuffer` sa zosúladí rovnako (obsadenie z `on_apron`, buffer drží len rezervácie + FIFO poradie, ak ho ledger nedá). Počítadlá `unitsIn`/`unitsOut` sa ukladajú.
  - `World.isConnected(module)` a `World.connectorCells(module)` (konektory po rotácii, vonkajšia bunka, `hasRoad`). §8 bod 5 v `module-rules.ts`: `connector_blocked`, keď žiadny `road` konektor nemá vonkajšiu bunku s cestou alebo voľnú pre cestu. Na berth sa vzťahuje tiež, ostatné pravidlá berthu zostávajú.
  - `RemoveModule`: sklad s `stored + reserved > 0` → `has_cargo`; depo s vozidlami → `has_vehicles` (vozidlá pribudnú v T03-04, pravidlo priprav).
  - `PlaceRoad`/`RemoveRoad` nesmú zasiahnuť footprint modulu (už platí). `RoadChanged` ovplyvní pripojenie, ktoré sa počíta z mriežky, nie z cache.
  - WorldState: nové moduly v save (runtime sklad = rezervácie + počítadlá). Migrácia v2 → v3 môže vzniknúť tu alebo až v T03-04, zdokumentuj to.
  - ADR-017: model skladu (rezervácie v module, obsadenie v ledgeri), pripojenie modulu, §8 bod 5, depo a kapacita.
- acceptance:
  - `pnpm vitest run tests/sim/modules tests/sim/world tests/sim/commands`
  - `grep -c '^## ADR-017:' docs/DECISIONS.md` = 1
  - `pnpm -s simrun data/scenarios/f2_unload.json --ticks 5000 --report | jq -e '.lostUnits == 0 and .shipsDeparted == 1 and .unitsOnApron == 4'`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T03-03 · Sim: `Pathfinder` (A*) + `PathCache` + `DistanceMatrix`
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-02
- inputs: ARCHITECTURE §7.4, §7.6; „Rozhodnutia orchestrátora" 5; BACKLOG P2 „Grid.neighbors4 alokuje pole"; `src/sim/grid/**`
- outputs: src/sim/logistics/{pathfinder,binary-heap,path-cache,distance-matrix,index}.ts; tests/sim/logistics/**
- požiadavky:
  - A* nad road bunkami, Manhattan heuristika, cena bunky 1 (API pripravené na penalizáciu F11 cez funkciu ceny bunky). Deterministický tie-break: pri rovnakom `f` menšie `h`, potom menší index bunky. Binárna halda nad `Int32Array` (+ `Float64Array`, ak treba), znovupoužiteľné polia s generačným počítadlom, **žiadna alokácia v cykle**.
  - `findPath(from, to)` vráti pole indexov vrátane `from` a `to`, alebo `null`. `from === to` → `[from]`. Bunka bez cesty → `null`.
  - `PathCache` (kľúč z oboch indexov) a `DistanceMatrix` (lazy, dĺžka cesty alebo `Infinity`) sa invalidujú pri `RoadChanged` cez `World` (verzia ciest `roadVersion`, bez odberu udalostí).
  - Testy: známe bludisko (najkratšia cesta, dĺžka), neexistujúca cesta → `null`, invalidácia po `RemoveRoad`, determinizmus rovnakých ciest, výkon (napr. 1 000 hľadaní na 96×64 do limitu, ktorý zvolíš a zdokumentuješ), žiadny rast alokácií (heap snapshot netreba, stačí kontrola znovupoužitia bufferov).
- acceptance:
  - `pnpm vitest run tests/sim/logistics`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T03-04 · Sim: `Vehicle` + `BuyVehicle`/`SellVehicle` + WorldState v3 (vozidlá)
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-03
- inputs: ARCHITECTURE §4.4, §5, §9.2 (ledger kategórie), §14; „Rozhodnutia orchestrátora" 4, 10; „Spoločné rozhrania"; `src/sim/commands/**` (vzor `spawn-ship-debug.ts`, `refund.ts`, `payload.ts`)
- outputs: src/sim/vehicles/{vehicle,vehicle-error,index}.ts; src/sim/commands/{buy-vehicle,sell-vehicle}.ts; src/sim/events/sim-event.ts; src/sim/world/{world,world-state,world-restore,migrate,world-invariants}.ts; tests/sim/vehicles/**, tests/sim/commands/**, tests/sim/world/**
- požiadavky:
  - `Vehicle` (trieda, stav privátny + getter ako `Ship`, FSM tabuľku doplní T03-06; tu stačí `idle`). `World.vehicles`, `addVehicle`/`removeVehicle` s `VehicleError`.
  - `BuyVehicle`: `unknown_vehicle_def`, `unknown_depot`, `depot_full`, `not_connected`, `insufficient_funds`. `apply`: vozidlo `idle` na vonkajšej bunke konektora depa, `cash −= purchaseCents`, `VehicleBought` + `MoneyChanged(vehicle_capex)`.
  - `SellVehicle`: `unknown_vehicle`, `vehicle_busy` (nie `idle` alebo má náklad/job). Refund cez `refundCents` → `VehicleSold` + `MoneyChanged(vehicle_sale)` pri refunde > 0.
  - `RemoveModule` depa s vozidlami → `has_vehicles`.
  - WorldState v3 (vozidlá: id, defId, depotId, poloha, kurz, stav, cena) + `migrate(v2 → v3)` (prázdne vozidlá). Náklad `in_vehicle` sa pri obnove overí voči existencii vozidla (`CARGO_HOLDER_SOURCES`).
- acceptance:
  - `pnpm vitest run tests/sim/vehicles tests/sim/commands tests/sim/world`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T03-05 · Sim: `TransportJob` + `StorageAllocator` + `Dispatcher` (krok 5) + `NoStorageAvailable`; ADR-018
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-04
- inputs: ARCHITECTURE §6 (krok 5), §7.3, §7.7, §7.8; „Rozhodnutia orchestrátora" 6, 8; testy T03-07 (ak už sú)
- outputs: src/sim/logistics/{transport-job,storage-allocator,dispatcher}.ts; src/sim/systems/dispatcher-system.ts; src/sim/world/**; docs/DECISIONS.md (ADR-018); tests/sim/logistics/**, tests/sim/systems/**
- požiadavky:
  - Inbound: pre každú jednotku `on_apron` bez jobu (poradie: berthy podľa id, jednotky FIFO) → `StorageAllocator.reserve(cargoType, fromBerth)` → job `open` s rezervovaným slotom (`to = in_storage(moduleId, slot)`). Bez skladu → `NoStorageAvailable`, najviac 1× za hodinu na berth.
  - Priradenie: pre `open` joby v poradí vzniku vyber `idle` vozidlo s kompatibilnou kategóriou a najmenšou cenou cesty (DistanceMatrix alebo Pathfinder) k vonkajšej bunke konektora zdroja; pri zhode rozhoduje menšie id. Bez dosiahnuteľného vozidla ostáva job `open`. `JobCreated`/`JobAssigned`.
  - Joby sú v `World.jobs` a v save (v3). Rezervácie skladu sa odvodia z jobov alebo uložia, podľa toho, čo je jednoduchšie a overiteľné invariantom.
  - Bez alokácií v hot path, kde to ide (predalokované pracovné polia, žiadne `filter/map` v cykle za tick).
  - Invarianty: každý job `open/assigned/picking` má rezervovaný slot v cieli; žiadna jednotka nemá 2 aktívne joby; vozidlo má najviac 1 job.
  - ADR-018: dispatcher, alokátor, poradie a tie-breaky, throttle `NoStorageAvailable`, joby v save.
- acceptance:
  - `pnpm vitest run tests/sim/logistics tests/sim/systems`
  - `grep -c '^## ADR-018:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T03-06 · Sim: Vehicle FSM + pohyb + load/unload + traffic (kroky 6, 11) + preplánovanie; ADR-019
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-05
- inputs: ARCHITECTURE §6 (kroky 6, 11), §7.1, §7.3 (bod 4), §7.6, §7.8; ADR-011; „Rozhodnutia orchestrátora" 1, 2, 7, 8, 9; testy T03-07 vo worktree
- outputs: src/sim/vehicles/vehicle-fsm.ts; src/sim/systems/{vehicle-system,metrics-system}.ts; src/sim/world/**; docs/DECISIONS.md (ADR-019); tests/sim/vehicles/**, tests/sim/systems/**; TDD testy T03-07 (zlúčiť, zazeleniť)
- požiadavky:
  - FSM s tabuľkou prechodov (`idle → to_pickup → loading → to_dropoff → unloading → idle`, `to_* ↔ no_path`), `VehicleStateChanged`.
  - Pohyb podľa rozhodnutia 1; cesta z `PathCache`; pri zmene `roadVersion` preplánovanie z aktuálnej bunky (pri pohybe medzi bunkami z cieľovej bunky úseku). `no_path` → retry každých `repathIntervalTicks`.
  - Pobyt v module: `internalTicks` + sekvenčne `loadTicks`/`unloadTicks` za jednotku; `move` až po dokončení jednotky (`on_apron → in_vehicle`, `in_vehicle → in_storage`). Po unload job `done` → `JobDone`, vozidlo `idle`.
  - Krok 11: `traffic += 1` za vozidlo na bunke každý tick, pri `HourClosed` `traffic *= trafficDecayPerHour`, pod prahom (napr. < 1e-3) 0.
  - `RemoveRoad` odmietne bunku s vozidlom (`occupied`). Odstránenie cesty pod trasou → preplánovanie.
  - Save v3: stav FSM, cesta alebo index (alebo preplánovanie po načítaní, ak je deterministické), progres, zostávajúce ticky pobytu. Roundtrip uprostred jazdy aj pobytu → identický ďalší priebeh.
  - TDD testy T03-07: `git checkout <vetva T03-07> -- <súbory>` a zazeleniť bez úprav. Prípadné úpravy zdôvodni.
  - ADR-019: pohyb, pobyt v module, `no_path`, traffic, save vozidiel.
- acceptance:
  - `pnpm vitest run tests/sim/vehicles tests/sim/systems tests/sim/scenarios tests/sim/invariants`
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0'`
  - `! grep -rnE 'Math\.(sin|cos|tan|atan2?|asin|acos)\b' src/sim`
  - `grep -c '^## ADR-019:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/defs/**, data/maps/**
- estimate: L

### T03-07 · Testy (TDD): scenár `apron_to_yard`, A*/cache/alokátor/dispatcher cez verejné API
- model: sonnet
- agent: test-writer
- parallel: yes (worktree od T03-01; zlúči sa v T03-06)
- depends_on: T03-01
- inputs: „Akceptácia fázy", „Rozhodnutia orchestrátora", „Spoločné rozhrania"; tests/sim/scenarios/** a tests/sim/helpers/** z F2 (štýl, `recordRun`, `runUntil`); data/maps/harbor_01.json (Root berth x 40–47 y 14–16, konektory berthu → vonkajšie bunky (41,17) a (46,17); starter parcela x 30–57, y 14–33; štartová cesta x=44, y 34..63)
- outputs: data/scenarios/apron_to_yard.json; tests/sim/scenarios/f3-apron-to-yard.test.ts; tests/sim/scenarios/f3-dispatch.test.ts; tests/sim/invariants/f3-conservation.test.ts
- požiadavky (len verejné API a JSON príkazy):
  - `apron_to_yard.json` (seed 3003): na tick 0 postaví cesty, 2× `container_yard_small`, 1× `vehicle_depot` na starter parcele (rozloženie navrhni tak, aby boli pripojené a vzdialenosti rôzne), 2× `BuyVehicle straddle_carrier` a `SpawnShipDebug feeder container_teu 120`. Očakávanie: do 15 000 tickov `countByKind('in_storage') === 120`, `on_apron === 0`, loď odplávala, `lostUnits 0`, oba dvory majú náklad (bližší viac alebo rovnako).
  - Po každom ticku `assertCargoConservation` a žiadne vozidlo v `to_pickup`/`to_dropoff` bez cesty (predpoklad: vozidlo v `to_*` sa v nasledujúcom ticku pohne alebo prejde do `loading`/`unloading`).
  - Dispatcher a alokátor: bližší z 2 dvorov dostane prvý job; plný sklad sa preskočí; bez skladu `NoStorageAvailable` (≤ 1×/h); vozidlo bez kompatibilnej kategórie (fixtúra alebo neexistujúce) job nedostane. Tam, kde by bol potrebný iný def, použi syntetický `DefRegistry` z `RAW_DEFS`.
  - A*/cache cez verejné API: po `RemoveRoad` bunky trasy vozidlo preplánuje; bez cesty prejde do `no_path` a po obnove cesty pokračuje.
  - Determinizmus a roundtrip uprostred jazdy.
  - Testy teraz padajú zo správneho dôvodu. Uveď hlášky.
- acceptance:
  - `pnpm vitest run tests/sim/scenarios tests/sim/invariants` (po T03-06)
  - `pnpm typecheck && pnpm lint` (po T03-06)
- do_not_touch: src/**, tools/**, data/defs/**, data/maps/**
- estimate: M

### T03-08 · Render: `VehicleView` + fill stavy dvora + badge „nepripojené"
- model: sonnet
- agent: implementer
- parallel: yes (worktree od T03-01; len `src/render/**` + testy + demo)
- depends_on: T03-01
- inputs: ARCHITECTURE §15.1; DESIGN_BRIEF §5; `assets/manifest.json` (`sprites.container_yard_small.states`, `sprites.vehicle_depot`, `entities.straddle_carrier.states`, `overlay.warning_badge`); „Render view-modely"; `src/render/**` z F2 (`module-view`, `ship-view`, `view-sync`, `entity-assets`, demo `src/render/__demo__/f2-render.*`)
- outputs: src/render/{vehicle-view,…}.ts; úpravy src/render/{view-models,module-view,module-layer,entity-layer,entity-assets,sprite-atlas,world-renderer}.ts; tests/render/**; demo `src/render/__demo__/f3-render.*`; tests/e2e/f3-render.spec.ts
- požiadavky:
  - `VehicleView`: sprite `entities.{defId}.states.{empty|loaded}`, interpolácia `lerp(prev, curr, alpha)`, rotácia `heading` okolo stredu bunky, vrstva `EntityLayer` (nad modulmi, pod žeriavmi).
  - `ModuleView` pre sklad vyberie `states.fill{00|25|50|75|100}` podľa `fillState` (čistá funkcia + tabuľkový test hraníc). Moduly s `connected === false` dostanú `overlay.warning_badge`.
  - Demo s pevnými VM: 2 dvory (fill 0 a 75), depo, 3 vozidlá (empty/loaded, rôzne kurzy), nepripojené depo s badge → screenshot `f3-render-demo.png`. Prezri ho (Read) a popíš.
- acceptance:
  - `pnpm vitest run tests/render`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e` (vrátane nového demo specu)
- do_not_touch: src/sim/**, src/ui/**, src/app/**, data/**, assets/**
- estimate: M

### T03-09 · UI: BuildBar Sklady/Logistika, inspector skladu a depa, `Toasts`
- model: sonnet
- agent: ui-builder
- parallel: yes (worktree od T03-01; len `src/ui/**`)
- depends_on: T03-01
- inputs: design/ui/game-ui.source.html (BuildBar `storage`/`logistics`, `insp_yard`, `insp_depot`, toasty `TT`), design/tokens.css, DESIGN_BRIEF §6; src/ui/{build-bar,module-inspector,top-hud,format,icon}.tsx
- outputs: src/ui/{module-inspector,…}.tsx (rozšírenie o sklad a depo), src/ui/{toasts,toasts.css}.tsx|css; src/ui/__demo__/f3-ui-demo.*; tests/ui/**; tests/e2e/f3-ui-demo.spec.ts
- požiadavky:
  - BuildBar: kategórie Sklady (`container_yard_small`) a Logistika (`straddle_carrier` ako položka s cenou a akciou „kúpiť", `vehicle_depot` ako stavba). `BuildBarItem` doplniť o `action: 'build' | 'buy'` (predvolene `build`).
  - `ModuleInspectorData` rozšíriť (spätne kompatibilne):
    - sklad: `storage?: { stored; reserved; capacity; unitsIn; unitsOut }`
    - depo: `depot?: { vehicles: { id; label; state: 'idle'|'busy'|'no_path' }[]; capacity; canBuy: boolean; buyBlockedReason?: string }`
    - `connected?: boolean` (badge „Nepripojené" ako `insp_gate` v prototype)
    - akcie `onBuyVehicle(depotId)`, `onSellVehicle(vehicleId)`
  - `Toasts` (prezentačné): `{ id; tone: 'info'|'warning'|'danger'|'success'; icon; title; text; onShow?; onClose }[]`, max 4, podľa prototypu.
  - Demo + screenshot `f3-ui-demo.png` (inspector dvora s 72 %, depa s 2 vozidlami, 2 toasty „Chýba sklad" a „Nepripojené"). Prezri ho (Read) a popíš.
- acceptance:
  - `pnpm vitest run tests/ui`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/render/**, src/app/**, data/**
- estimate: M

### T03-10 · App: snapshot v3, napojenie renderu a UI, nákup/predaj vozidla, notifikácie
- model: sonnet
- agent: implementer
- parallel: yes (s T03-11)
- depends_on: T03-06, T03-08, T03-09
- inputs: src/app/** (F2: `sim-bridge`, `entities-vm`, `build-bar-data`, `inspector-data`, `input-controller`, `connected-module-inspector`); src/render/view-models.ts; src/ui/{build-bar,module-inspector,toasts}.tsx; „Spoločné rozhrania"
- outputs: src/app/**; tests/app/**
- požiadavky:
  - `EntitiesVM.vehicles` (prevX/prevY ako pri lodiach), `ModuleVM.storage` a `connected`. `revision` sa zvyšuje aj pri `Vehicle*`, `Job*`, `NoStorageAvailable`.
  - BuildBar Sklady/Logistika z defov: `straddle_carrier` = `buy` → `BuyVehicle` do depa s voľným miestom s najmenším id. Ak depo nie je, položka je zamknutá s dôvodom „Postav depo vozidiel". `vehicle_depot` a `container_yard_small` = build mód.
  - Inspector dvora (stored/reserved/capacity, prijaté/vydané, pripojenie) a depa (vozidlá, kúpiť, predať s `validate`).
  - Toasty: `NoStorageAvailable` → „Chýba sklad" (warning); modul umiestnený bez pripojenia → „Nepripojené" (info) s akciou „Ukázať" (centrovanie kamery). Max 4, automatické zatvorenie po N s (konštanta v `config.ts`).
  - `REASON_TEXT` doplniť o nové dôvody.
- acceptance:
  - `pnpm vitest run tests/app`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T03-11 · Tooling: `simrun` metriky vozidiel a skladov
- model: sonnet
- agent: implementer
- parallel: yes (s T03-10)
- depends_on: T03-06, T03-07
- inputs: tools/simrun.ts; tests/tools/**; data/scenarios/apron_to_yard.json
- outputs: tools/simrun.ts; tests/tools/*.test.ts
- požiadavky: nové kľúče reportu `vehicles`, `unitsInStorage` (`countByKind('in_storage')`), `jobsDone` (počet `JobDone`), `vehicleUtilPct` (podiel tickov vozidiel mimo `idle`, 1 desatinné miesto), `noStorageEvents`, `ticksToAllStored` (prvý tick, keď `on_ship + on_apron + in_crane + in_vehicle === 0` po aspoň jednom spawne; inak `null`). Existujúce kľúče ostávajú.
- acceptance:
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0 and .unitsInStorage == 120 and .ticksToAllStored != null'`
  - `pnpm vitest run tests/tools && pnpm typecheck && pnpm lint`
- do_not_touch: src/**, data/defs/**, data/maps/**
- estimate: S

### T03-12 · E2E: loď → apron → vozidlá → dvor, screenshot
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T03-10, T03-11
- inputs: tests/e2e/**; src/app/dev-hook.ts; „Akceptácia fázy"
- outputs: tests/e2e/f3-vehicles-yard.spec.ts; screenshoty `f3-vehicles.png`, `f3-yard-filled.png`
- požiadavky: cez UI postaviť cestu, dvor, depo (BuildBar), kúpiť 2 straddle carriers, DEV spawn feeder (4 TEU alebo DEV variant s viac TEU, ak existuje) → počkať (`window.__sim`), kým vozidlá vezú (aspoň 1 `loaded`) → `f3-vehicles.png` → počkať, kým je všetko `in_storage` → `f3-yard-filled.png` (dvor so zaplnením > 0). Screenshoty si prezri (Read) a popíš.
- acceptance:
  - `CI=1 pnpm test:e2e` (všetky specy)
  - `test -s tests/e2e/__screenshots__/f3-vehicles.png -a -s tests/e2e/__screenshots__/f3-yard-filled.png`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T03-13 · Review `src/sim/**` (hot path alokácie)
- model: opus
- agent: sim-reviewer
- parallel: no
- depends_on: T03-06, T03-07, T03-11
- inputs: `git diff phase/02-berth-ship-crane..HEAD -- src/sim tests/sim data tools`
- outputs: tabuľka nálezov + verdikt
- acceptance: verdikt MERGE (0 blocking); blocking → nové karty (opus)
- do_not_touch: všetko
- estimate: S

### T03-14 · Opravy z review + ARCHITECTURE zosúladenie
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T03-13
- inputs: výsledok T03-13; ADR-017..019
- outputs: src/sim/** (opravy s testami); docs/ARCHITECTURE.md (§4.4, §4.6 `logistics`, §5, §6, §7.3, §7.4, §7.6, §7.7, §8 bod 5, §12, §13, §14, §18); docs/DECISIONS.md
- acceptance:
  - `grep -n 'ADR-019' docs/ARCHITECTURE.md`
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0 and .unitsInStorage == 120'`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T03-15 · Plná pipeline + triáž
- model: haiku
- agent: test-runner
- parallel: no
- depends_on: T03-01..T03-14
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs && pnpm build`
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0 and .unitsInStorage == 120'` (namiesto `vertical_slice` do F5)
  - `pnpm -s simrun data/scenarios/f2_unload.json --ticks 5000 --report | jq -e '.lostUnits == 0'`
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.lostUnits == 0 and .cashEnd == 108300000'`
  - `CI=1 pnpm test:e2e` + screenshoty `f3-vehicles.png`, `f3-yard-filled.png`
- do_not_touch: všetko
- estimate: S

### T03-16 · Uzavretie fázy (PROGRESS, BACKLOG) + PR
- model: haiku
- agent: docs-keeper
- parallel: no
- depends_on: T03-15
- outputs: docs/tasks/phase-03.md (checklist); docs/PROGRESS.md; docs/BACKLOG.md
- acceptance:
  - `! grep -n '^- \[ \] T03-' docs/tasks/phase-03.md`
- do_not_touch: všetko mimo outputs
- estimate: S

### T03-17 · Render: vozidlá v pravom pruhu (offset, škála, plynulá zákruta)
- model: sonnet
- agent: implementer
- parallel: yes (worktree; len `src/render/**` + testy + demo)
- depends_on: T03-08
- inputs: „Doplnok od používateľa" (rozhodnutie 11); `assets/infra/road_*.svg` (asfalt x 6–58, os x 32); `assets/entities/straddle_carrier_*.svg` (obsah 56×52 px); `src/render/{vehicle-view,view-models,entity-layer,road-layer,world-renderer}.ts`; demo `src/render/__demo__/f3-render.*`
- outputs: src/render/{lane,vehicle-view,view-models,…}.ts; tests/render/**; demo + tests/e2e/f3-render.spec.ts (screenshot `f3-lanes.png`)
- požiadavky:
  - Čistá funkcia `laneOffset(kind, heading)` → posun v bunkách kolmo na smer jazdy (pravostranne): `two_lane` = ±13/64, `one_lane`/`one_way` = 0. Konštanty sú pomenované, odvodené z geometrie spritu a zdokumentované.
  - Renderer zistí typ cesty pod vozidlom cez funkciu `roadKindAt(cellX, cellY)`, ktorú dostane z `WorldRenderer` (grid). Kým sim nemá `roadKind` (T03-18), vráti `two_lane`. Zdroj typu sa neskôr prepne na `cell.roadKind`.
  - `VehicleVM.prevHeading?` (predvolene = `heading`); poloha = `lerp(prev + offset(prevKind, prevHeading), curr + offset(kind, heading), alpha)`, takže v zákrute nie je skok cez stredovú čiaru.
  - Vozidlo sa škáluje tak, aby šírka obsahu spritu ≈ šírka pruhu (konštanta `VEHICLE_LANE_SCALE`). Test overí, že pri `two_lane` celý sprite leží v jednom pruhu (± 2 px).
  - Demo: priama cesta s protismernými vozidlami v oboch pruhoch, zákruta a T-križovatka → screenshot `f3-lanes.png`. Prezri ho (Read) a popíš.
- acceptance:
  - `pnpm vitest run tests/render`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/ui/**, src/app/**, data/**, assets/**
- estimate: S

### T03-18 · Sim: typy ciest `two_lane` / `one_lane` / `one_way`; ADR-020
- model: opus
- agent: sim-architect
- parallel: no (single writer `src/sim`)
- depends_on: T03-06
- inputs: „Doplnok od používateľa" (rozhodnutia 11, 12); ARCHITECTURE §4.6 (`infrastructure`), §5.1, §7.4, §7.6; ADR-006, ADR-008, ADR-012, ADR-015, ADR-018, ADR-019; `src/sim/{grid,commands,logistics,vehicles,systems,world}/**`; data/defs/infrastructure.json + schéma
- outputs: data/defs/infrastructure.json (`roadKinds`) + schéma; src/sim/defs/**; src/sim/grid/grid.ts (`Cell.roadKind`, `Cell.roadDir`); src/sim/commands/{place-road,remove-road,road-layer-command}.ts; src/sim/logistics/pathfinder.ts (smerové hrany, cena); src/sim/systems/vehicle-system.ts (rýchlosť podľa typu); src/sim/world/{world-state,world-restore}.ts; docs/DECISIONS.md (ADR-020); testy
- požiadavky:
  - `infrastructure.json`: `roadKinds` = `two_lane { costPerCellCents 200000, speedFactor 1 }`, `one_lane { costPerCellCents 120000, speedFactor 0.7 }`, `one_way { costPerCellCents 150000, speedFactor 1 }`. Existujúce `road.costPerCellCents` nahraď (alebo nechaj ako alias `two_lane`, zdokumentuj). Údržba ostáva 0.
  - `PlaceRoad { cells, kind?, dirs? }`: validácia `invalid_road_kind`, `invalid_direction` (`dirs` len pri `one_way`, dĺžka = `cells`). Prestavba podľa rozhodnutia 12 (cena = nový − refund starého; `costCents` vo `validate`; kategórie `road_capex`/`road_sale`, ADR-012). Bunka s vozidlom → `occupied`. `RemoveRoad` refunduje podľa typu. `toJSON` je spätne kompatibilné (bez `kind` = `two_lane`), scenáre F1–F3 musia dať rovnaké výsledky (`f1_roads` `cashEnd 108300000`).
  - Pathfinder: smerové hrany a cena `1/speedFactor`. Invalidácia cez `roadVersion` pri každej zmene typu alebo smeru. Rýchlosť vozidla na úseku podľa typu bunky, z ktorej vychádza (zdokumentuj).
  - Save v3: cesty `[index, layer, kind?, dir?]` (v3 ešte nie je vydaná, takže netreba migráciu, ale over roundtrip). Starter cesty mapy sú `two_lane`.
  - Testy: jednosmerka v protismere → cesta obchádzkou alebo `null`; jednopruhová cesta dá dlhší čas jazdy a A* ju obíde, keď existuje rovnako dlhá dvojpruhová; prestavba (ceny, udalosti `RoadChanged` + `MoneyChanged`); roundtrip; scenár `apron_to_yard` ostane zelený.
  - ADR-020: pruhy sú prezentačné, typy ciest, pravidlá smeru, cena/rýchlosť, prestavba.
- acceptance:
  - `pnpm vitest run tests/sim`
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.cashEnd == 108300000'`
  - `pnpm -s simrun data/scenarios/apron_to_yard.json --ticks 15000 --report | jq -e '.lostUnits == 0'`
  - `grep -c '^## ADR-020:' docs/DECISIONS.md` = 1
  - `pnpm validate:defs && pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/** (okrem `REASON_TEXT`, ak je nutné — inak zhrnutie), tools/**
- estimate: M

### T03-19 · Render: úzke cesty, šípky jednosmerky, pruh podľa typu cesty
- model: sonnet
- agent: implementer
- parallel: yes (s T03-20; worktree)
- depends_on: T03-17, T03-18
- inputs: „Doplnok od používateľa"; `src/render/{road-layer,autotile,lane,vehicle-view,overlay-assets}.ts`; `assets/manifest.json` (`overlay.path_arrow`); DESIGN_BRIEF §4, §5.2
- outputs: src/render/**; tests/render/**; demo `f3-road-kinds` + screenshot
- požiadavky:
  - `RoadLayer` kreslí `two_lane` spritami ako doteraz. `one_lane`/`one_way` kreslí procedurálne (asfalt 26 px + okraje, bez stredovej čiary) s rovnakým autotile tvarom a rotáciou. Jednosmerka dostane `overlay.path_arrow` otočenú podľa `roadDir` (každá 2. bunka alebo každá bunka, zvoľ čitateľne pri zoome 0.5–2).
  - `roadKindAt` z T03-17 číta `cell.roadKind`.
  - Demo so všetkými troma typmi, križovatkou rôznych typov a vozidlami → screenshot `f3-road-kinds.png`. Prezri ho (Read) a popíš.
- acceptance:
  - `pnpm vitest run tests/render`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/ui/**, src/app/**, data/**, assets/**
- estimate: M

### T03-20 · App/UI: výber typu cesty, smer jednosmerky ťahom
- model: sonnet
- agent: implementer
- parallel: yes (s T03-19)
- depends_on: T03-10, T03-18
- inputs: „Doplnok od používateľa"; `src/app/{input-controller,cell-line,build-feedback,build-bar-data,connected-build-bar}.ts(x)`; `src/ui/build-bar.tsx`
- outputs: src/app/**; src/ui/** (ak treba); tests/app/**, tests/ui/**
- požiadavky:
  - BuildBar Landside (odomknutá len pre cesty): „Cesta dvojpruhová", „Cesta jednopruhová", „Jednosmerná cesta" s cenou za bunku (z defov). Výber prepne build mód ciest s daným typom. `B` ďalej spúšťa naposledy použitý typ (predvolene `two_lane`).
  - Ťah pri `one_way` vypočíta `dirs` podľa rozhodnutia 12. Ghost ukáže smer (šípky cez BuildLayer alebo overlay) a cenu vrátane prestavby (`costCents` z `validate`, záporné časti ako refund).
  - `REASON_TEXT` doplniť o `invalid_road_kind`, `invalid_direction`.
- acceptance:
  - `pnpm vitest run tests/app tests/ui`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, data/**
- estimate: M
