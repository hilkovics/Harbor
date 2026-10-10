/**
 * Krok 6e ticku — vlaky (R6, ADR-043; poradie §6 rozšírené o krok 6e za `ReeferSystem`). V každom ticku:
 * 1. **Cestovný poriadok**: keď `tick ≥ rail.nextArrivalTick` a prístav má terminál napojený na koľajový portál (`world.railRoutes`), vznikne vlak na portáli — ak je niektorá koľaj terminálu voľná
 *    a po koľajisku práve nejazdí iný vlak (žetón pohybu). Vlak na prvej voľnej koľaji (vzostupne terminál, koľaj) dostane `rail.json` počet vagónov, privezie jednotky exportu
 *    splatné po koľaji (`loadRailExports`, `Rng` len pri nich) a `TrainArrived` nesie oneskorenie oproti plánu. Bez napojeného terminálu sa plánovaný príchod preskočí (`skippedArrivals`),
 *    `Rng` sa nespotrebuje. Keď príchod nejde (obsadené koľaje, jazdí iný vlak), vlak vznikne v najbližšom ticku, ktorý to dovolí — oneskorenie sa meria.
 * 2. **Jazda** (vlaky vzostupne podľa id): `arriving` ide k zastávke (koniec koľaje), `departing` k portálu; posun o `train.speedMilliCellsPerTick`, bunku pred sebou smie vlak obsadiť,
 *    len ak ju nedrží iný vlak (obsadenie `rail.occupancy`, vlaky sa neprekrývajú, ADR-037). Na zastávke `arriving → dwelling` (`departAtTick = tick + dwell`).
 * 3. **Pobyt**: `dwelling` odíde (`→ departing`) v plánovanom čase (`tick ≥ departAtTick`) alebo keď je plný (všetky miesta obsadené), ak RMG dokončil jeho vykládku (nezostal náklad z príchodu — jednotky
 *    iného smeru než `import` — a RMG nie je v cykle s ním; TR6-02: RMG vykladá a nakladá po vagónoch, `systems/rmg-train-work.ts`) a po koľajisku nejazdí iný vlak. Odchod = po portál (chvost vlaku opustil trasu): jednotky `in_train → exported` (FIFO), `TrainDeparted`, vlak zanikne.
 */
import { crossingsHeld, syncCrossings } from '../rail/rail-crossings';
import { MILLI_PER_CELL, Train } from '../rail/train';
import { loadRailExports } from '../rail/rail-exports';
import { isTrainFull } from '../rail/train-cargo';
import type { World } from '../world/world';
import { machineWorksOnTrain } from './rmg-train-work';

/** Vlak so všetkým nákladom z príchodu vyloženým? (Zostáva len import naložený na odvoz.) */
function hasInboundCargo(world: World, train: Train): boolean {
  for (const unitId of world.cargo.unitsAt('in_train', train.id)) {
    if (world.cargo.get(unitId)?.direction !== 'import') return true;
  }
  return false;
}

/** Vznik vlaka podľa cestovného poriadku (viď hlavička, bod 1); `true`, ak vlak vznikol. */
function trySpawn(world: World): boolean {
  const { rail } = world;
  const { tick } = world.clock;
  const route = world.railRoutes.find((candidate) => !rail.trackTaken(candidate.terminalId, candidate.track));
  if (route === undefined || rail.occupancy[route.cells[0]] !== 0) return false;
  const train = new Train({
    id: world.ids.next(),
    state: 'arriving',
    route: route.cells,
    posMilli: 0,
    terminalId: route.terminalId,
    track: route.track,
    wagons: rail.def.timetable.wagonsPerTrain,
    scheduledTick: rail.nextArrivalTick,
    spawnedTick: tick,
    stoppedTick: null,
    departAtTick: null,
    def: rail.def.train,
  });
  const delayTicks = tick - train.scheduledTick;
  world.addTrain(train);
  rail.advanceSchedule(tick);
  rail.recordSpawn(delayTicks);
  const exportUnits = loadRailExports(world, train);
  world.events.emit({ type: 'TrainArrived', trainId: train.id, terminalId: train.terminalId, delayTicks, exportUnits });
  return true;
}

