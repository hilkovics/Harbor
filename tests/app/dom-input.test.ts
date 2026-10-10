import { describe, expect, it, vi } from 'vitest';
import type { CellCoord } from '@sim/grid';
import { Camera } from '@render/camera';
import type { GhostCell, GhostView } from '@render/build-layer';
import { attachDomInput, keyboardTargetBelongsToUi, type DomInputHost, type DomInputWindow } from '@app/dom-input';
import { InputController } from '@app/input-controller';
import { createApp } from './app-fixtures';
import { selectionDeps } from './input-fixtures';

// ---- falošné DOM prvky (Node má EventTarget a Event) ----

/** Prvok mapy: EventTarget s polohou a spy-ami na zachytenie ukazovateľa. */
class FakeHost extends EventTarget implements DomInputHost {
  rect = { left: 10, top: 20 };
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();

  getBoundingClientRect(): { left: number; top: number } {
    return this.rect;
  }
}

class FakeWindow extends EventTarget implements DomInputWindow {}

interface FakeElementInit {
  tagName?: string;
  role?: string;
  isContentEditable?: boolean;
  closestButton?: FakeElement | null;
}

class FakeElement {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  readonly blur = vi.fn();
  private readonly role: string | null;
  private readonly button: FakeElement | null;

  constructor(init: FakeElementInit = {}) {
    this.tagName = init.tagName ?? 'DIV';
    this.role = init.role ?? null;
    this.isContentEditable = init.isContentEditable ?? false;
    this.button = init.closestButton ?? null;
  }

  getAttribute(name: string): string | null {
    return name === 'role' ? this.role : null;
  }

  closest(): FakeElement | null {
    return this.button;
  }
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(props)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}

class FakeGhost implements GhostView {
  cells: readonly GhostCell[] = [];
  setGhost(cells: readonly GhostCell[]): void {
    this.cells = cells;
  }
  clearGhost(): void {
    this.cells = [];
  }
}

function setup() {
  const { world, bridge, loop } = createApp();
  const camera = new Camera({
    cellPx: 64,
    mapWidth: world.grid.width,
    mapHeight: world.grid.height,
    viewportWidth: 1280,
    viewportHeight: 720,
    zoom: 1,
    focus: { x: 40, y: 18, w: 8, h: 4 },
  });
  const controller = new InputController({ bridge, camera, ghost: new FakeGhost(), ...selectionDeps() });
  const host = new FakeHost();
  const win = new FakeWindow();
  const releaseFocus = vi.fn();
  const detach = attachDomInput(controller, { host, window: win, releaseFocus });
  /** Súradnice stránky pre stred bunky: poloha na mape + posun prvku mapy. */
  const page = (cell: CellCoord): { clientX: number; clientY: number } => {
    const p = camera.cellCenterToScreen(cell.x, cell.y);
    return { clientX: p.x + host.rect.left, clientY: p.y + host.rect.top };
  };
  return { world, bridge, loop, camera, controller, host, win, detach, releaseFocus, page };
}

const KEY = { repeat: false, ctrlKey: false, altKey: false, metaKey: false };

// ---- rozhodnutie UI vs. mapa ----

describe('keyboardTargetBelongsToUi', () => {
  it.each([
    [{ tagName: 'INPUT' }, true],
    [{ tagName: 'textarea' }, true],
    [{ tagName: 'SELECT' }, true],
    [{ tagName: 'BUTTON' }, true],
    [{ tagName: 'A' }, true],
    [{ tagName: 'DIV', role: 'slider' }, true],
    [{ tagName: 'DIV', role: 'button' }, true],
    [{ tagName: 'DIV', isContentEditable: true }, true],
    [{ tagName: 'BODY' }, false],
    [{ tagName: 'DIV' }, false],
    [{ tagName: 'CANVAS' }, false],
    [{ tagName: 'DIV', role: 'presentation' }, false],
  ] as const)('%j → %s', (init, expected) => {
    expect(keyboardTargetBelongsToUi(new FakeElement(init))).toBe(expected);
  });

  it('okno, null a primitíva nepatria UI', () => {
    expect(keyboardTargetBelongsToUi(new FakeWindow())).toBe(false);
    expect(keyboardTargetBelongsToUi(null)).toBe(false);
    expect(keyboardTargetBelongsToUi(undefined)).toBe(false);
    expect(keyboardTargetBelongsToUi('button')).toBe(false);
  });
});

// ---- klávesy ----

