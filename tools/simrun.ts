// Headless runner scenára (ARCHITECTURE §16): načíta scenár, odsimuluje N tickov a vypíše report.
// Spustenie: `pnpm simrun <scenario.json> --ticks N [--report] [--hash] [--roundtrip-at T]`. Exit 1 pri akejkoľvek chybe
// (správa na stderr). `--hash` pridá odtlačok stavu na konci (`stateHash`, FNV-1a 32, ADR-030), `--roundtrip-at T` v ticku T
// svet uloží a znovu načíta (`World.deserialize(JSON.parse(JSON.stringify(world.serialize())))`) a pokračuje — report aj
// hash musia byť zhodné s behom bez roundtripu (T06-01).
// Logika je exportovaná (`parseArgs`, `loadScenario`, `runScenario`), CLI sa spustí len pri priamom behu súboru.
//
// Beh nad skutočným `World` (od fázy 1): `World.create(defs, mapa, seed)`; príkazy scenára sa vo fronte sveta
// objavia presne pred tickom `atTick` (replay, ARCHITECTURE §12.2). Odmietnutý príkaz = chyba scenára → exit 1.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, commandFromJSON, type Command, type SerializedCommand } from '@sim/commands';
import type { CargoDirection } from '@sim/cargo';
import { loadBundledDefs, type DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { loadBundledMap, loadMap, parseMapDef, type LoadedMap } from '@sim/grid';
import { CraneModule, TruckGate } from '@sim/modules';
import { World, stateHash, type WorldState } from '@sim/world';
import { exportGroupingShare } from '@sim/world/cargo-queries';

// ---------------------------------------------------------------------------------------------------------
// Scenár
// ---------------------------------------------------------------------------------------------------------

/** Jeden riadok replaye: príkaz, ktorý sa aplikuje pred tickom `atTick` (ARCHITECTURE §12.2). */
export interface ScenarioEntry {
  /** Celé číslo ≥ 0; záznamy v scenári sú zoradené neklesajúco (rovnaký tick = poradie zo scenára). */
  readonly atTick: number;
  /** Serializovaný `Command` (`{ type, … }`); zostaví ho `commandFromJSON`. */
  readonly command: unknown;
}

/** Scenár = seed + (voliteľná) mapa + zoznam príkazov. */
export interface Scenario {
  readonly id: string;
  /** Seed jediného `Rng` (ARCHITECTURE §14); celé číslo ≥ 0. */
  readonly seed: number;
  /** Cesta k mape (relatívna k pracovnému adresáru, rovnako ako cesta k scenáru). */
  readonly map?: string;
  readonly commands: readonly ScenarioEntry[];
}

/** Scenár po načítaní; `mapData` je surový JSON súboru `map` (`runScenario` ho spracuje `parseMapDef` + `loadMap`). */
export interface LoadedScenario extends Scenario {
  readonly mapData?: unknown;
}

/** Očakávaná chyba použitia alebo vstupu (nie chyba programu) — CLI ju vypíše bez stack trace. */
export class SimrunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimrunError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------

/**
 * Report behu. Kľúče a ich poradie sú záväzné — číta ich `test-runner` a budúce golden reporty; nové kľúče sa pridávajú
 * na koniec. Metriky, ktoré ešte nie sú implementované, sú `null` (nie 0), aby sa nedali zameniť za nameranú nulu.
 */
export interface SimrunReport {
  readonly scenario: string;
  readonly seed: number;
  /** Vykonané ticky (= `clock.tick`). */
  readonly ticks: number;
  /** Uplynulé herné dni (= `clock.gameDay`). */
  readonly gameDays: number;
  /** Hotovosť na konci v centoch (`world.cashCents`). */
  readonly cashEnd: number;
  /** Exportované jednotky nákladu (`world.cargo.exportedCount`); pred landside vo F3+ vždy 0. */
  readonly exportedUnits: number;
  /** Stratené jednotky nákladu = vytvorené − (živé + exportované + odplávané); musí byť 0 (CLAUDE.md, `/sim-check`). */
  readonly lostUnits: number;
  /**
   * Podiel kontraktov dokončených včas: počet `ContractCompleted` s `onTime` / počet `ContractCompleted` počas behu;
   * `null`, ak sa v behu nedokončil žiadny kontrakt (T05-04, plné metriky kontraktov T05-08).
   */
  readonly onTimeRate: number | null;
  /**
   * Podiel ticků žeriavov v stave `blocked`: Σ blocked / Σ (busy + idle + blocked) × 100, na 1 desatinné miesto.
   * Bez žeriavov (alebo bez jediného ticku) 0.
   */
  readonly craneBlockedPct: number;
  /** Počet buniek s cestou (`road === 'road'`) na konci behu, vrátane štartovacích ciest mapy. */
  readonly roads: number;
  /** Príkazy scenára aplikované pred tickom `atTick < ticks` (každý prešiel validáciou, inak beh končí chybou). */
  readonly commandsApplied: number;
  /** Príkazy s `atTick ≥ ticks` — beh skončil skôr, než na ne prišiel rad. */
  readonly commandsSkipped: number;
  /** Počet modulov vo svete na konci behu (`world.modules.size`), vrátane štartovacích modulov mapy. */
  readonly modules: number;
  /** Počet udalostí `ShipSpawned` počas behu (počítadlo nie je v save — počíta sa z udalostí). */
  readonly shipsSpawned: number;
  /** Počet udalostí `ShipDeparted` počas behu. */
  readonly shipsDeparted: number;
  /** Jednotky nákladu na aprone kotvísk na konci behu (`countByKind('on_apron')`). */
  readonly unitsOnApron: number;
  /** Počet udalostí `CraneCycleDone` počas behu (jednotka `in_crane → on_apron`). */
  readonly craneCycles: number;
  /** Počet vozidiel vo svete na konci behu (`world.vehicles.size`). */
  readonly vehicles: number;
  /** Jednotky nákladu uložené v skladoch na konci behu (`countByKind('in_storage')`). */
  readonly unitsInStorage: number;
  /** Počet udalostí `JobDone` počas behu (vozidlo uložilo poslednú jednotku jobu do cieľa). */
  readonly jobsDone: number;
  /**
   * Využitie vozidiel: Σ vozidlo-tickov so `state !== 'idle'` / Σ všetkých vozidlo-tickov × 100, na 1 desatinné miesto.
   * Vozidlo-tick = jedno vozidlo po jednom `tick()`; po uložení všetkého sa podiel len riedi. Bez vozidiel 0.
   */
  readonly vehicleUtilPct: number;
  /** Počet udalostí `NoStorageAvailable` počas behu (najviac raz za hernú hodinu na berth). */
  readonly noStorageEvents: number;
  /**
   * `world.clock.tick` po prvom ticku, v ktorom po aspoň jednom `ShipSpawned` platí
   * `on_ship + on_apron + in_crane + in_vehicle === 0` (všetok náklad je už mimo lodí, apronu, žeriavov a vozidiel);
   * `null`, ak taký tick v behu nenastal (vrátane behu bez spawnu lode).
   */
  readonly ticksToAllStored: number | null;
  /** Počet udalostí `TruckSpawned` počas behu (kamión vyšiel na road portáli s nákladom z docku rampy, F4). */
  readonly trucksSpawned: number;
  /** Počet udalostí `TruckExited` počas behu (kamión opustil mapu cez road portál). */
  readonly trucksExited: number;
  /** Σ `TruckExited.units` — jednotky odvezené kamiónmi; krížová kontrola voči `exportedUnits` (bez iného exportu sú rovnaké). */
  readonly unitsExportedByTrucks: number;
  /** Počet udalostí `NoWaitingBay` počas behu (rampa má náklad, ale žiadne stojisko nemá voľný bay; najviac raz za hernú hodinu na rampu). */
  readonly noWaitingBayEvents: number;
  /**
   * Maximum Σ `TruckGate.queueLength` cez všetky brány (moduly druhu `gate`) meraného po každom ticku; do fronty sa
   * počíta aj kamión, ktorý bránou práve prechádza (z fronty vypadne až po dokončení prechodu). Bez brány 0.
   */
  readonly gateQueueMax: number;
  /**
   * `world.clock.tick` po prvom ticku, v ktorom po aspoň jednom `ShipSpawned` platí `cargo.exportedCount + shippedCount ===
   * cargo.createdCount` a `createdCount > 0` (všetok vytvorený náklad opustil mapu po súši alebo loďou); `null`, ak taký tick
   * v behu nenastal.
   */
  readonly ticksToAllExported: number | null;
  /** Počet dokončených kontraktov za hru na konci behu (`world.completedContracts`, F5). */
  readonly contractsCompleted: number;
  /** Nazbierané XP na konci behu (`world.xp`, F5). */
  readonly xp: number;
  /** Počet udalostí `ContractOffered` počas behu (vrátane úvodných ponúk pri štarte hry). */
  readonly contractsOffered: number;
  /** Počet udalostí `ContractAccepted` počas behu. */
  readonly contractsAccepted: number;
  /** Počet udalostí `ContractFailed` počas behu. */
  readonly contractsFailed: number;
  /** Počet udalostí `ContractExpired` počas behu (timeout aj odmietnutie). */
  readonly contractsExpired: number;
  /** Σ `PenaltyApplied.amountCents` počas behu (penalizácie nazbierané na kontraktoch, nie nutne už strhnuté z hotovosti). */
  readonly penaltiesCents: number;
  /** Σ príjmov kategórie `contract_revenue` (z `MoneyChanged`) počas behu. */
  readonly revenueCents: number;
  /** Σ výdavkov kategórie `maintenance` počas behu, kladná veľkosť. */
  readonly maintenanceCents: number;
  /** Σ výdavkov kategórie `wages` počas behu, kladná veľkosť. */
  readonly wagesCents: number;
  /** Tier hráča na konci behu (`world.tier`). */
  readonly tier: number;
  /** Bankrot nastal (`world.gameOver`). */
  readonly gameOver: boolean;
  /**
   * Odtlačok stavu na konci behu (`stateHash(world)`: FNV-1a 32 nad `JSON.stringify(serialize())`, 8 hex znakov; ADR-030)
   * s voľbou `--hash`, inak `null`. Roundtrip (`--roundtrip-at`) ho nesmie zmeniť.
   */
  readonly stateHash: string | null;
  /** Jednotky exportu, ktoré odplávali na lodi (`world.cargo.shippedCount`, F6a). Do `lostUnits` sa počítajú ako vybavené. */
  readonly shippedUnits: number;
  /** Počet udalostí `UnitRolled` (jednotka prešla bránou po cut-off). */
  readonly rolledUnits: number;
  /** Jednotky exportu vrátené odosielateľovi po súši: Σ `returnedUnits` bookingov v knihe na konci behu. */
  readonly returnedUnits: number;
  /** Počet udalostí `VgmHoldStarted` (jednotka s chýbajúcim VGM zadržaná). */
  readonly vgmHolds: number;
  /**
   * Podiel dual cyklov: `DualCycle / (CraneCycleDone + UnitLoaded − DualCycle)` (cyklus vykládky + cyklus nakládky, dual = jeden
   * cyklus za dve jednotky); bez cyklov `null`.
   */
  readonly dualCycleRate: number | null;
  /** Podiel vykládok delivery kamiónov, po ktorých kamión naložil import (`TruckUnloaded.dualTransaction`); bez vykládky `null`. */
  readonly dualTransactionRate: number | null;
  /** Σ `UnitLoaded.outOfOrder` — jednotky naložené mimo poradia stowage plánu (na termináli ostala skoršia). */
  readonly stowageOrderViolations: number;
  /**
   * Priemer `exportGroupingShare` bookingu v ticku každého `CutoffPassed` × 100 (podiel exportov voyage v jej najväčšom sklade),
   * na 1 desatinné miesto; bez cut-off s uskladnenými jednotkami `null`.
   */
  readonly exportGroupingPct: number | null;
  /** Σ ticky, v ktorých žeriav v režime `under_hook` čakal na vozidlo (`CraneModule.waitForVehicleTicks`). */
  readonly craneWaitForVehicleTicks: number;
  /** Σ ticky vozidiel čakajúcich pod hákom žeriava (`CraneModule.vehicleWaitTicks`). */
  readonly vehicleWaitUnderCraneTicks: number;
  /** Počet udalostí `EmptyReturned` — prázdne kontajnery, ktoré prešli bránou dnu z vnútrozemia (F6c, ADR-034). */
  readonly emptyReturns: number;
  /** Počet `EmptyStored` s `fallback` — prázdne uložené do bežného dvora, lebo depo prázdnych bolo plné alebo chýbalo. */
  readonly emptyFallbackStored: number;
  /** Počet udalostí `EmptyDamaged` — kontrola v depe našla poškodenie (`damageChance`). */
  readonly emptyDamaged: number;
  /** Počet udalostí `EmptyRepaired` — dokončené opravy v depe. */
  readonly emptyRepaired: number;
  /** Σ `EmptyRepaired.costCents` — poplatky za opravy (ledger kategória `maintenance_repair`), kladná veľkosť. */
  readonly repairCostCents: number;
  /** Počet udalostí `EmptyPickedUp` — prázdne kontajnery odvezené exportérmi z depa. */
  readonly emptyPickedUp: number;
  /** Počet udalostí `EmptyPickupMissed` — kamióny po prázdny kontajner, ktoré odišli naprázdno po `emptyPickupMaxWaitHours`. */
  readonly emptyPickupMisses: number;
  /** Prázdne kontajnery (smer `empty`) naložené na loď repositioningu, ktoré s ňou odplávali (`CargoMoved on_ship → shipped`, F6c, ADR-034). */
  readonly repositionedUnits: number;
  /** Jednotky prekládky (smer `tranship`) naložené na loď B, ktoré s ňou odplávali (`on_ship → shipped`). */
  readonly transhipLoaded: number;
  /** Σ `TranshipMissed.units` — jednotky prekládky, pri ktorých loď B odplávala bez nich. */
  readonly transhipMissed: number;
  /** Σ `TranshipRescued.units` — zmeškané jednotky presmerované na ďalšiu voyage linky. */
  readonly transhipRescued: number;
  /** Σ `TranshipSold.units` — zmeškané jednotky bez záchrany, ktoré odišli kamiónom ako predané. */
  readonly transhipSold: number;
  /** Počet udalostí `EmptyReturnDeclined` — návraty prázdneho zahodené bez kamióna, lebo depo prázdnych nemalo voľné miesto (T6C-07b, ADR-034 dodatok). */
  readonly emptyReturnsDeclined: number;
}

// ---------------------------------------------------------------------------------------------------------
// Argumenty
// ---------------------------------------------------------------------------------------------------------

export interface SimrunArgs {
  readonly scenarioPath: string;
  readonly ticks: number;
  readonly report: boolean;
  /** `--hash`: report nesie `stateHash` a zhrnutie ho vypíše na konci. */
  readonly hash: boolean;
  /** `--roundtrip-at T`: tick (0 ≤ T < ticks), v ktorom sa svet uloží a znovu načíta; `null` = bez roundtripu. */
  readonly roundtripAt: number | null;
}

export const USAGE = 'použitie: pnpm simrun <scenario.json> --ticks N [--report] [--hash] [--roundtrip-at T]';

const TICKS_FLAG = '--ticks';
const REPORT_FLAG = '--report';
const HASH_FLAG = '--hash';
const ROUNDTRIP_FLAG = '--roundtrip-at';

export function parseTicks(raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new SimrunError(`${TICKS_FLAG} vyžaduje hodnotu. ${USAGE}`);
  // Len desiatkový zápis kladného celého čísla; "1e3", "0x10", "1.5", "-5" a "0" sú chyby.
  const ticks = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(ticks)) {
    throw new SimrunError(`${TICKS_FLAG} musí byť kladné celé číslo, dostal "${raw}"`);
  }
  return ticks;
}

