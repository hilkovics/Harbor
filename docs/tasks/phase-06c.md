# Fáza 6c — Prázdne kontajnery a tranship · task karty → míľnik **M2 „živý terminál"**

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 6c", `docs/PORT_OPERATIONS.md` §2.2–2.3, ARCHITECTURE (stav po F6a), ADR-032, ADR-033.
> Vetva: `phase/06c-empties-tranship` (stacked nad `phase/06a-export-booking`, PR hilkovics/Harbor#9). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> Úsporný režim: implementácia na Sonnete, overovanie (test-runner) a odškrtávanie (docs-keeper) na Haiku; plná e2e raz za fázu.

**Cieľ:** všetky štyri toky kontajnerov v jednom prístave — import, export, prázdne, tranship.

**Akceptácia fázy (M2):** scenár `live_terminal.json` s importom, exportom, návratom prázdnych + repositioningom a transhipom (loď A → loď B) beží bez chyby, `lostUnits = 0`, `--roundtrip-at` uprostred toku dá zhodný hash; savy v1–v7 sa načítajú; `pnpm test` a plná e2e zelené.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-034 v T6C-01)
1. **Linky:** `lines.json` (napr. 3 linky, def). Každá voyage a kontrakt má `lineId` (Rng pri vzniku ponuky); jednotky nesú `lineId`. Import/export z F6a dostanú linku tiež (migrácia: deterministicky prvá linka).
2. **Návrat prázdnych:** keď importná jednotka odíde kamiónom (`exported`), naplánuje sa návrat prázdneho kontajnera tej istej linky po `hinterlandDaysRange` (def, Rng; plán v stave). Kamión príde s **novou** jednotkou `direction: 'empty'` (vzniká `in_truck` na portáli, ako export), prejde bránou, vyloží sa na rampe a vozidlo ju odvezie do depa prázdnych. Nie každý import sa vráti: `emptyReturnRate` (def).
3. **Depot prázdnych** `empty_depot`: nová trieda `extends StorageModule` + def (vyššia kapacita na plochu — vyššie stohovanie), prijíma len prázdne. Prázdne smú do bežného dvora len ak depo chýba/je plné (fallback, metrika).
4. **Kontrola a M&R:** pri uložení do depa `damageChance` (def) → jednotka `status: 'damaged'` → oprava `repairHours` + `repairCostCents` (ledger kategória `maintenance_repair`) → `available`. Poškodenú nemožno vydať ani naložiť.
5. **Empty handler:** nové vozidlo `empty_handler` (def + trieda, rýchlejší zdvih, len `direction: 'empty'`), sprite dočasne z `forklift_*`. Dispatcher priraďuje joby prázdnych prednostne empty handlerom, inak bežným vozidlám.
6. **Výdaj prázdneho exportérovi:** pred príchodom naloženého exportu (F6a) príde pre časť booking jednotiek (`emptyPickupRate`, def) najprv prázdny kamión po prázdny kontajner **tej istej linky** (z depa cez rampu) a odíde s ním (`exported`). Ak linka nemá dostupný prázdny, kamión čaká `emptyPickupMaxWaitHours` a potom odíde prázdny (metrika `emptyPickupMisses`).
7. **Repositioning kontrakt** `kind: 'empty_repositioning'`: linka L chce naložiť N dostupných prázdnych na voyage V (vlastná loď alebo pridaný k exportu voyage); prázdne sa nakladajú **po plných** (stowage: plné heavy→light, potom prázdne), odmena za naložený kus, `shipped`. Readiness: depo + dostatok dostupných prázdnych linky v čase prijatia (alebo len depo — rozhodne T6C-01, jednoduchšie vyhrá).
8. **Tranship kontrakt** `kind: 'tranship'`: voyage A (prichádzajúca) nesie N jednotiek `direction: 'tranship'` s cieľovou voyage B tej istej linky, ktorá príde neskôr (`transhipGapDaysRange`, def). Jednotky sa vyložia (pod hák/apron), uložia zoskupene podľa B, naložia sa na B v jej stowage (spolu s exportom) → `shipped`. **Nikdy neprejdú bránou.** Ak B odpláva bez nich: penalizácia, jednotky sa naložia na ďalšiu voyage linky, alebo (ak žiadna nie je naplánovaná do `transhipRescueDays`) odídu kamiónom ako „predané" s penalizáciou — nič sa neteleportuje.
9. **Ledger:** `direction` pribudne `'empty' | 'tranship'`; prechody z F6a postačia (empty: `in_truck → at_ramp → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck → exported` alebo `… → on_ship → shipped`; tranship: import reťazec po sklad + export reťazec zo skladu). Konzervácia: `created = živé + exported + shipped`.
10. **WorldState v8** + migrácia v7 → v8 (linka, status, plány návratov a výdajov).
11. **Render/UI:** prázdne kontajnery inou farbou (token, sivá), poškodené s odznakom; depo prázdnych (sprite odvodený z dvora, iná farba strechy/čiarky — bez nových assetov ak sa dá); empty handler; ContractsPanel karty `empty_repositioning` a `tranship` (A → B, odpočet do príchodu B); inšpektor depa (dostupné / poškodené / v oprave podľa linky); toasty (návrat prázdnych, oprava hotová, tranship zmeškaný).

