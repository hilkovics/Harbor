/**
 * Parsovanie knihy kontraktov vo `WorldState` v5 (ADR-026), v7 (ADR-032) a v8 (ADR-034): `contracts` (kontrakty okrem expirovaných
 * vzostupne podľa id, `Contract.toState()`), `xp`, `completedContracts`, `nextContractId` (vlastná postupnosť id
 * kontraktov) a `nextVoyageId` (postupnosť id voyage). Fail-fast `WorldStateError` s JSON pointerom pod `/contracts/<i>/…`.
 *
 * v7: známy `kind`, `voyageId` celé 1 … `nextVoyageId − 1`, `booking` `null` pri importe a pri exporte objekt s presnými
 * kľúčmi `SERIALIZED_BOOKING_KEYS` (neprázdny `destinationPort`, `cutoffTick` `null` alebo celé ≥ 0, plán príchodov
 * a rolled id ako polia celých čísel, počítadlá celé ≥ 0); súlad bookingu so stavom overí `Contract.fromState`.
 *
 * v8: `lineId` je linka z `lines.json`; `booking` majú export-podobné druhy (`CONTRACT_KIND_TRAITS`: export, repositioning,
 * tranship), `tranship` (plán lode B: `outVoyageId` menšie ako `nextVoyageId`, ticky a loď `null` alebo celé) len prekládka.
 *
 * Tvar: presné kľúče `SERIALIZED_CONTRACT_KEYS`, id celé ≥ 1, ostro rastúce a < `nextContractId`, známa šablóna, typ nákladu
 * a trieda lode, celé čísla (odmena, objem, SLA, ticky, počítadlá), `xpReward` konečné ≥ 0, známy stav, voliteľné polia
 * `null` alebo celé ≥ 0. Časy nie v budúcnosti (`offeredTick`, `acceptedTick`, `dockedTick`, `closedTick` ≤ `clock.tick`)
 * a nič, čo by krok 2 už vybavil: ponuka zanikne až v uzávierke dňa po `offerExpiresTick` (`offerClosingTick >
 * clock.tick`), prijatý kontrakt má `shipArrivalTick > clock.tick`. Súlad polí so stavom a počítadlá overí `Contract.fromState` (`ContractError` → `WorldStateError`); väzby
 * na lode a náklad overí obnova (`checkContracts` vo world-restore).
 */
import type { ContractBookState } from '../contracts/contract-book';
import {
  SERIALIZED_BOOKING_KEYS,
  SERIALIZED_CONTRACT_KEYS,
  SERIALIZED_TRANSHIP_KEYS,
  Contract,
  type SerializedBooking,
  type SerializedContract,
  type SerializedTranship,
} from '../contracts/contract';
import { ContractError } from '../contracts/contract-error';
import { CONTRACT_KINDS, CONTRACT_KIND_TRAITS, isContractKind, isContractState } from '../contracts/contract-fsm';
import { offerClosingTick } from '../contracts/contract-terms';
import type { SimClock } from '../core/sim-clock';
import type { DefRegistry } from '../defs/def-registry';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, pointerSegment } from './state-check';

/** Polia kontraktu, ktoré sú celé čísla ≥ 0 (okrem id). */
const COUNT_FIELDS = ['volumeUnits', 'slaDays', 'rewardCents', 'offeredTick', 'offerExpiresTick', 'unitsUnloaded', 'unitsExported', 'penaltiesCents', 'demurrageHours', 'lateDays'] as const;
/** Voliteľné polia (v save `null` alebo celé ≥ 0). */
const NULLABLE_FIELDS = ['acceptedTick', 'shipArrivalTick', 'slaDeadlineTick', 'shipId', 'dockedTick', 'closedTick'] as const;
/** Časy, ktoré nesmú byť v budúcnosti. */
const PAST_FIELDS = ['offeredTick', 'acceptedTick', 'dockedTick', 'closedTick'] as const;

function checkString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new WorldStateError(path, `musí byť reťazec, dostal ${describeValue(value)}`);
  return value;
}

function checkKnown(id: string, has: (id: string) => boolean, what: string, path: string): string {
  if (!has(id)) throw new WorldStateError(path, `neznáma ${what} '${id}'`);
  return id;
}

