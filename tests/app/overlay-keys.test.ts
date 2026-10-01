// T06-03b: kým je otvorený overlay (Nastavenia / Uložiť a načítať), InputController nesmie spracúvať herné klávesy.
// `ModalDialog` zastavuje klávesy len pri fokuse v dialógu (stopPropagation, počúvanie na okne je v bubble fáze); keď je cieľom
// `body` (klik na zásterku, zmizol prvok s fokusom), pomáha až `keysBlocked` v `attachDomInput`. Esc v tom prípade zatvára
// `useOverlayEscape`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '@render/camera';
import type { GhostCell, GhostView } from '@render/build-layer';
import { attachDomInput, type DomInputHost, type DomInputWindow } from '@app/dom-input';
import { InputController } from '@app/input-controller';
import { OverlaySelection } from '@app/overlay-selection';
import { createApp } from './app-fixtures';
import { selectionDeps } from './input-fixtures';

class FakeHost extends EventTarget implements DomInputHost {
  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
}

class FakeWindow extends EventTarget implements DomInputWindow {}

class FakeGhost implements GhostView {
  cells: readonly GhostCell[] = [];
  setGhost(cells: readonly GhostCell[]): void {
    this.cells = cells;
  }
  clearGhost(): void {
    this.cells = [];
  }
}

/** Cieľ udalosti: `<body>` — fokus mimo dialógu (po kliku na zásterku). */
const BODY = { tagName: 'BODY', isContentEditable: false, getAttribute: () => null };

function key(target: EventTarget, code: string, props: Record<string, unknown> = {}): Event {
  const event = new Event('keydown', { cancelable: true });
  const full = { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: BODY, ...props };
  for (const [name, value] of Object.entries(full)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
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
  const onQuickSave = vi.fn();
  const controller = new InputController({ bridge, camera, ghost: new FakeGhost(), ...selectionDeps(), onQuickSave });
  const overlays = new OverlaySelection();
  const win = new FakeWindow();
  attachDomInput(controller, { host: new FakeHost(), window: win, keysBlocked: overlays.isOpen });
  const speed = (): number => {
    loop.frame(0); // aplikuje zaradené príkazy (SetGameSpeed)
    return world.clock.speed;
  };
  return { controller, overlays, win, onQuickSave, speed, camera };
}

describe('attachDomInput: keysBlocked (otvorený overlay)', () => {
  it('bez otvoreného overlaya klávesy z tela stránky ovládajú hru (Space pauza, B build mód)', () => {
    const t = setup();
    expect(key(t.win, 'KeyB').defaultPrevented).toBe(true);
    expect(t.controller.buildMode).toBe(true);
    key(t.win, 'Space');
    expect(t.speed()).toBe(0);
  });

  it('s otvoreným overlayom herné klávesy z tela stránky nič nerobia a preventDefault sa nevolá', () => {
    const t = setup();
    t.overlays.open('saves');
    const speedBefore = t.speed();
    for (const code of ['Space', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyB', 'KeyR', 'KeyW', 'ArrowLeft', 'Escape']) {
      const event = key(t.win, code);
      expect(event.defaultPrevented, code).toBe(false);
    }
    expect(t.speed()).toBe(speedBefore); // ani Space, ani číslice nezmenili rýchlosť
    expect(t.controller.buildMode).toBe(false); // B nezapol build mód
    const { left } = t.camera;
    t.controller.update(100);
    expect(t.camera.left).toBe(left); // W/šípky nehýbu kamerou
  });

  it('rovnako pri overlayi Nastavenia; po zatvorení klávesy opäť fungujú', () => {
    const t = setup();
    t.overlays.open('settings');
    key(t.win, 'KeyB');
    expect(t.controller.buildMode).toBe(false);
    t.overlays.close();
    key(t.win, 'KeyB');
    expect(t.controller.buildMode).toBe(true);
  });

  it('Ctrl+S (rýchle uloženie) platí aj pod overlayom a ruší predvolenú akciu prehliadača', () => {
    const t = setup();
    t.overlays.open('saves');
    const event = key(t.win, 'KeyS', { ctrlKey: true });
    expect(t.onQuickSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keyup sa spracuje aj pod overlayom (pridržané W nezostane zaseknuté, ak sa overlay otvorí uprostred)', () => {
    const t = setup();
    key(t.win, 'KeyD');
    t.overlays.open('saves');
    t.win.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyD' }));
    t.overlays.close();
    const { left } = t.camera;
    t.controller.update(100);
    expect(t.camera.left).toBe(left);
  });

  it('bez voľby keysBlocked sa správanie nemení (testy a demo)', () => {
    const { world, bridge } = createApp();
    const camera = new Camera({ cellPx: 64, mapWidth: world.grid.width, mapHeight: world.grid.height, viewportWidth: 1280, viewportHeight: 720, zoom: 1, focus: { x: 40, y: 18, w: 8, h: 4 } });
    const controller = new InputController({ bridge, camera, ghost: new FakeGhost(), ...selectionDeps() });
    const win = new FakeWindow();
    attachDomInput(controller, { host: new FakeHost(), window: win });
    key(win, 'KeyB');
    expect(controller.buildMode).toBe(true);
  });
});

describe('useOverlayEscape (Esc mimo dialógu)', () => {
  afterEach(() => {
    vi.doUnmock('react');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Hook bez Reactu: `useEffect` sa spustí hneď a jeho upratanie vráti volajúcemu; `window` je EventTarget. */
  async function mountHook(overlays: OverlaySelection) {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    let cleanup: (() => void) | undefined;
    vi.doMock('react', () => ({
      useEffect: (effect: () => (() => void) | undefined) => {
        cleanup = effect();
      },
    }));
    const { useOverlayEscape } = await import('@app/use-overlay-escape');
    useOverlayEscape(overlays);
    return { win, unmount: () => cleanup?.() };
  }

  it('Esc zatvorí otvorený overlay; iné klávesy nie', async () => {
    const overlays = new OverlaySelection();
    const { win } = await mountHook(overlays);
    overlays.open('saves');
    win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Space' }));
    expect(overlays.get()).toBe('saves');
    win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Escape' }));
    expect(overlays.get()).toBeNull();
  });

  it('po odpojení (unmount) Esc nič nerobí', async () => {
    const overlays = new OverlaySelection();
    const { win, unmount } = await mountHook(overlays);
    unmount();
    overlays.open('settings');
    win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Escape' }));
    expect(overlays.get()).toBe('settings');
  });
});
