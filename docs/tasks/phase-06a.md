# Fáza 6a — Export a booking · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 6a", `docs/PORT_OPERATIONS.md` §2.1 a §4, ARCHITECTURE §7.1–7.8, §9.1, §14; ADR-026, ADR-027, ADR-029, ADR-030.
> Vetva: `phase/06a-export-booking` (stacked nad `phase/06-save-load`, PR hilkovics/Harbor#8). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora; úsporný režim (plná e2e raz za fázu).

**Cieľ:** prístav obsluhuje aj export. Hráč prijme booking, exportné kontajnery prichádzajú kamiónmi rozložene pred loďou, brána ich skontroluje, uložia sa do skladu, naložia sa na loď v poradí plánu a loď po lashingu odpláva. Jedna loď môže zároveň vykladať import a nakladať export.

**Akceptácia fázy:**
- scenár `export_roundtrip` (import aj export na jednej lodi): exporty prídu pred cut-off, naložia sa v poradí plánu, loď odpláva až po lashingu a papieroch; `lostUnits = 0`; `/sim-check` zelený;
- vertical slice ďalej funguje (import-only kontrakty sa správajú ako doteraz, golden sa smie zmeniť len so zdôvodnením);
- savy v1–v6 sa načítajú (migrácia na v7); roundtrip uprostred nakládky dáva zhodný `stateHash`.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-032 v T6A-01)
1. **Návštevu lode (voyage) a kontrakty oddeliť.** Pribudne pojem **voyage** (návšteva lode: trieda lode, príchod, `destinationPort`, odchod). Kontrakt má `kind: 'import' | 'export'` a odkaz na voyage. Import kontrakt = dnešné správanie. **Export booking** = počet TEU na danú voyage s `destinationPort` a **cut-off** (`cutoffHours` pred príchodom lode, def). Jedna voyage môže mať import kontrakt aj export booking (šablóna `kind: 'roundtrip'` vygeneruje obe naraz, alebo pool ponúkne export k už prijatej voyage — rozhodne T6A-01, jednoduchšie vyhrá). Rodina tried podľa pravidla 7 (`ImportContract` / `ExportContract` alebo stratégia na `Contract`), žiadne switch-e podľa `kind`.
2. **CargoUnit** dostane `direction: 'import' | 'export'`, `voyageId`, `destinationPort | null`, `weightClass: 'light' | 'medium' | 'heavy'` (Rng pri vzniku, rozdelenie v defe) a `hold: null | { reason: 'vgm', untilTick }`. Import jednotky: `weightClass` sa tiež určí (pre budúci stowage), na import nemá vplyv.
3. **Reverzný reťazec ledgera** (§7.1 rozšíriť riadkami tabuľky): export jednotka **vzniká v kamióne** pri spawne (`CARGO_SPAWN_KINDS` += `in_truck`), potom `in_truck → at_ramp → in_vehicle → in_storage → in_vehicle → on_apron → in_crane → on_ship → shipped`. **`shipped`** je nový konečný stav (ako `exported`), nastane, keď loď s jednotkou opustí mapu (`despawned`). Počítadlo `shippedCount`. `assertCargoConservation` počíta aj `shipped`.
4. **Príchody exportov:** pri prijatí bookingu sa naplánujú príchody kamiónov rovnomerne náhodne (jediný `Rng`) v okne `[arrival − exportArrivalWindowDays, cutoff]` (def). Plán je súčasť stavu (save). Kamión príde naložený jedným TEU, prejde bránou (kontrola = existujúce `processTicks`), stojiskom, zacúva k rampe, **vyloží** (rampa je výmenná zóna), vozidlo odvezie jednotku do skladu.
5. **VGM hold:** pri bráne s pravdepodobnosťou `vgmMissingChance` (def) dostane jednotka `hold vgm` na `vgmHoldHours` (def). Jednotka v hold sa nesmie naložiť na loď. Hold sa uvoľní automaticky po čase (zjednodušenie; žiadna interakcia hráča).
6. **Cut-off a neskoré exporty:** kamión, ktorý prejde bránou po cut-off, je **rolled**: jednotka sa prijme (nič sa neteleportuje), ale naloží sa len ak loď ešte nezačala lashing („last minute", penalizácia `lateExportPenaltyBp`); ak loď už odplávala alebo lashuje, jednotka sa **vráti odosielateľovi** kamiónom cez existujúci outbound tok (`exported`) s penalizáciou `rolledPenaltyBp`. Booking sa splní, ak sa naloží ≥ `bookingFulfilmentPct` (def) TEU; inak čiastočná odmena podľa naložených TEU a penalizácia.
7. **Sklad:** bez poradia v stohu (to je Fáza 14). Dispatcher ukladá exporty **zoskupene**: preferuje sklad, kde už ležia jednotky tej istej voyage, inak najbližší s voľným miestom. Import a export zdieľajú sklady. Metrika `exportGroupingPct` (podiel exportov voyage v jej najväčšom sklade).
8. **Stowage plán (zjednodušený):** pri dokovaní lode sa určí poradie nakládky jej exportov: `heavy → medium → light`, pri zhode podľa id (jeden cieľový prístav na voyage vo F6a; viac prístavov + 40'/20' až F12). Dispatcher posiela jednotky na apron **v poradí plánu**; žeriav nakladá z apronu v poradí plánu (ak ďalšia v poradí ešte nie je na aprone, nakladá sa najbližšia nasledujúca dostupná — neblokovať žeriav; metrika `stowageOrderViolations`).
9. **Apron** zdieľa sloty pre vykládku aj nakládku. Rezervácia: aspoň `apronExportReserve` slotov (def, napr. 2 z 8) pre export počas nakládky, aby import nezablokoval export a naopak.
10. **Žeriav — nakládka a dual cycling:** nový smer cyklu `apron → ship` (rovnaké fázy grabbing/swinging/placing s rovnakými časmi). Ak loď má import na vykládku aj export pripravený na aprone, žeriav robí **dual cycle**: naloží export a cestou späť vezme import; čas dvojcyklu = `dualCycleFactor × (single cycle)` (def, napr. 1,5 namiesto 2). Metrika `dualCycleRate`. Poradie: kým je loď plná importu a nemá voľné miesto, najprv vykladať (kapacita lode `capacityUnits` platí pre import + export na palube).
11. **Lashing a papiere:** po poslednej naloženej jednotke (a vyložení importu) loď prejde do stavu `lashing` (`lashingTicksPerUnit × naložené` + `paperworkTicks`, def v `ships.json`/`economy.json`), drží kotvisko, potom `undocking`. Demurrage beží ďalej podľa ADR-026.
12. **Dual transaction kamiónov:** exportný kamión po vyložení na rampe zostane na docku a **naloží import**, ak je na tom docku import jednotka pripravená na odvoz (SLA poradie ADR-027); inak odíde prázdny. Importné kamióny (bez exportu) jazdia ako doteraz. Metrika `dualTransactionRate` = podiel exportných kamiónov, ktoré odišli s importom.
13. **Ekonomika:** odmena exportu = `exportPricePerUnitCents × naložené TEU × urgency` (rovnaký vzorec ako import, ADR-026), penalizácie v bp (rolled, last-minute, nesplnený booking). XP ako pri importe.
14. **WorldState v7** + migrácia v6 → v7 (jednotky dostanú `direction: 'import'`, `weightClass` deterministicky bez Rng — napr. `medium`, `hold: null`; existujúce kontrakty `kind: 'import'`; voyage sa odvodí z lodí/kontraktov).
15. **UI/Render (mimo sim):** ContractsPanel ukáže export booking (cieľový prístav, cut-off, prišlo/naložené/hold), loď ukáže náklad na palube (import/export) a stav `lashing`; inšpektor skladu rozdelí import/export; kamión prichádzajúci naložený má loaded sprite už pri príchode; žeriav anim. aj pri nakládke (smer opačný).

16. **Odovzdávanie „pod hákom" (požiadavka používateľa, variant A):** odovzdávací bod žeriav ↔ vozidlo sa mení z apronu na **miesto pod hákom**. Straddle carrier čaká pod žeriavom; žeriav mu kontajner položí priamo (vykládka) alebo ho z neho zdvihne (nakládka). Apron ostáva len ako **buffer 0–1 jednotka na žeriav** (`craneBufferSlots`, def; 0 = čisto priame odovzdanie, žeriav čaká na vozidlo). Ledger: nové prechody `in_crane → in_vehicle` a `in_vehicle → in_crane` (§7.1), `on_apron` ostáva pre buffer. Dispatcher posiela vozidlo k žeriavu vopred (stav vozidla „čaká pod žeriavom"), aby žeriav nečakal; metriky `craneWaitForVehicleTicks`, `vehicleWaitUnderCraneTicks`. Rieši sa spolu s nakládkou a dual cyclingom v T6A-05 (jeden návrh cyklu žeriavu pre oba smery). Testy, ktoré pripínajú starý apron (`LEGACY_CAPACITY_DEFS`), ostanú na starom režime cez def. **Variant B** (terminálové ťahače + skladový RTG, ktorý ich v sklade vyloží) je nový typ vozidla a modulu → **Fáza 10a**.

