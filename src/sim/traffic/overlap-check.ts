/**
 * Invariant dopravy bez prekrývania (ADR-037 bod 9, krok 12 a obnova save): `carrierOverlapProblem(world)` vráti popis
 * prvého porušenia, alebo `null`.
 *
 * - sloty v `world.laneSlots` = sloty prepočítané z tiel a slotov vpredu všetkých nosičov (každý slot má najviac jedného
 *   držiteľa a drží ho práve ten nosič, ktorý ho má v `body` / `ahead`);
 * - telo má najviac `lengthCells` slotov, je súvislé (susedné alebo rovnaké bunky) a jeho hlava je v bunke nosiča;
 * - sloty vpredu nadväzujú na hlavu a zodpovedajú bunkám trasy pred nosičom; pri rozbehnutom úseku nosič drží aj cieľovú
 *   bunku úseku;
 * - nosič mimo cesty (stav bez `holdsRoad`) nedrží nič a nečaká (`blockedTicks`, `rerouteCooldown` = 0).
 * Nosič v jazdnom stave smie byť bez slotov (práve do stavu vstúpil, slot získa `TrafficSystem` v nasledujúcom ticku).
 */
import type { Carrier } from '../movement/carrier';
import type { World } from '../world/world';
import { holdsRoad, type RoadCarrier } from './holds-road';
import { keyCell, keyLane } from './lane-slots';

/** Čo kontrola číta zo sveta (`World` ju spĺňa). */
export type OverlapWorld = Pick<World, 'vehicles' | 'trucks' | 'laneSlots' | 'grid'>;

function adjacentOrSame(width: number, a: number, b: number): boolean {
  const delta = Math.abs(a - b);
  return delta === 0 || delta === width || (delta === 1 && Math.floor(a / width) === Math.floor(b / width));
}

/** Problém slotov jedného nosiča (bez porovnania s cache), alebo `null`. */
function carrierSlotProblem(world: OverlapWorld, carrier: RoadCarrier): string | null {
  const { width, cellCount } = world.grid;
  const { body, ahead } = carrier;
  const label = carrier.label;
  if (!holdsRoad(carrier)) {
    if (body.length > 0 || ahead.length > 0) return `${label} (stav '${carrier.state}') je mimo cesty, ale drží ${String(body.length + ahead.length)} slotov`;
    if (carrier.blockedTicks !== 0 || carrier.rerouteCooldown !== 0) return `${label} (stav '${carrier.state}') je mimo cesty, ale čaká (blockedTicks ${String(carrier.blockedTicks)}, rerouteCooldown ${String(carrier.rerouteCooldown)})`;
    return null;
  }
  if (!Number.isSafeInteger(carrier.blockedTicks) || carrier.blockedTicks < 0) return `${label}: blockedTicks ${String(carrier.blockedTicks)} musí byť celé číslo ≥ 0`;
  if (!Number.isSafeInteger(carrier.rerouteCooldown) || carrier.rerouteCooldown < 0) return `${label}: rerouteCooldown ${String(carrier.rerouteCooldown)} musí byť celé číslo ≥ 0`;
  if (body.length > carrier.lengthCells) return `${label}: telo má ${String(body.length)} slotov, dĺžka nosiča je ${String(carrier.lengthCells)}`;
  if (body.length === 0) return ahead.length > 0 ? `${label}: drží ${String(ahead.length)} slotov vpredu bez tela` : null;
  for (const key of [...body, ...ahead]) {
    if (!Number.isSafeInteger(key) || key < 0 || keyCell(key) >= cellCount || keyLane(key) > 1) return `${label}: neplatný kľúč slotu ${String(key)}`;
  }
  if (keyCell(body[0]) !== carrier.cell) return `${label}: hlava tela je v bunke ${String(keyCell(body[0]))}, nosič stojí v bunke ${String(carrier.cell)}`;
  for (let i = 1; i < body.length; i++) {
    if (!adjacentOrSame(width, keyCell(body[i - 1]), keyCell(body[i]))) return `${label}: telo nie je súvislé — bunky ${String(keyCell(body[i - 1]))} a ${String(keyCell(body[i]))} nesusedia`;
  }
  let previous = keyCell(body[0]);
  for (let i = 0; i < ahead.length; i++) {
    const cell = keyCell(ahead[i]);
    if (cell !== carrier.routeCellAt(i + 1)) return `${label}: slot vpredu #${String(i)} je v bunke ${String(cell)}, trasa tam vedie cez ${String(carrier.routeCellAt(i + 1))}`;
    if (!adjacentOrSame(width, previous, cell)) return `${label}: sloty vpredu nenadväzujú na telo — bunky ${String(previous)} a ${String(cell)} nesusedia`;
    previous = cell;
  }
  const next = carrier.nextCell;
  if (carrier.progress > 0 && next !== undefined && !body.some((key) => keyCell(key) === next) && !ahead.some((key) => keyCell(key) === next)) {
    return `${label}: rozbehnutý úsek ${String(carrier.cell)} → ${String(next)}, ale cieľovú bunku nedrží`;
  }
  return null;
}

/** Prvý problém dopravy bez prekrývania vo svete (viď hlavička súboru), alebo `null`. */
export function carrierOverlapProblem(world: OverlapWorld): string | null {
  const slots = world.laneSlots;
  let held = 0;
  const check = (carrier: Carrier & RoadCarrier): string | null => {
    const problem = carrierSlotProblem(world, carrier);
    if (problem !== null) return problem;
    const keys = [...carrier.body, ...carrier.ahead];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const holder = slots.holderOfKey(key);
      if (holder !== carrier.id) {
        return `${carrier.label}: slot ${String(key)} (bunka ${String(keyCell(key))}, pruh ${String(keyLane(key))}) drží ${holder === 0 ? 'nikto' : `#${String(holder)}`} — prekryv alebo nesúlad cache`;
      }
      if (keys.indexOf(key) === i) held += 1;
    }
    return null;
  };
  for (const vehicle of world.vehicles.values()) {
    const problem = check(vehicle);
    if (problem !== null) return problem;
  }
  for (const truck of world.trucks.values()) {
    const problem = check(truck);
    if (problem !== null) return problem;
  }
  if (held !== slots.claimedCount) return `cache slotov drží ${String(slots.claimedCount)} slotov, nosiče ich držia ${String(held)}`;
  return null;
}
