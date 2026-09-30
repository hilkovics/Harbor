# ARCHITECTURE.md — Modular Harbor (2D Port Tycoon)

> Záväzný technický návrh. Zmeny len cez ADR v `docs/DECISIONS.md`.
> Číslovanie sekcií (§) je referencované z `CLAUDE.md` a `IMPLEMENTATION_PLAN.md` — nemeň ho.

---

## 1. Zhrnutie GDD → technické dôsledky

| Požiadavka GDD | Technický dôsledok |
|---|---|
| Top-down, grid, statické pobrežie | Mapa = JSON s terénom; `Grid` je nemenný okrem vrstiev postavených hráčom (moduly, cesty, koľaje) |
| Modulárne stavanie so snappingom | `ModuleDef` s footprintom, pravidlami umiestnenia a **konektormi** (prístupové bunky); validácia v `PlaceModuleCommand` |
| Žiadna teleportácia tovaru | `CargoUnit` + `CargoLocation` + `CargoLedger` s povolenými prechodmi; vozidlá s pathfindingom; apron buffer |
| Kamióny / vlaky s bránami, stojiskami, rampami | „Landside" reťazec: `TruckGate → WaitingArea → LoadingRamp → RoadPortal`; `RailStation → RailPortal` |
| Kontrakty s SLA a pokutami | `Contract` stavový automat; demurrage (zdržanie lode) + late penalty; tlak na bottlenecky |
| XP a tech tree | `TechSystem` s efektmi `unlock*` a `statModifier` cez `StatResolver` |
| Metriky, heatmapy, vyťaženosť | `MetricsSystem`: ring buffery, per-cell traffic counter, busy/idle ticky |
| Jedna mena | `Ledger` v celých centoch (`bigint` nie je potrebný — `number` do 2^53 stačí) |
| Rozšírenia ako dedičné triedy | Abstraktné `Module`, `StorageModule`, `CraneModule`, `LandExportModule`, `Carrier` + `ModuleRegistry` |

---

## 2. Vrstvy a závislosti

```
┌──────────────────────────────────────────────────────────────┐
│ src/app  — GameLoop, SimBridge, InputController, SaveLoad     │
│   ├── volá world.tick()  ├── číta snapshot/events  ├── dispatch(Command) │
├──────────────────────────┬───────────────────────────────────┤
│ src/render (PixiJS)      │ src/ui (React)                    │
│ svet, sprity, overlays   │ HUD, panely, grafy                │
├──────────────────────────┴───────────────────────────────────┤
│ src/sim — ČISTÝ TS, bez DOM/Pixi/React. Jediný zdroj pravdy.  │
│ World → Systems → Entities → Defs (JSON)                      │
└──────────────────────────────────────────────────────────────┘
```

Pravidlá toku dát:
- **Dole → hore iba čítanie.** Render/UI dostávajú `WorldSnapshot` (read-only view) a `SimEvent[]` za tick.
- **Hore → dole iba príkazy.** `Command` objekty, validované simom.
- `src/sim` nesmie importovať nič mimo `src/sim` a `data/` typov. Hranica je trojvrstvová: (1) kompilátor — `src/sim/tsconfig.json` s `lib: ["ES2023"]`, `types: []` a aliasmi len `@sim/*`, `@data/*` (DOM/Node globály = chyba `pnpm typecheck`); (2) ESLint — allowlist importov (`@sim/…`, `@data/…`, relatívne cesty, ktoré neopustia `src/sim`, najviac 5× `../`, vzdialenejšie cez `@sim/…`), zákazy globálov a obchvatov nedeterminizmu, `noInlineConfig`, zákaz `@ts-*` komentárov; (3) test, že `src/sim/**` obsahuje len súbory `.ts` (ADR-007).
- Sim je pripravený bežať v Web Workeri (všetko je serializovateľné) — implementácia je ADR kandidát (§18).

---

## 3. Časový model

| Konštanta (`data/defs/time.json`) | Hodnota | Význam |
|---|---|---|
| `tickGameSeconds` | 10 | 1 tick = 10 herných sekúnd |
| `ticksPerRealSecond` | 10 | pri rýchlosti 1× |
| `speeds` | `[0, 1, 2, 4, 8]` | 0 = pauza |
| `maxTicksPerFrame` | 64 | strop tickov za jeden render frame v `GameLoop` (ADR-013) |
| Odvodené | 6 tickov = 1 herná minúta; 360 = hodina; 8 640 = deň; 259 200 = mesiac (30 dní) | |
| Reálny čas | 1 herný deň ≈ 14,4 min pri 1×, 3,6 min pri 4× | tycoon pacing |

- `SimClock { tick, speed }` — stav do save `getState()` / `fromState()`, `setSpeed()`; odvodené konštanty `ticksPerMinute/Hour/Day/Month` z `tickGameSeconds` (musí deliť 60). Dve sady odvodených hodnôt, obe 0-based: **celkové počty** od začiatku hry `gameMinute`, `gameHour`, `gameDay`, `gameMonth` (napr. throttle `CraneBlocked` podľa `gameHour`, ADR-016) a **kalendárne zložky** pre HUD `minuteOfHour` (0–59), `hourOfDay` (0–23), `dayOfMonth` (0–29; herný mesiac má vždy 30 dní — kalendár je konštanta v kóde, nie def). Nová hra začína pri `INITIAL_SPEED` = 1, ktorá musí byť v `time.speeds` (overuje `World.create`). `clock.advance()` vráti uzavreté hranice a `World` v kroku 1 (§6) emituje `TickAdvanced`, potom `HourClosed`, `DayClosed`, `MonthClosed` (ADR-013).
- `GameLoop` (app): každý frame najprv `world.applyPending()` (príkazy sa aplikujú aj počas pauzy), potom akumulátor `acc += dt × speed`; vykoná `n = min(floor(acc / tickDuration), time.maxTicksPerFrame)` tickov (64, proti spirále smrti; pri zásahu limitu sa `acc` oreže na najviac `tickDuration`); prezentácia interpoluje polohy medzi `prevTick` a `currTick` pomocou `alpha = acc / tickDuration` (ADR-013).
- Všetky trvania v defoch sú **v tickoch** (nie v sekundách).

---

## 4. Dátové definície (`data/defs/*.json`)

Každý súbor má `schemaVersion`. Konfiguračné defy (`time`, `economy`, `infrastructure`, `logistics`) sú jeden objekt parametrov; katalógové defy (`cargo_types`, `modules`, `ships`, `vehicles`, `tech_tree`, `contract_templates`, …) majú `items: [...]` s `id` (snake_case) a rozhrania v §4.1–§4.5 opisujú jednu položku (ADR-009). Načítava `DefRegistry` (typované gettery, fail-fast pri chybe). Schémy v `data/schemas/*.schema.json`, validácia `pnpm validate:defs`.

### 4.1 `cargo_types.json`
```ts
interface CargoTypeDef {
  id: string;                 // 'container_teu', 'grain', 'crude_oil', 'cng', 'car'
  category: 'container' | 'bulk' | 'liquid' | 'gas' | 'roro';
  unitName: string;           // 'TEU', 't', 'm³', 'm³', 'ks'
  unitsPerBatch: number;      // koľko "jednotiek" tvorí jedna CargoUnit (kontajner = 1, sypké = 25 t)
  basePricePerUnitCents: number;  // odmena za jednotku (referenčná)
  xpPerUnit: number;
  colorToken: string;         // 'cargo-container' → viď DESIGN_BRIEF tokeny
}
```
> Sypké/tekuté/plynné komodity sa diskretizujú do `CargoUnit` s `quantity = unitsPerBatch`. Jedna CargoUnit = jeden „úchop" žeriava = jedna dávka pre vozidlo. Zachováva „žiadnu teleportáciu" bez miliónov entít.

### 4.2 `modules.json`
```ts
type ModuleKind = 'berth' | 'crane' | 'storage' | 'gate' | 'waiting_area' | 'ramp' | 'depot' | 'rail_station' | 'pipeline';
type Side = 'n' | 'e' | 's' | 'w';
interface ModuleDef {
  id: string;
  kind: ModuleKind;
  displayName: string;                        // 'Kotvisko', 'Kontajnerový žeriav' (BuildBar, inspector)
  footprint: { w: number; h: number };        // v bunkách, pri rotácii 0°
  placement: {
    requiredTerrain: TerrainType[];           // napr. ['quay'] pre berth, ['land','quay'] pre sklad
    waterSide?: 'north';                      // berth (povinné): dlhá hrana pri vode pri rot 0; po rotácii `waterSideOf` (ADR-014)
    requiresParcelOwnership: boolean;         // vždy true — cesty nie sú moduly (ADR-006), pravidlo pre cesty viď §5.2 (ADR-008)
    mustAttachTo?: ModuleKind[];              // crane → ['berth']: stojí na bunkách hostiteľa (ADR-014, ADR-015); ramp → nič
  };
  connectors: { x: number; y: number; side: Side; type: 'road' | 'rail' | 'pipe' }[];  // bunka footprintu pri rot 0 + strana vstupu
  costCents: number;
  maintenancePerDayCents: number;
  techRequired?: string;                      // id uzla tech tree
  params: Readonly<Record<string, number | string>>;   // tvar podľa `kind` = MODULE_PARAM_SPECS (nižšie)
}
interface BerthParams { depthClass: 1 | 2 | 3; apronSlots: number; maxCranes: number; frontWaterCells: number }
interface CraneParams { cycleTicks: number /* ≥ 2: dve fázy po ≥ 1 tick */; category: CargoCategory }
```
- Typované parametre podľa `kind` sú v tabuľke `MODULE_PARAM_SPECS: { [K in ModuleKind]: SpecTable<ModuleParamsByKind[K]> }` (nie switch): berth vyžaduje `BerthParams`, crane `CraneParams`, ostatné druhy zatiaľ `{}`; nový druh s parametrami = nový typ v `ModuleParamsByKind` + riadok tabuľky. Sim číta parametre len cez typované gettery `berthParams(def)` / `craneParams(def)` (nikdy `params['x'] as number`) a laditeľné štatistiky (`cycleTicks`) cez `StatResolver` (§7.2, §10). `DefRegistry` je fail-fast (`DefError` s cestou): duplicitné id, neznámy kľúč, zlý typ alebo rozsah parametra, neznámy druh v `mustAttachTo` či terén v `requiredTerrain`, berth bez `waterSide`, konektor mimo footprintu (T02-01).
- Konektory sú **jediné bunky, cez ktoré vozidlá vchádzajú/vychádzajú** z modulu; `side` je strana bunky, ktorou sa vchádza. Kanonický zdroj je `assets/manifest.json` (`sprites.*.connectors`); vo svete ich po rotácii dáva `connectorsOf(def, x, y, rotation)` (`rotateLocalCell` + `rotateSide`, ADR-015). Vnútorný pohyb v module je abstrahovaný na `internalTicks` (viď §7.3).
- Typ konektora `berth_edge` z pôvodného návrhu sa **nepoužíva**: hranu kotviska pri vode určuje `placement.waterSide` otočená o rotáciu (`edgeCells`) a miesto lode pás `BerthModule.frontWaterBand` (`params.frontWaterCells` riadkov vody pred hranou). Loď nie je vozidlo, nevchádza cez bunku konektora a hrana kotviska nie je jedna bunka (ADR-014, ADR-015; T02-01).

### 4.3 `ships.json`
```ts
interface ShipClassDef {
  id: 'feeder' | 'handy' | 'panamax' | 'mega' | string;
  displayName: string;   // 'Feeder', 'Handysize' (UI, inspector)
  lengthCells: number;   // 6 / 10 / 14 / 20 — zhodné s entities.ship_<id>.footprint.h v manifeste
  widthCells: number;    // 2 / 2 / 3 / 3 — zhodné s footprint.w; musí sa zmestiť do frontWaterCells kotviska
  draftClass: 1 | 2 | 3; // každé obsadené kotvisko musí mať (efektívnu, §5) depthClass >= draftClass
  capacityUnits: number; // 120 / 300 / 700 / 1500 (v CargoUnit)
  speedCellsPerTick: number; // 0.15
  cargoCategories: CargoCategory[];
  berthAllowanceTicks: number;  // koľko smie stáť bez demurrage (napr. 2 dni = 17 280)
  techRequired?: string;
}
```

### 4.4 `vehicles.json` (interné vozidlá)
```ts
interface VehicleDef {
  id: 'straddle_carrier' | 'forklift' | 'agv' | 'bulk_shuttle' | 'tanker_shuttle' | string;
  displayName: string;            // 'Straddle carrier' (BuildBar Logistika, inšpektor depa)
  capacityUnits: number;          // v CargoUnit (straddle 1, agv 2, bulk_shuttle 1)
  speedCellsPerTick: number;      // 0.4 / 0.3 / 0.5; na úseku × speedFactor typu cieľovej bunky (§7.4, ADR-020)
  loadTicks: number; unloadTicks: number;   // 3 / 3, za jednotku, sekvenčne po internalTicks (§7.3, ADR-011)
  cargoCategories: CargoCategory[];
  purchaseCents: number; wagePerDayCents: number;   // straddle 4 800 000 / 18 000
  techRequired?: string;
}
```
- Katalóg `defs.vehicles` (F3: `straddle_carrier` { capacity 1, speed 0.4, load/unload 3, `[container]` }), schéma `vehicles.schema.json`; `validate:defs` krížovo overí, že každé vozidlo má `entities.<id>` v `assets/manifest.json` (T03-01). `techRequired` sa zatiaľ nevyhodnocuje (tech strom príde neskôr) a mzdy zúčtuje `economySystem` pri `DayClosed` (§9.2), ktorý ešte nie je.

### 4.5 `tech_tree.json`
```ts
interface TechNodeDef {
  id: string; branch: 'cargo' | 'efficiency' | 'infrastructure';
  displayName: string; xpCost: number; prerequisites: string[];
  effects: TechEffect[];
}
type TechEffect =
  | { type: 'unlockModule'; moduleId: string }
  | { type: 'unlockCargoType'; cargoTypeId: string }
  | { type: 'unlockShipClass'; shipClassId: string }
  | { type: 'unlockVehicle'; vehicleId: string }
  | { type: 'statModifier'; target: 'crane' | 'vehicle' | 'gate' | 'ramp' | 'storage';
      targetId?: string; stat: string; op: 'mul' | 'add'; value: number };
```

