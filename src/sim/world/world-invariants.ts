/**
 * Invarianty sveta nad rámec ledgera (ARCHITECTURE §6 krok 12, §16; ADR-014): moduly, mriežka, žeriavy, aprony
 * a skupiny kotvísk musia zodpovedať sebe navzájom aj `CargoLedger`. `World.assertInvariants()` ich volá po
 * `cargo.assertConservation()`; krok 12 ticku ho spustí od T02-05, loader save ho volá ako poslednú poistku.
 *
 * Kontroly (prvé porušenie vyhráva, správa pomenuje entity):
 * 1. každá jednotka nákladu je u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`);
 * 2. mriežka: bunky modulu (okrem žeriavu) majú `moduleId` modulu a žiadnu cestu, iné bunky nemajú `moduleId`;
 * 3. žeriav: stojí celý na svojom berthe, má jeho rotáciu, berth ho eviduje, držaná jednotka a rezervácia
 *    zodpovedajú ledgeru, apronu a `CRANE_STATE_TRAITS`; berth: `craneIds` = jeho žeriavy v poradí umiestnenia,
 *    najviac `maxCranes`, bez prekryvu, rezervácie apronu = rezervácie jeho žeriavov;
 * 4. apron: rovnaké jednotky, sloty aj FIFO poradie ako `on_apron` v ledgeri;
 * 5. `berthGroups` a `groupId` = prepočet `computeBerthGroups`.
 */
import { CARGO_HOLDER_KINDS } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { computeBerthGroups } from '../modules/berth-group';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import type { World } from './world';

/** Porušený invariant sveta (moduly, mriežka, aprony, žeriavy, skupiny kotvísk). */
export class WorldInvariantError extends Error {
  constructor(violation: string) {
    super(`World: porušený invariant — ${violation}`);
    this.name = 'WorldInvariantError';
  }
}

type Check = (world: World) => string | undefined;

function cellLabel(x: number, y: number): string {
  return `(${String(x)}, ${String(y)})`;
}

function sameIds(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function berths(world: World): BerthModule[] {
  return [...world.modules.values()].filter((module): module is BerthModule => module instanceof BerthModule);
}

function cranes(world: World): CraneModule[] {
  return [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);
}

const checkCargoHolders: Check = (world) => {
  for (const kind of CARGO_HOLDER_KINDS) {
    let held = 0;
    for (const holderId of CARGO_HOLDER_SOURCES[kind](world)) held += world.cargo.countAt(kind, holderId);
    const total = world.cargo.countByKind(kind);
    if (held !== total) return `${String(total - held)} jednotiek v '${kind}' je u neexistujúceho držiteľa`;
  }
  return undefined;
};

const checkModuleCells: Check = (world) => {
  const { grid } = world;
  for (const [id, module] of world.modules) {
    if (module.id !== id) return `world.modules: kľúč ${String(id)} ukazuje na ${module.label}`;
    if (!grid.rectInBounds({ x: module.origin.x, y: module.origin.y, w: module.size.w, h: module.size.h })) {
      return `${module.label} presahuje mapu`;
    }
    if (module instanceof CraneModule) continue;
    for (const { x, y } of module.cells) {
      const cell = grid.at(x, y);
      if (cell.moduleId !== module.id) return `bunka ${cellLabel(x, y)} modulu ${module.label} má moduleId ${String(cell.moduleId)}`;
      if (cell.road !== 'none') return `pod modulom ${module.label} je na ${cellLabel(x, y)} vrstva '${cell.road}'`;
    }
  }
  for (let i = 0; i < grid.cellCount; i++) {
    const { moduleId } = grid.atIndex(i);
    if (moduleId === null) continue;
    const { x, y } = grid.coordOf(i);
    const owner = world.modules.get(moduleId);
    if (owner === undefined) return `bunka ${cellLabel(x, y)} odkazuje na neexistujúci modul #${String(moduleId)}`;
    if (owner instanceof CraneModule || !owner.containsCell(x, y)) {
      return `bunka ${cellLabel(x, y)} odkazuje na ${owner.label}, ktorý ju nezaberá`;
    }
  }
  return undefined;
};

function checkCrane(world: World, crane: CraneModule): string | undefined {
  const berth = world.modules.get(crane.berthId);
  if (!(berth instanceof BerthModule)) return `${crane.label} stojí na #${String(crane.berthId)}, ktorý nie je berth`;
  if (crane.rotation !== berth.rotation) return `${crane.label} má rotáciu ${String(crane.rotation)}, berth ${berth.label} ${String(berth.rotation)}`;
  const outside = crane.cells.find(({ x, y }) => world.grid.at(x, y).moduleId !== berth.id);
  if (outside !== undefined) return `${crane.label}: bunka ${cellLabel(outside.x, outside.y)} nepatrí berthu ${berth.label}`;
  if (!berth.craneIds.includes(crane.id)) return `${crane.label} chýba v craneIds berthu ${berth.label}`;

  const held = world.cargo.unitsAt('in_crane', crane.id);
  if (held.length > 1) return `${crane.label} drží ${String(held.length)} jednotiek (${held.join(', ')})`;
  if (crane.heldUnitId !== (held[0] ?? null)) {
    return `${crane.label}: heldUnitId ${String(crane.heldUnitId)}, ledger in_crane ${String(held[0] ?? null)}`;
  }
  const traits = CRANE_STATE_TRAITS[crane.state];
  if (traits.holdsUnit !== (crane.heldUnitId !== null)) {
    return `${crane.label} v stave '${crane.state}' ${traits.holdsUnit ? 'nedrží' : 'drží'} jednotku`;
  }
  if (traits.hasReservation !== (crane.reservedSlot !== null)) {
    return `${crane.label} v stave '${crane.state}' ${traits.hasReservation ? 'nemá' : 'má'} rezervovaný slot`;
  }
  const slot = crane.reservedSlot;
  if (slot !== null && (slot >= berth.apron.capacity || !berth.apron.isReserved(slot))) {
    return `${crane.label}: slot ${String(slot)} nie je rezervovaný na aprone ${berth.label}`;
  }
  return undefined;
}

function checkBerthCranes(world: World, berth: BerthModule, all: readonly CraneModule[]): string | undefined {
  const own = all.filter((crane) => crane.berthId === berth.id);
  if (!sameIds(berth.craneIds, own.map((crane) => crane.id))) {
    return `${berth.label}: craneIds [${berth.craneIds.join(', ')}] ≠ žeriavy na berthe [${own.map((c) => c.id).join(', ')}]`;
  }
  if (own.length > berth.params.maxCranes) return `${berth.label} má ${String(own.length)} žeriavov (maxCranes ${String(berth.params.maxCranes)})`;
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const overlap = own[i].cells.find(({ x, y }) => own[j].containsCell(x, y));
      if (overlap !== undefined) return `${own[i].label} a ${own[j].label} sa prekrývajú na ${cellLabel(overlap.x, overlap.y)}`;
    }
  }
  const expected = own
    .map((crane) => crane.reservedSlot)
    .filter((slot): slot is number => slot !== null)
    .sort((a, b) => a - b);
  const reserved = berth.apron.reservedSlots();
  if (reserved.length !== expected.length || reserved.some((slot, i) => slot !== expected[i])) {
    return `${berth.label}: rezervované sloty apronu [${reserved.join(', ')}] ≠ rezervácie žeriavov [${expected.join(', ')}]`;
  }
  return undefined;
}

