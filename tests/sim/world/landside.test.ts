// Pozemný reťazec vo svete (T04-02, ADR-022): strany brány (priechod, vstup z portálu), priechod stojiskom, prevádzkovosť
// rampy s dôvodom, zverejnenie do modulov a RampOperationalChanged po príkazoch, cache podľa roadVersion + moduleVersion,
// save/load (nič z toho sa neukladá), pravidlo has_cargo pre rampu, obnova a invarianty jednotiek at_ramp.
//
// Rozloženie na harbor_01 (starter parcela x 30–57, y 14–33; road portál (44, 63), verejná cesta x = 44, y 34..63) je
// to isté ako v TDD scenári T04-05 (`full_import_chain`), len bez dvorov a vozidiel:
//   brána (45, 32) rot 270 — konektory w (45, 33) → vonkajšia (44, 33) a e (46, 33) → (47, 33);
//   stojisko (49, 31) rot 0 — konektory w (49, 33) → (48, 33) a e (52, 33) → (53, 33);
//   rampa (53, 28) rot 0 — konektory s (54, 29) → (54, 30) a s (55, 29) → (55, 30).
// Cesty: (44, 33) vstup brány; (47, 33)–(48, 33) výstup brány → západ stojiska; (53, 31..33) východ stojiska → (53, 30);
// (51..55, 30) k rampe. Brána je jediné spojenie s portálom, stojisko jediné spojenie výstupu brány s rampou.
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { describe, expect, it } from 'vitest';
import { RemoveModuleCommand, commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import { NO_ACCESS } from '@sim/logistics';
import { LoadingRamp, TruckGate, WaitingArea, type Module, type RampInoperativeReason } from '@sim/modules';
import { NO_GATE_SIDES, World, WorldStateError, findRemovalViolations, findWorldViolation, type WorldState } from '@sim/world';
import { DEFS, MAP, RAW_DEFS, SEED } from './world-fixtures';

const GATE = { defId: 'truck_gate', x: 45, y: 32, rotation: 270 } as const;
const AREA = { defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 } as const;
const RAMP = { defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 } as const;
type Placement = { readonly defId: string; readonly x: number; readonly y: number; readonly rotation: number };

function row(y: number, x0: number, x1: number): CellCoord[] {
  const cells: CellCoord[] = [];
  for (let x = x0; x <= x1; x++) cells.push({ x, y });
  return cells;
}

function column(x: number, y0: number, y1: number): CellCoord[] {
  const cells: CellCoord[] = [];
  for (let y = y0; y <= y1; y++) cells.push({ x, y });
  return cells;
}

const ROADS = {
  gateApproach: [{ x: 44, y: 33 }],
  gateExit: row(33, 47, 48),
  truckLink: column(53, 31, 33),
  rampRow: row(30, 51, 55),
} as const;
const RAMP_OUTSIDE: readonly CellCoord[] = [
  { x: 54, y: 30 },
  { x: 55, y: 30 },
];

const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

function roadCommands(omit: readonly CellCoord[] = [], extra: readonly (readonly CellCoord[])[] = []): SerializedCommand[] {
  const commands: SerializedCommand[] = [];
  for (const cells of [...Object.values(ROADS), ...extra]) {
    const kept = cells.filter((cell) => !omit.some((omitted) => sameCell(cell, omitted)));
    if (kept.length > 0) commands.push({ type: 'PlaceRoad', cells: kept });
  }
  return commands;
}

const place = ({ defId, x, y, rotation }: Placement): SerializedCommand => ({ type: 'PlaceModule', defId, x, y, rotation });

/** Aplikuje príkazy (bez posunu času) a vráti udalosti; odmietnutý príkaz je chyba testu. */
function apply(world: World, ...commands: readonly SerializedCommand[]): readonly SimEvent[] {
  for (const command of commands) world.enqueue(commandFromJSON(command));
  const events = world.applyPending();
  const rejected = events.filter((event) => event.type === 'CommandRejected');
  expect(rejected).toEqual([]);
  return events;
}

interface Layout {
  readonly modules?: readonly Placement[];
  readonly omit?: readonly CellCoord[];
  readonly extraRoads?: readonly (readonly CellCoord[])[];
  readonly defs?: DefRegistry;
}

function build({ modules = [GATE, AREA, RAMP], omit = [], extraRoads = [], defs = DEFS }: Layout = {}): World {
  const world = World.create(defs, MAP, SEED);
  apply(world, ...roadCommands(omit, extraRoads), ...modules.map(place));
  return world;
}

function only<T extends Module>(world: World, cls: abstract new (...args: never[]) => T): T {
  const found = [...world.modules.values()].filter((module): module is T => module instanceof cls);
  if (found.length !== 1) throw new Error(`očakávaný práve jeden ${cls.name}, je ${String(found.length)}`);
  return found[0];
}

const idx = (world: World, cell: CellCoord): number => world.grid.index(cell.x, cell.y);

function rampEvents(events: readonly SimEvent[]): Extract<SimEvent, { type: 'RampOperationalChanged' }>[] {
  return events.filter((event): event is Extract<SimEvent, { type: 'RampOperationalChanged' }> => event.type === 'RampOperationalChanged');
}

/** Zverejnený stav rampy = aktuálny výpočet sveta. */
function expectPublished(world: World, ramp: LoadingRamp): void {
  expect(ramp.operational).toBe(world.isRampOperational(ramp));
  expect(ramp.inoperativeReason).toBe(world.rampStatus(ramp).reason);
}

describe('strany brány (priechod, rozhodnutie 2)', () => {
  it('rot 270: vstup = konektor w (45, 33) dosiahnuteľný z portálu, výstup = e (46, 33); prístupové bunky', () => {
    const world = build();
    const gate = only(world, TruckGate);
    expect(gate.entrySide).toEqual({ x: 45, y: 33, side: 'w', type: 'road' });
    expect(gate.exitSide).toEqual({ x: 46, y: 33, side: 'e', type: 'road' });
    const sides = world.gateSides(gate);
    expect([sides.entry, sides.exit]).toEqual([gate.entrySide, gate.exitSide]);
    expect([sides.entryCell, sides.exitCell]).toEqual([idx(world, { x: 44, y: 33 }), idx(world, { x: 47, y: 33 })]);
    expect(world.landside.portalCell).toBe(idx(world, { x: 44, y: 63 }));
  });

  it('rot 0 (konektory n / s): vstup je južný (vonkajšia bunka (44, 34) na verejnej ceste), výstup severný', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, { type: 'PlaceRoad', cells: [{ x: 44, y: 31 }] }, place({ defId: 'truck_gate', x: 44, y: 32, rotation: 0 }));
    const gate = only(world, TruckGate);
    expect(gate.entrySide).toMatchObject({ x: 44, y: 33, side: 's' });
    expect(gate.exitSide).toMatchObject({ x: 44, y: 32, side: 'n' });
  });

  it('obe strany dosiahnuteľné z portálu (obchádzka): vstup je strana s lacnejšou cestou z portálu, nie prvá v poradí defu', () => {
    // rot 90: konektor 0 defu je e (46, 32), konektor 1 je w (45, 32). Vstup w cez (44, 32), obchádzka (44..47, 31) → (47, 32).
    const world = World.create(DEFS, MAP, SEED);
    apply(
      world,
      { type: 'PlaceRoad', cells: [...column(44, 31, 33), ...row(31, 45, 47), { x: 47, y: 32 }] },
      place({ defId: 'truck_gate', x: 45, y: 32, rotation: 90 }),
    );
    const gate = only(world, TruckGate);
    expect(gate.connectors.map(({ x, y, side }) => `${String(x)},${String(y)},${side}`)).toEqual(['46,32,e', '45,32,w']);
    expect(gate.entrySide).toMatchObject({ x: 45, y: 32, side: 'w' });
    expect(gate.exitSide).toMatchObject({ x: 46, y: 32, side: 'e' });
  });

  it('brána bez cesty z portálu: strany neurčené; bez cesty na výstupe: vstup áno, výstup null', () => {
    const noEntry = build({ omit: ROADS.gateApproach });
    expect([only(noEntry, TruckGate).entrySide, only(noEntry, TruckGate).exitSide]).toEqual([null, null]);
    expect(noEntry.gateSides(only(noEntry, TruckGate))).toMatchObject({ entryCell: NO_ACCESS, exitCell: NO_ACCESS });

    const noExit = build({ omit: ROADS.gateExit });
    const gate = only(noExit, TruckGate);
    expect(gate.entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
    expect(gate.exitSide).toBeNull();
  });
});

