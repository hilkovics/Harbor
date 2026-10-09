// Pozemný reťazec vo svete (T04-02, ADR-022; R4, ADR-041): strany pruhov brány (jednosmerné, prvý konektor = vonkajšia strana), priechod stojiskom, prevádzkovosť
// rampy s dôvodom, zverejnenie do modulov a RampOperationalChanged po príkazoch, cache podľa roadVersion + moduleVersion,
// save/load (nič z toho sa neukladá), pravidlo has_cargo pre rampu, obnova a invarianty jednotiek at_ramp, viac portálov a predbránová plocha.
//
// Rozloženie na harbor_01 (starter parcela x 30–57, y 14–33; road portál vjazdu (44, 63), verejná cesta x = 44, y 34..63) je
// to isté ako v TDD scenári T04-05 (`full_import_chain`, `helpers/f4-layout.ts`), len bez dvorov a vozidiel:
//   vstupný pruh (45, 33) rot 90 — konektor 0 (w) (45, 33) → vonkajšia (44, 33), konektor 1 (e) (48, 33) → (49, 33);
//   výstupný pruh (45, 32) rot 270 — konektor 0 (e) (48, 32) → vonkajšia (49, 32), konektor 1 (w) (45, 32) → (44, 32);
//   stojisko (53, 31) rot 0 — konektory w (53, 33) → (52, 33) a e (56, 33) → (57, 33);
//   rampa (53, 28) rot 0 — konektory s (54, 29) → (54, 30) a s (55, 29) → (55, 30).
// Cesty: (44, 33) vstup; (44, 32) výstup výstupného pruhu; (49..52, 33) výstup vstupného pruhu → západ stojiska; (49, 32) vstup výstupného pruhu;
// (57, 31..33) východ stojiska → (57, 30), (56, 30); (51..55, 30) k rampe. Vstupný pruh je jediné spojenie s portálom, stojisko jediné spojenie
// výstupu vstupného pruhu s rampou (späť ide kamión prechodom telom stojiska k vstupu výstupného pruhu).
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { describe, expect, it } from 'vitest';
import { RemoveModuleCommand, commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { NO_ACCESS } from '@sim/logistics';
import { LoadingRamp, PreGateBuffer, TruckGate, WaitingArea, type Module, type RampInoperativeReason } from '@sim/modules';
import { NO_GATE_SIDES, World, WorldStateError, findRemovalViolations, findWorldViolation, type WorldState } from '@sim/world';
import { loadMap, parseMapDef, type CellCoord } from '@sim/grid';
import { DEFS, LEGACY_HARBOR_JSON, MAP, PORT_MAP, RAW_DEFS, SEED } from './world-fixtures';

const GATE = { defId: 'gate_in_lane', x: 45, y: 33, rotation: 90 } as const;
const GATE_OUT = { defId: 'gate_out_lane', x: 45, y: 32, rotation: 270 } as const;
const AREA = { defId: 'truck_waiting_area', x: 53, y: 31, rotation: 0 } as const;
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
  gateOutExit: [{ x: 44, y: 32 }],
  gateExit: row(33, 49, 52),
  gateOutEntry: [{ x: 49, y: 32 }],
  truckLink: column(57, 31, 33),
  rampRow: row(30, 51, 55),
  rampLink: row(30, 56, 57),
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

function build({ modules = [GATE, AREA, RAMP, GATE_OUT], omit = [], extraRoads = [], defs = DEFS }: Layout = {}): World {
  const world = World.create(defs, MAP, SEED);
  apply(world, ...roadCommands(omit, extraRoads), ...modules.map(place));
  return world;
}

function only<T extends Module>(world: World, cls: abstract new (...args: never[]) => T): T {
  const found = [...world.modules.values()].filter((module): module is T => module instanceof cls);
  if (found.length !== 1) throw new Error(`očakávaný práve jeden ${cls.name}, je ${String(found.length)}`);
  return found[0];
}

/** Pruh brány daného smeru (vo svete je práve jeden). */
function lane(world: World, direction: 'in' | 'out'): TruckGate {
  const found = [...world.modules.values()].filter((module): module is TruckGate => module instanceof TruckGate && module.direction === direction);
  if (found.length !== 1) throw new Error(`očakávaný práve jeden pruh '${direction}', je ${String(found.length)}`);
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

describe('strany pruhov brány (jednosmerné, ADR-041 bod 1)', () => {
  it('vstupný pruh rot 90: vstup = prvý konektor w (45, 33) s vonkajšou bunkou (44, 33) z portálu, výstup = e (48, 33) → (49, 33); výstupný pruh rot 270: vstup e (48, 32) → (49, 32), výstup w (45, 32) → (44, 32)', () => {
    const world = build();
    const gate = lane(world, 'in');
    expect(gate.entrySide).toEqual({ x: 45, y: 33, side: 'w', type: 'road' });
    expect(gate.exitSide).toEqual({ x: 48, y: 33, side: 'e', type: 'road' });
    const sides = world.gateSides(gate);
    expect([sides.entry, sides.exit]).toEqual([gate.entrySide, gate.exitSide]);
    expect([sides.entryCell, sides.exitCell]).toEqual([idx(world, { x: 44, y: 33 }), idx(world, { x: 49, y: 33 })]);
    const out = lane(world, 'out');
    expect(out.entrySide).toEqual({ x: 48, y: 32, side: 'e', type: 'road' });
    expect(out.exitSide).toEqual({ x: 45, y: 32, side: 'w', type: 'road' });
    expect([world.gateSides(out).entryCell, world.gateSides(out).exitCell]).toEqual([idx(world, { x: 49, y: 32 }), idx(world, { x: 44, y: 32 })]);
    expect(world.landside.portalCell).toBe(idx(world, { x: 44, y: 63 }));
    expect(world.landside.inLanes).toEqual([gate]);
    expect(world.landside.outLanes).toEqual([out]);
  });

  it('rot 0 (konektory s / n): vstup je južný (vonkajšia bunka (44, 34) na verejnej ceste), výstup severný', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, { type: 'PlaceRoad', cells: [{ x: 44, y: 29 }] }, place({ defId: 'gate_in_lane', x: 44, y: 30, rotation: 0 }));
    const gate = lane(world, 'in');
    expect(gate.entrySide).toMatchObject({ x: 44, y: 33, side: 's' });
    expect(gate.exitSide).toMatchObject({ x: 44, y: 30, side: 'n' });
    expect(world.gateSides(gate).entryCell).toBe(idx(world, { x: 44, y: 34 }));
  });

  it('strany sú nezávislé od portálu: pruh bez cesty z portálu má strany, ale nie je platný vstupný pruh; bez cesty na vstupe je strana null, výstup ostáva', () => {
    const noPortalRoad = build({ omit: [...ROADS.gateApproach] });
    const gate = lane(noPortalRoad, 'in');
    expect([gate.entrySide, gate.exitSide === null]).toEqual([null, false]);
    expect(noPortalRoad.gateSides(gate)).toMatchObject({ entryCell: NO_ACCESS, exitCell: idx(noPortalRoad, { x: 49, y: 33 }) });
    expect(noPortalRoad.landside.inLanes).toEqual([]);

    const noExit = build({ omit: ROADS.gateExit });
    const exitless = lane(noExit, 'in');
    expect(exitless.entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
    expect(exitless.exitSide).toBeNull();
    expect(noExit.landside.inLanes).toEqual([]);

    const noRoads = World.create(DEFS, MAP, SEED);
    apply(noRoads, place(GATE));
    expect(noRoads.gateSides(lane(noRoads, 'in'))).toEqual(NO_GATE_SIDES);
  });

  it('výstupný pruh je platný, len keď jeho výstup vedie k portálu výjazdu; vstupný pruh sa vo výstupných nepočíta', () => {
    const world = build();
    expect(world.landside.outLanes.map((candidate) => candidate.direction)).toEqual(['out']);
    const cut = build({ omit: ROADS.gateOutExit });
    expect(cut.landside.outLanes).toEqual([]);
    expect(cut.landside.inLanes).toHaveLength(1);
  });
});

describe('prevádzkovosť rampy (rozhodnutie 1): dôvody a trasy', () => {
  const CASES: readonly [string, Layout, RampInoperativeReason | null][] = [
    ['kompletné rozloženie', {}, null],
    ['bez vstupného pruhu', { modules: [AREA, RAMP, GATE_OUT] }, 'no_gate'],
    ['bez výstupného pruhu (cesta späť nie je)', { modules: [GATE, AREA, RAMP] }, 'no_return_path'],
    ['vstupný pruh bez cesty z portálu (chýba (44, 33))', { omit: ROADS.gateApproach }, 'no_gate'],
    ['vstupný pruh bez cesty na výstupe', { omit: ROADS.gateExit }, 'no_gate'],
    ['výstupný pruh bez cesty na vstupe (chýba (49, 32))', { omit: ROADS.gateOutEntry }, 'no_return_path'],
    ['výstupný pruh bez cesty na výstupe (chýba (44, 32))', { omit: ROADS.gateOutExit }, 'no_return_path'],
    ['bez stojiska', { modules: [GATE, RAMP, GATE_OUT] }, 'no_waiting_area'],
    ['rampa bez cesty na konektoroch', { omit: RAMP_OUTSIDE }, 'not_connected'],
    ['stojisko za bránou je, ale z neho k rampe cesta nevedie', { omit: ROADS.truckLink }, 'not_connected'],
    [
      'rampa pred bránou (na ceste z portálu), stojisko za bránou',
      { modules: [GATE, AREA, { ...RAMP, x: 39, y: 31 }, GATE_OUT], extraRoads: [row(33, 40, 43)] },
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

  it('trasa: vstupný pruh (44, 33) → (49, 33), stojisko (52, 33) → (57, 33), rampa (55, 30) — najbližšia bunka rampy od východu stojiska', () => {
    const world = build();
    const ramp = only(world, LoadingRamp);
    expect(world.landsideRoutes(ramp)).toEqual([
      {
        gateId: lane(world, 'in').id,
        gateEntryCell: idx(world, { x: 44, y: 33 }),
        gateExitCell: idx(world, { x: 49, y: 33 }),
        waitingAreaId: only(world, WaitingArea).id,
        waitingEntryCell: idx(world, { x: 52, y: 33 }),
        waitingExitCell: idx(world, { x: 57, y: 33 }),
        rampCell: idx(world, { x: 55, y: 30 }),
      },
    ]);
  });

  it('viac vstupných pruhov: trasa cez každý platný pruh v poradí id pruhu (ADR-041 bod 1: pruhy sú nezávislé)', () => {
    // Druhý vstupný pruh (45, 31) rot 90 s vstupom (44, 31) z cesty x = 44 a výstupom (49, 31) napojeným na výstup prvého pruhu cez (49, 32).
    const world = build({
      modules: [GATE, { ...GATE, y: 31 }, AREA, RAMP, GATE_OUT],
      extraRoads: [[{ x: 44, y: 31 }], [{ x: 49, y: 31 }]],
      omit: [],
    });
    const ramp = only(world, LoadingRamp);
    const lanes = world.landside.inLanes;
    expect(lanes).toHaveLength(2);
    expect(lanes[0].id).toBeLessThan(lanes[1].id);
    // (44, 31) je dosiahnuteľné z portálu len cez (44, 32), ktoré je výstupom výstupného pruhu — cesta je dvojpruhová, takže platí.
    expect(world.landsideRoutes(ramp).map((route) => route.gateId)).toEqual([lanes[0].id, lanes[1].id]);
  });

  it('stojisko s jediným použiteľným konektorom poslúži ako slepé parkovisko (vstup = výstup)', () => {
    const world = build({ omit: ROADS.truckLink, extraRoads: [column(52, 31, 32)] });
    const ramp = only(world, LoadingRamp);
    expect(world.isRampOperational(ramp)).toBe(true);
    const [route] = world.landsideRoutes(ramp);
    expect([route.waitingEntryCell, route.waitingExitCell]).toEqual([idx(world, { x: 52, y: 33 }), idx(world, { x: 52, y: 33 })]);
  });

  it('dve stojiská za bránou: trasa cez každé, v poradí id stojiska (nie podľa vzdialenosti)', () => {
    // Druhé stojisko (45..48, 27..29): w (45, 29) → (44, 29), e (48, 29) → (49, 29); (49, 29..31) napojí (49, 32), (44..50, 30) vetvu k rampe.
    const second = { defId: 'truck_waiting_area', x: 45, y: 27, rotation: 0 } as const;
    const world = build({
      modules: [GATE, second, AREA, RAMP, GATE_OUT],
      extraRoads: [[...column(49, 29, 31), { x: 44, y: 29 }], row(30, 44, 50)],
    });
    const ramp = only(world, LoadingRamp);
    const [secondArea, firstArea] = [...world.modules.values()].filter((module) => module instanceof WaitingArea);
    expect(world.landsideRoutes(ramp).map((route) => route.waitingAreaId)).toEqual([secondArea.id, firstArea.id]);
    expect(world.landsideRoutes(ramp)[1]).toMatchObject({ waitingEntryCell: idx(world, { x: 52, y: 33 }), waitingExitCell: idx(world, { x: 57, y: 33 }) });
  });

  it('nerampové moduly a neznáme id nie sú prevádzkové rampy', () => {
    const world = build();
    expect(world.isRampOperational(lane(world, 'in'))).toBe(false);
    expect(world.isRampOperational(999 as EntityId)).toBe(false);
  });

  it('pozemné moduly ide postaviť v ľubovoľnom poradí aj bez ciest (rampa bez cesty = not_connected)', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, place(RAMP), place(GATE_OUT), place(GATE), place(AREA));
    expect(world.rampStatus(only(world, LoadingRamp)).reason).toBe('not_connected');
    expect(world.gateSides(lane(world, 'in'))).toEqual(NO_GATE_SIDES);
  });
});

describe('cesta späť (review T04-11, major 1): trasa len s cestou rampa → výstupný pruh → portál', () => {
  const oneWay = (cell: CellCoord, dir: 'N' | 'E' | 'S' | 'W'): SerializedCommand => ({ type: 'PlaceRoad', cells: [cell], kind: 'one_way', dirs: [dir] });

  it.each<[string, CellCoord, 'N' | 'E' | 'S' | 'W']>([
    ['jednosmerka (50, 33) smerom od vstupného pruhu (E): od stojiska sa k výstupnému pruhu nedá vrátiť', { x: 50, y: 33 }, 'E'],
    ['jednosmerka na výstupe výstupného pruhu (44, 32) smerom od portálu nepomôže, (44, 33) smerom k bráne (N): od výstupného pruhu sa k portálu výjazdu nedá ísť', { x: 44, y: 33 }, 'N'],
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
    const noArea = build({ modules: [GATE, RAMP, GATE_OUT] });
    apply(noArea, oneWay({ x: 50, y: 33 }, 'E'));
    expect(noArea.rampStatus(only(noArea, LoadingRamp)).reason).toBe('no_waiting_area');
    const noLink = build({ omit: ROADS.truckLink });
    apply(noLink, oneWay({ x: 50, y: 33 }, 'E'));
    expect(noLink.rampStatus(only(noLink, LoadingRamp)).reason).toBe('not_connected');
  });

  it('okruh: s cestou späť returns = true a trasa = okruh; jednosmerka (50, 33) E → okruh len tam (returns = false)', () => {
    const world = build();
    const [gate, area, ramp] = [lane(world, 'in'), only(world, WaitingArea), only(world, LoadingRamp)];
    const [route] = world.landsideRoutes(ramp);
    expect(world.landside.circuit(gate, area, ramp)).toEqual({
      gateInnerCell: route.gateExitCell,
      waitingEntryCell: route.waitingEntryCell,
      waitingExitCell: route.waitingExitCell,
      rampCell: route.rampCell,
      returns: true,
    });
    apply(world, oneWay({ x: 50, y: 33 }, 'E'));
    expect(world.landside.circuit(gate, area, ramp)).toMatchObject({ gateInnerCell: idx(world, { x: 49, y: 33 }), returns: false });
    expect(world.landside.circuit(gate, area, gate)).toBeUndefined();
  });

  it('okruh obslúži bunku rampy len ak je dosiahnuteľná z výstupu stojiska a má cestu späť; cudzia bunka a NO_ACCESS nie', () => {
    const world = build();
    const [gate, area, ramp] = [lane(world, 'in'), only(world, WaitingArea), only(world, LoadingRamp)];
    const circuit = world.landside.circuit(gate, area, ramp);
    if (circuit === undefined) throw new Error('okruh chýba');
    expect(world.landside.circuitServesCell(circuit, idx(world, { x: 54, y: 30 }))).toBe(true);
    expect(world.landside.circuitServesCell(circuit, idx(world, { x: 55, y: 30 }))).toBe(true);
    expect(world.landside.circuitServesCell(circuit, idx(world, { x: 44, y: 33 }))).toBe(false);
    expect(world.landside.circuitServesCell(circuit, NO_ACCESS)).toBe(false);
  });

  it('kamión s okruhom bez vstupnej cesty: okruh za pruhom ostáva (strany sú nezávislé), rampa je neprevádzková (no_gate)', () => {
    const world = build();
    const [gate, area, ramp] = [lane(world, 'in'), only(world, WaitingArea), only(world, LoadingRamp)];
    apply(world, { type: 'RemoveRoad', cells: ROADS.gateApproach });
    expect(world.gateSides(gate)).toMatchObject({ entry: null, entryCell: NO_ACCESS, exitCell: idx(world, { x: 49, y: 33 }) });
    expect(world.rampStatus(ramp).reason).toBe('no_gate');
    // Vstup (44, 33) je zároveň cestou výstupného pruhu k portálu výjazdu, takže ani cesta späť neexistuje (returns = false), ale okruh dopredu ostáva.
    expect(world.landside.circuit(gate, area, ramp)).toMatchObject({ gateInnerCell: idx(world, { x: 49, y: 33 }), waitingEntryCell: idx(world, { x: 52, y: 33 }), returns: false });
  });
});

describe('viac portálov (R4, ADR-041 bod 3)', () => {
  /** Mapa harbor_01 (legacy) s tromi cestnými portálmi: dva vjazdy (podiel 3 : 1) a jeden výjazd. */
  const MULTI_MAP = loadMap(
    parseMapDef({
      ...LEGACY_HARBOR_JSON,
      roadPortals: [
        { id: 'road_south', cell: { x: 44, y: 63 }, direction: 'in', trafficShare: 3 },
        { id: 'road_south_2', cell: { x: 42, y: 63 }, direction: 'in', trafficShare: 1 },
        { id: 'road_south_out', cell: { x: 46, y: 63 }, direction: 'out' },
      ],
    }),
  );

  it('portál vjazdu je použiteľný, len keď z neho vedie cesta k vstupu pruhu; podiel trafficShare; výjazd je najbližší portál výjazdu', () => {
    const world = World.create(DEFS, MULTI_MAP, SEED);
    apply(world, ...roadCommands(), ...[GATE, AREA, RAMP, GATE_OUT].map(place));
    // Druhý vjazd a výjazd zatiaľ bez ciest: portál bez cesty na svojej bunke sa nepoužije.
    expect(world.landside.inPortals).toEqual([{ cell: idx(world, { x: 44, y: 63 }), share: 3 }]);
    expect(world.landside.outPortals).toEqual([]);
    apply(world, { type: 'PlaceRoad', cells: [...column(46, 34, 63), { x: 45, y: 34 }] });
    expect(world.landside.outPortals).toEqual([{ cell: idx(world, { x: 46, y: 63 }), share: 1 }]);
    expect(world.landside.nearestExitPortal(idx(world, { x: 44, y: 32 }))).toBe(idx(world, { x: 46, y: 63 }));
    // Druhý vjazd s cestou k (44, 34): obaja majú podiel v poradí mapy.
    apply(world, { type: 'PlaceRoad', cells: [...column(42, 34, 63), ...row(34, 42, 43)] });
    expect(world.landside.inPortals).toEqual([
      { cell: idx(world, { x: 44, y: 63 }), share: 3 },
      { cell: idx(world, { x: 42, y: 63 }), share: 1 },
    ]);
    expect(world.landside.inLanes).toHaveLength(1);
    expect(world.landside.outPortalCells).toEqual(Int32Array.of(idx(world, { x: 46, y: 63 })));
  });

  it('skutočná harbor_01 má druhý (západný) portál vjazdu a výjazdu; bez ciest k vstupu brány ich sieť nepoužije', () => {
    const world = World.create(DEFS, PORT_MAP, SEED);
    expect(PORT_MAP.roadPortals.map((portal) => [portal.id, portal.direction, portal.trafficShare])).toEqual([
      ['road_south_in', 'in', 0.6],
      ['road_south_out', 'out', undefined],
      ['road_west_in', 'in', 0.4],
      ['road_west_out', 'out', undefined],
    ]);
    expect(world.landside.inPortals).toEqual([]);
    expect(world.landside.outPortals.map((portal) => portal.cell)).toEqual([idx(world, { x: 45, y: 63 }), idx(world, { x: 0, y: 61 })]);
  });
});

describe('predbránová plocha (R4, ADR-041 bod 2)', () => {
  const BUFFER = { defId: 'pre_gate_buffer', x: 44, y: 26, rotation: 0 } as const;

  it('plocha 8×8 s vjazdom (44, 34) a výjazdom (51, 25): platná, keď vjazd je z portálu a z výjazdu je dosiahnuteľný vstupný pruh; pruh radu r = lanes[r mod počet]', () => {
    // Vjazd (0, 7, s) → vonkajšia (44, 34); výjazd (7, 0, n) → vonkajšia (51, 25); vstupný pruh (50, 21) rot 0 (1×4, y 21..24) má vstup (50, 25) a výstup (50, 20).
    const world = World.create(DEFS, MAP, SEED);
    apply(
      world,
      { type: 'PlaceRoad', cells: [...row(25, 50, 51), { x: 50, y: 20 }] },
      place(BUFFER),
      place({ defId: 'gate_in_lane', x: 50, y: 21, rotation: 0 }),
    );
    const buffer = only(world, PreGateBuffer);
    expect(world.landside.preGateLanes(buffer).map((candidate) => candidate.direction)).toEqual(['in']);
    expect(world.landside.preGateOf(lane(world, 'in'), world.landsideModules.preGates)).toBe(buffer);
    // Pruh je platný vďaka ploche (z portálu nevedie k jeho vstupu žiadna cesta mimo plochy) a portál vjazdu je použiteľný cez vjazd plochy.
    expect(world.landside.inLanes).toEqual([lane(world, 'in')]);
    expect(world.landside.inPortals.map((portal) => portal.cell)).toEqual([idx(world, { x: 44, y: 63 })]);
  });

  it('plocha bez pruhu za výjazdom nie je platná: preGateLanes je prázdne a pruh bez plochy nemá preGateOf', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, { type: 'PlaceRoad', cells: [{ x: 51, y: 25 }] }, place(BUFFER));
    expect(world.landside.preGateLanes(only(world, PreGateBuffer))).toEqual([]);
    const plain = build();
    expect(plain.landside.preGateOf(lane(plain, 'in'), plain.landsideModules.preGates)).toBeUndefined();
  });
});