## Karty
| id | názov | agent (model) | parallel | depends_on |
|---|---|---|---|---|
| T6C-01 | Návrh + defy: ADR-034, „Spoločné rozhrania", `lines.json`, nové defy (empty_depot, empty_handler, ekonomika návratov/opráv/repositioning/tranship), schémy, DefRegistry, kostra typov, WorldState v8 + migrácia | sim-architect (sonnet) | no | – |
| T6C-02 | Sim 1: linky, plán návratov prázdnych, prázdne kamióny, depo + kontrola + M&R, empty handler, výdaj prázdneho exportérovi; scenár `empty_cycle.json` | sim-architect (sonnet) | no | 01 |
| T6C-03 | Sim 2: repositioning a tranship kontrakty (pool, readiness, stowage prázdnych po plných, tranship A → B, záchrana zmeškaného), scenár `live_terminal.json` + golden, simrun metriky | sim-architect (sonnet) | no | 02 |
| T6C-04 | Render: farba prázdnych, odznak poškodených, depo prázdnych, empty handler | implementer (sonnet, worktree) | yes | 01 |
| T6C-05 | UI + app: karty repositioning/tranship, inšpektor depa, toasty, VM | ui-builder (sonnet, worktree) | yes | 01 |
| T6C-06 | Napojenie render/UI na sim + e2e `f6c-live-terminal` (rozdelené na T6C-06a a T6C-06b) | implementer (sonnet) | no | 03, 04, 05 |
| T6C-06a | Napojenie render/UI/app na sim 1: prázdne kontajnery, depo, empty handler a toasty nad `empty_cycle` | implementer (sonnet) | no | 02, 04, 05 |
| T6C-06b | Napojenie na sim 2: prekládka A → B, repositioning, toast lode B, inšpektor + e2e `f6c-live-terminal` | implementer (sonnet) | no | 03, 06a |
| T6C-07 | Review `src/sim/**` + opravy | sim-reviewer (sonnet) → sim-architect (sonnet) | no | 03 |
| T6C-07b | Opravy z review F6c (2 major + 5 minor): limit návratov podľa miesta v depe, dosiahnuteľnosť nakládky, hot path, vzdanie sa len `collect`, overenie `pickupPlan` | sim-architect (sonnet) | no | 07 |
| T6C-08 | Plná pipeline + e2e (test-runner, haiku), artefakt | test-runner (haiku) | no | 06, 07 |
| T6C-09 | Docs: ARCHITECTURE (sonnet), PROGRESS/BACKLOG/checklist (haiku), PR | implementer / docs-keeper | no | 08 |

Vlny: T6C-01 → {T6C-02 → T6C-03} ‖ {T6C-04 ‖ T6C-05} → T6C-06 ‖ T6C-07 → T6C-08 → T6C-09.