describe('attachDomInput: klávesy', () => {
  it('kláves z tela stránky ovláda hru a udalosť sa zruší (preventDefault)', () => {
    const t = setup();
    const event = fire(t.win, 'keydown', { code: 'KeyB', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    expect(t.controller.buildMode).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('kláves s fokusom na tlačidle/poli patrí UI: hra ho ignoruje a preventDefault sa nevolá', () => {
    const t = setup();
    for (const tagName of ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']) {
      const event = fire(t.win, 'keydown', { code: 'KeyB', target: new FakeElement({ tagName }), ...KEY });
      expect(t.controller.buildMode, tagName).toBe(false);
      expect(event.defaultPrevented, tagName).toBe(false);
    }
    const space = fire(t.win, 'keydown', { code: 'Space', target: new FakeElement({ tagName: 'BUTTON' }), ...KEY });
    t.loop.frame(0);
    expect(t.world.clock.speed).toBe(1); // Space nepozastavil hru
    expect(space.defaultPrevented).toBe(false);
  });

  it('neznámy kláves sa nespotrebuje', () => {
    const t = setup();
    const event = fire(t.win, 'keydown', { code: 'KeyQ', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    expect(event.defaultPrevented).toBe(false);
  });

  it('keyup sa spracuje vždy (aj s fokusom na tlačidle), takže W nezostane „zaseknuté“', () => {
    const t = setup();
    fire(t.win, 'keydown', { code: 'KeyD', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    fire(t.win, 'keyup', { code: 'KeyD', target: new FakeElement({ tagName: 'BUTTON' }) });
    const { left } = t.camera;
    t.controller.update(50);
    expect(t.camera.left).toBe(left);
  });

  it('blur okna zruší pridržané klávesy', () => {
    const t = setup();
    fire(t.win, 'keydown', { code: 'KeyD', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    fire(t.win, 'blur');
    const { left } = t.camera;
    t.controller.update(50);
    expect(t.camera.left).toBe(left);
  });
});

describe('attachDomInput: fokus po kliku', () => {
  it('klik myšou na tlačidlo (aj na jeho ikonu) mu vezme fokus, aby hotkeys ďalej fungovali', () => {
    const t = setup();
    const button = new FakeElement({ tagName: 'BUTTON' });
    const icon = new FakeElement({ tagName: 'svg', closestButton: button });
    fire(t.win, 'click', { detail: 1, target: icon });
    expect(button.blur).toHaveBeenCalledTimes(1);
  });

  it('klávesnicová aktivácia (detail 0) fokus ponechá; pole na písanie fokus nestráca', () => {
    const t = setup();
    const button = new FakeElement({ tagName: 'BUTTON' });
    fire(t.win, 'click', { detail: 0, target: new FakeElement({ tagName: 'BUTTON', closestButton: button }) });
    expect(button.blur).not.toHaveBeenCalled();

    const input = new FakeElement({ tagName: 'INPUT' });
    fire(t.win, 'click', { detail: 1, target: input });
    expect(input.blur).not.toHaveBeenCalled();
  });
});

// ---- myš ----

describe('attachDomInput: myš na mape', () => {
  it('ťah myšou: súradnice sa prepočítajú na polohu v mape (odpočet posunu prvku), pointer capture sa zapne', () => {
    const t = setup();
    fire(t.win, 'keydown', { code: 'KeyB', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    const down = fire(t.host, 'pointerdown', { button: 0, pointerId: 7, ...t.page({ x: 30, y: 20 }) });
    expect(down.defaultPrevented).toBe(true);
    expect(t.host.setPointerCapture).toHaveBeenCalledWith(7);
    expect(t.releaseFocus).toHaveBeenCalled();
    expect(t.controller.state).toBe('build_place');

    fire(t.host, 'pointermove', { pointerId: 7, ...t.page({ x: 32, y: 20 }) });
    fire(t.host, 'pointerup', { button: 0, pointerId: 7, ...t.page({ x: 34, y: 20 }) });
    expect(t.host.releasePointerCapture).toHaveBeenCalledWith(7);
    t.loop.frame(0);

    const built: number[] = [];
    for (let x = 28; x <= 36; x++) if (t.world.grid.at(x, 20).road === 'road') built.push(x);
    expect(built).toEqual([30, 31, 32, 33, 34]);
  });

  it('pravé tlačidlo mimo build módu sa nespotrebuje; contextmenu sa vždy zruší', () => {
    const t = setup();
    const down = fire(t.host, 'pointerdown', { button: 2, pointerId: 1, ...t.page({ x: 30, y: 20 }) });
    expect(down.defaultPrevented).toBe(false);
    expect(t.host.setPointerCapture).not.toHaveBeenCalled();
    expect(fire(t.host, 'contextmenu').defaultPrevented).toBe(true);
  });

  it('koleso zoomuje a zruší scroll stránky; pivot sa počíta v súradniciach mapy', () => {
    const t = setup();
    t.camera.zoomAt(0.5, 640, 360);
    const pointer = { clientX: 510, clientY: 270 }; // v mape (500, 250)
    const before = t.camera.screenToCellFloat(500, 250);
    const wheel = fire(t.host, 'wheel', { deltaY: -100, deltaMode: 0, ...pointer });
    expect(wheel.defaultPrevented).toBe(true);
    expect(t.camera.zoom).toBeGreaterThan(0.5);
    const after = t.camera.screenToCellFloat(500, 250);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('pointercancel zruší ťah', () => {
    const t = setup();
    fire(t.host, 'pointerdown', { button: 0, pointerId: 1, ...t.page({ x: 30, y: 20 }) });
    expect(t.controller.state).toBe('pan');
    fire(t.host, 'pointercancel', { pointerId: 1 });
    expect(t.controller.state).toBe('idle');
  });

  it('po detach() už udalosti nič nerobia', () => {
    const t = setup();
    t.detach();
    fire(t.win, 'keydown', { code: 'KeyB', target: new FakeElement({ tagName: 'BODY' }), ...KEY });
    fire(t.host, 'pointerdown', { button: 0, pointerId: 1, ...t.page({ x: 30, y: 20 }) });
    expect(t.controller.buildMode).toBe(false);
    expect(t.controller.state).toBe('idle');
  });
});
