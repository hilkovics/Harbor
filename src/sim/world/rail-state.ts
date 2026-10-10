/**
 * Železnica v save (`WorldState.rail` a `WorldState.trains`, v15, ADR-043): tvar (`parseRailState`, `parseTrains`) a obnova vlakov (`restoreTrains`). Vlak sa pri obnove vytvorí z uloženého stavu
 * (trasa, poloha, stav, plán), obsadenie buniek sa odvodí z polohy; vzťahy k svetu (terminál, koľaje trasy, náklad) overí `restoreTrains` a krok 12 (`checkTrains`).
 */
import type { EntityId } from '../core/entity-id';
import type { DefRegistry } from '../defs/def-registry';
import type { Grid } from '../grid/grid';
import { RailTerminal } from '../modules/rail-terminal';
import { RAIL_RUNTIME_KEYS, type RailRuntimeState } from '../rail/rail';
import { MILLI_PER_CELL, SERIALIZED_TRAIN_KEYS, Train, type SerializedTrain } from '../rail/train';
import { TRAIN_STATES, isTrainState } from '../rail/train-fsm';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, pointerSegment } from './state-check';
import type { World } from './world';

/** Tvar súčtov železnice: presne kľúče `RailRuntimeState`, celé čísla ≥ 0. */
export function parseRailState(value: unknown, grid: Grid): RailRuntimeState {
  const raw = checkKeys(value, RAIL_RUNTIME_KEYS, '/rail');
  const field = (key: Exclude<keyof RailRuntimeState, 'crossings'>): number => checkInteger(raw[key], 0, `/rail/${key}`);
  let previous = -1;
  const crossings = checkArray(raw['crossings'], '/rail/crossings').map((cell: unknown, i): number => {
    const path = `/rail/crossings${pointerSegment(i)}`;
    const index = checkInteger(cell, 0, path);
    if (index >= grid.cellCount) throw new WorldStateError(path, `bunka ${String(index)} je mimo mapy`);
    if (index <= previous) throw new WorldStateError(path, `priecestia musia byť ostro vzostupne, ${String(index)} ≤ ${String(previous)}`);
    previous = index;
    return index;
  });
  return {
    nextArrivalTick: field('nextArrivalTick'),
    trainsSpawned: field('trainsSpawned'),
    trainsDeparted: field('trainsDeparted'),
    skippedArrivals: field('skippedArrivals'),
    delayTicksTotal: field('delayTicksTotal'),
    delayTicksMax: field('delayTicksMax'),
    turnaroundTicksTotal: field('turnaroundTicksTotal'),
    turnaroundTicksMax: field('turnaroundTicksMax'),
    importUnitsByTrain: field('importUnitsByTrain'),
    crossings,
  };
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : checkInteger(value, 0, path);
}

/** Tvar vlakov: presne kľúče `SerializedTrain`, id < `ids.nextId` a ostro rastúce, známy stav, trasa (≥ 2 bunky v mape), polohy a plán; vzťahy k svetu overí `restoreTrains`. */
export function parseTrains(value: unknown, defs: DefRegistry, grid: Grid, nextId: number): SerializedTrain[] {
  let previousId = 0;
  return checkArray(value, '/trains').map((raw: unknown, i): SerializedTrain => {
    const path = `/trains${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_TRAIN_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `vlaky musia byť vzostupne podľa id, ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const { state } = entry;
    if (!isTrainState(state)) throw new WorldStateError(`${path}/state`, `stav musí byť jeden z: ${TRAIN_STATES.join(', ')}, dostal ${describeValue(state)}`);
    const route = checkArray(entry['route'], `${path}/route`).map((cell: unknown, c) => {
      const index = checkInteger(cell, 0, `${path}/route${pointerSegment(c)}`);
      if (index >= grid.cellCount) throw new WorldStateError(`${path}/route${pointerSegment(c)}`, `bunka ${String(index)} je mimo mapy`);
      return index;
    });
    if (route.length < 2) throw new WorldStateError(`${path}/route`, 'trasa musí mať aspoň 2 bunky');
    const wagons = checkInteger(entry['wagons'], 1, `${path}/wagons`);
    const posMilli = entry['posMilli'];
    if (typeof posMilli !== 'number' || !Number.isSafeInteger(posMilli)) throw new WorldStateError(`${path}/posMilli`, `musí byť celé číslo, dostal ${describeValue(posMilli)}`);
    const stoppedTick = nullableInteger(entry['stoppedTick'], `${path}/stoppedTick`);
    const departAtTick = nullableInteger(entry['departAtTick'], `${path}/departAtTick`);
    if ((state === 'arriving') !== (stoppedTick === null) || (stoppedTick === null) !== (departAtTick === null)) {
      throw new WorldStateError(`${path}/stoppedTick`, `stav ${state}: stoppedTick a departAtTick sú nastavené práve po zastavení vlaku`);
    }
    const stopMilli = route.length * MILLI_PER_CELL;
    if (posMilli > stopMilli || posMilli < 0) throw new WorldStateError(`${path}/posMilli`, `poloha ${String(posMilli)} je mimo trasy (0 … ${String(stopMilli)})`);
    if (state === 'dwelling' && posMilli !== stopMilli) throw new WorldStateError(`${path}/posMilli`, 'vlak v pobyte stojí na konci trasy');
    return {
      id,
      state,
      route,
      posMilli,
      terminalId: checkInteger(entry['terminalId'], 1, `${path}/terminalId`),
      track: checkInteger(entry['track'], 0, `${path}/track`),
      wagons,
      scheduledTick: checkInteger(entry['scheduledTick'], 0, `${path}/scheduledTick`),
      spawnedTick: checkInteger(entry['spawnedTick'], 0, `${path}/spawnedTick`),
      stoppedTick,
      departAtTick,
    };
  });
}

/** Obnoví vlaky vzostupne podľa id: terminál musí existovať a mať koľaj, žiadne dve vlaky nesmú zdieľať koľaj ani prekrývať bunky. Po obnove modulov, pred kontrolou držiteľov nákladu. */
export function restoreTrains(world: World, entries: readonly SerializedTrain[]): void {
  entries.forEach((entry, index) => {
    const path = `/trains${pointerSegment(index)}`;
    const terminal = world.modules.get(entry.terminalId as EntityId);
    if (!(terminal instanceof RailTerminal)) throw new WorldStateError(`${path}/terminalId`, `modul #${String(entry.terminalId)} nie je železničný terminál`);
    if (entry.track >= terminal.tracks) throw new WorldStateError(`${path}/track`, `terminál #${String(terminal.id)} má ${String(terminal.tracks)} koľají, dostal ${String(entry.track)}`);
    if (world.rail.trackTaken(terminal.id, entry.track)) throw new WorldStateError(`${path}/track`, `koľaj ${String(entry.track)} terminálu #${String(terminal.id)} už obsadzuje iný vlak`);
    const train = new Train({ ...entry, def: world.defs.rail.train });
    const { lo, hi } = train.occupiedRangeAt(train.posMilli);
    for (let i = lo; i <= hi; i++) {
      if (world.rail.occupancy[train.route[i]] !== 0) throw new WorldStateError(`${path}/posMilli`, `${train.label} sa prekrýva s iným vlakom na bunke ${String(train.route[i])}`);
    }
    world.addTrain(train);
  });
}