/** Posun pohyblivého vlaka o jeden tick; `arriving` zastaví na konci trasy, `departing` skončí odchodom cez portál. */
function drive(world: World, train: Train): void {
  const { rail } = world;
  const speed = rail.def.train.speedMilliCellsPerTick;
  if (train.state === 'arriving') {
    const next = Math.min(train.stopMilli, train.posMilli + speed);
    const { hi } = train.occupiedRangeAt(next);
    for (let i = train.occHi + 1; i <= hi; i++) {
      const holder = rail.occupancy[train.route[i]];
      if (holder !== 0 && holder !== train.id) return;
    }
    // Úrovňové priecestie: do jeho bunky vlak vstúpi, len keď drží oba pruhové sloty (vozidlo na priecestí ho zdrží).
    if (!crossingsHeld(world, train, train.occHi + 1, hi)) return;
    train.posMilli = next;
    rail.refreshOccupancy(train);
    if (train.posMilli >= train.stopMilli) {
      const { tick } = world.clock;
      train.transition('dwelling');
      train.stoppedTick = tick;
      train.departAtTick = tick + rail.dwellTicks;
    }
    return;
  }
  const nextLo = Math.floor(Math.max(0, train.posMilli - speed - train.lengthMilli) / MILLI_PER_CELL);
  if (!crossingsHeld(world, train, nextLo, train.occLo - 1)) return;
  train.posMilli -= speed;
  rail.refreshOccupancy(train);
  if (train.posMilli - train.lengthMilli <= 0) depart(world, train);
}

/** Vlak prešiel portálom: jednotky `in_train → exported`, `TrainDeparted`, zánik vlaka. */
function depart(world: World, train: Train): void {
  let units = 0;
  let importUnits = 0;
  for (let unitId = world.cargo.firstUnitAt('in_train', train.id); unitId !== undefined; unitId = world.cargo.firstUnitAt('in_train', train.id)) {
    if (world.cargo.get(unitId)?.direction === 'import') importUnits += 1;
    world.cargo.move(unitId, { kind: 'exported' });
    units += 1;
  }
  const turnaroundTicks = world.clock.tick - train.spawnedTick;
  world.removeTrain(train.id);
  world.rail.recordDeparture(turnaroundTicks, importUnits);
  world.events.emit({ type: 'TrainDeparted', trainId: train.id, units, turnaroundTicks });
}

export class RailSystem {
  /** Krok 6e (viď hlavička). */
  tick(world: World): void {
    const { rail } = world;
    const { tick } = world.clock;
    if (rail.trains.size === 0 && tick < rail.nextArrivalTick) return;
    let mover = rail.mover();
    if (tick >= rail.nextArrivalTick) {
      if (!world.hasRailService) rail.skipArrivals(tick);
      else if (mover === undefined && trySpawn(world)) mover = rail.mover();
    }
    // Kópia id: odchod vlaka ho odstráni z mapy počas prechodu.
    for (const train of [...rail.trains.values()]) {
      if (train.state === 'dwelling') {
        const due = train.departAtTick !== null && tick >= train.departAtTick;
        if (mover !== undefined || !(due || isTrainFull(world.cargo, train)) || hasInboundCargo(world, train) || machineWorksOnTrain(world, train.id)) continue;
        train.transition('departing');
        mover = train;
        // Vlak vyráža v nasledujúcom ticku — tento tick sa len rozbieha (obsadenie sa nemení).
      } else {
        drive(world, train);
      }
      // Sloty priecestí podľa novej polohy (aj keď vlak stojí pred priecestím a získava uvoľnené sloty).
      if (rail.trains.has(train.id)) syncCrossings(world, train);
    }
  }
}