/** Tick roundtripu: desiatkové celé číslo ≥ 0 ("0" áno, "01", "1e3", "-1" nie). */
function parseRoundtripAt(raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new SimrunError(`${ROUNDTRIP_FLAG} vyžaduje hodnotu. ${USAGE}`);
  const tick = /^(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(tick)) throw new SimrunError(`${ROUNDTRIP_FLAG} musí byť celé číslo ≥ 0, dostal "${raw}"`);
  return tick;
}

/**
 * Spracuje argumenty bez `node`/skriptu. Chyba použitia → `SimrunError`. `--ticks` je povinné; `--roundtrip-at` najviac
 * raz a menšie než `--ticks` (tick, ktorý beh ešte zastihne pred svojím `tick()`).
 */
export function parseArgs(argv: readonly string[]): SimrunArgs {
  let scenarioPath: string | undefined;
  let ticksRaw: string | undefined;
  let ticksGiven = false;
  let report = false;
  let hash = false;
  let roundtripRaw: string | undefined;
  let roundtripGiven = false;

  const takeRoundtrip = (raw: string | undefined): void => {
    if (roundtripGiven) throw new SimrunError(`${ROUNDTRIP_FLAG} je zadaná viackrát. ${USAGE}`);
    roundtripGiven = true;
    roundtripRaw = raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === TICKS_FLAG) {
      ticksGiven = true;
      ticksRaw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith(`${TICKS_FLAG}=`)) {
      ticksGiven = true;
      ticksRaw = arg.slice(TICKS_FLAG.length + 1);
    } else if (arg === REPORT_FLAG) {
      report = true;
    } else if (arg === HASH_FLAG) {
      hash = true;
    } else if (arg === ROUNDTRIP_FLAG) {
      takeRoundtrip(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith(`${ROUNDTRIP_FLAG}=`)) {
      takeRoundtrip(arg.slice(ROUNDTRIP_FLAG.length + 1));
    } else if (arg.startsWith('--')) {
      throw new SimrunError(`neznáma voľba ${arg}. ${USAGE}`);
    } else if (scenarioPath === undefined) {
      scenarioPath = arg;
    } else {
      throw new SimrunError(`nadbytočný argument "${arg}". ${USAGE}`);
    }
  }

  if (scenarioPath === undefined) throw new SimrunError(`chýba cesta k scenáru. ${USAGE}`);
  if (!ticksGiven) throw new SimrunError(`chýba povinná voľba ${TICKS_FLAG}. ${USAGE}`);
  const ticks = parseTicks(ticksRaw);
  const roundtripAt = roundtripGiven ? parseRoundtripAt(roundtripRaw) : null;
  if (roundtripAt !== null && roundtripAt >= ticks) {
    throw new SimrunError(`${ROUNDTRIP_FLAG} ${String(roundtripAt)} musí byť menší než ${TICKS_FLAG} ${String(ticks)}`);
  }
  return { scenarioPath, ticks, report, hash, roundtripAt };
}