## Karty
| id | názov | model | agent | parallel | depends_on | est |
|---|---|---|---|---|---|---|
| T6A-01 | Návrh: ADR-032, typy a „Spoločné rozhrania" (voyage, kontrakt kind, CargoUnit polia, ledger prechody, nové stavy lode/kamióna/žeriava, udalosti, snapshot), skeleton + WorldState v7 migrácia | opus | sim-architect | no | – | M |
| T6A-02 | Defy: `contract_templates` (export/roundtrip šablóny), `economy`/`ships`/`logistics` nové polia (cut-off, okno príchodov, VGM, penalizácie, lashing, dualCycleFactor, apronExportReserve, weightClass rozdelenie), schémy, DefRegistry, validate-defs | sonnet | implementer | yes (worktree) | 01 | S |
| T6A-03 | TDD: scenár `export_roundtrip.json` + testy (príchody pred cut-off, VGM hold, rolled, poradie nakládky, dual cycle, lashing, dual transaction, konzervácia so `shipped`, save v6→v7, roundtrip uprostred nakládky) | sonnet | test-writer | yes (worktree) | 01 | M |
| T6A-04 | Sim: ledger reverzný reťazec + `shipped`, booking/voyage v ContractSystem, plán príchodov, spawn naložených kamiónov, brána + VGM + rolled | opus | sim-architect | no | 01, 02 | L |
| T6A-05 | Sim: odovzdávanie pod hákom (rozhodnutie 16, buffer 0–1), dispatcher export (rampa → sklad zoskupene, sklad → žeriav v poradí plánu), žeriav nakládka + dual cycling, stav lode `lashing`, dual transaction kamiónov | opus | sim-architect | no | 04 | L |
| T6A-06 | Render: naložený kamión pri príchode, vykladanie na rampe (cúvanie ako pri nakládke), žeriav nakládka (opačný smer), náklad na palube lode podľa počtu (import/export farebne), indikátor lashing | sonnet | implementer | yes (worktree) | 01 | M |
| T6A-07 | UI + app: ContractsPanel export booking (cieľ, cut-off, prišlo/naložené/hold), inšpektor skladu import/export, inšpektor lode (náklad, lashing), toasty (cut-off o 6 h, rolled, loď odplávala s exportom), snapshot v7 | sonnet | ui-builder → implementer | yes (worktree) | 01 | M |
| T6A-08 | Tooling: simrun metriky (shippedUnits, rolledUnits, vgmHolds, dualCycleRate, dualTransactionRate, stowageOrderViolations, exportGroupingPct), golden `export_roundtrip` | sonnet | implementer | yes (worktree) | 01 | S |
| T6A-09 | Review `src/sim/**` + opravy | opus | sim-reviewer → sim-architect | no | 05 | M |
| T6A-10 | e2e `f6a-export` (prijať booking → kamióny s exportom → nakládka → odchod), plná e2e, screenshoty, `/sim-check`, artefakt | sonnet / haiku | implementer / test-runner | no | 03–09 | M |
| T6A-11 | Docs: ARCHITECTURE (§7.1, §7.3, §7.5, §7.8, §9.1, §12, §14), PORT_OPERATIONS §1 stav, PROGRESS, BACKLOG, PR | haiku / sonnet | docs-keeper | no | 10 | S |