describe('prevádzkovosť rampy (rozhodnutie 1): dôvody a trasy', () => {
  const CASES: readonly [string, Layout, RampInoperativeReason | null][] = [
    ['kompletné rozloženie', {}, null],
    ['bez brány', { modules: [AREA, RAMP] }, 'no_gate'],
    ['brána bez cesty z portálu (chýba (44, 33))', { omit: ROADS.gateApproach }, 'no_gate'],
    ['brána bez cesty na výstupe', { omit: ROADS.gateExit }, 'no_gate'],
    ['brána bez stojiska', { modules: [GATE, RAMP] }, 'no_waiting_area'],
    ['rampa bez cesty na konektoroch', { omit: RAMP_OUTSIDE }, 'not_connected'],
    ['stojisko za bránou je, ale z neho k rampe cesta nevedie', { omit: ROADS.truckLink }, 'not_connected'],
    [
      'rampa pred bránou (na ceste z portálu), stojisko za bránou',
      { modules: [GATE, AREA, { ...RAMP, x: 39, y: 31 }], extraRoads: [row(33, 40, 43)] },
      'not_connected',
    ],
  ];
  it.each(CASES)('%s → %s', (_name, layout, reason) => {
    const world = build(layout);
    const ramp = only(world, LoadingRamp);
    expect(world.rampStatus(ramp)).toEqual({ operational: reason === null, reason });
    expect(world.isRampOperational(ramp)).toBe(reason === null);
    expect(world.isRampOperational(ramp.id)).toBe(reason === null);
    expectPublished(world, ramp);
    expect(world.landsideRoutes(ramp).length > 0).toBe(reason === null);
  });

  it('trasa: brána (44, 33) → (47, 33), stojisko (48, 33) → (53, 33), rampa (54, 30)', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    expect(world.landsideRoutes(ramp)).toEqual([
      {
        gateId: only(world, TruckGate).id,
        gateEntryCell: idx(world, { x: 44, y: 33 }),
        gateExitCell: idx(world, { x: 47, y: 33 }),
        waitingAreaId: only(world, WaitingArea).id,
        waitingEntryCell: idx(world, { x: 48, y: 33 }),
        waitingExitCell: idx(world, { x: 53, y: 33 }),
        rampCell: idx(world, { x: 54, y: 30 }),
      },
    ]);
  });

  it('stojisko s jediným použiteľným konektorom poslúži ako slepé parkovisko (vstup = výstup)', () => {
    const world = build({ omit: ROADS.truckLink, extraRoads: [[...column(48, 30, 32), ...row(30, 49, 50)]] });
    const ramp = only(world, LoadingRamp);
    expect(world.isRampOperational(ramp)).toBe(true);
    const [route] = world.landsideRoutes(ramp);
    expect([route.waitingEntryCell, route.waitingExitCell]).toEqual([idx(world, { x: 48, y: 33 }), idx(world, { x: 48, y: 33 })]);
  });

  it('dve stojiská za bránou: trasa cez každé, v poradí id stojiska (nie podľa vzdialenosti)', () => {
    // Druhé stojisko (38..41, 29..31): e (41, 31) → (42, 31) z výstupu brány, w (38, 31) → (37, 31) → y = 28 → rampa.
    const second = { defId: 'truck_waiting_area', x: 38, y: 29, rotation: 0 } as const;
    const world = build({
      modules: [GATE, second, AREA, RAMP],
      extraRoads: [
        [{ x: 47, y: 32 }, ...row(31, 42, 47)],
        [...column(37, 28, 31), ...row(28, 38, 52), { x: 52, y: 29 }],
      ],
    });
    const ramp = only(world, LoadingRamp);
    const [secondArea, firstArea] = [...world.modules.values()].filter((module) => module instanceof WaitingArea);
    expect(world.landsideRoutes(ramp).map((route) => [route.waitingAreaId, route.waitingEntryCell, route.waitingExitCell])).toEqual([
      [secondArea.id, idx(world, { x: 42, y: 31 }), idx(world, { x: 37, y: 31 })],
      [firstArea.id, idx(world, { x: 48, y: 33 }), idx(world, { x: 53, y: 33 })],
    ]);
  });

  it('neramp moduly a neznáme id nie sú prevádzkové rampy', () => {
    const world = build();
    expect(world.isRampOperational(only(world, TruckGate))).toBe(false);
    expect(world.isRampOperational(999 as EntityId)).toBe(false);
  });

  it('pozemné moduly ide postaviť v ľubovoľnom poradí aj bez ciest (rampa bez cesty = not_connected)', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, place(RAMP), place(GATE), place(AREA));
    expect(world.rampStatus(only(world, LoadingRamp)).reason).toBe('not_connected');
    expect(world.gateSides(only(world, TruckGate)).entry).toBeNull();
  });
});

