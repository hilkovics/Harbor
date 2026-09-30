import { Container, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';
import { QUEUE_BADGE_MAX, queueBadgeLabel } from '@render/badges';
import { QUEUE_BADGE_SIZE, moduleSprite } from '@render/entity-assets';
import { SIDE_STEP } from '@render/footprint-pose';
import { BARRIER_MOTION_MS, BarrierMotion, GateDecor, queueBadgePosition } from '@render/gate-decor';
import { VEHICLE_WIDTH_PX } from '@render/lane';
import { footprintPose } from '@render/footprint-pose';
import { ModuleLayer } from '@render/module-layer';
import { ModuleView } from '@render/module-view';
import type { ModuleVM, ViewSide } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Posun odznaku naľavo od osi vjazdu: okraj kamióna (polovica jeho šírky) + polomer odznaku, px. */
const LANE_PX = (VEHICLE_WIDTH_PX + QUEUE_BADGE_SIZE.w) / 2;

/** Riadené hodiny pre animáciu závory. */
function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function deps(textures: StubTextures | null, now?: () => number) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, ...(now === undefined ? {} : { now }) };
}

/** Brána 2×2 s ľavým horným rohom (44; 32) po rotácii. */
function gate(
  over: Partial<ModuleVM> = {},
  state: { queueLength: number; open: boolean; entryConnector?: number } = { queueLength: 0, open: false },
  rotation: Rotation = 0,
): ModuleVM {
  const size = rotateFootprint(2, 2, rotation);
  return { id: 7, defId: 'truck_gate', kind: 'gate', x: 44, y: 32, rotation, w: size.w, h: size.h, connected: true, gate: state, ...over };
}

function gateDecor(view: ModuleView): GateDecor {
  const decor = view.decor<GateDecor>('gate');
  if (decor === undefined) throw new Error('ModuleView nemá ozdobu brány');
  return decor;
}

describe('BarrierMotion (uhol závory v čase)', () => {
  it('zatvorená = closedDeg, otvorená = openDeg; bez pohybu žiadny prechod', () => {
    const time = clock();
    const closed = new BarrierMotion(0, -90, 150, time.now, false);
    expect(closed.angle).toBe(0);
    expect(closed.open).toBe(false);
    const open = new BarrierMotion(0, -90, 150, time.now, true);
    expect(open.angle).toBe(-90);
    expect(open.open).toBe(true);
  });

  it('otvorenie beží lineárne po celé trvanie a potom drží openDeg', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    expect(motion.angle).toBe(0);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(-45, 9);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(-90, 9);
    time.advance(1000);
    expect(motion.angle).toBe(-90);
  });

  it('zmena cieľa uprostred pohybu začne z aktuálneho uhla (žiadny skok)', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    time.advance(50);
    const halfway = motion.angle;
    expect(halfway).toBeCloseTo(-30, 9);
    motion.setOpen(false);
    expect(motion.angle).toBeCloseTo(halfway, 9);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(halfway / 2, 9);
  });

  it('opakované setOpen na ten istý cieľ pohyb nerestartuje', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    time.advance(75);
    motion.setOpen(true);
    expect(motion.angle).toBeCloseTo(-45, 9);
  });

  it('nulové trvanie = okamžitý prechod; trvanie je pod limitom 200 ms z DESIGN_BRIEF §6.4', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 0, time.now, false);
    motion.setOpen(true);
    expect(motion.angle).toBe(-90);
    expect(BARRIER_MOTION_MS).toBeLessThanOrEqual(200);
  });
});

describe('queueBadgeLabel', () => {
  it('číslo fronty; nad QUEUE_BADGE_MAX „99+“', () => {
    expect(queueBadgeLabel(3)).toBe('3');
    expect(queueBadgeLabel(QUEUE_BADGE_MAX)).toBe('99');
    expect(queueBadgeLabel(QUEUE_BADGE_MAX + 1)).toBe('99+');
    expect(queueBadgeLabel(-2)).toBe('0');
  });
});