## Checklist
- [x] T6C-01 · ADR-034, defy, Spoločné rozhrania, WorldState v8
- [x] T6C-02 · Sim 1: linky, návrat prázdnych, depo, M&R, empty handler, výdaj exportérovi
- [x] T6C-03 · Sim 2: repositioning, tranship, live_terminal, metriky
- [x] T6C-04 · Render
- [x] T6C-05 · UI + app
- [x] T6C-06 · Napojenie + e2e
  - [x] T6C-06a · Napojenie prázdnych kontajnerov, depa a empty handlera nad `empty_cycle`
  - [x] T6C-06b · Napojenie prekládky a repositioningu nad `live_terminal`, toasty, e2e `f6c-live-terminal`
- [x] T6C-07 · Review + opravy
  - [x] T6C-07b · Opravy z review: M1 (limit návratov podľa miesta v depe), M2 (dosiahnuteľnosť nakládky), m1–m6 a minor render + UI
- [x] T6C-08 · Pipeline + artefakt
- [x] T6C-09 · Docs + PR

## Spoločné rozhrania
*Záväzné pre T6C-02 až T6C-06 (T6C-01, ADR-034). Skeleton je v `src/sim` (HEAD po T6C-01): typy, tabuľky, defy, save v8 a migrácia existujú; správanie (návrat prázdnych, depo + kontrola + M&R, výdaj exportérovi, repositioning, tranship) dodajú T6C-02 / T6C-03.*