describe('cesta späť (review T04-11, major 1): trasa len s cestou rampa → brána → portál', () => {
  const oneWay = (cell: CellCoord, dir: 'N' | 'E' | 'S' | 'W'): SerializedCommand => ({ type: 'PlaceRoad', cells: [cell], kind: 'one_way', dirs: [dir] });

  it.each<[string, CellCoord, 'N' | 'E' | 'S' | 'W']>([
    ['jednosmerka na výstupe brány (47, 33) smerom od brány (E): od rampy sa k bráne nedá vrátiť', { x: 47, y: 33 }, 'E'],
    ['jednosmerka na vstupe brány (44, 33) smerom k bráne (N): od brány sa k portálu nedá vrátiť', { x: 44, y: 33 }, 'N'],
  ])('%s → no_return_path bez trás; po oprave cesty prevádzková', (_name, cell, dir) => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    const cut = apply(world, oneWay(cell, dir));
    expect(world.rampStatus(ramp)).toEqual({ operational: false, reason: 'no_return_path' });
    expect(world.landsideRoutes(ramp)).toEqual([]);
    expect(rampEvents(cut)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_return_path' }]);
    expectPublished(world, ramp);
    const fixed = apply(world, { type: 'PlaceRoad', cells: [cell], kind: 'two_lane' });
    expect(rampEvents(fixed)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null }]);
    expect(world.landsideRoutes(ramp)).toHaveLength(1);
  });

  it('no_return_path až keď cesta tam existuje; bez nej platia pôvodné dôvody (stojisko, not_connected)', () => {
    const noArea = build({ modules: [GATE, RAMP] });
    apply(noArea, oneWay({ x: 47, y: 33 }, 'E'));
    expect(noArea.rampStatus(only(noArea, LoadingRamp)).reason).toBe('no_waiting_area');
    const noLink = build({ omit: ROADS.truckLink });
    apply(noLink, oneWay({ x: 47, y: 33 }, 'E'));
    expect(noLink.rampStatus(only(noLink, LoadingRamp)).reason).toBe('not_connected');
  });

  it('okruh: s cestou späť returns = true a trasa = okruh; jednosmerka (47, 33) E → okruh len tam (returns = false)', () => {
    const world = build();
    const [gate, area, ramp] = [only(world, TruckGate), only(world, WaitingArea), only(world, LoadingRamp)];
    const [route] = world.landsideRoutes(ramp);
    expect(world.landside.circuit(gate, area, ramp)).toEqual({
      gateInnerCell: route.gateExitCell,
      waitingEntryCell: route.waitingEntryCell,
      waitingExitCell: route.waitingExitCell,
      rampCell: route.rampCell,
      returns: true,
    });
    apply(world, oneWay({ x: 47, y: 33 }, 'E'));
    expect(world.landside.circuit(gate, area, ramp)).toMatchObject({ gateInnerCell: idx(world, { x: 47, y: 33 }), returns: false });
    expect(world.landside.circuit(gate, area, gate)).toBeUndefined();
  });

  it('bunka rampy bez cesty späť (slepá jednosmerka na (55, 30)) sa v okruhu preskočí; okruh ju neobslúži, (54, 30) áno', () => {
    const world = build();
    const [gate, area, ramp] = [only(world, TruckGate), only(world, WaitingArea), only(world, LoadingRamp)];
    apply(world, oneWay({ x: 55, y: 30 }, 'E'));
    expect(world.isRampOperational(ramp)).toBe(true);
    const circuit = world.landside.circuit(gate, area, ramp);
    if (circuit === undefined) throw new Error('okruh chýba');
    expect([circuit.rampCell, circuit.returns]).toEqual([idx(world, { x: 54, y: 30 }), true]);
    expect(world.landside.circuitServesCell(circuit, idx(world, { x: 54, y: 30 }))).toBe(true);
    expect(world.landside.circuitServesCell(circuit, idx(world, { x: 55, y: 30 }))).toBe(false);
    expect(world.landside.circuitServesCell(circuit, NO_ACCESS)).toBe(false);
  });
});

