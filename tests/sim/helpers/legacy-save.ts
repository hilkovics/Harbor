/**
 * „Zhodenie" aktuálneho `WorldState` v7 na tvar v6 (T6A-01, ADR-032) — presný opak migrácie v6 → v7 pre testy a generátor
 * fixtures starších savov. Svet nesmie používať nič z F6a (export, voyage s viacerými kontraktmi, lashing, delivery
 * kamión, nakládka žeriavu): v6 by to nevedel zapísať, preto je to chyba. Odstránené kľúče nemenia relatívne poradie
 * ostatných, takže výsledok má presne poradie kľúčov natívneho v6 `serialize()`.
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

/** Stav v7 (`World.serialize()` alebo jeho JSON kópia) → stav v6 (nová kópia). */
export function toV6State(state: unknown): Json {
  const v7 = clone(state) as Json;
  if (v7['version'] !== 7) fail(`verziu ${String(v7['version'])} (čaká sa 7)`);
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