Vlny: T6A-01 → {T6A-02 ‖ T6A-03 ‖ T6A-06 ‖ T6A-07 ‖ T6A-08} → T6A-04 → T6A-05 → T6A-09 → T6A-10 → T6A-11.
Worktree karty začínajú `git reset --hard <HEAD phase/06a-export-booking>` (worktree sa zakladá z `main`).

## Checklist
- [ ] T6A-01 · ADR-032, typy, Spoločné rozhrania, WorldState v7
- [ ] T6A-02 · Defy + schémy
- [ ] T6A-03 · TDD export_roundtrip
- [ ] T6A-04 · Sim: ledger, booking/voyage, príchody, brána, VGM, rolled
- [ ] T6A-05 · Sim: odovzdávanie pod hákom, dispatcher export, žeriav nakládka + dual cycle, lashing, dual transaction
- [ ] T6A-06 · Render
- [ ] T6A-07 · UI + app
- [ ] T6A-08 · simrun metriky + golden
- [ ] T6A-09 · Review + opravy
- [ ] T6A-10 · e2e + pipeline + artefakt
- [ ] T6A-11 · Docs + PR

## Spoločné rozhrania
*Záväzné pre T6A-02, 03, 06, 07, 08 (T6A-01, ADR-032). Skeleton je v `src/sim` (HEAD po T6A-01): typy, tabuľky, save v7 a migrácia existujú; správanie exportu (spawn bookingov, brána, VGM, dispatcher, žeriav, lashing, dual transaction) dodajú T6A-04/05.*