describe('queueBadgePosition (odznak pri vstupnom konektore)', () => {
  const entry = moduleSprite('truck_gate');
  const pose = footprintPose({ x: 44, y: 32, w: 2, h: 2, rotation: 0 }, CELL);

  it('konektor 0 (sever): vonkajšia bunka nad bránou, odznak v ľavom (východnom) pruhu pre vjazd na juh', () => {
    expect(queueBadgePosition(entry, 0, pose, CELL)).toEqual({ x: -0.5 * CELL + LANE_PX, y: -1.5 * CELL });
  });

  it('konektor 1 (juh): vonkajšia bunka pod bránou, odznak v ľavom (západnom) pruhu pre vjazd na sever', () => {
    expect(queueBadgePosition(entry, 1, pose, CELL)).toEqual({ x: -0.5 * CELL - LANE_PX, y: 1.5 * CELL });
  });

  it('neplatný index → prvý konektor; modul bez konektorov / bez záznamu → null', () => {
    expect(queueBadgePosition(entry, 9, pose, CELL)).toEqual(queueBadgePosition(entry, 0, pose, CELL));
    expect(queueBadgePosition(moduleSprite('nema_zaznam'), 0, pose, CELL)).toBeNull();
  });
});

describe('ModuleView: brána (závora a odznak fronty)', () => {
  it('ozdoba brány vznikne len pre VM s `gate`; závora je sprite `parts.barrier` s pivotom z manifestu', () => {
    const textures = new StubTextures();
    const plain = new ModuleView(gate({ gate: undefined }), deps(textures));
    expect(plain.decor('gate')).toBeUndefined();
    const view = new ModuleView(gate(), deps(textures));
    const decor = gateDecor(view);
    const holder = decor.barrierView;
    expect(holder).not.toBeNull();
    // pivot závory = ľavý horný roh footprintu + offset (0; 64) + pivot (8; 32) px; footprint 2×2 → stred je (64; 64)
    expect(holder?.position.x).toBeCloseTo(-CELL + 8, 9);
    expect(holder?.position.y).toBeCloseTo(-CELL + 64 + 32, 9);
    const sprite = holder?.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/modules/truck_gate_barrier.svg'));
    expect(sprite.position.x).toBe(-8);
    expect(sprite.position.y).toBe(-32);
    expect(sprite.width).toBeCloseTo(CELL, 9);
    expect(sprite.height).toBeCloseTo(CELL, 9);
    expect(decor.barrierAngle).toBe(0);
  });

  it('závora sa otvára a zatvára podľa `gate.open` počas BARRIER_MOTION_MS (riadené hodiny)', () => {
    const time = clock();
    const view = new ModuleView(gate(), deps(new StubTextures(), time.now));
    const decor = gateDecor(view);
    expect(decor.barrierAngle).toBe(0);
    view.update(gate({}, { queueLength: 0, open: true }));
    expect(decor.barrierOpen).toBe(true);
    expect(decor.barrierAngle).toBe(0);
    time.advance(BARRIER_MOTION_MS / 2);
    view.update(gate({}, { queueLength: 0, open: true }));
    expect(decor.barrierAngle).toBeCloseTo(-45, 9);
    time.advance(BARRIER_MOTION_MS);
    view.update(gate({}, { queueLength: 0, open: true }));
    expect(decor.barrierAngle).toBeCloseTo(-90, 9);
    view.update(gate({}, { queueLength: 0, open: false }));
    time.advance(BARRIER_MOTION_MS);
    view.update(gate({}, { queueLength: 0, open: false }));
    expect(decor.barrierAngle).toBe(0);
    expect(decor.barrierOpen).toBe(false);
  });

  it('brána, ktorá je pri vzniku otvorená, má závoru hore hneď', () => {
    const view = new ModuleView(gate({}, { queueLength: 0, open: true }), deps(new StubTextures(), clock().now));
    expect(gateDecor(view).barrierAngle).toBe(-90);
  });

  it('otvorená závora smeruje pozdĺž cesty, zatvorená naprieč cez cestu (koniec ramena)', () => {
    const time = clock();
    const view = new ModuleView(gate(), deps(new StubTextures(), time.now));
    const root = new Container();
    root.addChild(view.view);
    const holder = gateDecor(view).barrierView as Container;
    // rameno je 50 px dlhé od pivotu (x 12–62 v súbore, pivot x 8): koniec je 54 px od pivotu
    const tip = (): { x: number; y: number } => holder.toGlobal({ x: 54, y: 0 });
    const pivot = holder.toGlobal({ x: 0, y: 0 });
    expect(tip().x - pivot.x).toBeCloseTo(54, 6); // zatvorená: naprieč cez cestu (na východ)
    expect(tip().y - pivot.y).toBeCloseTo(0, 6);
    view.update(gate({}, { queueLength: 0, open: true }));
    time.advance(BARRIER_MOTION_MS);
    view.update(gate({}, { queueLength: 0, open: true }));
    expect(tip().x - pivot.x).toBeCloseTo(0, 6); // otvorená: pozdĺž cesty (na sever)
    expect(tip().y - pivot.y).toBeCloseTo(-54, 6);
  });

  it('bez textúr → rameno závory `Graphics` z tokenov; závora sa aj tak otáča', () => {
    const view = new ModuleView(gate({}, { queueLength: 0, open: true }), deps(null, clock().now));
    const holder = gateDecor(view).barrierView;
    expect(holder?.children[0]).not.toBeInstanceOf(Sprite);
    expect(holder?.angle).toBe(-90);
  });

  it('odznak fronty sa vytvorí až pri prvej fronte; 0 ho skryje', () => {
    const view = new ModuleView(gate(), deps(new StubTextures(), clock().now));
    const decor = gateDecor(view);
    expect(decor.queueBadge).toBeNull();
    expect(decor.queueBadgeVisible).toBe(false);
    view.update(gate({}, { queueLength: 3, open: false }));
    expect(decor.queueBadgeVisible).toBe(true);
    expect(decor.queueBadge?.shownText).toBe('3');
    view.update(gate({}, { queueLength: 0, open: false }));
    expect(decor.queueBadgeVisible).toBe(false);
    view.update(gate({}, { queueLength: 120, open: false }));
    expect(decor.queueBadgeVisible).toBe(true);
    expect(decor.queueBadge?.shownText).toBe('99+');
  });

  it('odznak fronty je sprite `overlay.queue_badge` s číslom; bez textúr kruh z tokenov', () => {
    const textures = new StubTextures();
    const view = new ModuleView(gate({}, { queueLength: 3, open: false }), deps(textures));
    const badge = gateDecor(view).queueBadge;
    const sprite = badge?.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/overlay/queue_badge.svg'));
    expect(sprite.width).toBeCloseTo(24, 9);
    expect(badge?.children).toHaveLength(2); // kruh + číslo
    const bare = new ModuleView(gate({}, { queueLength: 3, open: false }), deps(null));
    expect(gateDecor(bare).queueBadge?.children[0]).not.toBeInstanceOf(Sprite);
    expect(gateDecor(bare).queueBadge?.shownText).toBe('3');
  });

  it('vstupný konektor: predvolene 0 (sever), `entryConnector: 1` presunie odznak k južnej strane a nový index ho premiestni', () => {
    const view = new ModuleView(gate({}, { queueLength: 2, open: false }), deps(new StubTextures()));
    const badge = gateDecor(view).queueBadge as Container;
    expect(badge.position.y).toBeCloseTo(-1.5 * CELL, 9);
    view.update(gate({}, { queueLength: 2, open: false, entryConnector: 1 }));
    expect(badge.position.x).toBeCloseTo(-0.5 * CELL - LANE_PX, 9);
    expect(badge.position.y).toBeCloseTo(1.5 * CELL, 9);
    view.update(gate({}, { queueLength: 2, open: false, entryConnector: 0 }));
    expect(badge.position.y).toBeCloseTo(-1.5 * CELL, 9);
  });

  it.each(ROTATIONS)('rot %i: odznak stojí vo vonkajšej bunke vstupného konektora vo svete a ostáva vzpriamený', (rotation) => {
    const footprint = { w: 2, h: 2 };
    const vm = gate({}, { queueLength: 4, open: false, entryConnector: 1 }, rotation);
    const view = new ModuleView(vm, deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    const badge = gateDecor(view).queueBadge as Container;
    const at = badge.toGlobal({ x: 0, y: 0 });
    // očakávaná vonkajšia bunka: konektor (0; 1, juh) po rotácii o `rotation`, o krok von cez otočenú stranu
    const connector = moduleSprite('truck_gate')?.connectors[1];
    expect(connector).toBeDefined();
    const local = rotateLocalCell(connector?.x ?? 0, connector?.y ?? 0, footprint.w, footprint.h, rotation);
    const side = rotateSide(connector?.side ?? 's', rotation);
    const outer = { x: vm.x + local.x + SIDE_STEP[side].x, y: vm.y + local.y + SIDE_STEP[side].y };
    const step = SIDE_STEP[side];
    // v smere vjazdu leží odznak vo vonkajšej bunke (na jej strednej priečke), bočne je odsadený o `LANE_PX` naľavo od kamióna
    const dx = at.x - (outer.x + 0.5) * CELL;
    const dy = at.y - (outer.y + 0.5) * CELL;
    expect(dx * step.x + dy * step.y).toBeCloseTo(0, 6);
    expect(Math.hypot(dx, dy)).toBeCloseTo(LANE_PX, 6);
    // číslo je vzpriamené: uhol odznaku vyrovnáva rotáciu modulu
    expect((((view.view.angle + badge.angle) % 360) + 360) % 360).toBeCloseTo(0, 9);
  });

  it('veľkosť odznaku fronty sleduje zoom (setBadgeScale), aj keď odznak ešte nevznikol', () => {
    const view = new ModuleView(gate(), deps(new StubTextures()));
    view.setBadgeScale(2);
    view.update(gate({}, { queueLength: 1, open: false }));
    expect(gateDecor(view).queueBadge?.scale.x).toBe(2);
    view.setBadgeScale(1.5);
    expect(gateDecor(view).queueBadge?.scale.x).toBe(1.5);
  });

  it('brána bez záznamu v manifeste: ozdoba nespadne, odznak fronty sa nekreslí', () => {
    const view = new ModuleView(gate({ defId: 'neznama_brana' }), deps(new StubTextures()));
    const decor = gateDecor(view);
    expect(decor.barrierView).toBeNull();
    view.update(gate({ defId: 'neznama_brana' }, { queueLength: 2, open: true }));
    expect(decor.queueBadgeVisible).toBe(false);
  });

  it('brána nie je „nepripojená“ ani „neprevádzková“: ozdoba brány odznak upozornenia nežiada', () => {
    const view = new ModuleView(gate({}, { queueLength: 5, open: true }), deps(new StubTextures()));
    expect(view.badgeVisible).toBe(false);
    expect(view.badgeView).toBeNull();
    const lonely = new ModuleView(gate({ connected: false }), deps(new StubTextures()));
    expect(lonely.badgeVisible).toBe(true);
  });

  it('destroy uvoľní ozdoby', () => {
    const view = new ModuleView(gate({}, { queueLength: 1, open: false }), deps(new StubTextures()));
    const badge = gateDecor(view).queueBadge;
    view.destroy();
    expect(view.view.destroyed).toBe(true);
    expect(badge?.destroyed).toBe(true);
  });
});

describe('ModuleLayer: brána', () => {
  it('vrstva vytvorí views brány z ModuleVM a zoom zmení veľkosť odznaku fronty', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([gate({}, { queueLength: 3, open: false })]);
    const view = layer.moduleView(7) as ModuleView;
    expect(gateDecor(view).queueBadge?.shownText).toBe('3');
    layer.setZoom(0.5); // 1 / zoom = 2 (najviac BADGE_MAX_SCALE)
    expect(gateDecor(view).queueBadge?.scale.x).toBe(2);
    layer.setZoom(1);
    expect(gateDecor(view).queueBadge?.scale.x).toBe(1);
  });

  it('zmena fronty a otvorenia nevytvorí view nanovo', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([gate()]);
    const first = layer.moduleView(7);
    layer.sync([gate({}, { queueLength: 7, open: true })]);
    expect(layer.moduleView(7)).toBe(first);
    expect(layer.moduleCount).toBe(1);
  });
});

/** Strana konektora po rotácii modulu o `rotation` (90° v smere hodinových ručičiek: n → e → s → w). */
function rotateSide(side: ViewSide, rotation: Rotation): ViewSide {
  const order: readonly ViewSide[] = ['n', 'e', 's', 'w'];
  return order[(order.indexOf(side) + rotation / 90) % 4];
}