### Sim typy (už v kóde)
```ts
// @sim/cargo
type CargoDirection = 'import' | 'export' | 'tranship' | 'empty';            // CARGO_DIRECTIONS
type CargoStatus = 'available' | 'damaged' | 'in_repair';                    // CARGO_STATUSES, DEFAULT_CARGO_STATUS = 'available'
interface CargoUnitLabels { direction; voyageId: VoyageId | null; lineId: string | null; destinationPort: string | null; weightClass }
interface CargoUnit extends CargoUnitLabels { id; typeId; contractId: ContractId | null; hold; status: CargoStatus; repairUntilTick: number | null; quantity; location }
// poradie kľúčov v save: CARGO_UNIT_KEYS = id, typeId, contractId, voyageId, lineId, direction, destinationPort, weightClass, hold, status, repairUntilTick, quantity, location
CargoLedger.create(typeId, location, contractId = null, labels = IMPORT_LABELS)
CargoLedger.setStatus(unitId, status, repairUntilTick: number | null): CargoUnit   // bez udalosti, poloha sa nemení; stav ≠ available len pre direction 'empty'
CARGO_SPAWN_KIND_BY_DIRECTION = { import: 'on_ship', export: 'in_truck', tranship: 'on_ship', empty: 'in_truck' }
EMPTY_WEIGHT_CLASS = 'light'
// štítky podľa smeru (DIRECTION_LABEL_RULES): empty = bez kontraktu / voyage / prístavu, s linkou; tranship = ako export (kontrakt, voyage A, linka, cieľový prístav)
// prázdny a tranship používajú existujúce prechody §7.1 (žiadny nový CargoLocation); konečné stavy: prázdny exported | shipped, tranship shipped (loď B) | exported (zmeškaná prekládka predaná po lehote záchrany, `TranshipSold`; ADR-034 dodatok T6C-03 bod 6)
// @sim/contracts
type ContractKind = 'import' | 'export' | 'empty_repositioning' | 'tranship';   // CONTRACT_KINDS
type OfferGroup = 'import' | 'booking' | 'repositioning' | 'tranship';          // OFFER_GROUPS; CONTRACT_KIND_TRAITS[kind] = { booking, tranship, offerGroup }
abstract class Contract { …; lineId: string;                                    // povinné; pool: lineForVoyage(lines, voyageId)
  offerGroup: OfferGroup; voyageIds: readonly VoyageId[];                       // tranship: [A, B]
  booking: ExportBooking | null;                                                // export, empty_repositioning, tranship
  tranship: TranshipLeg | null;                                                 // len tranship
  spawnUnits: number; spawnLabels: CargoUnitLabels }                            // spawn jednotiek na lodi (import: IMPORT štítky + linka; tranship: direction 'tranship')
class EmptyRepositioningContract extends ExportContract                         // booking prázdnych linky z depa na loď voyage (bez cut-off a plánu príchodov)
class TranshipContract extends ExportContract implements TranshipLeg            // loď A privezie, loď B odvezie
interface TranshipLeg { outVoyageId: VoyageId; outArrivalTick | undefined; outShipId: EntityId | undefined; rescueDeadlineTick | undefined }
interface TranshipContractTerms extends ExportContractTerms { outVoyageId: VoyageId }
SerializedContract: …, voyageId, lineId (za voyageId), templateId, …, booking, tranship: SerializedTranship | null (na konci)
SerializedTranship = { outVoyageId, outArrivalTick | null, outShipId | null, rescueDeadlineTick | null }
ContractBook: voyageContracts(id) a voyage(id): VoyageView platia aj pre voyage B prekládky; voyageIdOfShip(shipId) pozná loď A aj B; offeredGroups(): { import, booking, repositioning, tranship }
AcceptContext += { ticksPerHour, transhipGapDaysRange }                        // prijatie prekládky: 1 ťah Rng.range po ťahu príchodu lode A
// @sim/modules
class EmptyDepot extends StorageModule { repairBays: number; acceptsDirection(d) => d === 'empty'; storageCapacityUnits() => 0 }
StorageModule.acceptsDirection(direction): boolean                              // bežný sklad true pre každý smer (fallback prázdnych)
// def: kind 'storage', params { capacityUnits, category: 'container', role: 'empty_depot', repairBays }
// @sim/logistics
vehicleCarries(vehicle, category, direction): boolean                           // VehicleDef.cargoDirections ('empty' pre empty handler; chýba = všetko)
class EmptyFlow { returnPlan: {dueTick, lineId}[]; pickupPlan: {dueTick, lineId, contractId}[]; schedule*/due*/consume*/dropPickupsOf/getState }   // World.emptyFlow
// @sim/world
WORLD_STATE_VERSION = 8; WORLD_STATE_V8_KEYS = v7 + 'emptyFlow'; WorldState.emptyFlow = { returnPlan, pickupPlan }
migrateWorldState: v7 → v8 (lineId = prvá linka z lines.json, status 'available', prázdny emptyFlow); savy v1–v7 sa načítajú
cargoSplitAt / shipCargoSplit / storageCargoSplit(world, …): { import, export, tranship, empty }
depotCargoSplit(world, moduleId): { lines: LineStatusSplit[]; other: number }     // prázdne v sklade podľa linky (poradie lines.json) a stavu
terminalEmptySplit(world): LineStatusSplit[]                                       // uskladnené prázdne celého prístavu
interface LineStatusSplit { lineId: string; available: number; damaged: number; in_repair: number }
```
`ValidationReason`, `BookingPenaltyKind`, `PenaltyKind`, `ContractState`, `CraneState`, `LEDGER_CATEGORIES` sa **nemenia** (app ich mapuje vyčerpávajúco): repositioning používa `no_storage_for_category`, zmeškaná prekládka `BookingPenaltyApplied kind 'rolled'`. Kategóriu `maintenance_repair` pridá T6C-02. `ContractCardKind` v `@ui` rozšíri T6C-05 (dnes `src/app/contract-cards.ts` mapuje nové druhy dočasne na `export`).