// ---------------------------------------------------------------------------------------------------------
// Načítanie scenára
// ---------------------------------------------------------------------------------------------------------

const SCENARIO_KEYS: ReadonlySet<string> = new Set(['id', 'seed', 'map', 'commands']);

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new SimrunError(`${what} "${path}" sa nedá prečítať: ${errorMessage(cause)}`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SimrunError(`${what} "${path}" nie je platný JSON: ${errorMessage(cause)}`);
  }
}

function validateEntries(raw: unknown[], path: string): ScenarioEntry[] {
  let previousTick = 0;
  return raw.map((entry, index) => {
    const at = `${path}: /commands/${String(index)}`;
    if (!isPlainObject(entry)) throw new SimrunError(`${at} musí byť objekt { atTick, command }`);
    for (const key of Object.keys(entry)) {
      if (key !== 'atTick' && key !== 'command') throw new SimrunError(`${at}/${key} je neznámy kľúč`);
    }
    const { atTick, command } = entry;
    if (typeof atTick !== 'number' || !Number.isSafeInteger(atTick) || atTick < 0) {
      throw new SimrunError(`${at}/atTick musí byť celé číslo ≥ 0`);
    }
    if (atTick < previousTick) {
      throw new SimrunError(`${at}/atTick ${String(atTick)} je menší než predchádzajúci ${String(previousTick)} (záznamy musia byť neklesajúce)`);
    }
    previousTick = atTick;
    if (!isPlainObject(command)) throw new SimrunError(`${at}/command musí byť objekt`);
    return { atTick, command };
  });
}