describe('strany brány pre kamión (review T04-11, major 2)', () => {
  it('so vstupom z portálu = strany brány; bez neho vnútorná = prvá strana, z ktorej je stojisko dosiahnuteľné', () => {
    const world = build();
    const [gate, area, ramp] = [only(world, TruckGate), only(world, WaitingArea), only(world, LoadingRamp)];
    expect(world.landside.truckGateSides(gate, area)).toBe(world.gateSides(gate));

    apply(world, { type: 'RemoveRoad', cells: ROADS.gateApproach });
    expect(world.gateSides(gate)).toEqual(NO_GATE_SIDES);
    expect(world.landside.truckGateSides(gate, area)).toMatchObject({ entry: null, entryCell: NO_ACCESS, exitCell: idx(world, { x: 47, y: 33 }) });
    // Okruh za bránou ostáva aj bez cesty z portálu (rampa je neprevádzková — no_gate).
    expect(world.rampStatus(ramp).reason).toBe('no_gate');
    expect(world.landside.circuit(gate, area, ramp)).toMatchObject({ gateInnerCell: idx(world, { x: 47, y: 33 }), returns: true });
  });

  it('prerušenie ďalej na verejnej ceste: vonkajšia strana (44, 33) ostane, vnútorná (47, 33); stojisko nedosiahnuteľné → bez strán', () => {
    const world = build();
    const [gate, area] = [only(world, TruckGate), only(world, WaitingArea)];
    apply(world, { type: 'RemoveRoad', cells: [{ x: 44, y: 50 }] });
    expect(world.landside.truckGateSides(gate, area)).toMatchObject({ entryCell: idx(world, { x: 44, y: 33 }), exitCell: idx(world, { x: 47, y: 33 }) });
    apply(world, { type: 'RemoveRoad', cells: [{ x: 48, y: 33 }] });
    expect(world.landside.truckGateSides(gate, area)).toEqual(NO_GATE_SIDES);
    expect(world.landside.truckGateSides(only(world, LoadingRamp), area)).toEqual(NO_GATE_SIDES);
  });
});

