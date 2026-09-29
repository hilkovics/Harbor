# Fáza 2 — Root modul, loď, žeriav, apron · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 2" (+ riadok Model mix), ARCHITECTURE §4.1–§4.3, §5, §5.3, §5.4, §6 (kroky 3, 4, 12), §7.1, §7.2, §7.4 (lode), §8, §12, §13, §14, §15; ADR-003, ADR-006, ADR-008, ADR-009, ADR-012, ADR-013.
> Vetva: `phase/02-berth-ship-crane` (stacked nad `phase/01-grid-roads`, PR hilkovics/Harbor#2). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora („postupuj úplne samostatne").
> Assety: `assets/manifest.json` (kanonický, Claude Design relácia 6) — `sprites.berth_standard` (`apronSlots`, `connectors`), `sprites.crane_container_gantry` (`parts.base/boom/trolley` s `pivot`, `mountOnBase`, `travel`), `entities.ship_{feeder,handy}.variants.container.{empty,loaded}`, `cargo.container_teu`, `overlay.{connector_marker,blocked_badge,ghost_hatch,selection_ring}`. UI prototyp: `design/ui/game-ui.source.html` (BuildBar, Inspector).

**Cieľ:** loď pripláva, zakotví, žeriav vykladá kontajnery na apron. Iba kategória `container`, iba import.
**Akceptácia fázy:** v hre vidím loď doplávať, zakotviť, žeriav presúva kontajnery na quay; po vyložení odpláva. Testy: BerthGroup z 2 susedných berthov má dĺžku 16; `handy` (10) dostane skupinu 16, `feeder` stačí 8; žeriav sa pri plnom aprone zablokuje a `CraneBlocked` emituje najviac raz za hodinu; `CargoLedger.move` odmietne `on_ship → in_storage`; konzervácia počas 5 000 tickov so spawnutou loďou.

**Rozhodnutia orchestrátora (zapíšu sa do ADR-014..016 v kartách sim-architecta):**
1. Root modul = `berth_standard` na (40, 14) rot 0 + `crane_container_gantry` na (43, 14) rot 0 v `harbor_01.starter.modules`. Starter moduly sa umiestnia pri `World.create` rovnakou validáciou ako `PlaceModule` (okrem ceny) a majú `purchaseCostCents = 0`.
2. Refundácia pri odstránení modulu sa počíta zo **zaplatenej** ceny (`purchaseCostCents`), nie z ceny v defe. Starter moduly preto nič nevrátia, čím sa uzatvára exploit z BACKLOG. Všetky refundácie idú cez jeden celočíselný helper v bázických bodoch: `floor(price × round(rate × 10 000) / 10 000)` (BACKLOG P2 „RemoveRoad refundácia v double").
3. Žeriav stojí **na** bunkách kotviska: `cell.moduleId` ostáva id berthu a žeriav eviduje berth (`craneIds`). Pravidlo §8.1 „`moduleId === null`" pre žeriav znamená, že všetky bunky patria jednému berthu a neprekrývajú iný žeriav. Rotácia žeriavu = rotácia berthu. Berth so žeriavmi nejde odstrániť (`has_cranes`).
4. Efektívna hĺbka berthu = `min(def.params.depthClass, min(cell.depthClass) footprintu)` — mapa aj typ kotviska obmedzujú ponor.
5. Ladiaca loď `SpawnShipDebug` je registrovaná vždy (scenáre/replay); UI tlačidlo je len v DEV. Keďže vo F2 nejazdia vozidlá, e2e/scenár posiela ≤ `apronSlots` (4) jednotiek, aby sa loď vyložila celá a odplávala. Druhá loď na plný apron = test `CraneBlocked`.
6. Pohyb lode: `seaLane` → (anchorage, ak čaká) → priama úsečka k pozícii pri kotvisku (§7.4, bez A*). Poloha lode je float stred v bunkách. **V `src/sim` žiadne `Math.sin/cos/atan2`** (nie sú bit-presné naprieč enginmi), `Math.sqrt` je OK (IEEE presné). Kurz lode je kardinálny (`Rotation` podľa dominantnej osi segmentu).
7. Cyklus žeriavu (§7.2): pri `idle → grabbing` si žeriav **rezervuje slot apronu** (dvaja žeriavi ho nemôžu prebookovať). `swinging` je okamžitý prechod (jednotka `on_ship → in_crane`), `placing` jednotku odloží (`in_crane → on_apron`). `blocked` = loď má kompatibilný náklad, ale apron nemá voľný nerezervovaný slot. Žeriav pritom nič nedrží.
8. `WorldState` v2 (moduly, lode, náklad, žeriavy) + `migrate(v1 → v2)`. v1 nepoznal moduly, preto migrácia dá prázdne moduly/lode/náklad a starter moduly sa do starého save nedoplnia.

## Checklist
- [x] T02-01 · Defy: `cargo_types`, `modules`, `ships` (katalógy, ADR-009) + schémy + DefRegistry katalógy; mapa `schemaVersion` + Root modul; unikátne bunky portálov; `LoadedMap.createGrid()`
- [ ] T02-02 · Sim: `CargoUnit`, `CargoLocation`, `CargoLedger` (tabuľka prechodov §7.1), `assertConservation`, typovaný test helper
- [ ] T02-03 · Sim: `Module`, `ModuleRegistry`, `BerthModule`, `CraneModule`, `BerthGroup`, `ApronBuffer`, `StatResolver`; `World.modules`; `WorldState` v2 + migrate; ADR-014
- [ ] T02-04 · Sim: `PlaceModule` / `RemoveModule` (§8 body 1–4, 7, 8), starter moduly, celočíselná refundácia; ADR-015
- [ ] T02-05 · Sim: `Ship` + `ShipSystem` FSM + `BerthAllocator` + `CraneSystem` FSM + `CraneBlocked` + `SpawnShipDebug`; tick kroky 3, 4, 12; ADR-016
- [ ] T02-06 · Testy (TDD): scenár `f2_unload`, konzervácia 5 000 tickov, BerthGroup/alokácia, blokovanie žeriavu
- [ ] T02-07 · Render: `ModuleLayer`/`ModuleView`, `CraneView`, `ShipView`, `CargoSprite`, ghost modulu + konektory
- [x] T02-08 · UI: `BuildBar` (kategória Terminál) + `ModuleInspector` (kotvisko, žeriav)
- [ ] T02-09 · App: SimBridge snapshot v2 (moduly, lode, žeriavy, apron, `revision`, `speeds`) + napojenie renderu + DEV spawn lode
- [ ] T02-10 · App: build mód modulov (ghost, `R` rotácia, dôvody v tooltipe, umiestniť/odstrániť) + výber modulu → inspector
- [ ] T02-11 · Tooling: `simrun` metriky žeriavov/lodí + `validate:defs` pre asset manifest
- [ ] T02-12 · E2E: loď dokuje, žeriav vykladá, loď odpláva, screenshot
- [ ] T02-13 · Review `src/sim/**`
- [ ] T02-14 · ARCHITECTURE: zosúladenie s F2 (§4.2, §5, §7.2, §8, §12, §13, §14, §18) + minor nálezy review
- [ ] T02-15 · Plná pipeline + triáž
- [ ] T02-16 · Uzavretie fázy (PROGRESS, BACKLOG) + PR

Vlny: 01 → 02 → 03 → 04 → 05 (sim sériovo, single writer) ‖ {06 (TDD worktree od 01), 07 (worktree od 01), 08 (worktree od 01)} → 09 → {10 ‖ 11} → 12 → 13 → 14 → 15 → 16.
Single writer `src/sim/**`: T02-01 (defs + map loader), potom T02-02..T02-05 sériovo, T02-14 (len docs + minor opravy po review). T02-06/07/08 do `src/sim` nepíšu.

## Spoločné rozhrania (záväzné pre paralelné karty)

```ts
// src/sim/defs — katalógové defy (ADR-009): { schemaVersion: 1, items: [...] }
interface Catalog<T extends { readonly id: string }> {
  readonly items: readonly T[];            // poradie zo súboru
  get(id: string): T;                      // neznáme id → DefError
  has(id: string): boolean;
}
// DefRegistry: + readonly cargoTypes: Catalog<CargoTypeDef>; modules: Catalog<ModuleDef>; ships: Catalog<ShipClassDef>
type CargoCategory = 'container' | 'bulk' | 'liquid' | 'gas' | 'roro';
type ModuleKind = 'berth' | 'crane' | 'storage' | 'gate' | 'waiting_area' | 'ramp' | 'depot' | 'rail_station' | 'pipeline';
type Side = 'n' | 'e' | 's' | 'w';
interface CargoTypeDef { id; category: CargoCategory; unitName; unitsPerBatch; basePricePerUnitCents; xpPerUnit; colorToken }
interface ModuleConnectorDef { x: number; y: number; side: Side; type: 'road' | 'rail' | 'pipe' }   // bunka footprintu pri rot 0 (manifest)
interface ModuleDef { id; kind: ModuleKind; displayName; footprint: { w; h };
  placement: { requiredTerrain: TerrainType[]; waterSide?: 'north'; requiresParcelOwnership: boolean; mustAttachTo?: ModuleKind[] };
  connectors: ModuleConnectorDef[]; costCents; maintenancePerDayCents; techRequired?: string;
  params: Readonly<Record<string, number | string>> }       // typované prístupy nižšie
interface BerthParams { depthClass: 1 | 2 | 3; apronSlots: number; maxCranes: number; frontWaterCells: number }
interface CraneParams { cycleTicks: number; category: CargoCategory }
interface ShipClassDef { id; displayName; lengthCells; widthCells; draftClass: 1 | 2 | 3; capacityUnits;
  speedCellsPerTick; cargoCategories: CargoCategory[]; berthAllowanceTicks; techRequired?: string }

// src/sim/cargo (§7.1)
type CargoLocation =
  | { kind: 'on_ship'; shipId: EntityId } | { kind: 'in_crane'; craneId: EntityId } | { kind: 'on_apron'; berthId: EntityId; slot: number }
  | { kind: 'in_vehicle'; vehicleId: EntityId } | { kind: 'in_storage'; moduleId: EntityId; slot: number }
  | { kind: 'in_pipeline'; pipelineId: EntityId } | { kind: 'at_ramp'; rampId: EntityId; dock: number }
  | { kind: 'in_truck'; truckId: EntityId } | { kind: 'in_train'; trainId: EntityId } | { kind: 'exported' };
type CargoLocationKind = CargoLocation['kind'];
interface CargoUnit { readonly id: EntityId; readonly typeId: string; readonly contractId: EntityId | null;
  readonly quantity: number; readonly location: CargoLocation }
class CargoLedger {                        // world.cargo
  create(typeId: string, location: CargoLocation /* F2: len on_ship */, contractId?: EntityId | null): CargoUnit;
  move(unitId: EntityId, to: CargoLocation): void;   // nepovolený prechod → CargoTransitionError; emit CargoMoved
  get(unitId: EntityId): CargoUnit | undefined;
  unitsOnShip(shipId: EntityId): readonly EntityId[];      // vzostupne podľa id
  unitsOnApron(berthId: EntityId): readonly EntityId[];    // v poradí príchodu (FIFO)
  countByKind(kind: CargoLocationKind): number;
  readonly createdCount: number; readonly exportedCount: number;
  assertConservation(): void;              // porušenie → CargoConservationError
}
function isTransitionAllowed(from: CargoLocationKind, to: CargoLocationKind): boolean;   // tabuľka, nie switch

// src/sim/modules
abstract class Module { readonly id: EntityId; readonly def: ModuleDef; readonly kind: ModuleKind; readonly origin: CellCoord;
  readonly rotation: Rotation; readonly size: { w: number; h: number };   // po rotácii
  readonly cells: readonly CellCoord[]; readonly purchaseCostCents: number }
class BerthModule extends Module { readonly waterSide: Side; readonly lengthCells: number; readonly depthClass: 1 | 2 | 3;
  readonly craneIds: readonly EntityId[]; dockedShipId: EntityId | null; readonly apron: ApronBuffer; groupId: number }
type CraneState = 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked';
class CraneModule extends Module { readonly berthId: EntityId; state: CraneState; phaseTicksTotal: number; phaseTicksLeft: number;
  heldUnitId: EntityId | null; busyTicks: number; idleTicks: number; blockedTicks: number }
interface BerthGroup { readonly id: number; readonly berthIds: readonly EntityId[];   // poradie po pobreží
  readonly totalLength: number; readonly minDepth: number }
// World: + readonly modules: ReadonlyMap<EntityId, Module> (poradie umiestnenia); readonly berthGroups: readonly BerthGroup[];
//          readonly cargo: CargoLedger; readonly ships: ReadonlyMap<EntityId, Ship>

// src/sim/ships
type ShipState = 'inbound' | 'waiting_anchorage' | 'berthing' | 'docked' | 'undocking' | 'outbound' | 'despawned';
class Ship { readonly id: EntityId; readonly classId: string; readonly def: ShipClassDef; readonly cargoTypeId: string;
  state: ShipState; x: number; y: number;          // stred lode v bunkách (float); stred bunky (cx, cy) = (cx + 0.5, cy + 0.5)
  heading: Rotation;                               // 0 = predok na sever, v smere hodinových ručičiek
  berthIds: readonly EntityId[] }                  // obsadené kotviská (prázdne mimo berthing/docked/undocking)
// despawned loď sa z world.ships odstráni (ShipDeparted)
```

Príkazy (JSON, `commandFromJSON`; x, y = ľavý horný roh footprintu **po** rotácii):
- `{ "type": "PlaceModule", "defId": "berth_standard", "x": 48, "y": 14, "rotation": 0 }`
- `{ "type": "RemoveModule", "moduleId": 7 }`
- `{ "type": "SpawnShipDebug", "shipClassId": "feeder", "cargoTypeId": "container_teu", "units": 4 }`

Nové `ValidationReason`: `unknown_def`, `no_water_side`, `water_blocked`, `no_berth`, `rotation_mismatch`, `max_cranes`, `has_cranes`, `has_cargo`, `ship_docked`, `busy`, `unknown_module`, `unknown_ship_class`, `unknown_cargo`, `cargo_incompatible`, `invalid_units`, `invalid_rotation`.

Nové `SimEvent` (readonly DTO):
`ModulePlaced { moduleId, defId, x, y, rotation, cells }` · `ModuleRemoved { moduleId, defId, cells }` · `ShipSpawned { shipId, classId, cargoTypeId, units }` · `ShipDocked { shipId, berthIds }` · `ShipUndocked { shipId }` · `ShipDeparted { shipId }` · `CraneCycleDone { craneId, unitId }` · `CraneBlocked { craneId, berthId, reason: 'apron_full' }` · `CargoMoved { unitId, from: CargoLocation, to: CargoLocation, tick }`. `MoneyChanged.reason` += `module_capex`, `module_sale`.

Render view-modely (`src/render/view-models.ts`, T02-07 ich vytvorí presne takto; T02-09 ich plní zo simu):
```ts
interface ModuleVM { id: number; defId: string; kind: string; x: number; y: number; rotation: 0 | 90 | 180 | 270;
  w: number; h: number;                                   // po rotácii
  apron?: { capacity: number; units: { slot: number; unitId: number; typeId: string }[] } }   // len berth
interface CraneVM { id: number; defId: string; berthId: number; x: number; y: number; rotation: 0 | 90 | 180 | 270;
  state: 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked'; progress: number;   // 0..1 v rámci fázy
  holding: { unitId: number; typeId: string } | null }
interface ShipVM { id: number; classId: string; cargoCategory: string; state: string;
  x: number; y: number; prevX: number; prevY: number;      // stred v bunkách; interpolácia lerp(prev, curr, alpha)
  heading: 0 | 90 | 180 | 270; lengthCells: number; widthCells: number; unitsOnBoard: number; capacityUnits: number }
interface EntitiesVM { modules: readonly ModuleVM[]; cranes: readonly CraneVM[]; ships: readonly ShipVM[] }
interface ModuleGhostVM { defId: string; x: number; y: number; rotation: 0 | 90 | 180 | 270; w: number; h: number;
  valid: boolean; connectors: { x: number; y: number; side: 'n' | 'e' | 's' | 'w' }[] }   // svetové bunky po rotácii
// WorldRenderer: syncEntities(vm: EntitiesVM, alpha: number): void; setModuleGhost(ghost: ModuleGhostVM | null): void
```

Scenár (replay): ako vo F1 — `{ "id", "seed", "map", "commands": [{ "atTick", "command" }] }`.

---

### T02-01 · Defy: `cargo_types`, `modules`, `ships` + schémy + DefRegistry katalógy; mapa `schemaVersion` + Root modul; unikátne bunky portálov; `LoadedMap.createGrid()`
- model: sonnet
- agent: implementer
- parallel: no (mení `src/sim/defs` a `src/sim/grid` — single writer)
- depends_on: –
- inputs: ARCHITECTURE §4, §4.1–§4.3, §4.7, §5.3; ADR-009; „Spoločné rozhrania"; `assets/manifest.json` (`sprites.berth_standard.connectors`, `sprites.crane_container_gantry`, `entities.ship_*.footprint`); data/defs/*.json; data/schemas/*.json; src/sim/defs/**; src/sim/grid/{map-def,map-loader}.ts; tools/validate-defs.ts; BACKLOG P2 položky „Road a rail portál na tej istej bunke", „LoadedMap.grid je meniteľná šablóna", „Mapa harbor_01 nemá schemaVersion"
- outputs: data/defs/{cargo_types,modules,ships}.json; data/schemas/{cargo_types,modules,ships}.schema.json; data/schemas/map.schema.json + data/maps/harbor_01.json (`schemaVersion: 1`, `starter.modules`); src/sim/defs/{types,def-registry,catalog}.ts; src/sim/grid/{map-def,map-loader}.ts; úpravy volaní `map.grid` (src/sim/world/world.ts, tests, src/render ak treba); tools/validate-defs.ts; testy v tests/sim/defs, tests/sim/grid, tests/tools
- požiadavky:
  - `cargo_types.json`: `container_teu` { category `container`, unitName `TEU`, unitsPerBatch 1, basePricePerUnitCents 45000, xpPerUnit 1, colorToken `cargo-container` }.
  - `modules.json`: `berth_standard` { kind `berth`, displayName „Kotvisko", footprint 8×3, placement { requiredTerrain [`quay`], waterSide `north`, requiresParcelOwnership true }, connectors = `sprites.berth_standard.connectors` z manifestu (`{x:1,y:2,side:'s',type:'road'}`, `{x:6,y:2,side:'s',type:'road'}`), costCents 40 000 000, maintenancePerDayCents 120 000, params { depthClass 1, apronSlots 4, maxCranes 2, frontWaterCells 3 } } a `crane_container_gantry` { kind `crane`, displayName „Kontajnerový žeriav", footprint 2×3, placement { requiredTerrain [`quay`], requiresParcelOwnership true, mustAttachTo [`berth`] }, connectors [], costCents 60 000 000, maintenancePerDayCents 90 000, params { cycleTicks 12, category `container` } }.
  - `ships.json`: `feeder` { displayName „Feeder", lengthCells 6, widthCells 2, draftClass 1, capacityUnits 120, speedCellsPerTick 0.15, cargoCategories [container, bulk, liquid, gas, roro], berthAllowanceTicks 17 280 } a `handy` { „Handysize", 10, 2, draftClass 1, 300, 0.15, rovnaké kategórie, 17 280 }. `widthCells`/`lengthCells` musia sedieť s `entities.ship_{id}.footprint` (w/h) v manifeste. Otestuj to.
  - Schémy s `additionalProperties: false`, `items` s unikátnymi `id` (snake_case). Typované parametre podľa `kind` sú v tabuľke `MODULE_PARAM_SPECS: Record<ModuleKind, …>` (nie switch): berth vyžaduje `BerthParams`, crane `CraneParams`, ostatné kind-y zatiaľ `{}`. DefRegistry: katalógy `cargoTypes`, `modules`, `ships` (rozhranie `Catalog`), fail-fast `DefError` s cestou pri duplicitnom id, neznámom kľúči, zlom type parametra, `mustAttachTo` s neznámym kind-om, `requiredTerrain` s neznámym terénom a konektore mimo footprintu. Typované gettery `berthParams(def)`, `craneParams(def)` (alebo ekvivalent), aby sim nečítal `params['x'] as number`.
  - Mapa: `schemaVersion: 1` (schéma + parser); `starter.modules`: `[{ defId: 'berth_standard', x: 40, y: 14, rotation: 0 }, { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 }]`. `loadMap` overí len tvar a hranice mapy, existenciu defu a placement overí `World.create` v T02-04. Portály road/rail nesmú zdieľať bunku (`MapError`). `LoadedMap` už nevystavuje meniteľnú šablónu `grid`: pribudne `createGrid(): Grid` (nová kópia so starter cestami) a `World.create`/`deserialize` ho použijú.
  - `pnpm validate:defs` validuje nové defy.
- acceptance:
  - `pnpm validate:defs`
  - `pnpm vitest run tests/sim/defs tests/sim/grid tests/tools`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/{core,commands,events,economy}/**, src/render/** (okrem nevyhnutnej zmeny `map.grid` → `createGrid()`), src/ui/**, src/app/** (okrem tej istej zmeny), eslint.config.js, .claude/**
- estimate: M

### T02-02 · Sim: `CargoUnit`, `CargoLocation`, `CargoLedger`, `assertConservation`, typovaný test helper
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T02-01
- inputs: ARCHITECTURE §4.1 (batche), §7.1, §7.8, §16 (invarianty); ADR-003; CLAUDE.md pravidlo 2; „Spoločné rozhrania"; tests/sim/helpers/invariants.ts; BACKLOG P1 „assertCargoConservation … `as unknown as`"
- outputs: src/sim/cargo/{cargo-location,cargo-unit,cargo-ledger,cargo-error,index}.ts; src/sim/events/sim-event.ts (`CargoMoved`); src/sim/world/world.ts (`world.cargo`); tests/sim/cargo/*.test.ts; tests/sim/helpers/invariants.ts
- požiadavky:
  - Tabuľka povolených prechodov je dáta (`ReadonlyMap<kind, readonly kind[]>`) pokrývajúca všetky importné reťazce §7.1 (container/bulk, liquid/gas cez `in_pipeline`, RoRo `on_ship → in_vehicle`). `exported` je konečný stav bez výstupov.
  - Ledger je **jediný zdroj polohy**. Indexy podľa lokácie (loď, apron, …) udržiava sám a `move` ich mení atomicky: pri chybe sa nezmení nič a nič sa neemituje. `on_apron` slot je jedinečný na berth (dve jednotky na jednom slote → chyba). `create` pridelí id z `world.ids` a `quantity = cargoType.unitsPerBatch`; neznámy typ → chyba.
  - `assertConservation()` overí: každá jednotka je v práve jednom indexe, ktorý zodpovedá jej `location`; `createdCount = živé + exported`; žiadny slot nie je obsadený dvakrát. Chybová správa pomenuje jednotku aj lokácie.
  - Stav ledgera ide do `WorldState` až v T02-03 (v2). Tu stačí `getState()/fromState()` s testom roundtripu.
  - `tests/sim/helpers/invariants.ts`: `assertCargoConservation(world)` volá `world.cargo.assertConservation()` typovane (bez `as unknown as`) + test, že ledger existuje.
- acceptance:
  - `pnpm vitest run tests/sim/cargo` (vrátane `move(on_ship → in_storage)` → `CargoTransitionError`, atomickosť pri chybe, `CargoMoved { unitId, from, to, tick }`, roundtrip stavu)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T02-03 · Sim: `Module`, `ModuleRegistry`, `BerthModule`, `CraneModule`, `BerthGroup`, `ApronBuffer`, `StatResolver`; `World.modules`; `WorldState` v2 + migrate; ADR-014
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T02-02
- inputs: ARCHITECTURE §5, §5.3, §5.4, §7.2 (StatResolver), §10 (StatResolver poradie add → mul), §14; CLAUDE.md pravidlo 7 + BACKLOG P2 „Selektor .constructor … riešiť ModuleRegistry registráciou def → trieda"; BACKLOG P1 „WorldState v1 nemá moduleId/traffic → v2 + migrate"; „Rozhodnutia orchestrátora" 3, 4, 8; „Spoločné rozhrania"
- outputs: src/sim/modules/{module,module-registry,berth-module,crane-module,berth-group,apron-buffer,index}.ts; src/sim/tech/stat-resolver.ts (alebo src/sim/modules); src/sim/world/{world,world-state,migrate}.ts; docs/DECISIONS.md (ADR-014); tests/sim/modules/*.test.ts; tests/sim/world/*.test.ts (v2, migrate)
- požiadavky:
  - `ModuleRegistry`: `register(kind, factory)` → `create(def, spec, id, purchaseCostCents)`. Žiadny switch podľa kind-u ani `.constructor` (hranica ESLint). Neregistrovaný kind → chyba.
  - `BerthModule`: `waterSide` po rotácii (rot 0 = `n`), `lengthCells` = dĺžka dlhej hrany, efektívna `depthClass` podľa rozhodnutia 4, `ApronBuffer(capacity = apronSlots)` s rezerváciami (`reserve()`, `commit(slot, unitId)`, `take(unitId)`, `freeUnreservedCount`) a FIFO poradím. Stav apronu je konzistentný s ledgerom — overuje to `assertConservation` alebo nové `assertModules`.
  - `recomputeBerthGroups(world)`: berthy s rovnakým `waterSide`, ktorých krátke hrany sa dotýkajú na tej istej línii pobrežia, tvoria skupinu. `totalLength` = súčet `lengthCells`, `minDepth` = minimum. Poradie po pobreží je deterministické, id skupín od 1 v poradí prvého berthu. Prepočet sa volá pri každom place/remove.
  - `StatResolver.resolve('module', defId, stat)` = základ z typovaných params (bez modifikátorov, API pripravené na `add` → `mul`).
  - `World`: `modules`, `berthGroups`, `cargo`, `ships` (prázdna mapa, naplní T02-05), interné `addModule/removeModule` (zapisujú `cell.moduleId`, spravujú `craneIds`). Pre príkazy je API iba v rámci simu.
  - `WorldState` v2 = v1 + `modules` (id, defId, x, y, rotation, purchaseCostCents, stav žeriavu, apron sloty/rezervácie), `cargo` (stav ledgera), `ships` (prázdne pole, tvar doplní T02-05). `parseWorldState` prijme v1 aj v2: v1 prejde cez `migrate` a výsledkom je prázdny stav modulov. `serialize()` vždy vráti v2. Testy roundtripu a determinizmu z F1 ostanú zelené (upraviť ich na v2).
  - ADR-014: žeriav na bunkách berthu (rozhodnutie 3), efektívna hĺbka (4), WorldState v2 + migrácia (8).
- acceptance:
  - `pnpm vitest run tests/sim/modules tests/sim/world` (vrátane: 2 dotýkajúce sa berthy → 1 skupina `totalLength 16`; medzera 1 bunka → 2 skupiny; efektívna hĺbka; ApronBuffer rezervácia/FIFO; v1 save → migrate → v2)
  - `grep -c '^## ADR-014:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/defs/**
- estimate: L

### T02-04 · Sim: `PlaceModule` / `RemoveModule`, starter moduly, celočíselná refundácia; ADR-015
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T02-03
- inputs: ARCHITECTURE §8 (body 1–4, 6 peniaze, 7, 8), §5.2, §9.2 (ledger kategórie); ADR-008, ADR-012, ADR-013; „Rozhodnutia orchestrátora" 1–3; „Spoločné rozhrania"; src/sim/commands/**; BACKLOG P2 „RemoveRoad refundácia v double"
- outputs: src/sim/commands/{place-module,remove-module,refund,builtin-commands,validation}.ts; src/sim/events/sim-event.ts; src/sim/world/world.ts (starter moduly v `create`); src/sim/commands/remove-road.ts (refund helper); docs/DECISIONS.md (ADR-015); tests/sim/commands/{place-module,remove-module,refund}.test.ts
- požiadavky:
  - `PlaceModule { defId, x, y, rotation }`: `validate` vráti všetky platné dôvody naraz (bez duplicít), `cells` = footprint po rotácii a `costCents = def.costCents`. Pravidlá: 1) inBounds, terén, `moduleId === null`, `road === 'none'` (crane podľa rozhodnutia 3); 2) parcela vlastnená/prenajatá; 3) berth: všetky bunky dlhej hrany na strane `waterSide` (po rotácii) susedia s vodou a pás `frontWaterCells` pred ňou je celý vo vode, v mape a nezasahuje do footprintu iného modulu ani pásu berthu s inou orientáciou; 4) crane: celý footprint v jednom berthe s rovnakou rotáciou, neprekrýva iný žeriav, `craneIds.length < maxCranes`; 6) `insufficient_funds` len pri `costCents > 0`; 7) rotácia ∈ {0, 90, 180, 270}, footprint aj konektory cez `rotateLocalCell`. `apply`: modul cez `ModuleRegistry`, `cash −= cost`, `ModulePlaced` + `MoneyChanged(module_capex)`, prepočet berth skupín.
  - `RemoveModule { moduleId }`: odmietne `unknown_module`, `has_cargo` (apron/sklad), `ship_docked`, `has_cranes`, `busy` (žeriav mimo `idle`/`blocked`). Refund = `refundCents(purchaseCostCents, economy.removalRefundRate)` (bázické body, rozhodnutie 2) → `MoneyChanged(module_sale)` (len keď je refund > 0) + `ModuleRemoved`. Bunky sa uvoľnia, skupiny sa prepočítajú.
  - Rovnaký `refundCents` helper použije aj `RemoveRoad` (zmena výsledku 0.29 → −58 000 pokryje test). F1 scenár `f1_roads` musí dať rovnaký `cashEnd` (108 300 000).
  - `World.create`: starter moduly z mapy sa umiestnia v poradí mapy s `purchaseCostCents 0`, bez udalostí a bez zmeny hotovosti. Neplatný starter modul → `DefError`/`MapError` s indexom. `deserialize` ich neumiestňuje (sú v save).
- acceptance:
  - `pnpm vitest run tests/sim/commands` (berth na vode / mimo pobrežia / cudzia parcela / prekryv; crane mimo berthu → `no_berth`; tretí crane → `max_cranes`; refund zo zaplatenej ceny; starter berth refund 0; roundtrip `commandFromJSON(...).toJSON()`)
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.cashEnd == 108300000 and .lostUnits == 0'`
  - `grep -c '^## ADR-015:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: M

### T02-05 · Sim: `Ship` + `ShipSystem` + `BerthAllocator` + `CraneSystem` + `CraneBlocked` + `SpawnShipDebug`; tick kroky 3, 4, 12; ADR-016
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T02-04
- inputs: ARCHITECTURE §5.4, §6 (kroky 3, 4, 12), §7.1, §7.2, §7.4 (lode), §7.8; CLAUDE.md konvencia FSM (`transition()` tabuľka); „Rozhodnutia orchestrátora" 5–7; „Spoločné rozhrania"; testy T02-06 vo worktree (ak už existujú, majú prejsť)
- outputs: src/sim/ships/{ship,ship-fsm,berth-allocator,index}.ts; src/sim/systems/{ship-system,crane-system}.ts; src/sim/modules/crane-module.ts (FSM); src/sim/commands/spawn-ship-debug.ts; src/sim/world/{world,world-state}.ts (kroky 3, 4, 12; lode v save); src/sim/events/sim-event.ts; docs/DECISIONS.md (ADR-016); tests/sim/ships/*.test.ts; tests/sim/systems/{ship-system,crane-system}.test.ts
- požiadavky:
  - Ship FSM s explicitnou tabuľkou prechodov `inbound → waiting_anchorage | berthing`, `waiting_anchorage → berthing`, `berthing → docked`, `docked → undocking`, `undocking → outbound`, `outbound → despawned`. Spawn na `seaLane[0]`. Pohyb `speedCellsPerTick` po úsečkách (rozhodnutie 6), zvyšok kroku sa prenáša do ďalšieho segmentu, `heading` podľa dominantnej osi segmentu, pri dokovaní rovnobežne s dlhou hranou berthu. Pozícia pri kotvisku = obdĺžnik `lengthCells × widthCells` tesne pred dlhou hranou obsadených berthov. Presnú polohu a zaokrúhlenie urč v ADR-016.
  - `BerthAllocator`: čakajúce lode vo FIFO (poradie spawnu). Pre loď vyber skupinu s `totalLength ≥ lengthCells`, `minDepth ≥ draftClass` a aspoň jedným žeriavom kategórie nákladu. V nej nájdi prvý súvislý úsek voľných berthov (bez lode aj rezervácie) so súčtom dĺžok ≥ `lengthCells`, s najmenším počtom berthov a potom najmenším indexom po pobreží. Skupiny prechádzaj podľa id. Alokácia rezervuje berthy už pri `berthing` (`dockedShipId`). Loď bez skupiny čaká na prvej voľnej `anchorage` bunke; ak sú všetky obsadené, čaká na konci `seaLane`.
  - `docked → undocking`, keď loď nemá žiadnu jednotku `on_ship`. Pri `undocking` sa berthy uvoľnia a loď ide späť cez koniec `seaLane` → `seaLane[0]` → `despawned` (odstránená z `world.ships`, `ShipDeparted`).
  - CraneSystem (krok 4, žeriavy v poradí id): idle → ak dokovaná loď na jeho berthe má jednotku kategórie `CraneParams.category` a apron má voľný nerezervovaný slot → rezervuj slot, vyber najmenšie id jednotky na lodi, `grabbing` (⌊c/2⌋ tickov, `c = StatResolver.resolve(…,'cycleTicks')`) → `swinging` (okamžite: `on_ship → in_crane`) → `placing` (c − ⌊c/2⌋ tickov) → `in_crane → on_apron(slot)`, `CraneCycleDone` → `idle`. Ak loď má náklad a apron nemá voľný slot → `blocked`. `CraneBlocked { reason: 'apron_full' }` sa emituje pri prechode do `blocked`, najviac raz za hernú hodinu na žeriav (ukladá sa index hodiny posledného emitu). Počítadlá `busyTicks` (grabbing/placing), `blockedTicks`, `idleTicks` každý tick.
  - Krok 12: `cargo.assertConservation()` (+ konzistencia apronu). Predvolene zapnuté; `World.create(…, { checkInvariants: false })` ho vypne (app v produkcii, výkon F6).
  - `SpawnShipDebug { shipClassId, cargoTypeId, units }`: `unknown_ship_class`, `unknown_cargo`, `cargo_incompatible` (kategória ∉ `cargoCategories`), `invalid_units` (1 ≤ units ≤ capacityUnits, celé). `apply` vytvorí loď + `units` jednotiek `on_ship` a emitne `ShipSpawned`; `costCents 0`.
  - `WorldState` v2: lode (stav FSM, poloha, cesta/index, berthy, anchorage) aj stav žeriavov (fáza, zostávajúce ticky, rezervovaný slot, držaná jednotka, počítadlá, hodina posledného `CraneBlocked`). Roundtrip počas vykládky → identický ďalší priebeh (hash `serialize()` po ďalších 500 tickoch).
  - ADR-016: pohyb lode a poloha pri kotvisku, alokačné pravidlá, cyklus žeriavu + rezervácia slotu + throttle `CraneBlocked`, zákaz trigonometrie v sime.
- acceptance:
  - `pnpm vitest run tests/sim/ships tests/sim/systems` (FSM prechody, alokácia feeder/handy, anchorage, CraneBlocked ≤ 1×/h, roundtrip uprostred vykládky)
  - `pnpm vitest run tests/sim/scenarios` (vrátane testov T02-06, ak sú už zlúčené)
  - `! grep -rnE 'Math\.(sin|cos|tan|atan2?|asin|acos)\b' src/sim`
  - `grep -c '^## ADR-016:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/defs/**
- estimate: L

### T02-06 · Testy (TDD): scenár `f2_unload`, konzervácia 5 000 tickov, BerthGroup/alokácia, blokovanie žeriavu
- model: sonnet
- agent: test-writer
- parallel: yes (worktree od T02-01; zlúči sa po T02-05, keď je zelené)
- depends_on: T02-01
- inputs: „Akceptácia fázy", „Rozhodnutia orchestrátora", „Spoločné rozhrania" (World API, JSON príkazov, udalosti); tests/sim/scenarios/** z F1 (štýl); tests/sim/helpers/**; data/maps/harbor_01.json (Root berth x 40–47, y 14–16; starter parcela x 30–57)
- outputs: data/scenarios/f2_unload.json; tests/sim/scenarios/f2-unload.test.ts; tests/sim/scenarios/f2-berth-allocation.test.ts; tests/sim/scenarios/f2-crane-blocked.test.ts; tests/sim/invariants/f2-conservation.test.ts
- požiadavky (testy len cez verejné API a JSON príkazy):
  - `f2_unload.json` (seed 2002): tick 0 `SpawnShipDebug feeder container_teu 4`. Očakávanie: loď dosiahne `docked` na Root berthe (`berthIds = [rootBerth]`), apron má po vyložení 4 jednotky, loď prejde `undocking → outbound` a do 2 000 tickov je z `world.ships` preč (`ShipDeparted`). `countByKind('on_apron') === 4`, `createdCount === 4`.
  - Konzervácia: 5 000 tickov so spawnutou loďou (tick 0 feeder 4 TEU, tick 1 500 druhý feeder 6 TEU). Po každom ticku `assertCargoConservation(world)`, `createdCount === živé + exported`, žiadna jednotka v dvoch lokáciách.
  - BerthGroup: `PlaceModule berth_standard (48,14,0)` vedľa Root → jedna skupina `totalLength 16`. Berth na (30,14) je od Rootu oddelený medzerou → samostatná skupina 8. `handy` bez druhého berthu po 1 500 tickoch `waiting_anchorage`; s druhým berthom `docked` a `berthIds.length === 2`. `feeder` pri skupine 16 obsadí 1 berth.
  - Blokovanie: po `f2_unload` (apron plný) ďalší feeder s 4 TEU → loď `docked`, žeriav `blocked`, `CraneBlocked` sa za 5 000 tickov objaví ≥ 1× a v žiadnej hernej hodine viac ako raz; náklad lode ostáva 4.
  - Determinizmus: dva svety so `f2_unload` → rovnaký hash `serialize()` po 3 000 tickoch; roundtrip `deserialize(serialize())` uprostred vykládky → rovnaký hash po ďalších 500 tickoch.
  - Pred T02-05 testy padajú. Po zlúčení musia byť zelené bez úprav, a ak ich treba upraviť, zdôvodni to v „## Výsledok".
- acceptance:
  - `pnpm vitest run tests/sim/scenarios tests/sim/invariants` (po T02-05)
  - `pnpm typecheck && pnpm lint`
- do_not_touch: src/**, tools/**, data/defs/**, data/maps/**
- estimate: M

### T02-07 · Render: `ModuleLayer`/`ModuleView`, `CraneView`, `ShipView`, `CargoSprite`, ghost modulu + konektory
- model: sonnet
- agent: implementer
- parallel: yes (worktree od T02-01; len `src/render/**` + testy renderu)
- depends_on: T02-01
- inputs: ARCHITECTURE §15.1; DESIGN_BRIEF §5 (moduly, entity), §7; `assets/manifest.json` (`conventions`, `sprites.*`, `entities.ship_*`, `cargo.container_teu`, `overlay.*`); design/modules.html, design/entities.html (referenčné hárky); „Render view-modely"; src/render/** z F1 (SpriteAtlas, BuildLayer, WorldRenderer)
- outputs: src/render/{view-models,module-layer,module-view,crane-view,ship-view,cargo-sprite,entity-layer}.ts; úpravy src/render/{world-renderer,build-layer,sprite-atlas,index}.ts; tests/render/*.test.ts (čisté funkcie: rotácia spritu okolo stredu footprintu, pozícia apron slotov po rotácii, pozícia trolley podľa fázy, výber variantu lode)
- požiadavky:
  - Vrstvy podľa §15.1: `ModuleLayer` (nad RoadLayer), `EntityLayer` (lode), `CraneLayer` (nad loďami), BuildLayer navrchu. `syncEntities(vm, alpha)` vytvára a ničí view podľa `id` (`Map<id, View>`), nič nealokuje pre nezmenené entity.
  - ModuleView: sprite `sprites[defId].file`, rotácia po 90° okolo stredu footprintu (manifest `conventions.rotation`). Berth kreslí `CargoSprite` (`cargo.container_teu`) na obsadené `apronSlots` z manifestu, rotované s modulom. Chýbajúci sprite → fallback `Graphics` obdĺžnik s tokenom.
  - CraneView: `parts.base`, `parts.boom` (pivot + `mountOnBase`), `parts.trolley` (`travel.yMin..yMax` po osi výložníka). `grabbing`: vozík ide z pevninského konca na morský (progress), `placing`: späť, s kontajnerom, keď `holding`. Pri `idle` je vozík na pevninskom konci. Výložník sa podľa fázy mierne natočí (konštanta v renderi, pomenovaná), pri `blocked` sa zobrazí `overlay.blocked_badge`.
  - ShipView: `entities.ship_{classId}.variants[cargoCategory mapované na variant: container→container, bulk→bulk, liquid|gas→tanker, roro→roro].{loaded|empty}` (`loaded` pri `unitsOnBoard > 0`). Poloha = `lerp(prev, curr, alpha)` × 64 px, rotácia `heading` okolo stredu.
  - Ghost modulu: `setModuleGhost(ghost)` vykreslí footprint (`--ghost-valid`/`--ghost-invalid` + `overlay.ghost_hatch`) a `overlay.connector_marker` na každom konektore, otočený podľa `side`.
  - Demo: `src/render/__demo__` alebo rozšírenie existujúceho dema/Playwright testu s pevnými VM (berth + crane v `grabbing` + loď `docked` + 2 kontajnery na aprone) → screenshot `tests/e2e/__screenshots__/f2-render-demo.png`, ktorý si prezri (Read).
- acceptance:
  - `pnpm vitest run tests/render`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - screenshot `f2-render-demo.png` existuje a v „## Výsledok" je popísané, čo je na ňom
- do_not_touch: src/sim/**, src/ui/**, src/app/** (okrem demo vstupu, ak je nutný), data/**, assets/** (len čítať)
- estimate: L

### T02-08 · UI: `BuildBar` (kategória Terminál) + `ModuleInspector`
- model: sonnet
- agent: ui-builder
- parallel: yes (worktree od T02-01; len `src/ui/**`)
- depends_on: T02-01
- inputs: design/ui/game-ui.source.html (BuildBar dole, pravý SidePanel „Inspector"), design/ui/game-ui.html; design/tokens.css; DESIGN_BRIEF §6; assets/icons/icons.svg; src/ui/{top-hud,format,icon}.tsx; src/ui/__demo__/**
- outputs: src/ui/{build-bar,build-bar.css,module-inspector,module-inspector.css}.tsx|css; src/ui/__demo__/{build-bar,module-inspector}.demo.tsx; tests/ui/*.test.ts (čisté formátovače/mapovanie stavov)
- požiadavky:
  - Komponenty sú čisto prezentačné (props), napojí ich T02-09/T02-10:
    ```ts
    interface BuildBarItem { defId: string; displayName: string; costCents: number; icon: string; footprint: { w: number; h: number };
      locked: boolean; affordable: boolean }
    interface BuildBarCategory { id: string; label: string; icon: string; enabled: boolean; items: BuildBarItem[] }
    interface BuildBarProps { categories: BuildBarCategory[]; activeCategoryId: string; selectedDefId: string | null;
      onSelectCategory(id: string): void; onSelect(defId: string | null): void }
    interface ModuleInspectorData { id: number; defId: string; displayName: string; kind: 'berth' | 'crane' | string;
      stateLabel: string; ok: boolean;                                    // badge v hlavičke (zelený / žltý)
      apron?: { used: number; reserved: number; capacity: number };        // berth
      dockedShip?: { classLabel: string; unitsOnBoard: number; capacityUnits: number } | null;
      crane?: { state: 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked'; utilizationPct: number; blockedPct: number };
      refundCents: number; removable: boolean; removeBlockedReason?: string }
    interface ModuleInspectorProps { data: ModuleInspectorData; onRemove(id: number): void; onClose(): void }
    ```
  - Kategórie podľa prototypu (Terminál, Sklady, Pozemná doprava, Infraštruktúra…). Vo F2 je `enabled` iba Terminál (+ Infraštruktúra s cestou, ak je v prototype) a ostatné sú vizuálne zamknuté. Cena cez `formatMoney`, `affordable === false` → cena v `--ui-money-neg`.
  - Slovenské popisy stavov žeriavu (`idle` „Nečinný", `grabbing`/`swinging`/`placing` „Vykladá", `blocked` „Blokovaný — plný apron").
  - Demo stránky pre oba komponenty + Playwright screenshot `tests/e2e/__screenshots__/f2-ui-demo.png`, ktorý si prezri (Read).
- acceptance:
  - `pnpm vitest run tests/ui`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - screenshot `f2-ui-demo.png` existuje a v „## Výsledok" je popísané, čo je na ňom
- do_not_touch: src/sim/**, src/render/**, src/app/**, data/**, design/** (len čítať)
- estimate: M

### T02-09 · App: SimBridge snapshot v2 + napojenie renderu + DEV spawn lode
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T02-05, T02-07, T02-08
- inputs: ARCHITECTURE §13; „Spoločné rozhrania" + „Render view-modely"; src/app/{sim-bridge,bootstrap,app,game-loop,dev-hook}.ts(x); src/render/view-models.ts; src/ui/build-bar.tsx; BACKLOG P2 „Snapshot … revision", „WorldSnapshot neobsahuje speeds"
- outputs: src/app/{sim-bridge,entities-vm,bootstrap,app,dev-hook}.ts(x) (+ nové súbory podľa potreby); src/ui/top-hud.tsx (speeds zo snapshotu); tests/app/*.test.ts
- požiadavky:
  - `WorldSnapshot` v2 = F1 polia + `speeds`, `revision` (rastie pri každej udalosti meniacej štruktúru: `ModulePlaced/Removed`, `RoadChanged`, `Ship*`, `CargoMoved`, `CraneBlocked`, `CraneCycleDone`), `modules`, `cranes`, `ships` (typy z view-modelov alebo ich nadmnožina). `prevX/prevY` lode = poloha pred posledným tickom (bridge si ju pamätá). HUD číta `speeds` zo snapshotu.
  - Bootstrap: každý frame `renderer.syncEntities(entitiesVM(world), alpha)`, alpha z GameLoopu (akumulátor / tickMs). `World.create(…, { checkInvariants: import.meta.env.DEV })`.
  - BuildBar dole napojený (kategória Terminál: `berth_standard`, `crane_container_gantry` z `defs.modules`, `affordable` z cash). Výber zatiaľ len nastaví `selectedDefId`, build mód pripojí T02-10.
  - DEV: tlačidlo „Spawn feeder (DEV)" (napr. v rohu HUD, len `import.meta.env.DEV`) → `dispatch(SpawnShipDebug feeder container_teu 4)`. `window.__sim` doplní `entities()` (aktuálny `EntitiesVM`).
- acceptance:
  - `pnpm vitest run tests/app`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e` (F1 testy ostanú zelené)
- do_not_touch: src/sim/**, data/**
- estimate: M

### T02-10 · App: build mód modulov + výber modulu → inspector
- model: sonnet
- agent: implementer
- parallel: yes (s T02-11; nezasahujú do rovnakých súborov)
- depends_on: T02-09
- inputs: src/app/{input-controller,dom-input,bootstrap,app,build-feedback}.ts(x); src/render/build-layer.ts (`setModuleGhost`); src/ui/{build-bar,module-inspector}.tsx; „Spoločné rozhrania" (PlaceModule/RemoveModule, dôvody); ARCHITECTURE §15.2 (klávesy)
- outputs: src/app/{input-controller,module-build,selection,reason-labels,…}.ts(x); src/app/app.tsx; tests/app/*.test.ts
- požiadavky:
  - InputController FSM rozšíriť o `build_module(defId, rotation)`: ghost sleduje kurzor (stred footprintu pod kurzorom, zaokrúhlené na bunku), `R` rotuje 0 → 90 → 180 → 270, ľavý klik = `validate` → `dispatch(PlaceModule)` len pri `ok`, Esc/pravý klik zruší. Ghost dostáva `valid` + konektory po rotácii. Pri `insufficient_funds` je ghost zelený s ikonou $ (§8 bod 6). Tooltip (BuildFeedback) vypíše slovenské dôvody (`reason-labels.ts`, tabuľka pre všetky `ValidationReason`) a cenu. Po umiestnení mód zostáva aktívny (stavba viacerých).
  - Klik v `idle` móde na bunku modulu → výber (crane má prednosť pred berthom, ak bunka leží v jeho footprinte) → `ModuleInspector` v pravom paneli. Výber sa zruší klávesou Esc alebo klikom do prázdna. Tlačidlo „Odstrániť" → `validate(RemoveModule)`. Pri `ok` sa odošle, inak sa v inspectori ukáže dôvod (`removeBlockedReason`). `selection_ring` overlay na vybranom module (ak ho renderer podporuje, inak BACKLOG).
  - BuildBar klik na položku → `build_module`, opätovný klik/Esc → späť do `idle`. `B` naďalej prepína stavbu ciest (F1).
- acceptance:
  - `pnpm vitest run tests/app`
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/render/** (okrem drobných API doplnkov, zdôvodniť), data/**
- estimate: M

### T02-11 · Tooling: `simrun` metriky žeriavov/lodí + `validate:defs` pre asset manifest
- model: sonnet
- agent: implementer
- parallel: yes (s T02-10)
- depends_on: T02-05, T02-06
- inputs: tools/{simrun,validate-defs}.ts; tests/tools/**; data/scenarios/f2_unload.json; BACKLOG P2 „Schéma asset-manifest.schema.json nie je v pnpm validate:defs"
- outputs: tools/{simrun,validate-defs}.ts; tests/tools/*.test.ts
- požiadavky:
  - Report `simrun`: `craneBlockedPct` = Σ blockedTicks / Σ (busy + idle + blocked) × 100 (1 desatinné miesto; 0 bez žeriavov), `lostUnits` = `createdCount − (živé + exported)` (má byť 0), nové kľúče `modules`, `shipsSpawned`, `shipsDeparted`, `unitsOnApron`, `craneCycles`. Kľúče F1 ostávajú.
  - `validate:defs` validuje aj `assets/manifest.json` voči `data/schemas/asset-manifest.schema.json` a krížovo overí, že každý `modules.json` def má `sprites[id]` a každý ship def má `entities.ship_{id}`.
- acceptance:
  - `pnpm -s simrun data/scenarios/f2_unload.json --ticks 5000 --report | jq -e '.lostUnits == 0 and .shipsDeparted == 1 and .unitsOnApron == 4'`
  - `pnpm validate:defs`
  - `pnpm vitest run tests/tools && pnpm typecheck && pnpm lint`
- do_not_touch: src/**, data/defs/**, data/maps/**
- estimate: S

### T02-12 · E2E: loď dokuje, žeriav vykladá, loď odpláva, screenshot
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T02-10, T02-11
- inputs: tests/e2e/{boot,f1-roads}.spec.ts; playwright.config.ts; src/app/dev-hook.ts; „Akceptácia fázy"
- outputs: tests/e2e/f2-ship-crane.spec.ts; screenshoty `tests/e2e/__screenshots__/f2-docked.png`, `f2-departed.png`
- požiadavky:
  - Flow: načítať hru → klik „Spawn feeder (DEV)" → rýchlosť 4× → čakať (`window.__sim`), kým loď nie je `docked` a žeriav v `grabbing|placing` → screenshot `f2-docked.png` (kamera zameraná na Root berth, loď, žeriav a aspoň 1 kontajner na aprone). Potom čakať, kým `ships.length === 0` a apron má 4 jednotky → `f2-departed.png`.
  - Kontrola build módu: klik na BuildBar „Kotvisko" → ghost nad pevninou je invalid (tooltip s dôvodom), nad (48,14) valid → klik → `modules.length` +1 a hotovosť −$400,000 v HUD.
  - Screenshoty si prezri (Read) a popíš ich v „## Výsledok".
- acceptance:
  - `CI=1 pnpm test:e2e` (všetky specy)
  - `test -s tests/e2e/__screenshots__/f2-docked.png -a -s tests/e2e/__screenshots__/f2-departed.png`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T02-13 · Review `src/sim/**`
- model: opus
- agent: sim-reviewer
- parallel: no
- depends_on: T02-05, T02-06, T02-11
- inputs: `git diff phase/01-grid-roads..HEAD -- src/sim tests/sim data tools`
- outputs: tabuľka nálezov + verdikt
- acceptance: verdikt MERGE (0 blocking); blocking → nové karty (opus)
- do_not_touch: všetko
- estimate: S

### T02-14 · ARCHITECTURE: zosúladenie s F2 + minor nálezy review
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T02-13
- inputs: ADR-014..016; výsledok T02-13; BACKLOG P2 „ARCHITECTURE: §12.1 bez GameSpeedChanged/CommandRejected …"
- outputs: docs/ARCHITECTURE.md (§4.2 connectors `side`, BerthParams/CraneParams, §5 World polia, §5.4, §7.2 cyklus, §8 crane na berthe + refund zo zaplatenej ceny, §12.1 udalosti F1+F2, §12.2 `toJSON()` + `SpawnShipDebug`, §13 snapshot v2, §14 WorldState v2, §18 zoznam ADR-007..016); drobné opravy minor nálezov v src/sim s testom (len ak sú lokálne a bez zmeny správania; inak BACKLOG)
- acceptance:
  - `grep -n 'ADR-016' docs/ARCHITECTURE.md`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**, tools/**, data/**
- estimate: S

### T02-15 · Plná pipeline + triáž
- model: haiku
- agent: test-runner
- parallel: no
- depends_on: T02-01..T02-14
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs && pnpm build`
  - `pnpm -s simrun data/scenarios/f2_unload.json --ticks 5000 --report | jq -e '.lostUnits == 0'` (namiesto `vertical_slice` do F5)
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.lostUnits == 0 and .cashEnd == 108300000'`
  - `CI=1 pnpm test:e2e` + screenshoty `boot.png`, `f1-road.png`, `f2-docked.png`, `f2-departed.png`
- do_not_touch: všetko
- estimate: S

### T02-16 · Uzavretie fázy (PROGRESS, BACKLOG) + PR
- model: haiku
- agent: docs-keeper
- parallel: no
- depends_on: T02-15
- outputs: docs/tasks/phase-02.md (checklist); docs/PROGRESS.md; docs/BACKLOG.md
- acceptance:
  - `! grep -n '^- \[ \] T02-' docs/tasks/phase-02.md`
- do_not_touch: všetko mimo outputs
- estimate: S
