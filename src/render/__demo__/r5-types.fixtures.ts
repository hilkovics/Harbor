/**
 * Pevné view-modely pre demo renderu karty TR5-03 (`r5-types.html`, R5 reefery, OOG, reach stacker) — bez simu a bez UI.
 *
 * Scéna `types`: blok skladu (36; 19) so stohmi všetkých typov a veľkostí (reefer s odznakmi zásuvky on/off/alarm, open top, flat rack, tank 20′, OOG
 * varianty), rad `reefer_rack` (41; 20) so zásuvkami on/off/alarm/empty, plocha `oog_area` (36; 25) bez sprite (jednoduché dlaždice) a dva reach stackery
 * (jeden dvíha OOG flat rack 40′ s výložníkom takmer vysunutým, druhý 20′ tank s výložníkom zasunutým).
 *
 * `tests/render/r5-types-fixtures.test.ts` stráži konzistenciu (páry 40′ sú úplné, zásuvky ležia na racku).
 */
import { moduleSprite } from '../entity-assets';
import type { ContainerVM, EntitiesVM, MachineVM, ModuleVM, ReeferPlugVM, StackGeometryVM, StackVM } from '../view-models';
import { type R1Scene } from './r1-traffic.fixtures';
import { BLUE, AMBER, TEAL, stack20, stack40 } from './r2-stacks.fixtures';

export type R5Scene = R1Scene;

export const BLOCK_ID = 3;
export const RACK_FIRST_ID = 20;
export const OOG_AREA_ID = 30;
export const BLOCK_X = 36;
export const BLOCK_Y = 19;
export const RACK_X = 41;
export const RACK_Y = 20;
export const RACK_LENGTH = 4;

/** Kontajner typu `type` (plný, import) veľkosti `sizeFt` s linkou, OOG a stavom zásuvky. */
export function typed(sizeFt: 20 | 40, containerType: string, lineId: string | null, extra: { oog?: boolean; reefer?: ContainerVM['reefer'] } = {}): ContainerVM {
  return { sizeFt, containerType, lineId, direction: 'import', ...extra };
}

export const BLOCK_GEOMETRY: StackGeometryVM = { bays: 4, rows: 4, maxTier: 3 };

export const BLOCK_STACKS: readonly StackVM[] = [
  // rad 0: reefery 20′ (zapojený, porucha) a 40′ (odpojený)
  stack20(0, 0, 2, typed(20, 'reefer', BLUE, { reefer: 'on' })),
  stack20(1, 0, 1, typed(20, 'reefer', AMBER, { reefer: 'alarm' })),
  ...stack40(1, 0, 2, typed(40, 'reefer', TEAL, { reefer: 'off' })),
  // rad 1: open top 20′, flat rack 20′, open top 40′ OOG
  stack20(0, 1, 1, typed(20, 'open_top', BLUE)),
  stack20(1, 1, 2, typed(20, 'flat_rack', AMBER)),
  ...stack40(1, 1, 1, typed(40, 'open_top', TEAL, { oog: true })),
  // rad 2: tank 20′, dry 20′, flat rack 40′
  stack20(0, 2, 1, typed(20, 'tank', BLUE)),
  stack20(1, 2, 1, typed(20, 'dry', AMBER)),
  ...stack40(1, 2, 1, typed(40, 'flat_rack', TEAL)),
  // rad 3: flat rack 40′ OOG, open top 40′, reefer 40′ zapojený
  ...stack40(0, 3, 1, typed(40, 'flat_rack', BLUE, { oog: true })),
  ...stack40(1, 3, 1, typed(40, 'reefer', AMBER, { reefer: 'on' })),
];

function block(): ModuleVM {
  const base = moduleSprite('container_yard_small')?.footprint;
  if (base === undefined) throw new Error('demo: container_yard_small nie je v manifeste');
  const stored = BLOCK_STACKS.reduce((sum, stack) => sum + stack.height, 0);
  return {
    id: BLOCK_ID,
    defId: 'container_yard_small',
    kind: 'storage',
    x: BLOCK_X,
    y: BLOCK_Y,
    rotation: 0,
    w: base.w,
    h: base.h,
    connected: true,
    storage: { capacity: BLOCK_GEOMETRY.bays * BLOCK_GEOMETRY.rows * BLOCK_GEOMETRY.maxTier, stored, reserved: 0 },
    stackGeometry: BLOCK_GEOMETRY,
    stacks: BLOCK_STACKS,
  };
}

/** Stavy zásuviek racku: 4 moduly × 4 zásuvky (stĺpiky x 16 a 48 px, rady y 26 a 38 px zo sprite). */
const PLUG_STATES: readonly ReeferPlugVM['state'][] = [
  'on', 'on', 'on', 'off',
  'on', 'alarm', 'on', 'on',
  'off', 'off', 'empty', 'on',
  'alarm', 'on', 'empty', 'empty',
];

/** Zásuvky modulu racku `index` (bunka RACK_X + index): bod zásuvky v bunkách sveta. */
export function rackPlugs(index: number): ReeferPlugVM[] {
  const sockets = [
    { x: 16, y: 26 },
    { x: 16, y: 38 },
    { x: 48, y: 26 },
    { x: 48, y: 38 },
  ];
  return sockets.map((socket, i) => ({ x: RACK_X + index + socket.x / 64, y: RACK_Y + socket.y / 64, state: PLUG_STATES[index * 4 + i] ?? 'empty' }));
}

function racks(): ModuleVM[] {
  const base = moduleSprite('reefer_rack')?.footprint;
  if (base === undefined) throw new Error('demo: reefer_rack nie je v manifeste');
  return Array.from({ length: RACK_LENGTH }, (_, i) => ({
    id: RACK_FIRST_ID + i,
    defId: 'reefer_rack',
    kind: 'storage',
    x: RACK_X + i,
    y: RACK_Y,
    rotation: 0,
    w: base.w,
    h: base.h,
    connected: true,
    plugs: rackPlugs(i),
  }));
}

/** Plocha OOG: bez sprite v manifeste, kreslí sa ako jednoduché dlaždice modulu. */
function oogArea(): ModuleVM {
  return { id: OOG_AREA_ID, defId: 'oog_area', kind: 'storage', x: 36, y: 25, rotation: 0, w: 3, h: 2, connected: true };
}

export const OOG_FLAT_RACK = typed(40, 'flat_rack', BLUE, { oog: true });

/** Reach stackery: prvý dvíha OOG flat rack 40′ (výložník vysunutý), druhý drží 20′ tank so zasunutým výložníkom. */
export const MACHINES: readonly MachineVM[] = [
  { id: 41, defId: 'reach_stacker', blockId: 0, x: 44.5, y: 26, trolley: 0, hoist: 0, state: 'lifting', cargo: OOG_FLAT_RACK, boom: 0.9 },
  { id: 42, defId: 'reach_stacker', blockId: 0, x: 47.5, y: 26, trolley: 0, hoist: 0, state: 'moving', cargo: typed(20, 'tank', AMBER), boom: 0.2 },
];

export const VM: EntitiesVM = { modules: [block(), ...racks(), oogArea()], cranes: [], ships: [], vehicles: [], trucks: [], machines: MACHINES };

export const R5_SCENES = Object.freeze({
  types: { roads: [], vm: VM, view: { centerX: 42.5, centerY: 23.2, zoom: 0.7 } } satisfies R5Scene,
});
export type R5SceneName = keyof typeof R5_SCENES;