/** Pole celých čísel ≥ `min` (plán príchodov, rolled id); poradie overí `Contract.fromState`. */
function checkIntegerList(value: unknown, min: number, path: string): number[] {
  return checkArray(value, path).map((raw: unknown, i) => checkInteger(raw, min, `${path}${pointerSegment(i)}`));
}

/** Booking export kontraktu (tvar a typy, v7). */
function parseBooking(raw: unknown, path: string): SerializedBooking {
  const entry = checkKeys(raw, SERIALIZED_BOOKING_KEYS, path);
  const destinationPort = checkString(entry['destinationPort'], `${path}/destinationPort`);
  if (destinationPort.length === 0) throw new WorldStateError(`${path}/destinationPort`, 'cieľový prístav nesmie byť prázdny');
  const cutoff = entry['cutoffTick'];
  return {
    destinationPort,
    cutoffTick: cutoff === null ? null : checkInteger(cutoff, 0, `${path}/cutoffTick`),
    arrivalPlan: checkIntegerList(entry['arrivalPlan'], 0, `${path}/arrivalPlan`),
    arrivedUnits: checkInteger(entry['arrivedUnits'], 0, `${path}/arrivedUnits`),
    loadedUnits: checkInteger(entry['loadedUnits'], 0, `${path}/loadedUnits`),
    lastMinuteUnits: checkInteger(entry['lastMinuteUnits'], 0, `${path}/lastMinuteUnits`),
    rolledUnitIds: checkIntegerList(entry['rolledUnitIds'], 1, `${path}/rolledUnitIds`),
    heldUnits: checkInteger(entry['heldUnits'], 0, `${path}/heldUnits`),
  };
}

/** Plán lode B prekládky (tvar a typy, v8); súlad so stavom overí `TranshipContract.restore`. */
function parseTranship(raw: unknown, nextVoyageId: number, path: string): SerializedTranship {
  const entry = checkKeys(raw, SERIALIZED_TRANSHIP_KEYS, path);
  const outVoyageId = checkInteger(entry['outVoyageId'], 1, `${path}/outVoyageId`);
  if (outVoyageId >= nextVoyageId) throw new WorldStateError(`${path}/outVoyageId`, `voyage ${String(outVoyageId)} nepridelila kniha kontraktov (nextVoyageId ${String(nextVoyageId)})`);
  const nullable = (field: 'outArrivalTick' | 'outShipId' | 'rescueDeadlineTick'): number | null =>
    entry[field] === null ? null : checkInteger(entry[field], field === 'outShipId' ? 1 : 0, `${path}/${field}`);
  return { outVoyageId, outArrivalTick: nullable('outArrivalTick'), outShipId: nullable('outShipId'), rescueDeadlineTick: nullable('rescueDeadlineTick') };
}