/**
 * Načíta a zvaliduje scenár `{ id, seed, map?, commands }`. Ak je uvedená `map`, súbor sa načíta a parsuje ako JSON
 * (tvar mapy overí až `runScenario`). Záznamy `commands` musia mať `atTick` neklesajúci. Typy a payloady príkazov
 * sa overujú v `runScenario`. Akákoľvek chyba (súbor, JSON, tvar) → `SimrunError`.
 */
export function loadScenario(path: string): LoadedScenario {
  const raw = readJsonFile(path, 'scenár');
  if (!isPlainObject(raw)) throw new SimrunError(`${path}: scenár musí byť objekt`);

  for (const key of Object.keys(raw)) {
    if (!SCENARIO_KEYS.has(key)) throw new SimrunError(`${path}: /${key} je neznámy kľúč`);
  }
  const { id, seed, map, commands } = raw;
  if (typeof id !== 'string' || id === '') throw new SimrunError(`${path}: /id musí byť neprázdny reťazec`);
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) {
    throw new SimrunError(`${path}: /seed musí byť celé číslo ≥ 0`);
  }
  if (map !== undefined && (typeof map !== 'string' || map === '')) {
    throw new SimrunError(`${path}: /map musí byť neprázdny reťazec (cesta k mape)`);
  }
  if (!Array.isArray(commands)) throw new SimrunError(`${path}: /commands musí byť pole`);

  const scenario: Scenario = { id, seed, commands: validateEntries(commands, path), ...(map !== undefined && { map }) };

  if (scenario.map === undefined) return scenario;
  return { ...scenario, mapData: readJsonFile(scenario.map, 'mapa') };
}

// ---------------------------------------------------------------------------------------------------------
// Beh
// ---------------------------------------------------------------------------------------------------------

export interface ParsedEntry {
  readonly atTick: number;
  readonly command: Command;
}

/** Zostaví príkazy zo scenára vopred (pred prvým tickom), aby neplatný typ/payload zlyhal s cestou `/commands/i`. */
export function parseCommands(scenario: Scenario): ParsedEntry[] {
  return scenario.commands.map((entry, index) => {
    try {
      return { atTick: entry.atTick, command: commandFromJSON(entry.command as SerializedCommand) };
    } catch (cause) {
      if (cause instanceof CommandError) {
        throw new SimrunError(`${scenario.id}: /commands/${String(index)}/command: ${cause.message}`);
      }
      throw cause;
    }
  });
}

/** Mapa scenára (`map` = cesta k súboru, `mapData` = jeho obsah); bez `map` vstavaná `harbor_01`. */
export function resolveMap(scenario: LoadedScenario): LoadedMap {
  if (scenario.map === undefined) return loadBundledMap();
  const raw = scenario.mapData ?? readJsonFile(scenario.map, 'mapa');
  try {
    return loadMap(parseMapDef(raw));
  } catch (cause) {
    throw new SimrunError(`mapa "${scenario.map}" je neplatná: ${errorMessage(cause)}`);
  }
}

/** Počítadlá utilizácie jedného žeriavu (`CraneModule`): každý tick zvýši presne jedno z nich. */
export interface CraneTickCounters {
  readonly busyTicks: number;
  readonly idleTicks: number;
  readonly blockedTicks: number;
}

const PERCENT = 100;
/** Zaokrúhlenie na 1 desatinné miesto: násobok 10 pred `Math.round`, delenie 10 po ňom. */
const ONE_DECIMAL = 10;

/**
 * Podiel blokovaných ticků: Σ blocked / Σ (busy + idle + blocked) × 100, na 1 desatinné miesto. Sčítajú sa ticky
 * naprieč žeriavmi (nie priemer percent jednotlivých žeriavov). Bez žeriavov alebo bez ticku (súčet 0) vráti 0.
 */
export function craneBlockedPercent(cranes: Iterable<CraneTickCounters>): number {
  let blocked = 0;
  let total = 0;
  for (const crane of cranes) {
    blocked += crane.blockedTicks;
    total += crane.busyTicks + crane.idleTicks + crane.blockedTicks;
  }
  if (total === 0) return 0;
  return Math.round((blocked * PERCENT * ONE_DECIMAL) / total) / ONE_DECIMAL;
}