### Udalosti (`@sim/events`, deklarované; emitujú T6C-02 / T6C-03)
| Udalosť | Payload | Kedy |
|---|---|---|
| `EmptyReturned` | `unitId, lineId, truckId, gateId` | krok 8: kamión s prázdnym prešiel bránou dnu (toast „Návrat prázdnych") |
| `EmptyStored` | `unitId, lineId, moduleId, fallback` | uloženie prázdneho do skladu a kontrola; `fallback` = bežný dvor namiesto depa |
| `EmptyDamaged` | `unitId, lineId, moduleId` | kontrola v depe našla poškodenie (`damageChance`) |
| `EmptyRepairStarted` | `unitId, lineId, moduleId, untilTick` | krok 2: `damaged → in_repair` |
| `EmptyRepaired` | `unitId, lineId, moduleId, costCents` | krok 2: `in_repair → available`, poplatok `repairCostCents` (toast „Oprava hotová") |
| `EmptyPickedUp` | `unitId, lineId, contractId, truckId` | krok 8: kamión misie `pickup` odviezol prázdny exportérovi (`in_truck → exported`) |
| `EmptyPickupMissed` | `lineId, contractId, truckId` | kamión odišiel prázdny po `emptyPickupMaxWaitHours` |
| `TranshipMissed` | `contractId, units, outVoyageId` | loď B odplávala bez jednotiek prekládky (toast „Tranship zmeškaný") |
| `TranshipRescued` | `contractId, units, outVoyageId` | zmeškané jednotky presmerované na ďalšiu voyage linky |
| `TranshipSold` | `contractId, units` | zmeškané bez záchrany odišli kamiónom ako predané |
`CargoMoved` pokrýva každý presun prázdneho aj prekládky. **`REVISION_EVENTS` (`src/app/sim-bridge.ts`) rozšíri T6C-05** o `EmptyReturned`, `EmptyStored`, `EmptyDamaged`, `EmptyRepairStarted`, `EmptyRepaired`, `EmptyPickedUp`, `TranshipMissed`, `TranshipRescued`, `TranshipSold` (karty a inšpektor depa sa skladajú pri zmene revízie; zmena stavu jednotky `setStatus` udalosť nemá, preto `EmptyDamaged` / `EmptyRepairStarted` / `EmptyRepaired` musia revíziu zmeniť).

### Príkazy
Nové nie sú. `AcceptContract` / `DeclineContract { contractId }` pôsobia na skupinu ponuky (voyage) ako vo F6a; repositioning s exportom jednej voyage sa prijíma spolu. Validácia repositioningu (existuje depo prázdnych, dôvod `no_storage_for_category` opätovne použitý) pridá T6C-03; kostra `AcceptContract` ju zatiaľ nekontroluje.

### Čo app a render čítajú zo sveta (snapshot v8, T6C-04/05)
- jednotky (`world.cargo.get`): `direction` (`empty` → sivý tón, `tranship` ako import/export), `status` (`damaged` / `in_repair` → odznak), `lineId` (farba linky z `world.defs.lines.get(id).colorToken`), `repairUntilTick`;
- sklady: `storageCargoSplit` (štyri smery), `depotCargoSplit(world, depotId)` pre inšpektor depa (dostupné / poškodené / v oprave podľa linky), `EmptyDepot.repairBays`; HUD: `terminalEmptySplit(world)`;
- kontrakty: `contract.kind`, `contract.lineId`, `contract.voyageIds`, `contract.booking` (repositioning: `bookedUnits` / `arrivedUnits` / `loadedUnits`), `contract.tranship` (A → B: `outVoyageId`, `outArrivalTick` → odpočet do príchodu B, `outShipId`, `rescueDeadlineTick`), `contract.unitsUnloaded` (prekládka vyložená z A), `world.contractBook.voyage(B)`;
- vozidlá: def `empty_handler` (`cargoDirections: ['empty']`); sprite dočasne `assets/entities/empty_handler_{empty,loaded}.svg` (kópie `forklift_*` — prefarbiť);
- `world.emptyFlow.returnPlan.length` / `pickupPlan.length` (naplánované návraty a výdaje) pre prípadný indikátor;
- tokeny, ktoré **pridá T6C-04** do `design/tokens.css`: `--line-blue`, `--line-amber`, `--line-teal` (z `lines.json`) a `--cargo-empty`, `--cargo-empty-damaged` (sivý tón prázdnych a odznak poškodených).

### Nové polia defov (T6C-01: def + schéma + `DefRegistry` + validate-defs — hotové)
| Def | Pole | Typ / jednotka | Hodnota |
|---|---|---|---|
| `lines.json` (nový) | `items[]: { id, displayName, colorToken }` | neprázdne, jedinečné `id` | `blue_anchor` (`line-blue`), `northern_star` (`line-amber`), `golden_wave` (`line-teal`) |
| `economy.json` | `repositioningOffersPerDay`, `transhipOffersPerDay` | celé ≥ 0, skupiny ponúk | 1, 1 |
| | `repairCostCents` | celé ≥ 0, poplatok jednej opravy | 12 000 |
| | `transhipGapDaysRange` | `[min, max]` dni od príchodu lode A po príchod lode B | [1, 2] |
| | `transhipRescueDays` | dni na záchranu zmeškanej prekládky | 3 |
| | `transhipMissedRateOfReward` | 0…1 z odmeny / jednotku | 0,25 |
| `logistics.json` → `emptyFlow` | `hinterlandDaysRange` | `[min, max]` dni od odchodu importu po návrat prázdneho | [1, 3] |
| | `emptyReturnRate` | 0…1 | 0,6 |
| | `damageChance` | 0…1 pri uložení do depa | 0,08 |
| | `repairHours` | h > 0 | 6 |
| | `emptyPickupRate` | 0…1 podiel jednotiek exportu | 0,4 |
| | `emptyPickupLeadHoursRange` | `[min, max]` h pred príchodom naloženého exportu | [4, 12] |
| | `emptyPickupMaxWaitHours` | h ≥ 0 | 6 |
| `cargo_types.json` | `repositioningPricePerUnitCents`, `transhipPricePerUnitCents` | celé ≥ 0 centov (šablóna druhu vyžaduje > 0) | `container_teu` 12 000 / 28 000 |
| `modules.json` storage `params` | `role: 'empty_depot'`, `repairBays` | rola vyžaduje `repairBays` ≥ 1 a kategóriu `container` | `empty_depot`: 4×4, kapacita 96, cena 22 000 000, údržba 40 000 / deň, 2 miesta opravy |
| `vehicles.json` (položka) | `cargoDirections` | neprázdne jedinečné smery (chýba = všetky) | `empty_handler`: `['empty']`, rýchlosť 0,5, cena 3 600 000, mzda 14 000 / deň |
| `contract_templates.json` | `kind: 'empty_repositioning' \| 'tranship'` | tranship bez `exportVolumeUnitsRange`; repositioning s ním = spolu s exportom voyage | `container_feeder_repositioning`, `container_feeder_export_repositioning`, `container_feeder_tranship` (SLA ≤ 5, váha 2) |
Pool nové šablóny **zatiaľ neponúka** (T6C-03 zapne `repositioningOffersPerDay` / `transhipOffersPerDay`).

### Metriky `simrun` (T6C-02 / T6C-03; kľúče za `gameOver`, odporúčané názvy)
`emptyReturns` = Σ `EmptyReturned`; `emptyFallbackStored` = Σ `EmptyStored.fallback`; `emptyDamaged` = Σ `EmptyDamaged`; `emptyRepaired` = Σ `EmptyRepaired`; `repairCostCents` = Σ `EmptyRepaired.costCents`; `emptyPickedUp` = Σ `EmptyPickedUp`; `emptyPickupMisses` = Σ `EmptyPickupMissed`; `repositionedUnits` = naložené jednotky `empty` → `shipped`; `transhipLoaded` / `transhipMissed` / `transhipSold` = Σ jednotiek prekládky `shipped` / `TranshipMissed` / `TranshipSold`. **`lostUnits` = `createdCount − (liveCount + exportedCount + shippedCount)`** musí byť 0. Hashe po T6C-01 (len tvar v8, metriky bez zmeny): `vertical_slice` 30 000 `5a6eae94` (bolo `c8a8fb43`), `export_roundtrip` 40 000 `65ca76d6` (`8f8bbdaf`), `export_inbound` 30 000 `357cdd37` (`22216b6b`), `full_import_chain` 40 000 `da449fd5` (`9b649c29`), `multi_ship_queue` 40 000 `91e2d10b` (`ac070343`), `stress_f6` 30 000 `2b8e525c` (`c07780e3`); `--roundtrip-at` zhodný.

### Čo môžu paralelné karty robiť hneď / čo čaká na T6C-02/03
- **T6C-04** (render): farby prázdnych a odznak poškodených nad `CargoUnit.direction` / `status` / `lineId`, sprity depa a empty handlera (defy aj manifest existujú: `sprites.empty_depot`, `entities.empty_handler` — kópie dvora / vidlicového vozíka), tokeny liniek. Živé dáta (prázdne v sklade, poškodené, tranship na palube) až po T6C-02 / T6C-03; do tej doby demo dáta cez ručne vložené jednotky v ledgeri.
- **T6C-05** (UI + app): karty `empty_repositioning` a `tranship` nad `contract.kind` / `booking` / `tranship`, inšpektor depa nad `depotCargoSplit`, toasty nad udalosťami vyššie, `REVISION_EVENTS`, tabuľky `ContractCardKind` / `REASON_TEXT` ak by T6C-03 pridal nové dôvody. Pool nové ponuky neponúka, kým ich T6C-03 nezapne — karty sa overia nad ručne vloženými ponukami (`world.contractBook.add`, ako `helpers/f6a.ts`).
- **T6C-02** (sim 1): `EmptyFlow` je v svete, sloty `returnPlan` / `pickupPlan` sa napĺňajú až tam; musí pridať `maintenance_repair` do `LEDGER_CATEGORIES` (+ test `ledger-category.test.ts`, ARCHITECTURE §9.2) a upraviť `StoredCargoIndex` (vylúčiť `direction 'empty'` z odchádzajúceho „voľného" prúdu) a invariant kroku 12 `storedCargo.size`.
- **T6C-03** (sim 2): zovšeobecní `Bucket.exports` / `exportAboard` pre tranship a prázdne, zapne pool nových druhov, readiness, stowage prázdnych po plných, krok 2 tranship (`CONTRACT_STEPS.tranship` je dnes nečinné), záchranu zmeškaného a priradenie naložených prázdnych bookingu repositioningu podľa lode a linky.

## Výsledok fázy (M2)

Míľnik **M2 „živý terminál“ splnený**: v jednom prístave bežia všetky štyri toky kontajnerov — import, export, prázdne (návrat, depo, kontrola + M&R, výdaj exportérovi, repositioning) a tranship (loď A → sklad → loď B).

| Karta | Stav |
|---|---|
| T6C-01 … T6C-05 | hotové |
| T6C-06a, T6C-06b | hotové (napojenie nad `empty_cycle` a `live_terminal`, e2e `f6c-live-terminal`) |
| T6C-07 | hotové (review) |
| T6C-07b | hotové (2 major + 5 minor opravené, m3 do BACKLOG, m7 ponechané; dodatok T6C-07b k ADR-034) |
| T6C-08 | hotové (plná pipeline, e2e, artefakt) |
| T6C-09 | hotové (ARCHITECTURE, PORT_OPERATIONS, PROGRESS, BACKLOG) |

**Review `src/sim/**`:** MERGE (2 major + 5 minor opravené v T6C-07b, m3 do BACKLOG, m7 ponechané; nálezy odložené mimo fázu sú v `docs/BACKLOG.md` „Z Fázy 6c“).

**Pipeline:** `pnpm test` zelené: 355 súborov, 8 630 testov.

**E2E:** 48/48.

**Scenár `live_terminal`** (60 000 tickov, seed 5014):
- `lostUnits`: 0
- `exportedUnits`: 116
- `shippedUnits`: 96
- `emptyReturns`: 68
- `emptyRepaired`: 11
- `repositionedUnits`: 24
- `transhipLoaded`: 36
- `stateHash`: `271a07cc` (zhodný s `--roundtrip-at 37000`)

**Výkon:** bench `live_terminal` priemer 0,11 ms / tick.

**Artefakt** (hrateľná verzia „Fáza 6c“) zverejnený. **Oprava buildu:** Vite `assetsInlineLimit: 0` — `data:` URL SVG assetov blokovala CSP artefaktu, assety sa preto neinlinujú.