describe('zverejnenie a RampOperationalChanged', () => {
  it('stavba WA → rampa → brána, RemoveRoad vstupu, iná cesta, návrat vstupu: udalosť len pri zmene, po udalostiach príkazu', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(rampEvents(apply(world, ...roadCommands(), place(AREA)))).toEqual([]);

    const rampPlaced = apply(world, place(RAMP));
    const ramp = only(world, LoadingRamp);
    expect(rampEvents(rampPlaced)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    expect(rampPlaced.findIndex((event) => event.type === 'ModulePlaced')).toBeLessThan(rampPlaced.findIndex((event) => event.type === 'RampOperationalChanged'));
    expectPublished(world, ramp);

    const gatePlaced = apply(world, place(GATE));
    expect(rampEvents(gatePlaced)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null }]);
    expect(gatePlaced.at(-1)?.type).toBe('RampOperationalChanged');
    expectPublished(world, ramp);

    const cut = apply(world, { type: 'RemoveRoad', cells: ROADS.gateApproach });
    expect(rampEvents(cut)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    expect(cut.findIndex((event) => event.type === 'RoadChanged')).toBeLessThan(cut.findIndex((event) => event.type === 'RampOperationalChanged'));
    expect(only(world, TruckGate).entrySide).toBeNull();

    expect(rampEvents(apply(world, { type: 'PlaceRoad', cells: [{ x: 32, y: 25 }] }))).toEqual([]);
    expect(rampEvents(world.tick())).toEqual([]);
    expect(rampEvents(apply(world, { type: 'PlaceRoad', cells: ROADS.gateApproach }))).toEqual([
      { type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null },
    ]);
    expect(only(world, TruckGate).entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
    world.assertInvariants();
  });

  it('dôvod sa môže zmeniť aj bez zmeny prevádzkovosti (no_gate → no_waiting_area); odstránenie rampy udalosť nemá', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, ...roadCommands(), place(RAMP));
    const ramp = only(world, LoadingRamp);
    expect(rampEvents(apply(world, place(GATE)))).toEqual([
      { type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_waiting_area' },
    ]);
    expect(rampEvents(apply(world, new RemoveModuleCommand(ramp.id).toJSON()))).toEqual([]);
  });

  it('priama štrukturálna zmena mimo príkazu: dotaz je hneď aktuálny, zverejnenie a udalosť prídu v najbližšej príkazovej fáze', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    world.removeModule(only(world, TruckGate).id);
    expect(world.isRampOperational(ramp)).toBe(false);
    expect(ramp.operational).toBe(true);
    const events = world.tick();
    expect(rampEvents(events)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    expect(events.findIndex((event) => event.type === 'RampOperationalChanged')).toBeLessThan(events.findIndex((event) => event.type === 'TickAdvanced'));
    expectPublished(world, ramp);
  });

  it('World.create so starter modulmi nič nezverejňuje ako udalosť (prvý tick bez RampOperationalChanged)', () => {
    expect(rampEvents(World.create(DEFS, MAP, SEED).tick())).toEqual([]);
  });
});