/** Vozidlo-ticky: `activeTicks` (stav ≠ `idle`) z `totalTicks` (každé vozidlo po každom ticku). */
export interface VehicleTickCounters {
  readonly activeTicks: number;
  readonly totalTicks: number;
}

/**
 * Využitie vozidiel: activeTicks / totalTicks × 100, na 1 desatinné miesto. Bez vozidlo-tickov (žiadne vozidlá alebo
 * ešte žiadny tick) vráti 0.
 */
export function vehicleUtilPercent(counters: VehicleTickCounters): number {
  if (counters.totalTicks === 0) return 0;
  return Math.round((counters.activeTicks * PERCENT * ONE_DECIMAL) / counters.totalTicks) / ONE_DECIMAL;
}

function craneModules(world: World): CraneModule[] {
  const cranes: CraneModule[] = [];
  for (const module of world.modules.values()) {
    if (module instanceof CraneModule) cranes.push(module);
  }
  return cranes;
}

/** Počty udalostí, ktoré simrun sčítava počas behu (nie sú v save). */
interface EventTally {
  shipsSpawned: number;
  shipsDeparted: number;
  craneCycles: number;
  jobsDone: number;
  noStorageEvents: number;
  trucksSpawned: number;
  trucksExited: number;
  unitsExportedByTrucks: number;
  noWaitingBayEvents: number;
  contractsCompleted: number;
  contractsOnTime: number;
  contractsOffered: number;
  contractsAccepted: number;
  contractsFailed: number;
  contractsExpired: number;
  penaltiesCents: number;
  revenueCents: number;
  maintenanceCents: number;
  wagesCents: number;
  rolledUnits: number;
  vgmHolds: number;
  dualCycles: number;
  unitsLoaded: number;
  stowageOrderViolations: number;
  truckUnloads: number;
  dualTransactions: number;
  emptyReturns: number;
  emptyFallbackStored: number;
  emptyDamaged: number;
  emptyRepaired: number;
  repairCostCents: number;
  emptyPickedUp: number;
  emptyPickupMisses: number;
  repositionedUnits: number;
  transhipLoaded: number;
  transhipMissed: number;
  transhipRescued: number;
  transhipSold: number;
  emptyReturnsDeclined: number;
  /** Súčet a počet `exportGroupingShare` v ticku `CutoffPassed` (priemer sa počíta na konci). */
  groupingShareSum: number;
  groupingShareCount: number;
}

function tallyEvents(tally: EventTally, events: readonly SimEvent[]): void {
  for (const event of events) {
    if (event.type === 'ShipSpawned') tally.shipsSpawned += 1;
    else if (event.type === 'ShipDeparted') tally.shipsDeparted += 1;
    else if (event.type === 'CraneCycleDone') tally.craneCycles += 1;
    else if (event.type === 'JobDone') tally.jobsDone += 1;
    else if (event.type === 'NoStorageAvailable') tally.noStorageEvents += 1;
    else if (event.type === 'TruckSpawned') tally.trucksSpawned += 1;
    else if (event.type === 'TruckExited') {
      tally.trucksExited += 1;
      tally.unitsExportedByTrucks += event.units;
    } else if (event.type === 'NoWaitingBay') tally.noWaitingBayEvents += 1;
    else if (event.type === 'ContractCompleted') {
      tally.contractsCompleted += 1;
      if (event.onTime) tally.contractsOnTime += 1;
    } else if (event.type === 'ContractOffered') tally.contractsOffered += 1;
    else if (event.type === 'ContractAccepted') tally.contractsAccepted += 1;
    else if (event.type === 'ContractFailed') tally.contractsFailed += 1;
    else if (event.type === 'ContractExpired') tally.contractsExpired += 1;
    else if (event.type === 'PenaltyApplied') tally.penaltiesCents += event.amountCents;
    else if (event.type === 'UnitRolled') tally.rolledUnits += 1;
    else if (event.type === 'VgmHoldStarted') tally.vgmHolds += 1;
    else if (event.type === 'DualCycle') tally.dualCycles += 1;
    else if (event.type === 'UnitLoaded') {
      tally.unitsLoaded += 1;
      if (event.outOfOrder) tally.stowageOrderViolations += 1;
    } else if (event.type === 'TruckUnloaded') {
      tally.truckUnloads += 1;
      if (event.dualTransaction) tally.dualTransactions += 1;
    } else if (event.type === 'EmptyReturned') tally.emptyReturns += 1;
    else if (event.type === 'EmptyStored') {
      if (event.fallback) tally.emptyFallbackStored += 1;
    } else if (event.type === 'EmptyDamaged') tally.emptyDamaged += 1;
    else if (event.type === 'EmptyRepaired') {
      tally.emptyRepaired += 1;
      tally.repairCostCents += event.costCents;
    } else if (event.type === 'EmptyPickedUp') tally.emptyPickedUp += 1;
    else if (event.type === 'EmptyPickupMissed') tally.emptyPickupMisses += 1;
    else if (event.type === 'EmptyReturnDeclined') tally.emptyReturnsDeclined += 1;
    else if (event.type === 'TranshipMissed') tally.transhipMissed += event.units;
    else if (event.type === 'TranshipRescued') tally.transhipRescued += event.units;
    else if (event.type === 'TranshipSold') tally.transhipSold += event.units;
    else if (event.type === 'MoneyChanged') {
      // Kategórie účtovnej knihy: príjem kontraktu je kladný, údržba a mzdy záporné → kladná veľkosť.
      if (event.reason === 'contract_revenue') tally.revenueCents += event.deltaCents;
      else if (event.reason === 'maintenance') tally.maintenanceCents -= event.deltaCents;
      else if (event.reason === 'wages') tally.wagesCents -= event.deltaCents;
    }
  }
}

