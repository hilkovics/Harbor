/**
 * Brána pre kamióny s exportom (F6a, ADR-032 bod 7; krok 8): kontrola dokladov je prechod bránou (`processTicks`, FIFO
 * fronta ako pri importe); po prechode **dnu** kamión s misiou `delivery` prijme booking jednotku:
 * 1. `Contract.recordArrival(unit, rolled)` — `arrivedUnits += 1`, po cut-off (`tick > cutoffTick`) aj `rolled`;
 * 2. `ExportArrived`, pri rolled `UnitRolled`;
 * 3. `Rng.chance(exportFlow.vgmMissingChance)` — chýbajúce VGM: `CargoLedger.setHold({ reason: 'vgm', untilTick: tick +
 *    round(vgmHoldHours × ticksPerHour) })`, `heldUnits += 1`, index `HoldIndex`, `VgmHoldStarted`. Jednotka v hold sa
 *    nenakladá na loď; hold sa uvoľní sám (krok 2, `ContractSystem`).
 * Hook platí pre prechod z fronty dnu aj pre urovnanie fronty po zmene siete (kamión „ide ďalej bez prechodu"), takže
 * každá jednotka, ktorá vstúpi na terminál, je zaregistrovaná práve raz. Misia sa vyberá tabuľkou (pravidlo 7) — pickup
 * kamión bránou nič neregistruje.
 */
import type { World } from '../world/world';
import type { Truck } from './truck';
import { TRUCK_STATE_TRAITS, type TruckMission } from './truck-fsm';

/** Kamión s exportom prešiel bránou dnu: registrácia jednotky, rolled a VGM (viď hlavička). */
function registerExport(world: World, truck: Truck): void {
  const unitId = world.cargo.firstUnitAt('in_truck', truck.id);
  const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
  if (unit === undefined || unit.contractId === null) return;
  const contract = world.contractBook.get(unit.contractId);
  if (contract === undefined) return;
  const { tick, ticksPerHour } = world.clock;
  const cutoff = contract.booking?.cutoffTick;
  const rolled = cutoff !== undefined && tick > cutoff;
  contract.recordArrival(unit.id, rolled);
  world.events.emit({ type: 'ExportArrived', contractId: contract.id, unitId: unit.id, truckId: truck.id, gateId: truck.gateId });
  if (rolled) world.events.emit({ type: 'UnitRolled', contractId: contract.id, unitId: unit.id });
  if (!world.rng.chance(world.defs.logistics.exportFlow.vgmMissingChance)) return;
  const untilTick = tick + Math.round(world.defs.logistics.exportFlow.vgmHoldHours * ticksPerHour);
  world.cargo.setHold(unit.id, { reason: 'vgm', untilTick });
  world.holdIndex.add(untilTick, unit.id);
  contract.recordHold(1);
  world.events.emit({ type: 'VgmHoldStarted', contractId: contract.id, unitId: unit.id, untilTick });
}

/** Hook po prechode bránou podľa misie kamióna (tabuľka, nie switch): pickup nič, delivery registruje export. */
const GATE_PASS_HOOKS: { readonly [M in TruckMission]: (world: World, truck: Truck) => void } = Object.freeze({
  pickup: () => undefined,
  delivery: registerExport,
});

/**
 * Kamión vo fronte brány vyšiel na druhú stranu (prechod dokončený alebo fronta urovnaná po zmene siete): volá sa ešte
 * v stave `gate_queue*`. Hook beží len pri vstupe na terminál (vstupná strana brány) — odchod prázdneho kamióna von nič
 * neregistruje.
 */
export function onGatePassed(world: World, truck: Truck): void {
  if (TRUCK_STATE_TRAITS[truck.state].gateSide !== 'entry') return;
  GATE_PASS_HOOKS[truck.mission](world, truck);
}