const checkCranes: Check = (world) => {
  const all = cranes(world);
  for (const crane of all) {
    const violation = checkCrane(world, crane);
    if (violation !== undefined) return violation;
  }
  for (const berth of berths(world)) {
    const violation = checkBerthCranes(world, berth, all);
    if (violation !== undefined) return violation;
  }
  return undefined;
};

const checkAprons: Check = (world) => {
  for (const berth of berths(world)) {
    const { apron } = berth;
    if (apron.capacity !== berth.params.apronSlots) return `${berth.label}: kapacita apronu ${String(apron.capacity)} ≠ apronSlots`;
    const ledgerUnits = world.cargo.unitsOnApron(berth.id);
    const apronUnits = apron.units();
    if (!sameIds(apronUnits, ledgerUnits)) {
      return `${berth.label}: apron [${apronUnits.join(', ')}] ≠ ledger on_apron [${ledgerUnits.join(', ')}] (jednotky alebo FIFO poradie)`;
    }
    for (const unitId of ledgerUnits) {
      const location = world.cargo.get(unitId)?.location;
      const slot = location?.kind === 'on_apron' ? location.slot : undefined;
      if (slot !== apron.slotOf(unitId)) {
        return `${berth.label}: jednotka #${String(unitId)} je v ledgeri na slote ${String(slot)}, na aprone na ${String(apron.slotOf(unitId))}`;
      }
    }
  }
  return undefined;
};

const checkBerthGroups: Check = (world) => {
  const all = berths(world);
  const expected = computeBerthGroups(all);
  if (JSON.stringify(world.berthGroups) !== JSON.stringify(expected)) {
    return `berthGroups ${JSON.stringify(world.berthGroups)} ≠ prepočet ${JSON.stringify(expected)}`;
  }
  for (const berth of all) {
    const group = expected.find((candidate) => candidate.berthIds.includes(berth.id));
    if (berth.groupId !== group?.id) return `${berth.label}: groupId ${String(berth.groupId)}, patrí do skupiny ${String(group?.id)}`;
  }
  return undefined;
};

const CHECKS: readonly Check[] = [checkCargoHolders, checkModuleCells, checkCranes, checkAprons, checkBerthGroups];

/** Prvé porušenie invariantov sveta (viď hlavička súboru), alebo `undefined`. Svet nemení. */
export function findWorldViolation(world: World): string | undefined {
  for (const check of CHECKS) {
    const violation = check(world);
    if (violation !== undefined) return violation;
  }
  return undefined;
}