/** Podiel exportov voyage v jej najväčšom sklade v ticku každého `CutoffPassed` (metrika `exportGroupingPct`); volá sa po `world.tick()`. */
function tallyGrouping(tally: EventTally, world: World, events: readonly SimEvent[]): void {
  for (const event of events) {
    if (event.type !== 'CutoffPassed') continue;
    const share = exportGroupingShare(world, event.contractId);
    if (share === null) continue;
    tally.groupingShareSum += share;
    tally.groupingShareCount += 1;
  }
}

/**
 * Smer jednotiek naložených na loď (`CargoMoved in_crane → on_ship`) podľa id — `shipped` jednotku z ledgera odstráni, takže smer sa musí zapamätať
 * pri nakládke (jednotka je vtedy ešte v ledgeri; odplávanie je vždy v neskoršom ticku). Metriky `repositionedUnits` a `transhipLoaded`.
 */
type LoadedDirections = Map<number, CargoDirection>;

/** Sčíta jednotky prázdne a prekládky, ktoré odplávali (`on_ship → shipped`); volá sa po `world.tick()`, pred ním sa smer naložených zapamätá. */
function tallyShipped(tally: EventTally, loaded: LoadedDirections, world: World, events: readonly SimEvent[]): void {
  for (const event of events) {
    if (event.type !== 'CargoMoved') continue;
    if (event.to.kind === 'on_ship' && event.from.kind === 'in_crane') {
      const direction = world.cargo.get(event.unitId)?.direction;
      if (direction === 'empty' || direction === 'tranship') loaded.set(event.unitId, direction);
    } else if (event.to.kind === 'shipped') {
      const direction = loaded.get(event.unitId);
      loaded.delete(event.unitId);
      if (direction === 'empty') tally.repositionedUnits += 1;
      else if (direction === 'tranship') tally.transhipLoaded += 1;
    }
  }
}

/** Σ jednotiek exportu vrátených odosielateľovi cez všetky bookingy v knihe (`ExportBooking.returnedUnits`). */
function returnedUnits(world: World): number {
  let returned = 0;
  for (const contract of world.contractBook.contracts.values()) returned += contract.booking?.returnedUnits ?? 0;
  return returned;
}