### 4.6 `contract_templates.json`, `economy.json`, `time.json`, `infrastructure.json`, `logistics.json`
- `contract_templates`: `cargoTypeId, volumeUnitsRange, slaDaysRange, shipClassIds[], weight, minTier`.
- `economy`: `startingCashCents, demurrageRateOfRewardPerHour (0.005), latePenaltyRateOfRewardPerDay (0.05), failAfterDaysLate (3), leaseMonthlyRateOfPrice (0.015), bankruptcyDays (30), offersPerDay (6), offerExpiryDays (2), removalRefundRate (0.5)` — `removalRefundRate` je podiel ceny vrátený pri odstránení modulu (§8 bod 8) aj cesty/koľaje (ADR-012) (ADR-013), počítaný celočíselne v bázických bodoch (`refundCents`, ADR-015).
- `time`: viď §3, vrátane `maxTicksPerFrame (64)` — strop tickov za frame v `GameLoop` (ADR-013).
- `infrastructure` (`data/defs/infrastructure.json`, konfiguračný, vznikne vo F1): `road: { costPerCellCents (200 000), maintenancePerDayCents (0) }`, `rail: { costPerCellCents (600 000), maintenancePerDayCents (0) }` (ADR-010) a od F3 `roadKinds: { two_lane: { costPerCellCents 200 000, speedFactor 1 }, one_lane: { 120 000, 0.7 }, one_way: { 150 000, 1 } }` — cena za novú alebo prestavanú bunku a rýchlostný faktor typu cesty (§5.1, §7.4; ADR-020). Schéma a `DefRegistry` vyžadujú všetky tri typy a `0 < speedFactor ≤ 1`; `road.costPerCellCents` je **alias** ceny `two_lane` (spätná kompatibilita prezentácie, `DefRegistry` vyžaduje zhodu) — sim číta cenu cesty len z `roadKinds`, údržba ostáva `road.maintenancePerDayCents`.
- `logistics` (`data/defs/logistics.json`, konfiguračný, vznikne vo F3): `defaultInternalTicks (6)` — pobyt vozidla v module pred load/unload, modul ho môže prepísať `params.internalTicks` (§7.3 bod 4); `repathIntervalTicks (30)` — po koľkých tickoch skúsi vozidlo v `no_path` cestu znova (ADR-019); `congestion: { trafficDecayPerHour (0.9), slowdownPerExtraVehicle (0.25), penaltyTrafficDivisor (200), penaltyMax (3) }` — `trafficDecayPerHour` používa krok 11 od F3, ostatné F11 (§7.6) (ADR-010).

### 4.7 Mapa (`data/maps/*.json`)
```ts
interface MapDef {
  schemaVersion: 1;                            // jediná podporovaná verzia formátu mapy (T02-01)
  id: string; width: number; height: number;
  terrain: string[];   // riadky; znaky: '~' deep water, '=' shallow water, 'Q' quay, '.' land, '#' blocked
  depth: Record<string, 1|2|3>;  // kľúč "x,y,w,h" = zóna nábrežia → depthClass; Q mimo zón má 1
  parcels: { id: string; rect: Rect; priceCents: number; leasable: boolean; startOwned?: boolean }[];
  roadPortals: { id: string; cell: Cell }[];   // vstup/výstup kamiónov na okraji
  railPortals: { id: string; cell: Cell }[];   // road a rail portál nesmú zdieľať bunku (ADR-006)
  seaLane: Cell[];                             // polyline od okraja k anchorage
  anchorage: Cell[];                           // čakacie pozície lodí
  starter: { modules: PlacedModuleSpec[]; roads: Cell[] };  // Root modul (ADR-015), starter cesty
}
interface PlacedModuleSpec { defId: string; x: number; y: number; rotation: 0 | 90 | 180 | 270 }  // x, y = ľavý horný roh po rotácii
```
- `parseMapDef(raw)` overí tvar podľa `map.schema.json`, `loadMap(def)` vzťahy (rozmery terénu, znaky, zóny hĺbky celé v mape, bez prekryvu a s bunkou nábrežia, parcely, portály na okraji a na rôznych bunkách, voda, cesty) a vráti hlboko zmrazenú `LoadedMap`. Chyba = `MapError` s JSON pointerom.
- `LoadedMap` nevystavuje meniteľnú mriežku: `createGrid()` vráti pri každom volaní **novú** kópiu počiatočného stavu (terén, `depthClass`, `parcelId`, starter cesty), takže zápis do mriežky jedného sveta sa neprenesie do ďalšieho `World.create`/`deserialize` (T02-01).
- Starter moduly (`harbor_01`: `berth_standard` (40, 14) + `crane_container_gantry` (43, 14), rot 0) umiestni `World.create` v poradí mapy pravidlami `PlaceModule` bez ceny, bez udalostí a s `purchaseCostCents 0`; neznámy def alebo porušené pravidlo je `MapError` na `/starter/modules/<i>` (ADR-015).

---

## 5. Doménový model

```mermaid
classDiagram
  class World { +defs +map +clock: SimClock +grid: Grid +parcels +rng: Rng +ids +events: EventBus +cargo: CargoLedger +modules +berthGroups +ships +stats: StatResolver +cashCents +vehicles +trucks +trains +contracts +economy +tech +metrics +tick() +assertInvariants() }
  class Module { <<abstract>> id def kind origin rotation size cells purchaseCostCents +getRuntimeState() +restoreRuntimeState() }
  class BerthModule { waterSide lengthCells depthClass frontWaterBand groupId dockedShipId craneIds apron: ApronBuffer }
  class CraneModule { berthId category state phaseTicksTotal phaseTicksLeft heldUnitId reservedSlot busyTicks idleTicks blockedTicks lastBlockedHour }
  class StorageModule { <<abstract>> category capacity storedCount reservedCount freeCount unitsIn unitsOut +reserve() +commit() +release() +recordTaken() }
  class ContainerYard
  class Silo
  class TankFarm
  class GasHolder
  class VehicleLot
  class LandExportModule { <<abstract>> }
  class TruckGate { processTicks queue }
  class WaitingArea { bays }
  class LoadingRamp { docks category loadTicksPerUnit }
  class RailStation { tracks trainCapacity }
  class VehicleDepot { capacity vehicleIds freeStalls }
  class Pipeline { flowPerTick }
  Module <|-- BerthModule
  Module <|-- CraneModule
  Module <|-- StorageModule
  Module <|-- LandExportModule
  Module <|-- VehicleDepot
  Module <|-- Pipeline
  StorageModule <|-- ContainerYard
  StorageModule <|-- Silo
  StorageModule <|-- TankFarm
  StorageModule <|-- GasHolder
  StorageModule <|-- VehicleLot
  LandExportModule <|-- TruckGate
  LandExportModule <|-- WaitingArea
  LandExportModule <|-- LoadingRamp
  LandExportModule <|-- RailStation
  class Carrier { <<abstract>> id capacity }
  Carrier <|-- Ship
  Carrier <|-- Vehicle
  Carrier <|-- Truck
  Carrier <|-- Train
  class CargoUnit { id typeId contractId quantity location: CargoLocation }
  class Contract { id cargoTypeId volumeUnits rewardCents slaDeadlineTick state shipId }
```
Diagram opisuje cieľový model. Po F3 existujú `World`, `Module`, `BerthModule`, `CraneModule`, `StorageModule` s `ContainerYard`, `VehicleDepot`, `Ship` a `Vehicle` (zatiaľ bez spoločnej triedy `Carrier`), `TransportJob` a `CargoUnit`; náklad na palube, v žeriave, na aprone, vo vozidle či v sklade vedie výlučne `CargoLedger` — nosiče ani moduly si id jednotiek neevidujú, moduly so slotmi držia len rezervácie (pravidlo 2, ADR-014, ADR-017).

**`World` po F2** (ADR-013, ADR-014, ADR-016): `defs`, `map` (`LoadedMap`, len čítanie), `seed`, `clock`, `grid` (vlastná kópia z `map.createGrid()`), `parcels`, `rng`, `ids` (`EntityIdAllocator` — jedna sekvencia id pre moduly, lode aj náklad), `events`, `cargo` (`CargoLedger`, jediný zdroj polohy nákladu, §7.1), `modules: ReadonlyMap<EntityId, Module>` (poradie umiestnenia = vzostupne podľa id), `berthGroups: readonly BerthGroup[]` (§5.4), `ships: ReadonlyMap<EntityId, Ship>` (vzostupne podľa id = poradie spawnu), `stats: StatResolver` (§10), `cashCents`, `checkInvariants` (§6). Štrukturálne operácie pre príkazy a obnovu save: `placeModule` / `addModule` / `removeModule` (poistka `ModuleError`, pravidlá §8 z `module-rules.ts`) a `addShip` / `removeShip` (`ShipError` s kódom); dotazy `moduleAt`, `berthOfCell`, `craneAt`; `assertInvariants()`. Vozidlá a joby pribudli vo F3 (nižšie); kamióny, vlaky, kontrakty, ekonomika, tech a metriky pribudnú vo svojich fázach.
- Triedu modulu vyberá `ModuleRegistry.register(kind, factory)` → `create(def, spec, id, purchaseCostCents, env)`, nie switch ani `.constructor`; neregistrovaný druh je `ModuleError` (ADR-014). `Module.purchaseCostCents` je skutočne zaplatená cena (starter moduly 0) — základ refundácie (ADR-015); `getRuntimeState()` / `restoreRuntimeState()` nesú dynamický stav triedy do save (§14).
- **Žeriav stojí na bunkách berthu** (ADR-014 bod 1): `cell.moduleId` ostáva id berthu, `CraneModule.berthId` je berth pod ľavým horným rohom žeriavu, berth eviduje žeriavy v `craneIds` (poradie umiestnenia, najviac `params.maxCranes`), žeriav má rotáciu berthu a neprekrýva iný žeriav. Žeriav na bunke nájde `world.craneAt(x, y)`. `CraneModule.state` je len getter (FSM §7.2).
- **Efektívna hĺbka** berthu `depthClass = min(params.depthClass, min(cell.depthClass) footprintu)` — ponor obmedzuje typ kotviska aj mapa (ADR-014 bod 2). `waterSide` = `placement.waterSide` otočená o rotáciu (rot 0 = `n`, v smere hodinových ručičiek), `lengthCells = footprint.w` (dlhá hrana pri vode), `frontWaterBand` = pás `frontWaterCells` riadkov vody pred ňou (miesto lode, §7.4).
- **Sloty = rezervácie nad ledgerom** (ADR-017): `SlotReservations` (druhy s jedinečným slotom `on_apron`, `in_storage`) drží len príznaky rezervácie; obsadenie (`usedCount`, `unitAt`, `units()` vo FIFO, `oldest()`, `slotOf`) číta z ledgera cez `CargoReader` (`ModuleEnv.cargo`). Tok: `reserve()` (najnižší slot, ktorý nie je obsadený ani rezervovaný) → pred presunom `assertCommittable(slot, unit)` → `CargoLedger.move` → `commit(slot, unit)` (ledger musí mať jednotku na slote, inak `unit_not_at_slot`); odchod jednotky je len presun v ledgeri. FIFO = poradie príchodu v ledgeri (`CARGO_HOLDER_SPECS.order = 'arrival'`, zachované v save). `ApronBuffer` je tenká podtrieda (UI číta `usedCount` / `reservedCount` / `capacity`); generický kód sa pýta `Module.cargoSlots(): CargoSlotsView | undefined` (berth → apron, sklad → jeho sloty), nie `instanceof`.
- **`StorageModule`** (abstraktná, ADR-017, ADR-018): `params` (`StorageParams { capacityUnits, category, internalTicks? }`), `capacity`, `category`, `storedCount` (ledger), `reservedCount`, `freeCount = capacity − stored − reserved`, kumulatívne `unitsIn` / `unitsOut`; `reserve`, `reserveSlot` (obnova), `release`, `assertCommittable`, `commit` (+`unitsIn`), `recordTaken` (po presune von, +`unitsOut`). Triedu vyberá factory druhu `storage` tabuľkou `STORAGE_MODULES[params.category]` (`container` → `ContainerYard`; ostatné kategórie `ModuleError('unknown_kind')`, kým nepríde ich fáza). Rezervácie slotov patria aktívnym jobom (§7.3, §7.7) — neukladajú sa, obnova ich vytvorí z `to` jobov.
- **`VehicleDepot`** (ADR-017): `capacity` státí (`DepotParams { capacity, internalTicks? }`), `vehicleIds` v poradí pripojenia (zmrazená snímka, ADR-021) a `freeStalls`; zoznam mení len `World.addVehicle` / `removeVehicle` cez `attachVehicle` (`duplicate_id`, `depot_full`) a `detachVehicle` (`unknown_vehicle`). Do save nejde (odvodí sa z `Vehicle.depotId`).
- Každý modul má predpočítané konektory po rotácii (`Module.connectors`) a `vehicleInternalTicks()` (sklad a depo: `params.internalTicks`, inak `undefined` → `logistics.defaultInternalTicks`, §7.3 bod 4). **Pripojenie** (ADR-017): vonkajšia bunka konektora = bunka konektora + `SIDE_STEPS[side]`; `World.connectorCells(module)` vráti `{ connector, outside, hasRoad }`, `World.isConnected(module)` = aspoň jeden konektor typu `road` s cestou na vonkajšej bunke v mape (z mriežky pri každom volaní, bez cache; modul bez cestných konektorov — žeriav — pripojený nie je). Vonkajšia bunka s cestou je **prístupová bunka** modulu pre vozidlá (§7.3, §7.4).
- `Ship` (§4.3, §7.4; ADR-016): `id, classId, def, cargoTypeId, cargoCategory`, `state` (getter, mení ho len `transition`), `x, y` (float stred v bunkách; stred bunky = `(cx + 0.5, cy + 0.5)`), `heading` (kardinálny 0/90/180/270), `berthIds` (obsadené kotviská po pobreží), `anchorageIndex`, `waypointIndex`.
- `Vehicle` (§4.4, §7.3, §7.4; ADR-019, ADR-021): `id, defId, def, depotId, purchaseCostCents`, `state` (getter, mení ho len `transition` cez `changeVehicleState`), `jobId`, **trasa** (indexy buniek `[cell, …cieľové bunky]`; `cell`, `nextCell`, `cellsAhead`, `routeCellAt(offset)` bez kópie, `remainingRoute()` kópia pre save), **progres** úseku `cell → nextCell` (0 alebo v (`PROGRESS_NOISE`, 1)), `x, y` (stred `cell` posunutý o progres k `nextCell` — `vehiclePosition`), `heading` (kardinálny kurz úseku; stojace vozidlo si ponechá posledný), `waitTicks` (odpočet pobytu v module alebo nového pokusu v `no_path`), `replanPending` (cesty sa zmenili po naplánovaní). Trasu menia len `followRoute`, `turnAround`, `halt` a `advance`. Kúpené vozidlo stojí `idle` na vonkajšej bunke prvého pripojeného cestného konektora depa s kurzom von z depa (`depotExit`); voľné vozidlo ostáva, kde skončilo (návrat do depa = backlog).
- `TransportJob` (§7.3; ADR-018): `id, unitIds, from, to, fromModuleId, toModuleId, vehicleId, state, createdTick`.