describe('cache podľa roadVersion + moduleVersion', () => {
  it('opakované dotazy a ticky bez zmien neprepočítavajú; zmena ciest alebo modulov prepočíta raz', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    const { landside } = world;
    const before = landside.computeCount;
    for (let i = 0; i < 5; i++) {
      world.isRampOperational(ramp);
      world.landsideRoutes(ramp);
      world.gateSides(only(world, TruckGate));
      world.tick();
    }
    expect(landside.computeCount).toBe(before);
    const modules = world.moduleVersion;
    apply(world, { type: 'PlaceRoad', cells: [{ x: 32, y: 25 }] });
    expect(landside.computeCount).toBe(before + 1);
    apply(world, place({ defId: 'container_yard_small', x: 31, y: 20, rotation: 0 }));
    expect(world.moduleVersion).toBe(modules + 1);
    expect(landside.computeCount).toBe(before + 2);
    world.isRampOperational(ramp);
    expect(landside.computeCount).toBe(before + 2);
  });
});

describe('save / load', () => {
  it('prevádzkovosť ani strany sa neukladajú: obnova ich odvodí ticho, ďalší priebeh je rovnaký', () => {
    const world = build();
    world.tick();
    const state = world.serialize();
    const gateEntry = state.modules.find((entry) => entry.defId === 'truck_gate');
    expect(gateEntry?.runtime).toEqual({ queue: [], busyTicksLeft: 0, trucksProcessed: 0 });
    const runtimeOf = (defId: string): unknown => state.modules.find((entry) => entry.defId === defId)?.runtime;
    expect([runtimeOf('truck_waiting_area'), runtimeOf('loading_ramp_container')]).toEqual([{}, { lastNoWaitingBayHour: null }]);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)) as WorldState);
    const ramp = only(restored, LoadingRamp);
    expect([ramp.operational, ramp.inoperativeReason]).toEqual([true, null]);
    expect(only(restored, TruckGate).entrySide).toEqual(only(world, TruckGate).entrySide);
    expect(rampEvents(restored.applyPending())).toEqual([]);
    for (let i = 0; i < 3; i++) expect(restored.tick()).toEqual(world.tick());
    expect(restored.serialize()).toEqual(world.serialize());
  });
});

/** Jednotky presunuté do ledgera sveta priamo na docky rampy (cez `in_vehicle`, povolený prechod §7.1). */
function stage(world: World, ramp: LoadingRamp, docks: readonly number[]): EntityId[] {
  return docks.map((dock) => {
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 9000 as EntityId });
    world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 9001 as EntityId });
    world.cargo.move(unit.id, { kind: 'at_ramp', rampId: ramp.id, dock });
    return unit.id;
  });
}