/** `part / whole` alebo `null` pri nulovom menovateli. */
function ratioOrNull(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** Vozidlá (`state !== 'idle'`) po jednom ticku pripočíta do počítadiel využitia. */
function tallyVehicleTicks(world: World, counters: { activeTicks: number; totalTicks: number }): void {
  for (const vehicle of world.vehicles.values()) {
    counters.totalTicks += 1;
    if (vehicle.state !== 'idle') counters.activeTicks += 1;
  }
}

/** Všetok náklad je mimo lodí, aprona, žeriavov a vozidiel (= uložený v sklade, prípadne ďalej v toku F4+). */
function isAllStored(world: World): boolean {
  const { cargo } = world;
  const inTransit =
    cargo.countByKind('on_ship') +
    cargo.countByKind('on_apron') +
    cargo.countByKind('in_crane') +
    cargo.countByKind('in_vehicle');
  return inTransit === 0;
}

/** Všetok vytvorený náklad opustil mapu (`exportedCount + shippedCount === createdCount`); prázdny svet (`createdCount === 0`) nie. */
function isAllExported(world: World): boolean {
  const { cargo } = world;
  return cargo.createdCount > 0 && cargo.exportedCount + cargo.shippedCount === cargo.createdCount;
}

/** Σ dĺžok frontov všetkých brán kamiónov (vrátane kamióna, ktorý bránou práve prechádza). */
function totalGateQueue(world: World): number {
  let queued = 0;
  for (const module of world.modules.values()) {
    if (module instanceof TruckGate) queued += module.queueLength;
  }
  return queued;
}

function countRoads(world: World): number {
  let roads = 0;
  for (let i = 0; i < world.grid.cellCount; i++) {
    if (world.grid.atIndex(i).road === 'road') roads += 1;
  }
  return roads;
}

/** Voľby behu `runScenario` (CLI `--hash`, `--roundtrip-at`). */
export interface RunOptions {
  /** Report nesie `stateHash` (odtlačok stavu na konci); predvolene `false` → `stateHash: null`. */
  readonly hash?: boolean;
  /**
   * Tick (celé číslo, 0 ≤ T < ticks), v ktorom sa svet pred zaradením príkazov s `atTick === T` uloží a znovu načíta
   * (`roundtripWorld`) a beh pokračuje na obnovenom svete; `null`/chýba = bez roundtripu.
   */
  readonly roundtripAt?: number | null;
}

/**
 * Save → load ako v hre (ADR-030): `serialize()` → JSON text → `JSON.parse` → `World.deserialize` s tými istými defmi
 * a mapou. Neplatný stav (`WorldStateError`) alebo iná chyba obnovy → `SimrunError` s tickom.
 */
export function roundtripWorld(world: World, defs: DefRegistry): World {
  const text = JSON.stringify(world.serialize());
  try {
    return World.deserialize(defs, world.map, JSON.parse(text) as WorldState);
  } catch (cause) {
    throw new SimrunError(`roundtrip v ticku ${String(world.clock.tick)} zlyhal: ${errorMessage(cause)}`);
  }
}

/**
 * Odsimuluje `ticks` tickov (kladné celé číslo) a zostaví report. Pred každým tickom sa do fronty sveta zaradia
 * všetky príkazy s `atTick === world.clock.tick` (v poradí zo scenára) a zavolá sa `applyPending()`; odmietnutý
 * príkaz (`CommandRejected`) ukončí beh chybou. Príkazy s `atTick ≥ ticks` sa nevykonajú (`commandsSkipped`).
 * Rovnaký scenár + seed + defy + mapa → identický report. `options.roundtripAt` = T: keď `clock.tick === T`, svet
 * sa ešte pred príkazmi ticku T uloží a znovu načíta (`roundtripWorld`); počítadlá udalostí ostávajú v simrune, takže
 * report (aj `stateHash`) musí byť rovnaký ako bez roundtripu. Tick T beh nezastihne (bankrot zastaví hodiny skôr)
 * → `SimrunError`.
 */
export function runScenario(scenario: LoadedScenario, ticks: number, defs: DefRegistry, options: RunOptions = {}): SimrunReport {
  if (!Number.isSafeInteger(ticks) || ticks < 1) {
    throw new SimrunError(`ticks musí byť kladné celé číslo, dostal ${String(ticks)}`);
  }
  const roundtripAt = options.roundtripAt ?? null;
  if (roundtripAt !== null && (!Number.isSafeInteger(roundtripAt) || roundtripAt < 0 || roundtripAt >= ticks)) {
    throw new SimrunError(`roundtripAt musí byť celé číslo 0…${String(ticks - 1)}, dostal ${String(roundtripAt)}`);
  }
  const entries = parseCommands(scenario);
  let world = World.create(defs, resolveMap(scenario), scenario.seed);
  let roundtripDone = false;

  const tally: EventTally = {
    shipsSpawned: 0,
    shipsDeparted: 0,
    craneCycles: 0,
    jobsDone: 0,
    noStorageEvents: 0,
    trucksSpawned: 0,
    trucksExited: 0,
    unitsExportedByTrucks: 0,
    noWaitingBayEvents: 0,
    contractsCompleted: 0,
    contractsOnTime: 0,
    contractsOffered: 0,
    contractsAccepted: 0,
    contractsFailed: 0,
    contractsExpired: 0,
    penaltiesCents: 0,
    revenueCents: 0,
    maintenanceCents: 0,
    wagesCents: 0,
    rolledUnits: 0,
    vgmHolds: 0,
    dualCycles: 0,
    unitsLoaded: 0,
    stowageOrderViolations: 0,
    truckUnloads: 0,
    dualTransactions: 0,
    emptyReturns: 0,
    emptyFallbackStored: 0,
    emptyDamaged: 0,
    emptyRepaired: 0,
    repairCostCents: 0,
    emptyPickedUp: 0,
    emptyPickupMisses: 0,
    repositionedUnits: 0,
    transhipLoaded: 0,
    transhipMissed: 0,
    transhipRescued: 0,
    transhipSold: 0,
    emptyReturnsDeclined: 0,
    groupingShareSum: 0,
    groupingShareCount: 0,
  };
  const vehicleTicks = { activeTicks: 0, totalTicks: 0 };
  const loadedDirections: LoadedDirections = new Map();
  let ticksToAllStored: number | null = null;
  let ticksToAllExported: number | null = null;
  let gateQueueMax = 0;
  let next = 0;
  for (let i = 0; i < ticks; i++) {
    if (!roundtripDone && world.clock.tick === roundtripAt) {
      world = roundtripWorld(world, defs);
      roundtripDone = true;
    }
    const tick = world.clock.tick;
    while (next < entries.length && entries[next].atTick === tick) {
      world.enqueue(entries[next].command);
      next += 1;
    }
    const applied = world.applyPending();
    tallyEvents(tally, applied);
    const rejected = applied.filter((event) => event.type === 'CommandRejected');
    if (rejected.length > 0) {
      const what = rejected.map((event) => `${event.commandType}: ${event.reasons.join(', ')}`).join('; ');
      throw new SimrunError(`${scenario.id}: príkaz odmietnutý pri atTick ${String(tick)} — ${what}`);
    }
    const ticked = world.tick();
    tallyEvents(tally, ticked);
    tallyGrouping(tally, world, ticked);
    tallyShipped(tally, loadedDirections, world, ticked);
    tallyVehicleTicks(world, vehicleTicks);
    if (ticksToAllStored === null && tally.shipsSpawned > 0 && isAllStored(world)) ticksToAllStored = world.clock.tick;
    gateQueueMax = Math.max(gateQueueMax, totalGateQueue(world));
    if (ticksToAllExported === null && tally.shipsSpawned > 0 && isAllExported(world)) ticksToAllExported = world.clock.tick;
  }
  if (roundtripAt !== null && !roundtripDone) {
    throw new SimrunError(`${scenario.id}: roundtrip v ticku ${String(roundtripAt)} nenastal — hodiny sa zastavili v ticku ${String(world.clock.tick)} (koniec hry)`);
  }

  return {
    scenario: scenario.id,
    seed: scenario.seed,
    ticks: world.clock.tick,
    gameDays: world.clock.gameDay,
    cashEnd: world.cashCents,
    exportedUnits: world.cargo.exportedCount,
    lostUnits: world.cargo.createdCount - (world.cargo.liveCount + world.cargo.exportedCount + world.cargo.shippedCount),
    onTimeRate: tally.contractsCompleted === 0 ? null : tally.contractsOnTime / tally.contractsCompleted,
    craneBlockedPct: craneBlockedPercent(craneModules(world)),
    roads: countRoads(world),
    commandsApplied: next,
    commandsSkipped: entries.length - next,
    modules: world.modules.size,
    shipsSpawned: tally.shipsSpawned,
    shipsDeparted: tally.shipsDeparted,
    unitsOnApron: world.cargo.countByKind('on_apron'),
    craneCycles: tally.craneCycles,
    vehicles: world.vehicles.size,
    unitsInStorage: world.cargo.countByKind('in_storage'),
    jobsDone: tally.jobsDone,
    vehicleUtilPct: vehicleUtilPercent(vehicleTicks),
    noStorageEvents: tally.noStorageEvents,
    ticksToAllStored,
    trucksSpawned: tally.trucksSpawned,
    trucksExited: tally.trucksExited,
    unitsExportedByTrucks: tally.unitsExportedByTrucks,
    noWaitingBayEvents: tally.noWaitingBayEvents,
    gateQueueMax,
    ticksToAllExported,
    contractsCompleted: world.completedContracts,
    xp: world.xp,
    contractsOffered: tally.contractsOffered,
    contractsAccepted: tally.contractsAccepted,
    contractsFailed: tally.contractsFailed,
    contractsExpired: tally.contractsExpired,
    penaltiesCents: tally.penaltiesCents,
    revenueCents: tally.revenueCents,
    maintenanceCents: tally.maintenanceCents,
    wagesCents: tally.wagesCents,
    tier: world.tier,
    gameOver: world.gameOver,
    stateHash: options.hash === true ? stateHash(world) : null,
    shippedUnits: world.cargo.shippedCount,
    rolledUnits: tally.rolledUnits,
    returnedUnits: returnedUnits(world),
    vgmHolds: tally.vgmHolds,
    dualCycleRate: ratioOrNull(tally.dualCycles, tally.craneCycles + tally.unitsLoaded - tally.dualCycles),
    dualTransactionRate: ratioOrNull(tally.dualTransactions, tally.truckUnloads),
    stowageOrderViolations: tally.stowageOrderViolations,
    exportGroupingPct:
      tally.groupingShareCount === 0 ? null : Math.round((tally.groupingShareSum / tally.groupingShareCount) * PERCENT * ONE_DECIMAL) / ONE_DECIMAL,
    craneWaitForVehicleTicks: craneModules(world).reduce((sum, crane) => sum + crane.waitForVehicleTicks, 0),
    vehicleWaitUnderCraneTicks: craneModules(world).reduce((sum, crane) => sum + crane.vehicleWaitTicks, 0),
    emptyReturns: tally.emptyReturns,
    emptyFallbackStored: tally.emptyFallbackStored,
    emptyDamaged: tally.emptyDamaged,
    emptyRepaired: tally.emptyRepaired,
    repairCostCents: tally.repairCostCents,
    emptyPickedUp: tally.emptyPickedUp,
    emptyPickupMisses: tally.emptyPickupMisses,
    repositionedUnits: tally.repositionedUnits,
    transhipLoaded: tally.transhipLoaded,
    transhipMissed: tally.transhipMissed,
    transhipRescued: tally.transhipRescued,
    transhipSold: tally.transhipSold,
    emptyReturnsDeclined: tally.emptyReturnsDeclined,
  };
}

/** Jednoriadkové ľudské zhrnutie (výstup bez `--report`); s `--hash` končí „hash stavu <8 hex>". */
export function formatSummary(report: SimrunReport): string {
  const metric = (value: number | null): string => (value === null ? 'n/a' : String(value));
  return (
    `simrun ${report.scenario}: seed ${String(report.seed)}, ${String(report.ticks)} tickov ` +
    `(${String(report.gameDays)} dní), cash ${String(report.cashEnd)}, exportované ${String(report.exportedUnits)}, ` +
    `stratené ${String(report.lostUnits)}, on-time ${metric(report.onTimeRate)}, žeriav blokovaný ${metric(report.craneBlockedPct)}, ` +
    `cesty ${String(report.roads)}, príkazy ${String(report.commandsApplied)} (preskočené ${String(report.commandsSkipped)}), ` +
    `moduly ${String(report.modules)}, lode ${String(report.shipsSpawned)}/${String(report.shipsDeparted)} (spawn/odchod), ` +
    `na aprone ${String(report.unitsOnApron)}, cykly žeriavov ${String(report.craneCycles)}, ` +
    `vozidlá ${String(report.vehicles)}, v sklade ${String(report.unitsInStorage)}, joby hotové ${String(report.jobsDone)}, ` +
    `využitie vozidiel ${String(report.vehicleUtilPct)} %, bez skladu ${String(report.noStorageEvents)}, ` +
    `všetko uložené ${metric(report.ticksToAllStored)}, ` +
    `kamióny ${String(report.trucksSpawned)}/${String(report.trucksExited)} (spawn/odchod), ` +
    `odvezené kamiónmi ${String(report.unitsExportedByTrucks)}, bez stojiska ${String(report.noWaitingBayEvents)}, ` +
    `fronta brány max ${String(report.gateQueueMax)}, všetko exportované ${metric(report.ticksToAllExported)}, ` +
    `kontrakty dokončené ${String(report.contractsCompleted)}, XP ${String(report.xp)}, ` +
    `kontrakty ponúknuté/prijaté/zlyhané/zaniknuté ${String(report.contractsOffered)}/${String(report.contractsAccepted)}/` +
    `${String(report.contractsFailed)}/${String(report.contractsExpired)}, tier ${String(report.tier)}, ` +
    `tržby ${String(report.revenueCents)}, penalizácie ${String(report.penaltiesCents)}, ` +
    `údržba ${String(report.maintenanceCents)}, mzdy ${String(report.wagesCents)}, koniec hry ${report.gameOver ? 'áno' : 'nie'}, ` +
    `odplávané ${String(report.shippedUnits)}, rolled ${String(report.rolledUnits)}, vrátené ${String(report.returnedUnits)}, VGM hold ${String(report.vgmHolds)}, ` +
    `dual cycle ${metric(report.dualCycleRate)}, dual transaction ${metric(report.dualTransactionRate)}, mimo poradia ${String(report.stowageOrderViolations)}, ` +
    `zoskupenie exportu ${metric(report.exportGroupingPct)}, žeriav čaká ${String(report.craneWaitForVehicleTicks)}, vozidlo čaká ${String(report.vehicleWaitUnderCraneTicks)}, ` +
    `prázdne vrátené/záložné/poškodené/opravené ${String(report.emptyReturns)}/${String(report.emptyFallbackStored)}/${String(report.emptyDamaged)}/${String(report.emptyRepaired)}, ` +
    `opravy ${String(report.repairCostCents)}, prázdne vydané/zmeškané ${String(report.emptyPickedUp)}/${String(report.emptyPickupMisses)}, ` +
    `repositioning ${String(report.repositionedUnits)}, prekládka naložená/zmeškaná/zachránená/predaná ${String(report.transhipLoaded)}/${String(report.transhipMissed)}/` +
    `${String(report.transhipRescued)}/${String(report.transhipSold)}, návraty prázdnych zahodené ${String(report.emptyReturnsDeclined)}` +
    (report.stateHash === null ? '' : `, hash stavu ${report.stateHash}`)
  );
}

function main(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv);
    const report = runScenario(loadScenario(args.scenarioPath), args.ticks, loadBundledDefs(), {
      hash: args.hash,
      roundtripAt: args.roundtripAt,
    });
    // S `--report` ide na stdout IBA JSON (parsovateľný `JSON.parse`), inak jedno riadkové zhrnutie.
    console.log(args.report ? JSON.stringify(report, null, 2) : formatSummary(report));
    return 0;
  } catch (cause) {
    console.error(`simrun: ${errorMessage(cause)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode namiesto process.exit(): stdout sa pri rúre stihne vyprázdniť.
  process.exitCode = main(process.argv.slice(2));
}