**`World` po F3** (ADR-017 až ADR-021) pridáva: `vehicles: ReadonlyMap<EntityId, Vehicle>` a `jobs: ReadonlyMap<EntityId, TransportJob>` (vzostupne podľa id = poradie nákupu / vzniku; `addVehicle` / `removeVehicle` s depom a `addJob` / `removeJob` — `VehicleError` / `JobError` s kódom, poradie sa porovnáva s najväčším prítomným id), odvodený index `jobOfUnit(unitId)` + `jobUnitCount`, `vehicleOnCell(index)` (bunka pod vozidlom alebo cieľ jeho rozbehnutého úseku), `connectorCells` / `isConnected` (vyššie), `roadSpeeds` (`RoadSpeeds`: `speedFactor` a `cellCost` bunky podľa typu cesty, §7.4), `roadVersion` (počítadlo zmien vrstvy ciest; zvyšuje ho `markRoadsChanged` pri `PlaceRoad` / `RemoveRoad` vrátane prestavby a pri `deserialize` — zároveň označí jazdiace vozidlá `replanPending`) a lenivé `pathfinder` (A*), `paths` (`PathCache`) a `distances` (`DistanceMatrix`) — memo zneplatnené zmenou `roadVersion`, nič z toho nie je v save (§7.4).

### 5.1 Grid
```ts
type TerrainType = 'deep_water' | 'shallow_water' | 'quay' | 'land' | 'blocked';
type RoadKind = 'two_lane' | 'one_lane' | 'one_way';          // ROAD_KINDS (ADR-020)
interface Cell {
  terrain: TerrainType; depthClass: 0|1|2|3; parcelId: string | null;
  moduleId: EntityId | null;          // obsadenie footprintom
  road: 'none' | 'road' | 'rail';     // vrstva dopravy (hráč stavia po bunkách)
  roadKind: RoadKind;                 // typ cesty; bez cesty vždy DEFAULT_ROAD_KIND = 'two_lane'
  roadDir: 'N' | 'E' | 'S' | 'W' | null;   // smer práve pri jednosmerke (ROAD_KIND_TRAITS.oneWay)
  traffic: number;                    // heatmap akumulátor (decay)
}
```
- `Grid` má `width, height, cells: Cell[]` (row-major), helpery `inBounds, at, atIndex, index, coordOf, neighbors4, rect`.
- **Cesty a koľaje nie sú moduly** — sú vrstva na bunke, stavajú ich príkazy `PlaceRoad`/`PlaceRail` (a `RemoveRoad`/`RemoveRail`, §12.2), cena za bunku z `infrastructure.json` (ADR-010, pri ceste podľa typu z `roadKinds`, ADR-020). Nesmú byť na vode ani cez footprint modulu; koľaj a cesta sa v MVP nekrižujú (level crossing = backlog).
- **Typy ciest** (ADR-020): `two_lane` (obojsmerná dvojpruhová — štartové cesty mapy a predvolený typ `PlaceRoad`), `one_lane` (obojsmerná jednopruhová, lacnejšia a pomalšia), `one_way` (jednosmerná jednopruhová so smerom `roadDir`). Typ je vlastnosť bunky s `road === 'road'`, nie nová vrstva — dotazy `road === 'road'` (pripojenie, autotile, pravidlá umiestnenia) sa nemenia. Pevné vlastnosti typu sú tabuľka `ROAD_KIND_TRAITS` (`lanes` 2/1 pre render, `oneWay`; žiadny switch), laditeľné čísla (cena, `speedFactor`) sú v `infrastructure.roadKinds` (§4.6). Bunka bez cesty má vždy normalizovaný stav `two_lane` + `roadDir = null` — zapisujú ho len `createCell`, `RemoveRoad` a `World.deserialize`, takže priamy zápis `road = 'road'` (štartové cesty mapy, fixtúry) dá dvojpruhovú cestu.
- **Pravidlo prechodu** (`isRoadStepAllowed`): krok A → B v smere `d` je povolený, ak A nie je jednosmerná alebo `d === A.roadDir`, a B nie je jednosmerná alebo `d ≠ opačný(B.roadDir)` — do jednosmerky sa smie vojsť zboku, nie proti smeru; jednosmerka bez smeru je neprejazdná. Pravidlo používa A* (smerové hrany, §7.4), krok 12 aj obrat vozidla uprostred úseku.
- **Pruh je prezentácia** (ADR-020): sim modeluje cestu ako graf buniek a vozidlo ide stredom bunky; pravostranný posun do pruhu (`lanes` 2) a šípky jednosmerky kreslí render (§15.1).
- Pobrežie: bunky `quay` sú jediné, kde môže stáť `BerthModule`. Loď zaberá `shallow_water/deep_water` bunky priľahlé k dlhej hrane kotviska.

### 5.2 Parcely
`Parcel { id, rect, priceCents, leasable, ownership: 'none' | 'owned' | 'leased' }`. Moduly možno stavať len na vlastnej/prenajatej parcele (celý footprint); cesty a koľaje aj na verejných bunkách (`parcelId === null`), nie však na parcele s `ownership: 'none'` (na predaj); `startOwned` parcela je vlastnená od začiatku (ADR-008). Prenájom účtuje `priceCents * leaseMonthlyRate / 30` denne (kategória `parcel_lease`). Kúpa = CAPEX jednorazovo. Hráč môže prenájom kedykoľvek ukončiť, ak na parcele nie sú moduly.

### 5.3 Moduly — rozmery a parametre (počiatočné hodnoty, podliehajú balansu)
| id | kind | footprint | kľúčové params | cena | údržba/deň |
|---|---|---|---|---|---|
| `berth_standard` | berth | 8×3 (dlhá hrana k vode) | `depthClass 1`, `apronSlots 4`, `maxCranes 2`, `frontWaterCells 3` | 400k | 1 200 |
| `berth_deepwater` | berth | 8×3 | `depthClass 3`, `apronSlots 6` | 900k | 2 000 |
| `crane_container_gantry` | crane | 2×3 (na berth) | `cycleTicks 12` (2 min), `category container` | 600k | 900 |
| `crane_bulk_grab` | crane | 2×3 | `cycleTicks 18`, `bulk` | 450k | 700 |
| `crane_liquid_arm` | crane | 1×2 | `flowUnitsPerTick 0.5`, `liquid` | 350k | 500 |
| `crane_gas_arm` | crane | 1×2 | `flowUnitsPerTick 0.3`, `gas` | 500k | 600 |
| `roro_ramp` | crane | 3×3 | `cycleTicks 4`, `roro` (autá schádzajú samy) | 300k | 400 |
| `container_yard_small` | storage | 4×4 | `capacityUnits 64` | 150k | 300 |
| `container_yard_medium` | storage | 6×6 | `180` (tech) | 320k | 600 |
| `container_yard_large` | storage | 8×8 | `384` (tech) | 600k | 1 000 |
| `silo_small` | storage | 3×3 | `600 t` = 24 units | 200k | 350 |
| `tank_farm_small` | storage | 4×4 | `2000 m³` = 80 units | 350k | 500 |
| `gas_holder_small` | storage | 3×3 | `1500 m³` = 60 units | 400k | 550 |
| `vehicle_lot_small` | storage | 6×6 | `72 ks` | 120k | 200 |
| `truck_gate` | gate | 2×2 | `processTicks 18` (3 min/kamión) | 80k | 150 |
| `truck_waiting_area` | waiting_area | 4×3 | `bays 6` | 60k | 100 |
| `loading_ramp_container` | ramp | 4×2 | `docks 2`, `loadTicksPerUnit 6` | 100k | 200 |
| `vehicle_depot` | depot | 3×3 | `capacity 6` vozidiel | 90k | 150 |
| `rail_station_small` | rail_station | 12×4 | `tracks 1`, `trainCapacity 60`, `loadTicksPerUnit 2` | 1.2M | 2 500 |
| cesta / koľaj | vrstva | 1×1 | — | 2k / 6k za bunku (`infrastructure.json`, ADR-010) | 0 |

Root modul zo štartovej mapy = `berth_standard` na (40, 14) + `crane_container_gantry` na (43, 14), rot 0, na `starter` parcele (`harbor_01.starter.modules`); `World.create` ho umiestni pravidlami `PlaceModule` bez ceny a udalostí s `purchaseCostCents 0` (id 1, 2), takže `RemoveModule` zaň nevráti nič (ADR-015).