function stateError(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof WorldStateError) return error.path;
    throw error;
  }
  return undefined;
}

describe('rampa: has_cargo, obnova a invarianty at_ramp', () => {
  it('rampa so staging rezerváciou alebo jednotkou na docku nejde odstrániť (has_cargo); brána a stojisko bez kamiónov áno', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    ramp.reserve(0);
    expect(commandFromJSON(new RemoveModuleCommand(ramp.id).toJSON()).validate(world).reasons).toEqual(['has_cargo']);
    expect(findRemovalViolations(world, ramp)).toEqual([{ rule: 'has_cargo', detail: `${ramp.label} má rezervované sloty (at_ramp): 1` }]);
    ramp.release(0);
    stage(world, ramp, [1]);
    expect(findRemovalViolations(world, ramp).map((violation) => violation.rule)).toEqual(['has_cargo']);
    expect(findRemovalViolations(world, only(world, TruckGate))).toEqual([]);
    expect(findRemovalViolations(world, only(world, WaitingArea))).toEqual([]);
  });

  it('obnova: jednotky na dockoch v rozsahu a kapacite sa načítajú; dock mimo rozsahu alebo nad kapacitou je chyba jednotky', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    const per = ramp.stagingPerDock;
    stage(world, ramp, [...Array<number>(per).fill(0), 1]);
    world.assertInvariants();
    const state = world.serialize();
    const restored = World.deserialize(DEFS, MAP, state);
    const copy = only(restored, LoadingRamp);
    expect([copy.stagedAt(0), copy.stagedAt(1), copy.reservedAt(0)]).toEqual([per, 1, 0]);

    const units = state.cargo.units;
    const onRamp = units.map((unit, index) => ({ unit, index })).filter(({ unit }) => unit.location.kind === 'at_ramp');
    const withDock = (index: number, dock: number): WorldState => ({
      ...state,
      cargo: { ...state.cargo, units: units.map((unit, i) => (i === index ? { ...unit, location: { kind: 'at_ramp', rampId: ramp.id, dock } } : unit)) },
    });
    expect(stateError(() => World.deserialize(DEFS, MAP, withDock(onRamp[0].index, 5)))).toBe(`/cargo/units/${String(onRamp[0].index)}/location/dock`);
    const dockOne = onRamp.find(({ unit }) => unit.location.kind === 'at_ramp' && unit.location.dock === 1);
    const lastOnDockZero = onRamp.filter(({ unit }) => unit.location.kind === 'at_ramp' && unit.location.dock === 0).at(-1);
    if (dockOne === undefined || lastOnDockZero === undefined) throw new Error('rozloženie jednotiek');
    const path = stateError(() => World.deserialize(DEFS, MAP, withDock(dockOne.index, 0)));
    expect(path).toBe(`/cargo/units/${String(Math.max(dockOne.index, lastOnDockZero.index))}/location/dock`);
  });

  it('krok 12: dock nad kapacitou a jednotka inej kategórie na rampe sú porušenia', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    const per = ramp.stagingPerDock;
    stage(world, ramp, Array<number>(per).fill(1));
    expect(findWorldViolation(world)).toBeUndefined();
    stage(world, ramp, [1]);
    expect(findWorldViolation(world)).toMatch(new RegExp(`dock 1: pripravené ${String(per + 1)} \\+ rezervované 0 > ${String(per)}`));

    const bulkDefs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      modules: {
        ...modulesJson,
        items: [...modulesJson.items, { ...modulesJson.items[6], id: 'ramp_bulk_test', params: { ...modulesJson.items[6].params, category: 'bulk' } }],
      },
    });
    const bulkWorld = build({ defs: bulkDefs, modules: [GATE, AREA, { ...RAMP, defId: 'ramp_bulk_test' }] });
    const bulkRamp = only(bulkWorld, LoadingRamp);
    expect(bulkRamp.category).toBe('bulk');
    const [unit] = stage(bulkWorld, bulkRamp, [0]);
    expect(findWorldViolation(bulkWorld)).toBe(`${bulkRamp.label} (kategória 'bulk') drží jednotku #${String(unit)} kategórie 'container'`);
  });
});
