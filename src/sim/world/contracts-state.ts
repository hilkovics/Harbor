/**
 * Parsovanie knihy kontraktov vo `WorldState` v5 (ADR-026): `contracts` (kontrakty okrem expirovaných vzostupne podľa id,
 * `Contract.toState()`), `xp`, `completedContracts` a `nextContractId` (vlastná postupnosť id kontraktov). Fail-fast `WorldStateError` s JSON pointerom pod `/contracts/<i>/…`.
 *
 * Tvar: presné kľúče `SERIALIZED_CONTRACT_KEYS`, id celé ≥ 1, ostro rastúce a < `nextContractId`, známa šablóna, typ nákladu
 * a trieda lode, celé čísla (odmena, objem, SLA, ticky, počítadlá), `xpReward` konečné ≥ 0, známy stav, voliteľné polia
 * `null` alebo celé ≥ 0. Časy nie v budúcnosti (`offeredTick`, `acceptedTick`, `dockedTick`, `closedTick` ≤ `clock.tick`)
 * a nič, čo by krok 2 už vybavil: ponuka zanikne až v uzávierke dňa po `offerExpiresTick` (`offerClosingTick >
 * clock.tick`), prijatý kontrakt má `shipArrivalTick > clock.tick`. Súlad polí so stavom a počítadlá overí `Contract.fromState` (`ContractError` → `WorldStateError`); väzby
 * na lode a náklad overí obnova (`checkContracts` vo world-restore).
 */
import type { ContractBookState } from '../contracts/contract-book';
import { SERIALIZED_CONTRACT_KEYS, Contract, type SerializedContract } from '../contracts/contract';
import { ContractError } from '../contracts/contract-error';
import { isContractState } from '../contracts/contract-fsm';
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

/** Jeden kontrakt zo save (tvar a typy); súlad so stavom overí `Contract.fromState`. */
function parseContract(raw: unknown, defs: DefRegistry, clockTick: number, ticksPerDay: number, minId: number, nextId: number, path: string): SerializedContract {
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
  const contract: SerializedContract = {
    id,
    templateId: checkKnown(checkString(entry['templateId'], `${path}/templateId`), (value) => defs.contractTemplates.has(value), 'šablóna kontraktu', `${path}/templateId`),
    cargoTypeId: checkKnown(checkString(entry['cargoTypeId'], `${path}/cargoTypeId`), (value) => defs.cargoTypes.has(value), 'typ nákladu', `${path}/cargoTypeId`),
    shipClassId: checkKnown(checkString(entry['shipClassId'], `${path}/shipClassId`), (value) => defs.ships.has(value), 'trieda lode', `${path}/shipClassId`),
    xpReward,
    state,
    ...counts,
    ...nullable,
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

/** Overí `contracts`, `xp` a `completedContracts` stavu v5 (viď hlavička súboru). Výsledok nezdieľa objekty so vstupom. */
export function parseContractsState(state: Readonly<Record<string, unknown>>, defs: DefRegistry, clock: Pick<SimClock, 'tick' | 'ticksPerDay'>): ContractBookState {
  const nextId = checkInteger(state['nextContractId'], 1, '/nextContractId');
  let minId = 1;
  const contracts = checkArray(state['contracts'], '/contracts').map((raw: unknown, i) => {
    const contract = parseContract(raw, defs, clock.tick, clock.ticksPerDay, minId, nextId, `/contracts${pointerSegment(i)}`);
    minId = contract.id + 1;
    return contract;
  });
  return {
    contracts,
    xp: checkInteger(state['xp'], 0, '/xp'),
    completedContracts: checkInteger(state['completedContracts'], 0, '/completedContracts'),
    nextContractId: nextId,
  };
}