### 5.4 Kotviská a skupiny (BerthGroup)
- Kotviská s **dotýkajúcimi sa krátkymi hranami na tom istom pobreží** tvoria `BerthGroup { id, berthIds[], totalLength, minDepth }` (ADR-014 bod 3): rovnaká `waterSide`, hrany pri vode na tej istej línii pobrežia (n: `origin.y`, s: `origin.y + h − 1`, e: `origin.x + w − 1`, w: `origin.x`) a koniec jedného (`start + lengthCells`) je začiatkom druhého. **Poradie po pobreží** v skupine: stúpajúco podľa `x` (n/s) alebo `y` (e/w). Skupiny sú zoradené podľa (`waterSide` v poradí n, e, s, w; línia; začiatok) a číslované od 1 — id závisia od geometrie, nie od histórie stavby. `totalLength = Σ lengthCells`, `minDepth` = minimum efektívnej hĺbky (§5). Prepočet pri každom `addModule`/`removeModule`, berth dostane `groupId`.
- **Alokácia** (`allocateBerths`, čistá funkcia; ADR-016 bod 5, aktualizované T02-14): skupiny v poradí id s `totalLength ≥ ship.lengthCells` a aspoň jedným žeriavom kategórie nákladu lode. V skupine sa hľadá súvislý **úsek** berthov s najmenším počtom berthov, pri zhode s najmenším indexom po pobreží. Úsek musí byť celý voľný (`dockedShipId === null` — bez lode aj rezervácie), **každý** jeho berth musí mať efektívnu hĺbku `≥ ship.draftClass` (hlboký úsek vyhovuje aj vedľa plytkého suseda; `minDepth ≥ draftClass` je len skratka „hlboká je celá skupina"), `Σ lengthCells ≥ ship.lengthCells`, `frontWaterCells ≥ ship.widthCells` každého berthu a úsek musí obsahovať **kompatibilný žeriav** (loď na berthe bez žeriavu by sa nikdy nevyložila). Prvý vyhovujúci úsek sa rezervuje už pri `berthing` (`dockedShipId`, `berthIds` v poradí po pobreží). Čakajúce lode idú vo FIFO podľa id bez head-of-line blokovania (§7.4).
- Loď, ktorá zaberá viac kotvísk, je obsluhovaná **všetkými žeriavmi na obsadených kotviskách** (motivácia stavať viac žeriavov); každý žeriav odkladá na apron svojho berthu.
- Loď s nákladom, ktorá drží kotviská, má na nich vždy aspoň jeden žeriav svojej kategórie: alokátor ho vyžaduje, `RemoveModule` žeriav pod loďou odmietne (`ship_docked`, §8 bod 8) a invariant kroku 12 to stráži (T02-14).
- `ApronBuffer` = per-berth sloty (`apronSlots`) na quay, kam žeriav ukladá jednotky (FIFO); vozidlá ich vyzdvihujú. Odpája takt žeriava od dostupnosti vozidiel.

---

## 6. Tick pipeline (`World.tick()`) — poradie je záväzné

```
1. clock.advance()                       // tick++, emit TickAdvanced, potom HourClosed/DayClosed/MonthClosed (ADR-013)
2. contractSystem.tick()                 // refresh poolu (denne), spawn lodí pre prijaté kontrakty, SLA kontrola, penalizácie
3. shipSystem.tick()                     // pohyb po sea lane, alokácia kotviska, docking/undocking, demurrage
4. craneSystem.tick()                    // cyklus žeriavov: loď → apron (import) / apron → loď (export, neskôr)
5. dispatcherSystem.tick()               // inbound joby apron → sklad s rezerváciou slotu, NoStorageAvailable ≤ 1×/h, priradenie voľných vozidiel (ADR-018)
6. vehicleSystem.tick()                  // FSM vozidiel: preplánovanie po zmene ciest, pohyb po trase, pobyt v module, load/unload, no_path (ADR-019)
7. flowSystem.tick()                     // pipelines (liquid/gas): presun quantity po linkách
8. landsideSystem.tick()                 // brány, stojiská, rampy, spawn/pohyb kamiónov, vlaky, export z mapy
9. economySystem.tick()                  // pri DayClosed: údržba, mzdy, prenájmy; pri MonthClosed: report
10. techSystem.tick()                    // len spracovanie čakajúcich unlockov (efekty sú okamžité pri príkaze)
11. metricsSystem.tick()                 // traffic += 1 pod každým vozidlom (po pohybe), decay traffic pri HourClosed (ADR-019); utilization, fill % neskôr
12. world.assertInvariants()             // ak checkInvariants: cargo.assertConservation() + invarianty sveta (ADR-014, ADR-016)
13. events.flush() → SimBridge           // udalosti za tick sú k dispozícii prezentácii
```
Krok 12 = `world.assertInvariants()`: najprv `cargo.assertConservation()` (každá jednotka má presne 1 lokáciu, `createdCount = živé + exported`, žiadny slot dvakrát → `CargoConservationError`), potom `findWorldViolation` (→ `WorldInvariantError`): každá jednotka u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`, aj `in_vehicle`), mriežka ↔ moduly a typ/smer cesty buniek s vrstvou dopravy (ADR-020), žeriavy (berth, rotácia, držaná jednotka, rezervácia a fáza podľa `CRANE_STATE_TRAITS`), sloty modulov (`SlotReservations.findProblem`: rezervovaný slot nie je obsadený, počet rezervácií, slot jednotky v rozsahu, `stored + reserved ≤ capacity`; v sklade len jeho kategória — ADR-017), skupiny kotvísk = prepočet, lode (`dockedShipId` ↔ `berthIds`, súvislý úsek, anchorage, dokovaná loď v `dockPoint`, náklad na palube, žeriav svojej kategórie pod loďou s nákladom, žeriav v `grabbing` len nad dokovanou loďou s nákladom svojej kategórie), depá (`vehicleIds` bez duplicít, ≤ `capacity`, = vozidlá depa vzostupne podľa id), vozidlá (job podľa stavu a jeho stav podľa `jobStates`, poloha v mape, náklad ≤ kapacita, len kategórie vozidla a len jednotky vlastného jobu s nákladom vo vozidle, pohyb `vehicleMotionProblem` — ADR-019, ADR-021) a joby (aktívne, vzostupne podľa id, index `jobOfUnit`, jednotky podľa `cargoAt`, vozidlo jobu, cieľ = sklad kategórie nákladu s rezervovaným slotom, rezervácie skladu = sloty jeho aktívnych jobov — ADR-018). V platnom stave kontroly nealokujú, kde to ide (ADR-021). Zapína ho voľba `World.create(defs, map, seed, { checkInvariants })` / `World.deserialize(defs, map, state, { checkInvariants })` — predvolene `true` (testy, `simrun`, DEV), aplikácia v produkcii `false` (výkon F6); voľba nie je súčasťou save (ADR-016 bod 8). Po F3 sú implementované kroky 1, 3 (`ShipSystem`), 4 (`CraneSystem`), 5 (`DispatcherSystem`), 6 (`VehicleSystem`), 11 (`MetricsSystem` — zatiaľ len `traffic`), 12 a 13; ostatné pribudnú na označenom mieste v `World.tick()` v tomto poradí.
- **Krok 5** (ADR-018): `createInboundJobs` → `assignOpenJobs` (§7.3). Priradené vozidlo sa pohne v kroku 6 toho istého ticku.
- **Krok 6** (ADR-019): vozidlá vzostupne podľa id, krok podľa stavu je tabuľka `VEHICLE_STEPS` (§7.3). Zmena ciest z príkazov (pred krokom 1) sa prejaví v kroku 6 toho istého ticku (`replanPending`).
- **Krok 11** (ADR-019): `traffic` rastie **po** pohybe — bunka pod vozidlom (`⌊x⌋, ⌊y⌋`) dostane `TRAFFIC_PER_VEHICLE_TICK` = 1, takže bunka pod jazdiacim vozidlom má po ticku `traffic ≥ 1`; hranicu hodiny odovzdá krok 1 (§7.6).

Príkazy (`Command`) sa aplikujú **pred krokom 1** z fronty `pendingCommands` v poradí vloženia: každý sa validuje nad aktuálnym stavom (vidí účinok predchádzajúcich), pri úspechu sa aplikuje, inak `World` emituje `CommandRejected` a stav sa nemení; príkaz zaradený počas `apply` čaká na ďalšie kolo (ADR-013). Rovnakú príkazovú časť bez posunu času vykoná `World.applyPending()` (stavba počas pauzy; `applyPending(); tick()` ≡ `tick()`, replay ekvivalentný) (ADR-013). Udalosti ticku idú v poradí vzniku: udalosti príkazov → `TickAdvanced` → `HourClosed` → `DayClosed` → `MonthClosed` → udalosti krokov 2–12 (ADR-013).

---

## 7. Logistika — detailná logika

### 7.1 Životný cyklus nákladu (`CargoLocation` + povolené prechody)
```ts
type CargoLocation =
  | { kind: 'on_ship'; shipId }            // v nákladovom priestore
  | { kind: 'in_crane'; craneId }          // počas cyklu
  | { kind: 'on_apron'; berthId; slot }    // buffer na quay
  | { kind: 'in_vehicle'; vehicleId }
  | { kind: 'in_storage'; moduleId; slot }
  | { kind: 'in_pipeline'; pipelineId }    // liquid/gas
  | { kind: 'at_ramp'; rampId; dock }      // pripravené na nakládku kamiónu/vlaku
  | { kind: 'in_truck'; truckId }
  | { kind: 'in_train'; trainId }
  | { kind: 'exported' }                   // opustilo mapu — konečný stav
```
Povolené prechody (import): `on_ship → in_crane → on_apron → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck | in_train → exported`. Pre liquid/gas: `on_ship → in_pipeline → in_storage → in_pipeline → at_ramp …`. Pre RoRo: autá sú zároveň `CargoUnit` aj dočasné `Vehicle` (`selfPropelled: true`) — `on_ship → in_vehicle(self) → in_storage(lot) → in_vehicle(self) → at_ramp → in_truck(car transporter) → exported`.
`CargoLedger.move()` vyhodí chybu pri nepovolenom prechode. Každý pohyb emituje `CargoMoved { unitId, from, to, tick }`.
- Tabuľka povolených prechodov je dáta (`CARGO_TRANSITIONS`, podľa druhu lokácie, nie kategórie nákladu — kompatibilitu kategórie strážia systémy); `CARGO_HOLDER_SPECS` hovorí, ktoré pole nesie držiteľa a slot. Ledger je **jediný zdroj polohy**: indexy podľa držiteľa udržiava sám, `move` je atomický (pri chybe nezmení nič a nič neemituje) a slot `on_apron`/`in_storage` je jedinečný na držiteľa (ADR-014).
- `create(typeId, location)` smie len v `CARGO_SPAWN_KINDS` (F2: `on_ship`), pridelí id z `world.ids`, `quantity = unitsPerBatch` a `CargoMoved` neemituje — vznik ohlási zdroj (`ShipSpawned`). `CargoMoved.tick` = `clock.tick` v okamihu presunu (počas príkazov pred krokom 1 ešte predchádzajúci tick; ADR-016 bod 12).
- `exported` je konečný stav: jednotka, ktorá doň prejde, sa z ledgera **odstráni** a ostane len v počítadle `exportedCount`, aby save nerástol s každým vyvezeným kontajnerom; kontrakty (F4/F5) budú export počítať z `CargoMoved → exported` alebo z vlastného počítadla (ADR-014 bod 7).

### 7.2 Žeriav — stavový automat
```
idle|blocked ─ štart: loď docked, náklad kategórie žeriavu, nezabraná jednotka, voľný nerezervovaný slot ─▶ reserve(slot), grabbing(g)
idle|blocked ─ štart: to isté, ale apron bez voľného nerezervovaného slotu ──────────────────────────────▶ blocked (+ CraneBlocked ≤ 1×/h)
idle|blocked ─ štart: bez práce ─────────────────────────────────────────────────────────────────────────▶ idle
grabbing(g) ─ koniec: jednotka s najmenším id on_ship → in_crane ─▶ swinging (okamžitý) ─▶ placing(p)
placing(p)  ─ koniec: in_crane → on_apron(slot) + apron.commit, CraneCycleDone ─▶ idle ─▶ v tom istom ticku nový štart
```
- `c = round(StatResolver.resolve('module', craneDefId, 'cycleTicks'))` — cieľ je `module` (štatistika z typovaných `params`, §10 add → mul, ADR-014); `g = max(1, ⌊c/2⌋)`, `p = max(1, c − ⌊c/2⌋)` (`MIN_CRANE_PHASE_TICKS`). Tick vstupu do fázy je jej nultý tick a fáza končí v ticku, keď `phaseTicksLeft` klesne na 0, takže cyklus trvá presne `c` tickov (ADR-016 bod 7).
- Prechody sú tabuľka `CRANE_TRANSITIONS` (`idle → grabbing | blocked`, `grabbing → swinging`, `swinging → placing`, `placing → idle`, `blocked → idle | grabbing`), krok podľa stavu tabuľka `CRANE_STEPS` (nie switch); žeriavy sa spracúvajú vzostupne podľa id. Stav je privátny s getterom `CraneModule.state` — mení ho len `transition()` (CraneSystem) a `restoreRuntimeState()` (save) (T02-14).
- `CRANE_STATE_TRAITS` určuje pre každý stav: drží jednotku (`swinging`, `placing` — `heldUnitId` = zrkadlo `in_crane` v ledgeri), má rezervovaný slot (`grabbing`–`placing`), počítadlo utilizácie (§11: `busy` pre `grabbing`–`placing`, `idle`, `blocked`; tick sa pripočíta po kroku podľa výsledného stavu) a fázu: `idle`/`blocked` mimo fázy (0/0), `grabbing`/`placing` bežiaca fáza (`1 ≤ phaseTicksLeft ≤ phaseTicksTotal`), `swinging` okamžitý — tick v ňom nikdy nekončí, preto sa neukladá a obnova ho odmietne (T02-14).
- **Rezervácia slotu** apronu vzniká pri štarte (`→ grabbing`), takže dva žeriavy na jednom berthe nemôžu prebookovať ten istý slot; „nezabraná jednotka" = jednotky `on_ship` − žeriavy v `grabbing` nad kotviskami lode (bez uloženého cieľa). Na konci `placing` sa pred presunom v ledgeri overí všetko, čo by `apron.commit` odmietol (`assertCommittable`), aby sa ledger a apron nerozišli (T02-14). Žeriav odkladá len na apron svojho berthu; loď na viacerých berthoch obsluhujú všetky žeriavy na nich (§5.4).
- **blocked** = loď má kompatibilný náklad, ale apron nemá voľný nerezervovaný slot; žeriav nič nedrží ani nerezervuje (§7.8 bod 1). `CraneBlocked { craneId, berthId, reason: 'apron_full' }` sa emituje len pri prechode do `blocked` a najviac raz za hernú hodinu na žeriav (`lastBlockedHour ≠ clock.gameHour`, uložené v save); žeriav, ktorý v `blocked` zostáva, udalosť neopakuje — pripomienku rieši UI (ADR-016 bod 7).

### 7.3 Dispatcher a TransportJob
```ts
type JobState = 'open' | 'assigned' | 'picking' | 'moving' | 'dropping' | 'done';
interface TransportJob { readonly id; readonly unitIds: readonly EntityId[]; readonly from: CargoLocation; readonly to: CargoLocation;
  readonly fromModuleId; readonly toModuleId; vehicleId: EntityId | null; state: JobState; readonly createdTick }
```
- **Job** (ADR-018): stavy `open → assigned → picking → moving → dropping → done` v tabuľke `JOB_TRANSITIONS` (vozidlo priradí len `assign`, ostatné `transition`), vlastnosti `JOB_STATE_TRAITS` (`hasVehicle` od `assigned`, `cargoAt` = zdroj do `picking`, vozidlo v `moving`/`dropping`, cieľ v `done`; `active` okrem `done`), povolené dvojice lokácií `JOB_ROUTES` (F3 len `on_apron → in_storage`, F4 pridá riadok). Cieľ s jedinečným slotom pojme jednu jednotku, takže vo F3 job = 1 jednotka a vozidlo s kapacitou 1 berie 1 job. Stav jobu zrkadlí FSM vozidla; hotový job `VehicleSystem` hneď odstráni (`World.removeJob`) a ohlási `JobDone`, takže save nerastie s každým prevozom. Každý aktívny job drží rezerváciu práve svojho slotu `to.slot` v cieľovom sklade.

Algoritmus každý tick (krok 5, `DispatcherSystem`: `createInboundJobs`, potom `assignOpenJobs`; bez `filter`/`map`/closures v cykle, alokuje sa len nový job):
1. **Inbound**: kotviská vzostupne podľa id, jednotky na aprone vo FIFO (poradie príchodu v ledgeri, `countAt`/`unitAtIndex` bez kópie); jednotka bez aktívneho jobu dostane sklad z `allocateStorage` a job `open` s rezervovaným slotom (`StorageModule.reserve`, `JobCreated`). **Alokátor** berie `StorageModule` s kategóriou nákladu a `freeCount > 0`, ktorý je pripojený a z kotviska dosiahnuteľný po ceste; vzdialenosť modulov = najlacnejšia dvojica **prístupových buniek** (vonkajšia bunka cestného konektora s cestou, §5) z `DistanceMatrix` (§7.4), vyhráva najmenšia, pri zhode menšie id. Ak sklad pre jednotku nie je (žiadny, nepripojený, nedosiahnuteľný, plný), job nevznikne, jednotka čaká na aprone (bez head-of-line blokovania iných jednotiek) a kotvisko emituje `NoStorageAvailable { berthId, cargoTypeId }` najviac raz za hernú hodinu (`BerthModule.lastNoStorageHour`, v save; `cargoTypeId` = typ prvej takej jednotky vo FIFO).
2. **Outbound** (F4): pre kontrakt v stave `exporting` a jednotku `in_storage` → ak existuje rampa kompatibilnej kategórie s voľným `dock` (alebo rezervovateľným) → job `storage → at_ramp`. Prioritizuj kontrakty podľa najbližšieho SLA.
3. **Priradenie**: voľné (`idle`) vozidlá sa raz za tick zozbierajú do znovupoužiteľného poľa (ADR-021); joby `open` v poradí vzniku dostanú vozidlo, ktoré vozí kategóriu nákladu, s najmenšou cenou cesty z bunky vozidla k najbližšej prístupovej bunke zdroja (`distanceToModule`), pri zhode menšie id. Vozidlo bez cesty k zdroju job nedostane, job bez vozidla ostáva `open`, priradenie skončí, keď voľné vozidlo neostane. Priradenie = `job.assign`, `vehicle.jobId`, `JobAssigned`, vozidlo `idle → to_pickup` (`VehicleStateChanged`) a trasa (`startTrip`, §7.4). Vozidlo s kapacitou > 1 a viac jobmi s rovnakým `to` príde neskôr.
4. **Pobyt v module** (ADR-004, ADR-010, ADR-011, ADR-019): po príchode na koniec trasy — prístupovú bunku modulu jobu (`to_pickup → loading`, job `picking`; `to_dropoff → unloading`, job `dropping`) — dostane vozidlo `waitTicks = internalTicks + loadTicks` (resp. `unloadTicks`), kde `internalTicks` = `Module.vehicleInternalTicks()` (`params.internalTicks` skladu/depa), inak `logistics.defaultInternalTicks` = 6. Tick vstupu je nultý tick a stav končí v ticku, keď odpočet klesne na 0, takže pobyt trvá presne `internalTicks + k × loadTicks` (ako fázy žeriavu, ADR-016). `CargoLedger.move` jednotky nastane až po jej manipulácii: vyzdvihnutie = len `on_apron → in_vehicle` (slot apronu sa uvoľní sám, ADR-017), vykládka = `assertCommittable → in_vehicle → in_storage(slot jobu) → commit`; ďalšia jednotka jobu má odpočet `loadTicks`/`unloadTicks`. Po poslednej naloženej jednotke job `moving` a jazda k cieľu, po poslednej uloženej job `done`, `removeJob`, `JobDone` v tom istom ticku a vozidlo `idle` (ostane stáť). Vnútorný pohyb v module sa nemodeluje — zámerná abstrakcia.

**FSM vozidla** (ADR-019): tabuľka `VEHICLE_TRANSITIONS` — `idle → to_pickup → loading → to_dropoff → unloading → idle` a `to_* ↔ no_path` (z `no_path` späť do toho `to_*`, z ktorého vozidlo vypadlo, podľa stavu jobu: `assigned` → `to_pickup`, `moving` → `to_dropoff`, `RESUME_AFTER_NO_PATH`). `VEHICLE_STATE_TRAITS` určuje `hasJob`, `jobStates` (stavy jobu zodpovedajúce stavu vozidla; `no_path` má dva a rozhodne poloha nákladu), `motion` (`park` `[cell]`, `drive` po trase k prístupovej bunke, `halt` bez cesty v strede bunky alebo uprostred rozbehnutého úseku), `waits` (odpočet `waitTicks ≥ 1`) a `destination` (zdroj/cieľ jobu). Stav mení len `changeVehicleState` (`Vehicle.transition` + `VehicleStateChanged`); `VehicleSystem` (krok 6) spracúva vozidlá vzostupne podľa id krokom z tabuľky `VEHICLE_STEPS`. **Prechod stavu ukončí pohyb v danom ticku** (ako lode): po naložení (`→ to_dropoff`) aj po návrate z `no_path` sa vozidlo pohne až v ďalšom ticku; výnimka je priradenie v kroku 5. Jazda s nulovou trasou (vozidlo už stojí na prístupovej bunke cieľa) je platná, príchod spracuje najbližší krok 6.

### 7.4 Pathfinding
- **A*** (`Pathfinder`, ADR-018, ADR-020): uzly sú bunky `road === 'road'` (index `y × width + x`), hrany k 4 susedom v poradí `DIRECTIONS_4` (N, E, S, W; `Grid.neighbors4` sa nepoužíva), **smerové** podľa `isRoadStepAllowed` (§5.1). Cena vstupu do bunky z `CellCostFn` — vo svete `RoadSpeeds.cellCost` = `1 / speedFactor` typu cesty (dvojpruhová 1, jednopruhová 1/0,7), F11 pridá `congestionPenalty` (§7.6); cena musí byť konečná ≥ `BASE_CELL_COST` = 1 (inak `RangeError`), takže heuristika Manhattan × `BASE_CELL_COST` je prípustná aj konzistentná aj na smerovom grafe. **Deterministický výber** z open setu: menšie `f`, pri zhode menšie `h`, potom menší index bunky; pri rovnakej cene ostáva prvý nájdený rodič — rovnaký vstup dá vždy tú istú cestu nezávisle od histórie volaní. Binárna halda nad `Int32Array` a pracovné polia s generačnými pečiatkami vzniknú raz; hľadanie alokuje len výsledné pole. `findPath` (cesta vrátane oboch koncov), `findCost` a `routeCost(path)` (súčet cien v poradí jazdy — bitovo rovný `findCost` pre cestu z `findPath`).
- **`PathCache`** (cesty) a **`DistanceMatrix`** (ceny) sú čisté memo nad usporiadanou dvojicou (`from`, `to`) a zneplatnia sa celé, keď sa zmení `World.roadVersion` (§5) — bez odberu udalostí; obsah nie je stav simulácie a do save nepatrí. `DistanceMatrix` berie cenu ako `routeCost` cesty z `PathCache`, takže dvojicu, ktorú dispatcher zmeria a vozidlo potom prejde, hľadá po zmene ciest jeden A* (ADR-021). Jednosmerky a cena podľa cieľovej bunky robia maticu nesymetrickou.
- **Trasa vozidla** (ADR-019, ADR-020): cieľ je prístupová bunka modulu jobu s najnižším `routeCost` z **kotvy** vozidla — `cell`, pri pohybe medzi bunkami `nextCell` (rozbehnutý úsek vozidlo dokončí); pri zhode prvý konektor v poradí defu (`planRoute`). Ak nová cesta z `nextCell` vedie hneď späť do `cell` (teda je povolený krok `nextCell → cell`), vozidlo sa **otočí uprostred úseku** (`turnAround`: úsek sa otočí, progres `1 − p`, poloha ostane); na jednosmerke proti smeru sa neotočí a preplánuje dopredu (obchádzkou) alebo prejde do `no_path`. Každá zmena ciest (`markRoadsChanged`) nastaví jazdiacim vozidlám `replanPending` a `VehicleSystem` pred pohybom preplánuje z kotvy. **Bez cesty** (priradenie, koniec nakladania, preplánovanie) vozidlo prejde do `no_path`, zahodí zvyšok trasy (`halt`: `[cell]`, pri pohybe medzi bunkami `[cell, nextCell]` — zastane uprostred úseku) a o `logistics.repathIntervalTicks` skúsi znova; úspech = návrat do pôvodného `to_*`.
- **Pohyb vozidla** (`Vehicle.advance`, ADR-019, ADR-020, ADR-021): za tick o `speedCellsPerTick`; úsek `cell → nextCell` ide rýchlosťou `speedCellsPerTick × speedFactor` **cieľovej** bunky (tej istej, ktorej cenu platí A*, takže cena cesty = čas jazdy × `speedCellsPerTick`): zvyšok kroku sa meria v bunkách pri faktore 1 a úsek s faktorom `f` spotrebuje `zvyšok / f`. Zvyšok prechádza cez stred bunky do ďalšieho úseku (aj v zákrute), na konci trasy vozidlo zastane presne v strede poslednej bunky a zvyšok prepadne; keď `progres + krok` v double vyjde 1, hoci krok < zvyšok úseku, vozidlo dorazí do stredu ďalšej bunky. Progres je 0 alebo v (`PROGRESS_NOISE` = `Number.EPSILON`, 1) — šum zvyšku kroku po strede bunky sa zahodí, takže obrat nikdy nedá neplatný progres 1 (`turnAround` má poistku `VehicleError`). Poloha `x, y` = `vehiclePosition` (stred `cell` + progres k `nextCell`), kurz kardinálny podľa smeru úseku (`cardinalHeading`, bez trigonometrie); stojace vozidlo si kurz ponechá.
- **`RemoveRoad` a prestavba pod vozidlom** → `occupied` pre bunku, na ktorej stojí akékoľvek vozidlo, a pri pohybe medzi bunkami pre obe bunky úseku (`World.vehicleOnCell`) — cesta pod vozidlom a pred ním nezmizne (ADR-019, ADR-020).
- Kamióny: A* od `RoadPortal` k `TruckGate.connector` (povinný waypoint), potom k `WaitingArea`, potom k `LoadingRamp`, späť cez `TruckGate` k portálu. Vlaky: A* po `rail` bunkách od `RailPortal` k `RailStation`.
- Lode: **nie A*** a **bez trigonometrie** (ADR-016 bod 1–4). FSM je tabuľka `SHIP_TRANSITIONS` (`inbound → waiting_anchorage | berthing`, `waiting_anchorage → berthing`, `berthing → docked`, `docked → undocking`, `undocking → outbound`, `outbound → despawned`), stav mení len `Ship.transition` a `ShipSystem` (krok 3) spracúva lode vzostupne podľa id tabuľkou krokov. Trasa stavu sa odvodí, neukladá sa (`shipRoute`): `inbound` = stredy buniek `seaLane`, `waiting_anchorage` = stred pridelenej bunky anchorage, `berthing` = priama úsečka k `dockPoint` (voda je otvorená), `undocking` = koniec `seaLane`, `outbound` = `seaLane` odzadu po `seaLane[0]`.
- Pohyb `speedCellsPerTick` po úsečkách (dĺžka cez `Math.sqrt`, IEEE presná); zvyšok kroku pokračuje ďalším úsekom tej istej trasy, na konci trasy loď zastane presne v poslednom bode a prechod stavu ukončí pohyb v danom ticku. **Kurz je kardinálny** podľa dominantnej osi úseku (`|dx| ≥ |dy|` → 90/270, inak 180/0; nulový úsek kurz nemení) — `Math.sin/cos/atan2` sú v `src/sim` zakázané (nie sú bit-presné naprieč enginmi), plynulé natáčanie je vec renderu.
- **Poloha pri kotvisku** (`dockPoint`): obdĺžnik `lengthCells` buniek pozdĺž pobrežia od prvej bunky hrany prvého obsadeného berthu × `widthCells` riadkov pásu `frontWaterBand`; stred = `c0 + a·(L − 1)/2 + o·(W + 1)/2` (násobky 0,5 — presné v double, nezaokrúhľujú sa; Root berth: feeder (43, 13)). Kurz pri kotvisku je rovnobežný s hranou, nábrežie po pravoboku (`DOCKED_HEADING`: n → 90, e → 180, s → 270, w → 0). Dokovaná loď stojí presne tam (`SHIP_STATE_TRAITS.moored`; overuje obnova save aj krok 12, T02-14).
- Alokácia kotvísk (§5.4) sa skúša na konci `seaLane` a potom každý tick v `waiting_anchorage`, lode vzostupne podľa id (FIFO bez head-of-line blokovania). Neúspešná loď dostane prvú bunku `map.anchorage`, ktorú nemá iná loď; ak sú obsadené všetky, čaká na konci `seaLane`. `docked → undocking` nastane, keď na palube nie je žiadna jednotka `on_ship` (kotviská sa uvoľnia, `ShipUndocked`); na `seaLane[0]` loď prejde do `despawned`, odstráni sa zo sveta a emituje `ShipDeparted`. Lode sa môžu fyzicky prekrývať a trajektória sa neoveruje voči súši — zámerný „soft" model ako §7.6 (ADR-016).

### 7.5 Landside reťazec (kamióny)
```
TruckSpawner: pre každý dock rampy s jednotkami 'at_ramp' >= truckCapacity(1 TEU pre kontajner, 1 batch pre bulk)
  a s voľným bay v niektorej WaitingArea na tej istej cestnej sieti → spawn Truck na RoadPortal
Truck FSM: spawned → to_gate → gate_queue(processTicks, FIFO za bránu) → to_bay → waiting(bay) → to_dock
           → loading(loadTicksPerUnit * units) → to_gate_out → gate_queue → to_portal → exit → units 'exported'
```
- Bez `TruckGate` na ceste medzi portálom a rampou je rampa **neplatná** (validácia pri stavaní: existuje cesta portál→brána→rampa). Bez `WaitingArea` sa kamióny nespawnujú → notifikácia.
- Priepustnosť brány = tvrdý bottleneck (1 kamión / `processTicks`). Fronta pred bránou je „virtuálna" (mimo mapy) → nikdy nevznikne gridlock.
- Vlaky (fáza 10): `RailStation` s `tracks`; vlak príde, keď `stagedUnits >= 0.6 * trainCapacity` alebo keď SLA kontraktu hrozí; loaduje `loadTicksPerUnit * units`, odchádza.

### 7.6 Soft kongescia (bez fyzických kolízií)
- **Traffic** (F3, krok 11 po pohybe, ADR-019): bunka pod každým vozidlom (`⌊x⌋, ⌊y⌋`) dostane `cell.traffic += TRAFFIC_PER_VEHICLE_TICK` (1) za tick. Pri `HourClosed`: `traffic *= trafficDecayPerHour` (0.9) a hodnota pod `TRAFFIC_ZERO_THRESHOLD` = 1e-3 sa vynuluje (technická hranica riedkeho save, pomenovaná konštanta v kóde; kandidát na def).
- **Typ cesty** (F3, ADR-020): úsek ide rýchlosťou `speedCellsPerTick × speedFactor` typu cieľovej bunky a A* platí `1 / speedFactor` (§7.4) — jednopruhová cesta je lacnejšia na stavbu, ale pomalšia.
- Rýchlosť vozidla na bunke podľa počtu vozidiel: `speed * 1 / (1 + slowdownPerExtraVehicle * max(0, vehiclesOnCell - 1))` (0.25; fáza 11). Pathfinding pridáva `congestionPenalty = clamp(traffic / penaltyTrafficDivisor, 0, penaltyMax)` (200, 3) — cena sa potom mení bez zmeny `roadVersion`, takže cache ciest potrebuje ďalší spúšťač invalidácie (BACKLOG).
- **Pruhy sú prezentácia** (ADR-020): dvojpruhová cesta nemá dva uzly — vozidlá v protismere sa v sime neobchádzajú ani neblokujú; render ich posunie do pravého pruhu (`laneOffset` podľa `ROAD_KIND_TRAITS.lanes`, v zákrute oblúk podľa `prevHeading` a `heading`, §13, §15.1).
- Konštanty sú v `logistics.json` → `congestion` (§4.6) (ADR-010).
- Heatmapa v UI = normalizované `traffic` per bunka. Žiadne deadlocky, žiadna fyzika — vozidlo nikdy nečaká na iné vozidlo (§7.8 bod 2).

### 7.7 Skladovanie
- **Obsadenie je len v ledgeri** (ADR-017): sklad nemá vlastné pole slotov — jednotka leží na `in_storage { moduleId, slot }` a `StorageModule` (§5) drží len rezervácie slotov (`SlotReservations`) a kumulatívne počítadlá `unitsIn` / `unitsOut`. Kapacita `capacityUnits` (kontajnerový dvor: `slots × layers` v manifeste, `container_yard_small` 32 × 2 = 64); `Silo/Tank/GasHolder` budú ďalšie triedy `STORAGE_MODULES` s rovnakým modelom (kontinuálne komodity sú diskretizované do `CargoUnit`, ADR-003).
- Tok: dispatcher pri vzniku jobu `reserve()` (najnižší voľný nerezervovaný slot) → vozidlo pri vykládke `assertCommittable(slot, unit)` → `CargoLedger.move(unit, in_storage(id, slot))` → `commit(slot, unit)` (rezervácia zaniká, `unitsIn += 1`). Výdaj (F4): `move` von → `recordTaken(unit)` (`unitsOut += 1`). Zrušený job: `release(slot)`.
- **Rezervácie patria jobom** (ADR-018): každý aktívny job drží práve svoj slot `to.slot` a iné rezervácie sklad nemá (krok 12). Preto sa neukladajú — obnova ich vytvorí z `to` jobov (`reserveSlot`).
- Fill % = `(stored + reserved) / capacity` pre alokátor (`freeCount > 0`), `stored / capacity` pre UI a sprite (`fillState` 0/25/50/75/100, §15.1); `RemoveModule` skladu s jednotkou alebo rezerváciou je `has_cargo` (§8 bod 8).
- Politika modulu (UI): `acceptAnyContract | reservedForContractId` (fáza 12).

### 7.8 Prevencia deadlockov — invarianty
1. Apron buffer je jediné miesto, kde žeriav čaká — čaká len na slot, nie na vozidlo.
2. Vozidlo nikdy nečaká na inú entitu na bunke (soft kongescia).
3. Kamión sa spawnuje iba, ak má garantovaný bay; fronta pred bránou je neobmedzená.
4. Ak sklad chýba/je plný, žeriav sa zablokuje → loď stojí → demurrage. **To je zámerný herný tlak**, nie bug — UI to musí jasne oznámiť.

---

## 8. Pravidlá umiestňovania (`PlaceModuleCommand.validate`)
Vracia `ValidationResult { ok: boolean; reasons: ValidationReason[]; cells: CellCoord[]; costCents: number }` — rovnaký tvar ako všetky príkazy; UI ho používa na farbu ghostu a `costCents` je cena, ktorú by `apply` strhol (záporná = príjem) (ADR-013).
Pravidlá majú **jediný opis** v `src/sim/world/module-rules.ts`: čisté funkcie `findPlacementViolations` / `findRemovalViolations` nad tabuľkami `PLACEMENT_CHECKS` / `REMOVAL_CHECKS`. Zdieľa ich príkaz (všetky porušenia naraz, bez duplicít, v kanonickom poradí `VALIDATION_REASONS`), `World.create` pre starter moduly a `World.addModule` / `removeModule` ako poistka (`ModuleError` s kódom prvého porušenia; pri umiestnení len štrukturálne pravidlá, takže obnova save neoveruje terén, parcelu ani vodu) (ADR-015). `PlaceModule`: `cells` = celý footprint po rotácii row-major (aj bunky mimo mapy — ghost), `costCents = def.costCents` aj pri odmietnutí; pri `unknown_def` / `invalid_rotation` sa pravidlá nevyhodnocujú (`cells = []`). `RemoveModule`: `cells` = footprint modulu, `costCents` = −refundácia.
1. Všetky footprint bunky `inBounds` (bunky mimo mapy hlási len `out_of_bounds`), terén ∈ `requiredTerrain` (`terrain`), `moduleId === null` (`occupied`), `road === 'none'` (cesta vo footprinte je tiež `occupied`). **Žeriav** (`mustAttachTo: ['berth']`) stojí na bunkách berthu, preto sa preň `moduleId === null` číta ako „všetky bunky patria jednému berthu" (ADR-014 bod 1).
2. Parcela vlastnená/prenajatá pre všetky bunky (ak `requiresParcelOwnership`) (`parcel_not_owned`, ADR-008).
3. `berth` so stranou `waterSide` po rotácii (ADR-015 bod 3): `no_water_side` = niektorá bunka hrany pri vode nesusedí s vodou v mape; `water_blocked` = pre bunky hrany, ktoré s vodou susedia, **pás** `params.frontWaterCells` riadkov pred nimi (`BerthModule.frontWaterBand`) nie je celý v mape a vo vode, zasahuje do footprintu modulu, do pásu kotviska s inou `waterSide` (pásy kotvísk s rovnakou stranou ležia vedľa seba a nekonfliktujú) alebo do obdĺžnika lode v stave `berthing` / `docked` / `undocking` (ADR-016 bod 11).
4. `crane`: footprint musí ležať celý na jednom `berth` (`no_berth`), mať jeho rotáciu (`rotation_mismatch`), neprekrývať iný žeriav berthu (`occupied`) a berth môže mať najviac `params.maxCranes` žeriavov (`max_cranes`, default 2 na 8 buniek) (ADR-014, ADR-015).
5. **`connector_blocked`** (ADR-017, od F3): každý modul s aspoň jedným konektorom typu `road` (sklad, depo, **aj kotvisko**; neskôr rampa, brána, stojisko) musí mať aspoň jeden taký konektor (na bunke v mape), ktorého vonkajšia bunka má cestu **alebo je voľná pre cestu** — v mape, terén unesie cestu, bez footprintu modulu vrátane umiestňovaného a bez koľaje (`isOutsideUsable`). Vlastníctvo parcely sa neoveruje (parcela sa dá dokúpiť alebo prenajať), konektory na bunkách mimo mapy hlási len `out_of_bounds`. Sklad postavený skôr než cesta je OK — dispatcher ho ignoruje, kým nie je pripojený (`World.isConnected`, §5), a UI zobrazí „Nepripojené". Pravidlo hráča (`PLACEMENT_RULE_ERROR = null`), obnova save ho neoveruje; modul bez cestných konektorov (žeriav) sa ním neriadi. Otvorené: zakázať stavbu, ktorá zablokuje posledný konektor iného modulu (BACKLOG).
6. Tech: `techRequired` odomknutý (vo F2 sa nevyhodnocuje). Peniaze: pri `costCents > 0` musí platiť `cash >= costCents` (inak `insufficient_funds`, ghost stále zelený s ikonou $); bezplatné akcie a refundácie (`costCents ≤ 0`) prejdú aj pri zápornej hotovosti (ADR-013).
7. Rotácia: 0/90/180/270 (iná konečná hodnota = `invalid_rotation`) — footprint a konektory sa transformujú `rotateLocalCell` / `rotateSide` (`footprintOf`, `connectorsOf`); x, y príkazu = ľavý horný roh footprintu **po** rotácii.
8. `RemoveModuleCommand` odmietne `unknown_module`, `has_cargo` (náklad u modulu v ledgeri alebo `cargoSlots().reservedCount > 0` — apron aj sklad, ADR-017; modul s aktívnym jobom má jednotku na aprone alebo rezervovaný slot, takže nejde odstrániť ani on, ADR-018), `has_cranes` (berth so žeriavmi), `has_vehicles` (depo s neprázdnym `vehicleIds`, ADR-017), `ship_docked` (berth, ktorý drží loď v `berthing` / `docked`, **aj žeriav stojaci na takom berthe** — loď bez žeriavu svojej kategórie by pri kotvisku ostala naveky s nákladom; T02-14, ADR-015 bod 4) a `busy` (žeriav mimo `idle` / `blocked`). `RemoveRoad` a prestavba cesty odmietnu bunku so vozidlom (`occupied`, §7.4). Refundácia = `refundCents(purchaseCostCents, economy.removalRefundRate)` = `floor(price × round(rate × 10 000) / 10 000)` počítaná celočíselne v **bázických bodoch** zo **zaplatenej** ceny, takže starter moduly (`purchaseCostCents 0`) nevrátia nič (ADR-013, ADR-015 bod 5); `MoneyChanged(module_sale)` len pri refundácii > 0. Rovnaký helper používa `RemoveRoad` s aktuálnou cenou vrstvy (ADR-012).

---

## 9. Kontrakty a ekonomika

### 9.1 Kontrakt
```ts
type ContractState = 'offered' | 'accepted' | 'ship_en_route' | 'unloading' | 'exporting' | 'completed' | 'failed' | 'expired';
interface Contract { id; templateId; cargoTypeId; volumeUnits; rewardCents; xpReward;
  offeredTick; offerExpiresTick; acceptedTick?; shipClassId; shipArrivalTick?; slaDeadlineTick?;
  unitsUnloaded; unitsExported; penaltiesCents; state }
```
- **Pool**: pri `DayClosed` doplní ponuky do `offersPerDay`; vyberá šablóny váhovo podľa odomknutých kategórií a `minTier` (tier = počet dokončených kontraktov / 10). Objem sa škáluje na `[0.4, 1.2] × capacityHint`, kde `capacityHint = min(sum berth capacity per day, sum storage capacity)` — ponuky sú vždy realistické, ale horná hranica tlačí na expanziu.
- **Odmena**: `reward = volumeUnits × basePricePerUnit × urgency`, `urgency = 1 + 0.6 × (1 − slaDays / maxSlaDays)`.
- **Prijatie**: `shipArrivalTick = now + rng.range(0.5, 2) dní`; `slaDeadlineTick = shipArrivalTick + slaDays`.
- **Penalizácie**:
  - Demurrage: za každú hodinu státia lode nad `berthAllowanceTicks`: `reward × demurrageRatePerHour` (0,5 %).
  - Late export: za každý deň po `slaDeadlineTick`: `reward × latePenaltyRatePerDay` (5 %).
  - Fail: `daysLate > failAfterDaysLate` → `failed`, odmena prepadá, penalizácie zostávajú, reputácia −5.
- **Dokončenie**: `unitsExported === volumeUnits` → `completed`, `cash += reward − penalties`, `xp += xpReward × (onTime ? 1 : 0.5)`.
- Loď odpláva, keď `unitsUnloaded === volumeUnits` (nezávisle od exportu).

### 9.2 Ledger a účtovné obdobia
```ts
type LedgerCategory = 'contract_revenue' | 'penalty' | 'module_capex' | 'module_sale' | 'road_capex' | 'road_sale'
  | 'parcel_purchase' | 'parcel_lease' | 'maintenance' | 'wages' | 'vehicle_capex' | 'vehicle_sale';  // road_sale (ADR-012)
interface LedgerEntry { tick; amountCents; category; refId?: string }
```
- `Economy { cashCents, entries: RingBuffer<LedgerEntry>(50k), daily: DaySummary[365], monthly: MonthSummary[36] }`.
- `DayClosed`: `maintenance = Σ module.maintenancePerDay`, `wages = Σ vehicle.wagePerDay + Σ crane.params.wagePerDay`, `lease = Σ leased parcel price × 0.015 / 30`. Zapíš `DaySummary { income by category, expense by category, cashEnd }`.
- `MonthClosed`: agreguj `MonthSummary`, emit `MonthlyReport` (UI modal).
- Bankrot: `cash < 0` po `bankruptcyDays` (30) za sebou → `GameOver`. (Pôžičky = backlog.)
- Štart: `startingCashCents = 1 200 000 00`, Root modul predpostavený, 1 parcela vlastnená.

### 9.3 Reputácia (fáza 12)
`0–100`, štart 50; `+2` za včasný kontrakt, `−5` za fail. Váha šablón s vyšším `basePrice` rastie s reputáciou.

---

## 10. Progresia — XP a tech tree
- XP získava len `ContractCompleted`. `StatResolver` drží `modifiers: Modifier[]` a `resolve(target, id, stat)` = `base` → aplikuj `add` → aplikuj `mul` (poradie záväzné). Výsledky cache-uje do `TechChanged`.
- Vetvy (počiatočný obsah `tech_tree.json`):
  - **cargo**: `bulk_handling` (silo, grab crane, bulk_shuttle, grain) → `liquid_handling` (tank, arm, tanker_shuttle, pipeline, crude_oil) → `gas_handling` → `roro_handling`.
  - **efficiency**: `crane_speed_1` (×0.85 cycleTicks) → `crane_speed_2` (×0.85) ; `vehicle_capacity_1` (agv) ; `autonomous_vehicles` (−50 % wages AGV) ; `gate_fast_lane` (×0.7 processTicks); `yard_medium` → `yard_large`.
  - **infrastructure**: `rail_link` (rail_station, koľaje) → `rail_station_large`; `deepwater_berth` (berth_deepwater, ship mega); `logistics_hub` (depot capacity ×2, dispatcher „lookahead": rezervácie 2 joby dopredu).
- `ResearchTechCommand.validate`: prerequisites splnené, `xp >= xpCost`. `apply`: `xp -= cost`, aplikuj efekty, emit `TechUnlocked`.

---

## 11. Metriky (`MetricsSystem`)
- **Finance**: z `Economy.daily/monthly` (nie duplicitne).
- **Utilization**: per žeriav a vozidlo `busyTicks/blockedTicks/idleTicks` v hodinovom ring bufferi (24 h) + celkové; `utilization = busy / (busy+idle+blocked)`.
- **Storage**: per modul `fill%`, `reserved%`, `throughputUnitsPerDay` (in/out).
- **Traffic heatmap**: `cell.traffic` (§7.6); snapshot exportuje `Float32Array(width*height)` normalizovanú `0..1` len keď je overlay zapnutý.
- **Contracts**: on-time rate, avg berth time, avg dwell time (apron→exported).
- **Bottleneck hint** (fáza 11): jednoduchá heuristika — ak `crane.blocked% > 30` → „sklad plný", ak `vehicle.idle% < 10 & apron plný` → „málo vozidiel", ak `gate queue avg > 3` → „brána".

---

## 12. Udalosti a príkazy

### 12.1 `SimEvent`
Implementované (F1 – F3, `src/sim/events/sim-event.ts`):

| Udalosť | Payload | Kedy |
|---|---|---|
| `TickAdvanced` | `tick` | krok 1, každý tick |
| `HourClosed` / `DayClosed` / `MonthClosed` | `tick` | krok 1 pri uzavretí hranice, v tomto poradí (ADR-013) |
| `RoadChanged` | `cells` | `PlaceRoad` (nové aj prestavané bunky, ADR-020) / `RemoveRoad` |
| `MoneyChanged` | `cashCents, deltaCents, reason: LedgerCategory` | každá zmena hotovosti (`road_capex`, `road_sale`, `module_capex`, `module_sale`, `vehicle_capex`, `vehicle_sale`, …) |
| `GameSpeedChanged` | `speed` | `SetGameSpeed` |
| `CommandRejected` | `commandType, reasons` | príkaz z fronty neprešiel `validate` pri aplikácii, stav sa nezmenil (ADR-013) |
| `CargoMoved` | `unitId, from, to, tick` | každý `CargoLedger.move` (§7.1) |
| `ModulePlaced` | `moduleId, defId, x, y, rotation, cells` | `PlaceModule` (starter moduly udalosť nemajú) (ADR-015) |
| `ModuleRemoved` | `moduleId, defId, cells` | `RemoveModule` (ADR-015) |
| `ShipSpawned` | `shipId, classId, cargoTypeId, units` | `SpawnShipDebug` (neskôr kontrakty) (ADR-016) |
| `ShipDocked` | `shipId, berthIds` | `berthing → docked` |
| `ShipUndocked` | `shipId` | `docked → undocking`, kotviská sú voľné |
| `ShipDeparted` | `shipId` | `outbound → despawned`, loď odstránená z `world.ships` |
| `CraneCycleDone` | `craneId, unitId` | koniec `placing` — jednotka leží na aprone |
| `CraneBlocked` | `craneId, berthId, reason: 'apron_full'` | prechod do `blocked`, najviac 1× za hernú hodinu na žeriav (§7.2) |
| `VehicleBought` | `vehicleId, defId, depotId` | `BuyVehicle` — vozidlo stojí `idle` pri depe; cena v `MoneyChanged(vehicle_capex)` (F3) |
| `VehicleSold` | `vehicleId` | `SellVehicle` — refundácia v `MoneyChanged(vehicle_sale)` len pri sume > 0 (F3) |
| `JobCreated` | `jobId, unitIds, fromModuleId, toModuleId` | krok 5: job `open` s rezervovaným slotom (ADR-018) |
| `JobAssigned` | `jobId, vehicleId` | krok 5: `open → assigned`; hneď po nej `VehicleStateChanged idle → to_pickup` |
| `JobDone` | `jobId` | krok 6: posledná jednotka uložená, job odstránený z `world.jobs` |
| `VehicleStateChanged` | `vehicleId, from, to` | každý prechod FSM vozidla (`changeVehicleState`, ADR-019) |
| `NoStorageAvailable` | `berthId, cargoTypeId` | krok 5: jednotka na aprone bez skladu, najviac 1× za hernú hodinu na kotvisko (§7.3) |

Poradie v ticku s vozidlami: všetky `JobCreated`, potom pre každé priradenie `JobAssigned` → `VehicleStateChanged` (krok 5), potom udalosti kroku 6 po vozidlách vzostupne podľa id v poradí vzniku (napr. vykládka: `CargoMoved` → `JobDone` → `VehicleStateChanged unloading → idle`).
Plánované (výber): `ContractOffered, ContractAccepted, ContractCompleted, ContractFailed, TruckSpawned, TruckExited, TrainArrived, TrainDeparted, ParcelOwnershipChanged, PenaltyApplied, TechUnlocked, NoVehicleAvailable, GameOver`.
Udalosti sú `readonly` DTO; `EventBus` ich zbiera do poľa za tick v poradí vzniku (§6); prezentácia ich číta a nikdy nemení. Nový typ = nový člen únie `SimEvent` (+ test).

### 12.2 `Command`
Implementované: `PlaceRoad`, `RemoveRoad`, `SetGameSpeed` (F1; `PlaceRoad { kind, dirs }` od F3), `PlaceModule`, `RemoveModule`, `SpawnShipDebug` (F2), `BuyVehicle`, `SellVehicle` (F3). Plánované: `PlaceRail, RemoveRail, BuyParcel, LeaseParcel, ReleaseParcel, AcceptContract, DeclineContract, ResearchTech, SetStoragePolicy`.
Každý `Command` má `type`, payload, `validate(world): ValidationResult` (nemení svet, nespotrebuje `Rng` — UI ho volá pri každom pohybe ghostu), `apply(world)` a `toJSON(): SerializedCommand` (`{ type, …payload }`, len JSON hodnoty). `commandFromJSON(json)` cez `commandRegistry` (tabuľka `BUILTIN_COMMANDS`, nie switch) vytvorí ekvivalentný príkaz — `commandFromJSON(cmd.toJSON())` ≡ `cmd`; neplatný tvar je `CommandError`. Serializovateľnosť je základ **replay** (`data/scenarios/*.json` = `{ id, seed, map, commands: [{ atTick, command }] }`).
- **`PlaceRoad { cells, kind?, dirs? }`** (ADR-020): `kind` z `ROAD_KINDS`, bez neho `two_lane` (JSON z F1–F3 platí bez zmeny, `toJSON` vracia `kind`/`dirs` len ak boli na vstupe); `dirs[i]` = smer bunky `cells[i]` len pri jednosmerke (UI ho odvodí z ťahu `dragDirections`; pri duplicitnej bunke platí prvý výskyt). Štrukturálne chyby sú `CommandError`, neznámy typ `invalid_road_kind`, chýbajúce/prebytočné/zlé `dirs` alebo iná dĺžka než `cells` `invalid_direction` — vtedy sa bunky neposudzujú (`cells = []`, cena 0). Bunka s cestou rovnakého typu aj smeru sa preskočí zadarmo; iný typ alebo smer je **prestavba** = atomický `RemoveRoad + PlaceRoad` (vozidlo na bunke alebo ako cieľ rozbehnutého úseku → `occupied`, parcela na predaj → `parcel_not_owned`). Cena = stavba (zmenené bunky × cena nového typu, `road_capex`) − `refundCents(Σ cien starých typov prestavaných buniek, removalRefundRate)` raz za príkaz (`road_sale`); `validate().costCents` je čistá cena (môže byť záporná), rozpad dáva `RoadLayerCommand.quote()` (`buildCents`, `refundCents`). `apply` emituje `RoadChanged`, pri refundácii > 0 `MoneyChanged(road_sale)` a nakoniec vždy `MoneyChanged(road_capex)`; každá zmena typu alebo smeru volá `markRoadsChanged`.
- **`RemoveRoad { cells }`**: refundácia podľa typu každej bunky (ADR-012, ADR-020), bunka so vozidlom (stojace alebo cieľ rozbehnutého úseku, `World.vehicleOnCell`) → `occupied` (ADR-019); odstránená bunka dostane normalizovaný typ (`two_lane`, bez smeru).
- **`BuyVehicle { vehicleDefId, depotId }`** (F3): `validate` vráti naraz `unknown_vehicle_def`, `unknown_depot` (modul nie je `VehicleDepot`; o státiach a pripojení sa potom nerozhoduje), `depot_full` (`freeStalls`), `not_connected` (`World.isConnected`) a `insufficient_funds`; `cells = []`, `costCents = def.purchaseCents` (pri neznámom defe 0). `apply`: vozidlo s novým id, `idle` v strede vonkajšej bunky prvého pripojeného cestného konektora depa s kurzom von z depa (`depotExit`), `purchaseCostCents = def.purchaseCents`, `World.addVehicle`, hotovosť −= cena, `VehicleBought` a pri cene > 0 `MoneyChanged(vehicle_capex)`.
- **`SellVehicle { vehicleId }`** (F3): `unknown_vehicle`, `vehicle_busy` (nie `idle`, má job alebo vezie náklad); `costCents` = −`refundCents(purchaseCostCents, removalRefundRate)` zo **zaplatenej** ceny. `apply`: `World.removeVehicle` (odpojí vozidlo od depa), hotovosť += refundácia, `VehicleSold` a pri refundácii > 0 `MoneyChanged(vehicle_sale)`.

`SpawnShipDebug { shipClassId, cargoTypeId, units }` je ladiaca loď — kým nie sú kontrakty (F4/F5), jediný zdroj lodí a nákladu. Je registrovaný **vždy** (scenáre, replay, `simrun`) a stojí 0, tlačidlo v UI je **len v DEV** (`import.meta.env.DEV`). `validate` vráti naraz `unknown_ship_class`, `unknown_cargo`, `cargo_incompatible` (kategória ∉ `cargoCategories`) a `invalid_units` (celé `1 … capacityUnits`); `apply` vytvorí loď na `seaLane[0]` (id pred id jednotiek), `units` jednotiek `on_ship` a `ShipSpawned` (ADR-016 bod 10).

---

## 13. Snapshot pre prezentáciu
`SimBridge.snapshot(): WorldSnapshot` — **plytký read-only view** (žiadne kopírovanie veľkých polí každý frame). Snapshot **v2** (F2, karta T02-09; ADR-016 Dôsledky):
- F1 polia: `tick`, `speed`, `cashCents`, `day`, `hour`, `minute` (z kalendárnych getterov §3), `grid` a `parcels` (živé referencie, immutable rozhranie);
- `speeds` = `time.speeds` — HUD ich číta zo snapshotu, nie zo sveta;
- `revision` — počítadlo štrukturálnych zmien: rastie pri každej udalosti, ktorá mení obsah sveta mimo ticku a hotovosti (`ModulePlaced` / `ModuleRemoved`, `RoadChanged`, `Ship*`, `CargoMoved`, `CraneBlocked`, `CraneCycleDone`), takže panely lacno zistia zmenu `grid` alebo modulov;
- `modules: ModuleVM[]` (moduly okrem žeriavov v poradí umiestnenia; berth s `apron { capacity, units: [{ slot, unitId, typeId }] }`), `cranes: CraneVM[]` (`berthId`, `state`, `progress` = `CraneModule.phaseProgress`, `holding`), `ships: ShipVM[]` (vzostupne podľa id; `x, y, prevX, prevY, heading, lengthCells, widthCells, unitsOnBoard` = `cargo.countAt('on_ship', id)`, `capacityUnits`, `cargoCategory`, `state`) — typy z `src/render/view-models.ts`;
- `prevX` / `prevY` = poloha lode pred posledným tickom — vedie ju **bridge** (zapamätá si ju pred každým tickom), sim predchádzajúcu polohu nevedie (ADR-016). Render interpoluje `lerp(prev, curr, alpha)` s `alpha` z `GameLoop` (§3).
- Render si udržuje `Map<EntityId, View>`; každý frame `renderer.syncEntities(entitiesVM, alpha)` vytvára a ničí view podľa `id` a pre nezmenené entity nič nealokuje; ghost modulu `setModuleGhost(ghost | null)` (§15.1).
- **Snapshot v3** (F3, karta T03-10; ADR-017, ADR-019): `vehicles: VehicleVM[]` (vzostupne podľa id; `id, defId, x, y, heading, state`, `loaded` = `cargo.countAt('in_vehicle', id) > 0`, `prevX, prevY` a `prevHeading` = póza pred posledným tickom, ktorú si ako pri lodiach pamätá **bridge** v `beforeTick()` — render z nich v zákrute skladá oblúk medzi pruhom predchádzajúceho a aktuálneho úseku, §7.6, §15.1); `ModuleVM` skladu nesie `storage { capacity, stored, reserved }` (sprite podľa `stored / capacity`, `fillState`), moduly s konektormi `connected` (`World.isConnected`; `false` → odznak „Nepripojené"). `revision` rastie aj pri `VehicleBought` / `VehicleSold`, `VehicleStateChanged`, `JobCreated` / `JobAssigned` / `JobDone` a `NoStorageAvailable` (tabuľka `REVISION_EVENTS`); poloha vozidiel sa mení bez udalosti, preto sa vozidlá (ako lode a žeriavy) skladajú pri každom novom snapshote. Typ a smer cesty render číta priamo z `grid` (`cell.roadKind` / `cell.roadDir`, ADR-020).
- `World.create(…, { checkInvariants: import.meta.env.DEV })` — krok 12 (§6) beží v DEV, v produkcii nie.
- UI (React) číta cez `useSimSnapshot(selector, throttleMs = 100)` — panely sa neprekresľujú každý frame.

---

## 14. Save/Load
- `SaveGame { version: 1, createdAt, seed, tick, world: WorldState }` — `WorldState` je čistý JSON (bez tried): `World.serialize()` / `World.deserialize(defs, map, state, options?)`. Terén ani geometria a ceny parciel sa neukladajú (dodá ich `LoadedMap` s `id === mapId`) a `serialize()` s neprázdnou frontou príkazov vyhodí chybu (fronta nie je súčasťou save) (ADR-013).
- **`WorldState` v2** (ADR-014, ADR-016) = v1 `{ version, mapId, seed, rng, clock, ids, cashCents, roads, parcels }` (ADR-013) + `traffic` (riedke `[index, hodnota > 0]`), `modules` (`{ id, defId, x, y, rotation, purchaseCostCents, runtime }` v poradí umiestnenia; `runtime` = stav triedy), `cargo` (`CargoLedgerState { createdCount, exportedCount, units }` — len živé jednotky v kanonickom poradí) a `ships` (`{ id, classId, cargoTypeId, state, x, y, heading, berthIds, anchorageIndex, waypointIndex }` vzostupne podľa id).
- **`WorldState` v3** (`WORLD_STATE_VERSION`, F3; ADR-017 až ADR-021) = v2 + `vehicles` a `jobs`; `serialize()` vždy vracia v3.
  - `vehicles` vzostupne podľa id (= poradie nákupu): `{ id, defId, depotId, state, x, y, heading, jobId, purchaseCostCents, route, progress, waitTicks, replan }` — `route` = zvyšok trasy od `cell`, `progress` úseku `route[0] → route[1]`, `replan` = `replanPending` (ADR-019).
  - `jobs` vzostupne podľa id: `{ id, unitIds, from, to, createdTick }` — len aktívne joby (ADR-018).
  - `roads` = `[index, vrstva]` pre koľaj a dvojpruhovú cestu, `[index, 'road', typ]` pre `one_lane`, `[index, 'road', 'one_way', smer]` pre jednosmerku — jediný kanonický tvar (`serializeRoad`); predvolený typ, typ pri koľaji a chýbajúci/prebytočný smer sú chyba (ADR-020).
  - `runtime`: berth `{ lastNoStorageHour }` (throttle `NoStorageAvailable`, ADR-018), žeriav `{ state, phaseTicksTotal, phaseTicksLeft, reservedSlot, busyTicks, idleTicks, blockedTicks, lastBlockedHour }`, sklad `{ unitsIn, unitsOut }`, depo `{}` (ADR-017, ADR-018).
- Neukladá sa nič odvoditeľné: `cell.moduleId` (z footprintov), obsadenie apronov a skladov a `heldUnitId` žeriavu (z ledgera), rezervácie apronov (z `reservedSlot` žeriavov) a skladov (z `to` aktívnych jobov), skupiny kotvísk (prepočet), `dockedShipId` (z `berthIds` lodí), trasa lode (zo stavu a mapy), `VehicleDepot.vehicleIds` (z `depotId` vozidiel v poradí id), vozidlo a stav jobu (z vozidla s daným `jobId`; pri `no_path` rozhodne poloha nákladu: vo vozidle → `moving`, inak `assigned`; bez vozidla `open`) a cache ciest (`roadVersion`, `PathCache`, `DistanceMatrix`) — jeden zdroj pravdy, nesúladný save sa nedá ani zapísať (pravidlo 2).
- **Migrácia:** `migrateWorldState(raw, defs)` prevedie staršiu verziu po krokoch z tabuľky `verzia → migrácia` (nie switch); každý krok zapíše svoju pomenovanú cieľovú verziu (`WORLD_STATE_V2`, `WORLD_STATE_V3`), nie aktuálnu. v1 → v2 prevezme polia v1 a doplní prázdne `traffic`, `modules`, `cargo`, `ships`; starter moduly mapy sa do starého save **nedoplnia** (ADR-014 bod 6). v2 → v3 doplní prázdne `vehicles` a `jobs` a podľa druhu modulu z defov upraví `runtime` (sklad stratí `reservedSlots` — v2 nemal joby, rezervácia by nemala vlastníka; kotvisko dostane `lastNoStorageHour: null`); medzistupňové v3 z T03-04 (kotvisko `{}`) sa nenačíta (v3 ešte nebola vydaná). Save v1/v2 majú v `roads` len dvojice = dvojpruhové cesty.
- **Obnova** je fail-fast: `parseWorldState` overí tvar a hodnoty (vozidlo: bunky trasy v mape a susedné, progres v `[0, 1)` a `> 0` len s ďalšou bunkou, `waitTicks` celé ≥ 0, `x, y` = poloha na trase), `restoreEntities` prehrá moduly cez `ModuleRegistry` + `addModule` (a `restoreRuntimeState`), lode cez `addShip` (kotviská, anchorage, index trasy, dokovaná loď presne v `dockPoint` s `DOCKED_HEADING`), vozidlá cez `addVehicle` (depo dostane `vehicleIds` v poradí id), overí držiteľov a sloty nákladu a náklad vozidiel (kapacita, kategórie), obnoví joby (stav a vozidlo odvodené, `addJob`, rezervácia slotu v sklade `reserveSlot`), overí, že náklad vozidla patrí jeho jobu, a pohyb vozidiel (`vehicleMotionProblem`: progres bez šumu, kurz rozbehnutého vozidla, tvar trasy a odpočet podľa stavu, cesty pod trasou, cieľ na prístupovej bunke — ADR-019, ADR-021), potom rezervácie apronov a stav žeriavov a skončí `findWorldViolation` (§6 krok 12). **Po načítaní sa nepreplánuje** — vozidlo pokračuje po uloženej trase, preplánuje len vozidlo s `replan: true`, presne ako originál. Každá chyba je `WorldStateError` s JSON pointerom, takže nekonzistentný save (napr. žeriav s fázou, ktorá nesedí so stavom, uložený okamžitý `swinging`, loď s nákladom na kotvisku bez žeriavu svojej kategórie, vozidlo s progresom-šumom alebo s trasou proti jednosmerke) zlyhá už pri `deserialize`, nie až v `tick()` (ADR-016 bod 9, T02-14).
- Uložiť do `localStorage` (autosave každý herný deň) + export/import ako `.json` súbor; pred uložením vyprázdniť frontu (`applyPending()`).
- Test: `World.deserialize(defs, map, w.serialize())` po 1000 tickoch ≡ `w` po 1000 tickoch (hash `serialize()`; determinizmus + roundtrip) (ADR-013); roundtrip uprostred vykládky → identický ďalší priebeh aj udalosti (ADR-016).

---

## 15. Prezentačná vrstva

### 15.1 Render (PixiJS, `src/render/`)
```
WorldRenderer
 ├─ TerrainLayer     (RenderTexture / tilemap; kreslí sa raz, prekreslí pri load mapy)
 ├─ ParcelLayer      (obrysy, na predaj / vlastnené / prenajaté)
 ├─ RoadLayer        (autotile: straight/corner/t/cross/end podľa susedov; prekreslí pri RoadChanged)
 ├─ ModuleLayer      (ModuleView: base sprite + state overlay (fill 0/25/50/75/100) + connector markers v build mode)
 ├─ EntityLayer      (ShipView, VehicleView, TruckView, TrainView, CargoSprite na palube/vozidle)
 ├─ CraneLayer       (CraneView: base + rotujúci boom + trolley podľa fázy cyklu)
 ├─ OverlayLayer     (heatmap: 1 Sprite s texture width×height, nearest filter, škálovaný na 64 px/bunku)
 └─ BuildLayer       (ghost footprint + validácia farba + konektory + rotácia)
Camera: pan (drag/WASD), zoom 0.25–2.0 (wheel, pivot pod kurzorom), clamp na mapu. 1 bunka = 64 px @ zoom 1.
```
- Sprity z `assets/manifest.json` (id → súbor, footprint, stavy). Atlas generuje `tools/gen-atlas.ts` (PNG @1x/@2x).
- Interpolácia: `pos = lerp(prev, curr, alpha)`; rotácia vozidla = smer segmentu cesty. Vozidlo jazdí v pravom pruhu dvojpruhovej cesty a stredom úzkej (`laneOffset(kind, heading)`, T03-17), v zákrute po oblúku s plynulým otáčaním (`turn-arc.ts`, T03-19); úzke cesty (`one_lane` / `one_way`) a šípky jednosmerky (`overlay.path_arrow` podľa `cell.roadDir`) kreslí render podľa `cell.roadKind` / `cell.roadDir` (ADR-020, T03-19).
- Výkon: PixiJS `ParticleContainer`/`Container` s cullingom podľa kamery; texty len v UI vrstve.

### 15.2 UI (React, `src/ui/`)
- Layout podľa `DESIGN_BRIEF.md` §6: `TopHUD` (cash, denný delta, dátum/čas, speed), `BuildBar` (kategórie → moduly s cenou/tech stavom), pravý `SidePanel` (kontextový: `ModuleInspector`, `ContractsPanel`, `FinancePanel`, `TechTree`, `StatsPanel`), `Toasts`, modály (`MonthlyReport`, `GameOver`, `Settings`).
- Grafy: vlastné SVG komponenty (`StackedBars`, `LineChart`, `Donut`) s tokenmi; dáta z `Economy.daily/monthly`.
- Input: `InputController` rozhoduje, či udalosť patrí UI (DOM) alebo svetu (canvas). Klávesy: `B` build, `R` rotácia, `Esc` zrušiť, `Space` pauza, `1-4` rýchlosť, `H` heatmap.

---

## 16. Testovacia stratégia
| Úroveň | Nástroj | Čo |
|---|---|---|
| Unit | Vitest | Grid/rotácia/footprint, A* (cesty, neexistujúca cesta, cache invalidácia), StorageAllocator, Crane FSM, Vehicle FSM, Ledger, Contract vzorce, StatResolver, ship berth allocation |
| Invarianty | Vitest | `assertCargoConservation` po každom ticku v scenároch; „žiadna jednotka v dvoch lokáciách", „súčet units konstantný", „exported je konečný" |
| Scenáre | Vitest + `simrun` | `data/scenarios/*.json` (replay príkazov) → asercie: cash, exported units, on-time, žiadne `CraneBlocked` > X; **golden**: uložený report, diff pri zmene balansu je zámerný |
| Determinizmus | Vitest | dva svety s rovnakým seedom & scenárom → identický hash stavu po N tickoch; save/load roundtrip |
| E2E | Playwright | načíta `pnpm dev`, vykoná klik-flow (build yard, accept contract), spraví screenshot; overí, že HUD zobrazuje cash a že po X sekundách existuje aspoň jedna `CargoMoved` udalosť (cez `window.__sim` debug hook v dev móde) |

---

## 17. Rozšíriteľnosť — checklist „nový typ nákladu" (`/new-cargo`)
1. `cargo_types.json`: nový `CargoTypeDef` + `colorToken` (a token do `design/tokens.css`).
2. `modules.json`: sklad (`extends StorageModule`), žeriav/arm (`extends CraneModule` alebo `FlowLink`), rampa variant, prípadne špecifické `params`.
3. `vehicles.json`: interné vozidlo (ak kategória vyžaduje) + kamión variant v `trucks.json`.
4. `ships.json`: pridaj kategóriu do `cargoCategories` tried lodí, ktoré ju vozia.
5. Kód: nové triedy v `src/sim/modules/<category>/`, registrácia v `ModuleRegistry.register(kind, defId → class)`. **Žiadne úpravy v Dispatcher/CraneSystem** — tie pracujú cez abstraktné rozhrania (`ICraneStrategy`, `IStorage`, `ILandExport`).
6. `contract_templates.json`: šablóny s `minTier` a `techRequired`.
7. `tech_tree.json`: uzol s `unlockCargoType` + `unlockModule`.
8. Testy: scenár `data/scenarios/<category>_flow.json` prechádzajúci celým reťazcom do `exported`.
9. Assety: podľa `DESIGN_BRIEF.md` §5 + záznam v `assets/manifest.json`.

---

## 18. Rozhodnutia (ADR) a otvorené otázky
Prijaté ADR — plné znenie (kontext, rozhodnutie, alternatívy, dôsledky) je v [`docs/DECISIONS.md`](DECISIONS.md):
- **ADR-001** Stack TypeScript + PixiJS + React (§1, §2, §15).
- **ADR-002** Tick = 10 herných sekúnd, 10 tickov/s (§3).
- **ADR-003** Sypké/tekuté komodity diskretizované do `CargoUnit` batchov (§4.1).
- **ADR-004** Vnútorný pohyb v moduloch abstrahovaný na `internalTicks` (§7.3).
- **ADR-005** Soft kongescia namiesto kolízií (§7.6).
- **ADR-006** Cesty/koľaje ako vrstva bunky, nie moduly (§5.1).
- **ADR-007** Trojvrstvová hranica `src/sim`: kompilátor, ESLint allowlist a zákazy obchvatov, len `.ts` (§2).
- **ADR-008** Cesty/koľaje aj na verejných bunkách, moduly len na vlastnej/prenajatej parcele (§5.2, §8).
- **ADR-009** Konfiguračné vs katalógové defy (§4).
- **ADR-010** Domov konštánt bez defu — `infrastructure.json` a `logistics.json` (§4.6).
- **ADR-011** Pobyt vozidla pri konektore = `internalTicks` + load/unload za jednotku (§7.3).
- **ADR-012** Refundácia pri odstránení cesty/koľaje, kategória `road_sale` (§8, §9.2).
- **ADR-013** Rozhrania `World` a príkazov z F1: `create`/`deserialize`, `applyPending`, `ValidationResult`, poradie udalostí, `WorldState` v1 (§3, §4.6, §6, §8, §14).
- **ADR-014** Moduly, kotviská a `WorldState` v2: žeriav na berthe, efektívna hĺbka, `BerthGroup`, `ModuleRegistry`, `ApronBuffer`, migrácia, `exported` mimo ledgera (§5, §5.4, §7.1, §14).
- **ADR-015** `PlaceModule`/`RemoveModule`, zdieľané pravidlá umiestnenia, starter moduly, refundácia v bázických bodoch (§5.3, §8, §12).
- **ADR-016** Lode, alokácia kotvísk, cyklus žeriavu a krok 12 (§5.4, §6, §7.2, §7.4, §12, §14).
- **ADR-017** Sklady, depo a pripojenie modulov k ceste; apron a sklad držia len rezervácie nad ledgerom (§5, §5.3, §7.7, §8 body 5 a 8, §14).
- **ADR-018** Dispatcher, `TransportJob`, alokátor skladu a pathfinding (deterministický A*, memo podľa `roadVersion`), `WorldState` v3 s jobmi (§6 krok 5, §7.3, §7.4, §7.7, §12.1, §14).
- **ADR-019** Vozidlá — pohyb po trase, pobyt v module, `no_path`, preplánovanie, `traffic` v kroku 11 a save (§4.4, §6 kroky 6 a 11, §7.3, §7.4, §7.6, §8, §12.1, §14).
- **ADR-020** Typy ciest `two_lane` / `one_lane` / `one_way`, pruh ako prezentácia, smerové hrany, cena a rýchlosť podľa typu, prestavba (§4.6, §5.1, §7.4, §7.6, §8, §12.2, §14).
- **ADR-021** Šum progresu vozidla (`PROGRESS_NOISE`), kurz rozbehnutého úseku, ceny ciest z `PathCache` a krok 12 bez alokácií — review T03-13 (§5, §6, §7.3, §7.4, §14).

Otvorené (kandidáti na ADR, detail v `docs/BACKLOG.md`): sim vo Web Workeri (áno, ak tick > 8 ms pri 8×); export kontrakty (land → ship) vo fáze 12; pôžičky; level crossing; kontajnerové stacky ako 3D vizualizácia zaplnenosti vs. 5 stavov spritu.