### Sim typy (už v kóde)
```ts
// @sim/core
type VoyageId = number & { __brand: 'VoyageId' };            // vlastná postupnosť knihy (nextVoyageId v save)
// @sim/cargo
type CargoDirection = 'import' | 'export';                   // CARGO_DIRECTIONS
type WeightClass = 'light' | 'medium' | 'heavy';             // WEIGHT_CLASSES; DEFAULT_WEIGHT_CLASS = 'medium' (import, migrácia)
interface CargoHold { reason: 'vgm'; untilTick: number }      // CARGO_HOLD_REASONS
interface CargoUnitLabels { direction; voyageId: VoyageId | null; destinationPort: string | null; weightClass }
interface CargoUnit extends CargoUnitLabels { id; typeId; contractId; hold: CargoHold | null; quantity; location }
// poradie kľúčov v save: CARGO_UNIT_KEYS = id, typeId, contractId, voyageId, direction, destinationPort, weightClass, hold, quantity, location
type CargoLocation = … | { kind: 'shipped' };                // 2. konečný stav (CargoTerminalKind = 'exported' | 'shipped')
CargoLedger.create(typeId, location, contractId = null, labels = IMPORT_LABELS)  // export: location in_truck, labels exportu
CargoLedger.setHold(unitId, hold | null): CargoUnit          // bez udalosti, poloha sa nemení
CargoLedger.shippedCount; CargoLedgerState = { createdCount, exportedCount, shippedCount, units }
CARGO_SPAWN_KIND_BY_DIRECTION = { import: 'on_ship', export: 'in_truck' }
compareStowageOrder(a, b) / STOWAGE_WEIGHT_RANK = { heavy: 0, medium: 1, light: 2 }   // stowage plán = (váha, id), neukladá sa
// @sim/contracts
type ContractKind = 'import' | 'export';                      // stavy ContractState sa NEMENIA
abstract class Contract { kind; voyageId; …polia F5…; outbound; carriesShipCargo; accruesDemurrage; booking: ExportBooking | null;
  transitions; cargoMoved(unit, to); countersProblem(); static fromState(s) }
class ImportContract extends Contract                         // F5
class ExportContract extends Contract implements ExportBooking { recordArrival(unitId, rolled) }
interface ExportBooking { destinationPort; cutoffTick: number | undefined; bookedUnits; arrivalPlan: readonly number[];
  arrivedUnits; loadedUnits; lastMinuteUnits; rolledUnits; rolledUnitIds; returnedUnits; heldUnits }
EXPORT_CONTRACT_TRANSITIONS: offered → accepted|expired; accepted → ship_en_route; ship_en_route → exporting|failed; exporting → completed|failed
SerializedContract = { id, kind, voyageId, …F5…, lateDays, booking: SerializedBooking | null }
SerializedBooking = { destinationPort, cutoffTick | null, arrivalPlan, arrivedUnits, loadedUnits, lastMinuteUnits, rolledUnitIds, heldUnits }
ContractBook: allocateVoyageId(), voyageContracts(id), voyage(id): VoyageView, voyageIdOfShip(shipId)
VoyageView = { id, contracts, shipClassId, arrivalTick?, shipId?, destinationPort: string | null, cutoffTick? }
// @sim/ships
type ShipState = … | 'lashing';   // docked → undocking | lashing; lashing → undocking; SHIP_STATE_TRAITS.lashes; moored: docked, lashing
Ship.lashingTicksLeft: number     // ≥ 1 práve v lashing (save)
// @sim/trucks
type TruckState = … | 'unloading';  // to_dock → loading | unloading | no_path; unloading → loading | to_gate_out
type TruckMission = 'pickup' | 'delivery';  Truck.mission, Truck.becomePickup(), Truck.traits, truckStateTraits(mission, state)
type TruckCargo = 'empty' | 'loading' | 'unloading' | 'full' | 'loaded'   // TRUCK_DELIVERY_STATE_TRAITS
// @sim/modules
type CraneCycle = 'unload' | 'load' | 'dual_load' | 'dual_unload';   // CraneModule.cycle, targetUnitId; CRANE_CYCLE_TRAITS[c].direction/dual
// CraneState sa NEMENÍ (idle/grabbing/swinging/placing/blocked) — animácia nakládky = rovnaké fázy, opačný smer
// @sim/world
WORLD_STATE_VERSION = 7; WORLD_STATE_V7_KEYS = v6 + 'nextVoyageId'; WorldStateV6, LegacyCargoUnitV6
shipCargoSplit(world, shipId) / storageCargoSplit(world, moduleId) / cargoSplitAt(world, kind, id): { import, export }
exportGroupingShare(world, contractId): number | null        // 0…1, najväčší sklad / všetky uskladnené
```

