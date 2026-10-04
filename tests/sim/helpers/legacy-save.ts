/**
 * „Zhodenie" aktuálneho `WorldState` na tvar v8 (`toV8State`, T6D-01 + T6D-03, ADR-035, ADR-029 dodatok), v7 (`toV7State`, T6C-01, ADR-034) a v6
 * (`toV6State`, T6A-01, ADR-032) — presný opak migrácií v8 → v9, v7 → v8 a v6 → v7 pre testy a generátor fixtures starších savov. Svet nesmie používať nič z F6c (prázdne
 * kontajnery, repositioning, prekládka, plán `emptyFlow`) ani F6a (export, voyage s viacerými kontraktmi, lashing, delivery
 * kamión, nakládka žeriavu): starší tvar by to nevedel zapísať, preto je to chyba. Odstránené kľúče nemenia relatívne poradie
 * ostatných, takže výsledok má presne poradie kľúčov natívneho `serialize()` starej verzie. Linky (`lineId`) sa zahadzujú
 * bez kontroly (v7 ich nepozná a migrácia ich nastaví na prvú linku).
 */
import { DEFS } from '../world/world-fixtures';

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function without(entry: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(entry)) if (!keys.includes(key)) out[key] = value;
  return out;
}

function fail(what: string): never {
  throw new Error(`toV6State: v6 nevie zapísať ${what}`);
}

/**
 * Stav v9 (`World.serialize()` alebo jeho JSON kópia) → stav v8 (nová kópia): bez poľa `hinterland` (T6D-01). Počítadlá vnútrozemia sa zahodia — len ich číta UI
 * a `simrun`, správanie sveta neovplyvňujú (plány kamiónov, ktoré v8 pozná, ostávajú), takže zhodenie nie je stratové pre nič, čo v8 vie zapísať.
 * Lode s rejdou zostanú, ako sú (T6D-03 zmenila len význam `anchorageIndex` a trás lodí) — pri načítaní ich normalizuje parser (`legacyAnchorage`).
 */
export function toV8State(state: unknown): Json {
  const v9 = clone(state) as Json;
  if (v9['version'] !== 9) fail(`verziu ${String(v9['version'])} (čaká sa 9, toV8State)`);
  return { ...without(v9, ['hinterland']), version: 8 };
}

/** Stav v9 alebo v8 (`World.serialize()` alebo jeho JSON kópia; v9 sa najprv zhodí cez `toV8State`) → stav v7 (nová kópia). */
export function toV7State(state: unknown): Json {
  const given = clone(state) as Json;
  const v8 = given['version'] === 9 ? toV8State(given) : given;
  if (v8['version'] !== 8) fail(`verziu ${String(v8['version'])} (čaká sa 8 alebo 9, toV7State)`);
  const flow = v8['emptyFlow'] as { returnPlan: unknown[]; pickupPlan: unknown[]; errands: unknown[] };
  if (flow.returnPlan.length > 0 || flow.pickupPlan.length > 0 || flow.errands.length > 0) fail('plán prázdnych kontajnerov (emptyFlow)');
  const contracts = (v8['contracts'] as Json[]).map((contract) => {
    if ((contract['kind'] !== 'import' && contract['kind'] !== 'export') || contract['tranship'] !== null) fail(`kontrakt #${String(contract['id'])} druhu ${String(contract['kind'])} (F6c)`);
    return without(contract, ['lineId', 'tranship']);
  });
  const cargo = v8['cargo'] as Json;
  const units = (cargo['units'] as Json[]).map((unit) => {
    if ((unit['direction'] !== 'import' && unit['direction'] !== 'export') || unit['status'] !== 'available' || unit['repairUntilTick'] !== null) {
      fail(`jednotku #${String(unit['id'])} smeru ${String(unit['direction'])} alebo s iným stavom kvality (F6c)`);
    }
    return without(unit, ['lineId', 'status', 'repairUntilTick']);
  });
  return { ...without(v8, ['emptyFlow']), version: 7, contracts, cargo: { ...cargo, units } };
}

/** Stav v7, v8 alebo v9 (`World.serialize()` alebo jeho JSON kópia; v8 a v9 sa najprv zhodia cez `toV7State`) → stav v6 (nová kópia). */
export function toV6State(state: unknown): Json {
  const given = clone(state) as Json;
  const v7 = given['version'] === 8 || given['version'] === 9 ? toV7State(given) : given;
  if (v7['version'] !== 7) fail(`verziu ${String(v7['version'])} (čaká sa 7, 8 alebo 9)`);
  const contracts = v7['contracts'] as Json[];
  for (const contract of contracts) {
    if (contract['kind'] !== 'import' || contract['booking'] !== null || contract['voyageId'] !== contract['id']) fail(`kontrakt #${String(contract['id'])} (export alebo voyage ≠ id)`);
  }
  const cargo = v7['cargo'] as Json;
  if (cargo['shippedCount'] !== 0) fail('odplávané jednotky (shippedCount > 0)');
  const units = (cargo['units'] as Json[]).map((unit) => {
    if (unit['direction'] !== 'import' || unit['hold'] !== null || unit['weightClass'] !== 'medium' || unit['voyageId'] !== unit['contractId']) {
      fail(`jednotku #${String(unit['id'])} so štítkami exportu`);
    }
    return without(unit, ['voyageId', 'direction', 'destinationPort', 'weightClass', 'hold']);
  });
  const ships = (v7['ships'] as Json[]).map((ship) => {
    if (ship['lashingTicksLeft'] !== 0) fail(`loď #${String(ship['id'])} v lashingu`);
    return without(ship, ['lashingTicksLeft']);
  });
  const trucks = (v7['trucks'] as Json[]).map((truck) => {
    if (truck['mission'] !== 'pickup') fail(`delivery kamión #${String(truck['id'])}`);
    return without(truck, ['mission']);
  });
  const modules = (v7['modules'] as Json[]).map((entry) => {
    if (DEFS.modules.get(entry['defId'] as string).kind !== 'crane') return entry;
    const runtime = entry['runtime'] as Json;
    if (runtime['cycle'] !== 'unload' || runtime['targetUnitId'] !== null || runtime['dualUnitId'] !== null) fail(`žeriav #${String(entry['id'])} pri nakládke`);
    if (runtime['waitForVehicleTicks'] !== 0 || runtime['vehicleWaitTicks'] !== 0) fail(`žeriav #${String(entry['id'])} s čakaním na vozidlo (pod hákom)`);
    return { ...entry, runtime: without(runtime, ['cycle', 'targetUnitId', 'dualUnitId', 'waitForVehicleTicks', 'vehicleWaitTicks']) };
  });
  const v6 = without(v7, ['nextVoyageId']);
  return {
    ...v6,
    version: 6,
    modules,
    cargo: { ...without(cargo, ['shippedCount']), units },
    ships,
    trucks,
    contracts: contracts.map((contract) => without(contract, ['kind', 'voyageId', 'booking'])),
  };
}