describe('zverejnenie a RampOperationalChanged', () => {
  it('stavba WA → rampa → pruhy, RemoveRoad vstupu, iná cesta, návrat vstupu: udalosť len pri zmene, po udalostiach príkazu', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(rampEvents(apply(world, ...roadCommands(), place(AREA)))).toEqual([]);

    const rampPlaced = apply(world, place(RAMP));
    const ramp = only(world, LoadingRamp);
    expect(rampEvents(rampPlaced)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    expect(rampPlaced.findIndex((event) => event.type === 'ModulePlaced')).toBeLessThan(rampPlaced.findIndex((event) => event.type === 'RampOperationalChanged'));
    expectPublished(world, ramp);

    // Vstupný pruh bez výstupného: okruh je len tam (no_return_path), až výstupný pruh rampu sprevádzkuje.
    expect(rampEvents(apply(world, place(GATE)))).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_return_path' }]);
    const outPlaced = apply(world, place(GATE_OUT));
    expect(rampEvents(outPlaced)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null }]);
    expect(outPlaced.at(-1)?.type).toBe('RampOperationalChanged');
    expectPublished(world, ramp);

    const cut = apply(world, { type: 'RemoveRoad', cells: ROADS.gateApproach });
    expect(rampEvents(cut)).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    expect(cut.findIndex((event) => event.type === 'RoadChanged')).toBeLessThan(cut.findIndex((event) => event.type === 'RampOperationalChanged'));
    expect(lane(world, 'in').entrySide).toBeNull();

    expect(rampEvents(apply(world, { type: 'PlaceRoad', cells: [{ x: 32, y: 25 }] }))).toEqual([]);
    expect(rampEvents(world.tick())).toEqual([]);
    expect(rampEvents(apply(world, { type: 'PlaceRoad', cells: ROADS.gateApproach }))).toEqual([
      { type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null },
    ]);
    expect(lane(world, 'in').entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
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
    world.removeModule(lane(world, 'in').id);
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
      world.gateSides(lane(world, 'in'));
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
  it('prevádzkovosť ani strany sa neukladajú: obnova ich odvodí ticho, ďalší priebeh je rovnaký; režim pruhu sa ukladá', () => {
    const world = build();
    apply(world, { type: 'SetGateLaneMode', laneId: lane(world, 'out').id, mode: 'express' });
    world.tick();
    const state = world.serialize();
    const gateEntry = state.modules.find((entry) => entry.defId === 'gate_in_lane');
    expect(gateEntry?.runtime).toEqual({ queue: [], busyTicksLeft: 0, trucksProcessed: 0, mode: 'standard', passPlan: [], passTotalTicks: 0 });
    const outEntry = state.modules.find((entry) => entry.defId === 'gate_out_lane');
    expect(outEntry?.runtime).toMatchObject({ mode: 'express' });
    const runtimeOf = (defId: string): unknown => state.modules.find((entry) => entry.defId === defId)?.runtime;
    expect([runtimeOf('truck_waiting_area'), runtimeOf('loading_ramp_container')]).toEqual([{}, { lastNoWaitingBayHour: null }]);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)) as WorldState);
    const ramp = only(restored, LoadingRamp);
    expect([ramp.operational, ramp.inoperativeReason]).toEqual([true, null]);
    expect(lane(restored, 'in').entrySide).toEqual(lane(world, 'in').entrySide);
    expect(lane(restored, 'out').mode).toBe('express');
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

const rampItem = modulesJson.items.find((item) => item.id === 'loading_ramp_container') as (typeof modulesJson.items)[number];

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
    expect(findRemovalViolations(world, lane(world, 'in'))).toEqual([]);
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
        items: [...modulesJson.items, { ...rampItem, id: 'ramp_bulk_test', params: { ...rampItem.params, category: 'bulk' } }],
      },
    });
    const bulkWorld = build({ defs: bulkDefs, modules: [GATE, AREA, { ...RAMP, defId: 'ramp_bulk_test' }, GATE_OUT] });
    const bulkRamp = only(bulkWorld, LoadingRamp);
    expect(bulkRamp.category).toBe('bulk');
    const [unit] = stage(bulkWorld, bulkRamp, [0]);
    expect(findWorldViolation(bulkWorld)).toBe(`${bulkRamp.label} (kategória 'bulk') drží jednotku #${String(unit)} kategórie 'container'`);
  });
});
