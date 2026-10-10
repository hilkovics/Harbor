/**
 * Pevné view-modely pre demo renderu Fázy 2 (`f2-render.html`) — bez simu, aby šlo skontrolovať vzhľad a rotácie.
 *
 * Scéna `main` (screenshot `f2-render-demo.png`): berth na (40, 14) + žeriav na (43, 14) vo fáze `grabbing` (progress 0,5),
 * loď feeder `docked` pred berthom (stred 43; 13, kurz 90°), 2 kontajnery na aprone a ghost druhého berthu na (48, 14)
 * s konektormi. Scéna `rotated` overuje rotácie 90° a 180° (berth + žeriav + náklad + loď) a stav `blocked`.
 *
 * Geometria (rotácia footprintu, bunky žeriava vo footprinte berthu, konektory ghostu) sa počíta z manifestu a
 * `@sim/grid` rovnako ako v sime; `tests/render/f2-render-fixtures.test.ts` stráži, že scény sú konzistentné.
 */
import { rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';
import { moduleSprite, shipSprite } from '../entity-assets';
import type { CraneVM, EntitiesVM, ModuleGhostVM, ModuleVM, ShipVM, ViewSide } from '../view-models';

export const DEMO_BERTH_DEF = 'berth_standard';
export const DEMO_CRANE_DEF = 'crane_container_gantry';

/** Bunky berthu (rot 0), ktoré zaberá žeriav: stredné dva stĺpce (x 3–4) po celej hĺbke. Ľavý horný roh žeriava pri rot 0. */
export const CRANE_OFFSET_ON_BERTH = { x: 3, y: 0 } as const;

const SIDE_ORDER: readonly ViewSide[] = ['n', 'e', 's', 'w'];

/** Strana po otočení o `rotation` v smere hodinových ručičiek. */
export function rotateSide(side: ViewSide, rotation: Rotation): ViewSide {
  return SIDE_ORDER[(SIDE_ORDER.indexOf(side) + rotation / 90) % SIDE_ORDER.length];
}

function footprintOf(defId: string): { w: number; h: number } {
  const entry = moduleSprite(defId);
  if (entry === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  return entry.footprint;
}

/** Berth s ľavým horným rohom (x, y) PO rotácii. */
export function berthVM(id: number, x: number, y: number, rotation: Rotation, occupiedSlots: readonly number[]): ModuleVM {
  const base = footprintOf(DEMO_BERTH_DEF);
  const size = rotateFootprint(base.w, base.h, rotation);
  const slots = moduleSprite(DEMO_BERTH_DEF)?.apronSlots ?? [];
  return {
    id,
    defId: DEMO_BERTH_DEF,
    kind: 'berth',
    x,
    y,
    rotation,
    w: size.w,
    h: size.h,
    apron: {
      capacity: slots.length,
      units: occupiedSlots.map((slot, i) => ({ slot, unitId: id * 100 + i, typeId: 'container_teu' })),
    },
  };
}

/** Ľavý horný roh žeriava (footprint po rotácii) na berthe `berth` — žeriav stojí na bunkách kotviska (rozhodnutie 3). */
export function craneOrigin(berth: ModuleVM): { x: number; y: number } {
  const base = footprintOf(DEMO_BERTH_DEF);
  const crane = footprintOf(DEMO_CRANE_DEF);
  const cells = [
    rotateLocalCell(CRANE_OFFSET_ON_BERTH.x, CRANE_OFFSET_ON_BERTH.y, base.w, base.h, berth.rotation),
    rotateLocalCell(CRANE_OFFSET_ON_BERTH.x + crane.w - 1, CRANE_OFFSET_ON_BERTH.y + crane.h - 1, base.w, base.h, berth.rotation),
  ];
  return { x: berth.x + Math.min(cells[0].x, cells[1].x), y: berth.y + Math.min(cells[0].y, cells[1].y) };
}

export function craneVM(id: number, berth: ModuleVM, patch: Partial<CraneVM> = {}): CraneVM {
  const origin = craneOrigin(berth);
  return {
    id,
    defId: DEMO_CRANE_DEF,
    berthId: berth.id,
    x: origin.x,
    y: origin.y,
    rotation: berth.rotation,
    state: 'idle',
    progress: 0,
    holding: null,
    ...patch,
  };
}

/** Kapacita lode vo fixtúrach — renderer ju nepoužíva (variant sprite určuje `unitsOnBoard`). */
const DEMO_CAPACITY_UNITS = 16;

export function shipVM(id: number, classId: string, x: number, y: number, heading: Rotation, patch: Partial<ShipVM> = {}): ShipVM {
  const footprint = shipSprite(classId)?.footprint;
  if (footprint === undefined) throw new Error(`demo: trieda lode "${classId}" nie je v manifeste`);
  return {
    id,
    classId,
    cargoCategory: 'container',
    state: 'docked',
    x,
    y,
    prevX: x,
    prevY: y,
    heading,
    lengthCells: footprint.h,
    widthCells: footprint.w,
    unitsOnBoard: 4,
    capacityUnits: DEMO_CAPACITY_UNITS,
    ...patch,
  };
}

/** Ghost modulu `defId` na (x, y) po rotácii: footprint a konektory v svetových bunkách (strana otočená s modulom). */
export function moduleGhost(defId: string, x: number, y: number, rotation: Rotation, valid: boolean): ModuleGhostVM {
  const entry = moduleSprite(defId);
  if (entry === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const size = rotateFootprint(entry.footprint.w, entry.footprint.h, rotation);
  return {
    defId,
    x,
    y,
    rotation,
    w: size.w,
    h: size.h,
    valid,
    connectors: entry.connectors.map((connector) => {
      const cell = rotateLocalCell(connector.x, connector.y, entry.footprint.w, entry.footprint.h, rotation);
      return { x: x + cell.x, y: y + cell.y, side: rotateSide(connector.side, rotation) };
    }),
  };
}

const MAIN_BERTH = berthVM(1, 40, 14, 0, [0, 1]);

/** Scéna `main`: presne podľa karty T02-07. */
export const MAIN_SCENE: EntitiesVM = {
  modules: [MAIN_BERTH],
  cranes: [craneVM(2, MAIN_BERTH, { state: 'grabbing', progress: 0.5 })],
  ships: [shipVM(3, 'feeder', 43, 13, 90)],
};

/** Ghost druhého berthu vedľa prvého (48, 14); platný alebo neplatný (šrafa). */
export function mainGhost(valid: boolean): ModuleGhostVM {
  return moduleGhost(DEMO_BERTH_DEF, 48, 14, 0, valid);
}

const BERTH_EAST = berthVM(11, 44, 18, 90, [0, 1]);
const BERTH_SOUTH = berthVM(12, 54, 20, 180, [0, 1, 2, 3]);

/** Scéna `rotated`: berth 90° (voda na východe) so žeriavom s kontajnerom a loďou, berth 180° (voda na juhu) so zablokovaným žeriavom. */
export const ROTATED_SCENE: EntitiesVM = {
  modules: [BERTH_EAST, BERTH_SOUTH],
  cranes: [
    craneVM(21, BERTH_EAST, { state: 'placing', progress: 0.5, holding: { unitId: 900, typeId: 'container_teu' } }),
    craneVM(22, BERTH_SOUTH, { state: 'blocked' }),
  ],
  ships: [
    shipVM(31, 'feeder', 49, 22, 0),
    shipVM(32, 'handy', 58, 25, 270, { unitsOnBoard: 0 }),
  ],
};

/** Kam sa má pri scéne nasmerovať kamera (stred v bunkách) a zoom. */
export const SCENE_VIEW = {
  main: { centerX: 46, centerY: 14.5, zoom: 1 },
  rotated: { centerX: 52, centerY: 22, zoom: 0.6 },
} as const;

export type SceneId = keyof typeof SCENE_VIEW;

export const SCENES: Readonly<Record<SceneId, EntitiesVM>> = { main: MAIN_SCENE, rotated: ROTATED_SCENE };