### Udalosti (`@sim/events`, deklarované; emitujú T6A-04/05)
| Udalosť | Payload | Kedy |
|---|---|---|
| `ExportArrived` | `contractId, unitId, truckId, gateId` | krok 8: delivery kamión prešiel bránou dnu |
| `UnitRolled` | `contractId, unitId` | hneď po `ExportArrived`, ak brána po cut-off |
| `VgmHoldStarted` / `VgmHoldReleased` | `contractId, unitId, untilTick` / `contractId, unitId` | brána (krok 8) / krok 2 v `tick ≥ untilTick` |
| `CutoffWarning` | `contractId, cutoffTick` | krok 2, `cutoffWarningHours` pred cut-off (toast „cut-off o N h") |
| `CutoffPassed` | `contractId, arrivedUnits, bookedUnits` | krok 2 v ticku cut-off |
| `UnitLoaded` | `craneId, shipId, unitId, contractId, lastMinute, outOfOrder` | krok 4: `in_crane → on_ship` |
| `DualCycle` | `craneId, shipId, loadedUnitId, unloadedUnitId` | krok 4: koniec dual cyklu (po `CraneCycleDone`) |
| `ShipLashingStarted` | `shipId, loadedUnits, ticks` | krok 3: `docked → lashing` |
| `ExportShipped` | `shipId, units` | krok 3: pri odchode z mapy, po `CargoMoved → shipped`, pred `ShipDeparted` |
| `TruckUnloaded` | `truckId, rampId, dock, unitId, dualTransaction` | krok 8: koniec vykládky delivery kamióna |
| `BookingPenaltyApplied` | `contractId, kind: 'last_minute' \| 'rolled' \| 'unfulfilled', units, amountCents` | krok 2 pri uzavretí bookingu, pred `ContractCompleted` / `ContractFailed` |
`PenaltyKind`, `ValidationReason`, `ContractState`, `CraneState` sa nemenia (app ich mapuje vyčerpávajúco). `CargoMoved` pokrýva každý presun aj `on_ship → shipped`.

### Príkazy
Nové nie sú. `AcceptContract` / `DeclineContract { contractId }` pôsobia na **skupinu ponuky** — všetky `offered` kontrakty tej istej voyage (roundtrip = import + export s jednou voyage); UI zoskupí karty podľa `contract.voyageId`. Dôvody validácie bez zmeny.

### Čo app číta zo sveta (snapshot v7, T6A-06/07)
- kontrakty: `contract.kind`, `contract.voyageId`, `contract.booking` (cieľ, cut-off, bookované / prišlo / naložené / hold / rolled / vrátené / zostávajúce príchody `arrivalPlan.length`), `world.contractBook.voyage(id)`;
- lode: `ship.state` (+ `lashing`), `ship.lashingTicksLeft`, `shipCargoSplit` (import / export na palube), `voyageIdOfShip`;
- sklady: `storageCargoSplit`; jednotky (`world.cargo.get`): `direction`, `weightClass`, `hold`, `destinationPort`;
- kamióny: `truck.mission`, stav `unloading`, `loaded` (= `in_truck > 0`; delivery je naložený už pri príchode);
- žeriavy: `crane.cycle` (`CRANE_CYCLE_TRAITS[cycle].direction` pre smer animácie);
- `world.cargo.shippedCount`; `REVISION_EVENTS` + nové udalosti; toasty: `CutoffWarning`, `UnitRolled`, `ExportShipped`, `BookingPenaltyApplied`.

### Nové polia defov (T6A-02: def + schéma + `DefRegistry` + validate-defs)
| Def | Pole | Typ / jednotka | Odporúčané |
|---|---|---|---|
| `economy.json` | `bookingOffersPerDay` | celé ≥ 0, skupiny ponúk (voyage) | 2 |
| | `exportArrivalDaysRange` | `[min, max]` dni od prijatia po príchod lode voyage s exportom; min × 24 > `cutoffHours` | [2, 3] |
| | `cutoffHours` | h > 0 pred príchodom lode | 12 |
| | `cutoffWarningHours` | h ≥ 0 pred cut-off | 6 |
| | `bookingFulfilmentShare` | 0…1 podiel bookovaných TEU | 0.9 |
| | `lastMinuteExportRateOfReward` | 0…1 z odmeny / jednotku | 0.02 |
| | `rolledExportRateOfReward` | 0…1 z odmeny / vrátenú jednotku | 0.05 |
| | `unfulfilledBookingRateOfReward` | 0…1 z odmeny, raz | 0.1 |
| `logistics.json` → `exportFlow` (objekt) | `arrivalWindowDays` | d > 0 (okno príchodov pred loďou) | 2 |
| | `vgmMissingChance` | 0…1 | 0.05 |
| | `vgmHoldHours` | h > 0 | 6 |
| | `weightClassShares` | `{ light, medium, heavy }` váhy ≥ 0, súčet > 0 | 0.3 / 0.5 / 0.2 |
| `modules.json` berth `params` | `apronReserveSlots` | celé 0 … ⌊apronSlots / 2⌋ (rezerva pre opačný smer) | 2 |
| `modules.json` crane `params` | `dualCycleFactor` | 1 … 2 (× jeden cyklus) | 1.5 |
| `ships.json` (trieda) | `lashingTicksPerUnit` | celé ≥ 0 tickov / naložená jednotka | 6 |
| | `paperworkTicks` | celé ≥ 0 tickov | feeder 360, handy 540 |
| `cargo_types.json` (položka) | `exportPricePerUnitCents` | celé ≥ 0 centov (export šablóna vyžaduje > 0) | `container_teu` 40 000 |
| `contract_templates.json` (položka) | `kind` | `'import' \| 'export' \| 'roundtrip'` (existujúce = `import`) | — |
| | `destinationPorts` | neprázdne `string[]` pre export/roundtrip, inak chýba | ["Rotterdam", "Hamburg", "Gdańsk"] |
| | `exportVolumeUnitsRange` | `[min, max]` bookované TEU, len roundtrip; max ≤ najmenšia kapacita lode | [12, 36] |
Nové šablóny (odporúčanie): `container_feeder_roundtrip` (roundtrip, feeder, `volumeUnitsRange` [24, 72], `exportVolumeUnitsRange` [12, 36], SLA [3, 5], váha 4, minTier 0), `container_feeder_export` (export, feeder, booked z `volumeUnitsRange` [12, 36], SLA [3, 5], váha 2, minTier 0). Pool ich ťahá oddelene od import šablón, po nich a len pri `DayClosed` (ADR-032 bod 1): prvé naplnenie poolu a ťah príchodu pri prijatí v ticku 1 ostanú bitovo rovnaké, obsah import ponúk od prvej polnoci sa posunie o ťahy bookingov.

### Metriky `simrun` (T6A-08; kľúče za `gameOver`)
`shippedUnits` = `cargo.shippedCount`; `rolledUnits` = Σ `UnitRolled`; `vgmHolds` = Σ `VgmHoldStarted`; `dualCycleRate` = `DualCycle / (CraneCycleDone + UnitLoaded − DualCycle)` (bez cyklov `null`); `dualTransactionRate` = Σ `TruckUnloaded.dualTransaction` / Σ `TruckUnloaded` (bez vykládky `null`); `stowageOrderViolations` = Σ `UnitLoaded.outOfOrder`; `exportGroupingPct` = priemer `exportGroupingShare(world, contractId)` v ticku každého `CutoffPassed` × 100 (1 desatinné miesto, bez cut-off `null`). **`lostUnits` = `createdCount − (liveCount + exportedCount + shippedCount)`.** Hashe po T6A-01 (len tvar v7): `vertical_slice` 30 000 `6ead4b16`, `full_import_chain` `275658b2`, `stress_f6` `df95dafc`.

### Čo môžu paralelné karty robiť hneď / čo čaká na T6A-04/05
- **T6A-02** (defy): všetko z tabuľky vyššie; typy defov (`EconomyDef`, `LogisticsDef.exportFlow`, `BerthParams`, `CraneParams`, `ShipClassDef`, `CargoTypeDef`, `ContractTemplateDef`) pridá T6A-02 v `src/sim/defs` (sim ich ešte nečíta).
- **T6A-03** (TDD): testy proti rozhraniam vyššie; save v6 → v7 a roundtrip v7 už pokrýva `tests/sim/world/save-v6-migration.test.ts` (fixture `save-v6.json`, pomocník `tests/sim/helpers/legacy-save.ts`); scenár `export_roundtrip` bude zelený až po T6A-05 (roundtrip ponuka vznikne až s T6A-02 + T6A-04; kroky `lashing` / `unloading` dovtedy vyhodia chybu).
- **T6A-06 / T6A-07** (render, UI): view-modely a panely nad poľami a udalosťami vyššie, demo dáta; živé dáta (delivery kamióny, nakládka, lashing) až po T6A-05.
- **T6A-08** (tooling): metriky a `lostUnits` hneď (počty sú 0 do T6A-04/05); golden `export_roundtrip` až po T6A-05.