/** Jeden kontrakt zo save (tvar a typy); súlad so stavom overí `Contract.fromState`. */
function parseContract(raw: unknown, defs: DefRegistry, clockTick: number, ticksPerDay: number, minId: number, nextId: number, nextVoyageId: number, path: string): SerializedContract {
  const entry = checkKeys(raw, SERIALIZED_CONTRACT_KEYS, path);
  const id = checkInteger(entry['id'], minId, `${path}/id`);
  if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} nepridelila kniha kontraktov (nextContractId ${String(nextId)})`);
  const counts = Object.fromEntries(COUNT_FIELDS.map((field) => [field, checkInteger(entry[field], 0, `${path}/${field}`)])) as Record<(typeof COUNT_FIELDS)[number], number>;
  const nullable = Object.fromEntries(
    NULLABLE_FIELDS.map((field) => [field, entry[field] === null ? null : checkInteger(entry[field], 0, `${path}/${field}`)]),
  ) as Record<(typeof NULLABLE_FIELDS)[number], number | null>;
  const xpReward = entry['xpReward'];
  if (typeof xpReward !== 'number' || !Number.isFinite(xpReward) || xpReward < 0) {
    throw new WorldStateError(`${path}/xpReward`, `musí byť konečné číslo ≥ 0, dostal ${describeValue(xpReward)}`);
  }
  const state = entry['state'];
  if (!isContractState(state)) throw new WorldStateError(`${path}/state`, `neznámy stav ${describeValue(state)}`);
  const kind = entry['kind'];
  if (!isContractKind(kind)) throw new WorldStateError(`${path}/kind`, `druh musí byť jeden z: ${CONTRACT_KINDS.join(', ')}, dostal ${describeValue(kind)}`);
  const voyageId = checkInteger(entry['voyageId'], 1, `${path}/voyageId`);
  if (voyageId >= nextVoyageId) throw new WorldStateError(`${path}/voyageId`, `voyage ${String(voyageId)} nepridelila kniha kontraktov (nextVoyageId ${String(nextVoyageId)})`);
  const traits = CONTRACT_KIND_TRAITS[kind];
  const rawBooking = entry['booking'];
  const booking = rawBooking === null ? null : parseBooking(rawBooking, `${path}/booking`);
  if (traits.booking !== (booking !== null)) {
    throw new WorldStateError(`${path}/booking`, traits.booking ? `kontrakt druhu '${kind}' musí mať booking` : `kontrakt druhu '${kind}' nemá booking (null)`);
  }
  const rawTranship = entry['tranship'];
  const tranship = rawTranship === null ? null : parseTranship(rawTranship, nextVoyageId, `${path}/tranship`);
  if (traits.tranship !== (tranship !== null)) {
    throw new WorldStateError(`${path}/tranship`, traits.tranship ? `kontrakt druhu '${kind}' musí mať plán lode B (tranship)` : `kontrakt druhu '${kind}' nemá plán lode B (null)`);
  }
  const contract: SerializedContract = {
    id,
    kind,
    voyageId,
    lineId: checkKnown(checkString(entry['lineId'], `${path}/lineId`), (value) => defs.lines.has(value), 'linka', `${path}/lineId`),
    templateId: checkKnown(checkString(entry['templateId'], `${path}/templateId`), (value) => defs.contractTemplates.has(value), 'šablóna kontraktu', `${path}/templateId`),
    cargoTypeId: checkKnown(checkString(entry['cargoTypeId'], `${path}/cargoTypeId`), (value) => defs.cargoTypes.has(value), 'typ nákladu', `${path}/cargoTypeId`),
    shipClassId: checkKnown(checkString(entry['shipClassId'], `${path}/shipClassId`), (value) => defs.ships.has(value), 'trieda lode', `${path}/shipClassId`),
    xpReward,
    state,
    ...counts,
    ...nullable,
    booking,
    tranship,
  };
  for (const field of PAST_FIELDS) {
    const tick = contract[field];
    if (tick !== null && tick > clockTick) throw new WorldStateError(`${path}/${field}`, `tick ${String(tick)} je v budúcnosti (clock ${String(clockTick)})`);
  }
  if (state === 'offered' && offerClosingTick(contract.offerExpiresTick, ticksPerDay) <= clockTick) {
    throw new WorldStateError(`${path}/offerExpiresTick`, `ponuka mala zaniknúť v uzávierke dňa po ticku ${String(contract.offerExpiresTick)} (clock ${String(clockTick)})`);
  }
  if (state === 'accepted' && contract.shipArrivalTick !== null && contract.shipArrivalTick <= clockTick) {
    throw new WorldStateError(`${path}/shipArrivalTick`, `loď mala priplávať v ticku ${String(contract.shipArrivalTick)} (clock ${String(clockTick)})`);
  }
  try {
    Contract.fromState(contract);
  } catch (error) {
    if (error instanceof ContractError) throw new WorldStateError(path, error.message);
    throw error;
  }
  return contract;
}

/** Overí `contracts`, `xp`, `completedContracts` a postupnosti id (viď hlavička súboru). Výsledok nezdieľa objekty so vstupom. */
export function parseContractsState(state: Readonly<Record<string, unknown>>, defs: DefRegistry, clock: Pick<SimClock, 'tick' | 'ticksPerDay'>): ContractBookState {
  const nextId = checkInteger(state['nextContractId'], 1, '/nextContractId');
  const nextVoyageId = checkInteger(state['nextVoyageId'], 1, '/nextVoyageId');
  let minId = 1;
  const contracts = checkArray(state['contracts'], '/contracts').map((raw: unknown, i) => {
    const contract = parseContract(raw, defs, clock.tick, clock.ticksPerDay, minId, nextId, nextVoyageId, `/contracts${pointerSegment(i)}`);
    minId = contract.id + 1;
    return contract;
  });
  return {
    contracts,
    xp: checkInteger(state['xp'], 0, '/xp'),
    completedContracts: checkInteger(state['completedContracts'], 0, '/completedContracts'),
    nextContractId: nextId,
    nextVoyageId,
  };
}
