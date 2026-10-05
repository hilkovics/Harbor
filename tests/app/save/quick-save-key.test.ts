// T06-03: Ctrl+S = rýchle uloženie do slotu 1 — InputController (preventDefault cez návratovú hodnotu) a DOM väzba.
import { describe, expect, it, vi } from 'vitest';
import { Camera } from '@render/camera';
import { attachDomInput, type DomInputHost, type DomInputWindow } from '@app/dom-input';
import { InputController, isQuickSaveKey } from '@app/input-controller';
import { createApp } from '../app-fixtures';
import { FakeGhost, key, selectionDeps } from '../input-fixtures';

function controllerWith(onQuickSave?: () => void) {
  const { world, bridge } = createApp();
  const camera = new Camera({
    cellPx: 64,
    mapWidth: world.grid.width,
    mapHeight: world.grid.height,
    viewportWidth: 1280,
    viewportHeight: 720,
    zoom: 1,
    focus: { x: 40, y: 18, w: 8, h: 4 },
  });
  const controller = new InputController({
    bridge,
    camera,
    ghost: new FakeGhost(),
    ...selectionDeps(),
    ...(onQuickSave === undefined ? {} : { onQuickSave }),
  });
  return { controller, camera };
}

describe('isQuickSaveKey', () => {
  it('Ctrl+S a Cmd+S (podľa fyzickej klávesy), nie Alt a nie samotné S', () => {
    expect(isQuickSaveKey(key('KeyS', { ctrlKey: true }))).toBe(true);
    expect(isQuickSaveKey(key('KeyS', { metaKey: true }))).toBe(true);
    expect(isQuickSaveKey(key('KeyS', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isQuickSaveKey(key('KeyS'))).toBe(false);
    expect(isQuickSaveKey(key('KeyD', { ctrlKey: true }))).toBe(false);
  });
});

describe('InputController: Ctrl+S', () => {
  it('zavolá onQuickSave raz a vráti true (volajúci zavolá preventDefault)', () => {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    expect(controller.keyDown(key('KeyS', { ctrlKey: true }))).toBe(true);
    expect(onQuickSave).toHaveBeenCalledTimes(1);
  });

  it('Cmd+S (macOS) funguje rovnako', () => {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    expect(controller.keyDown(key('KeyS', { metaKey: true }))).toBe(true);
    expect(onQuickSave).toHaveBeenCalledTimes(1);
  });

  it('držaný kláves (repeat) neukladá znova, ale prehliadačový „Uložiť stránku“ potlačí', () => {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    controller.keyDown(key('KeyS', { ctrlKey: true }));
    expect(controller.keyDown(key('KeyS', { ctrlKey: true, repeat: true }))).toBe(true);
    expect(onQuickSave).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Alt+S neukladá a prehliadaču ho necháva', () => {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    expect(controller.keyDown(key('KeyS', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(onQuickSave).not.toHaveBeenCalled();
  });

  it('samotné S ďalej posúva kameru (nie je to uloženie)', () => {
    const onQuickSave = vi.fn();
    const { controller, camera } = controllerWith(onQuickSave);
    const pan = vi.spyOn(camera, 'pan');
    expect(controller.keyDown(key('KeyS'))).toBe(true);
    controller.update(50);
    expect(onQuickSave).not.toHaveBeenCalled();
    expect(pan).toHaveBeenCalled();
  });

  it('bez onQuickSave sa Ctrl+S nespracuje (prehliadač si ho berie)', () => {
    const { controller } = controllerWith();
    expect(controller.keyDown(key('KeyS', { ctrlKey: true }))).toBe(false);
  });

  it('ostatné klávesy s Ctrl sa ďalej ignorujú', () => {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    expect(controller.keyDown(key('KeyB', { ctrlKey: true }))).toBe(false);
    expect(onQuickSave).not.toHaveBeenCalled();
  });
});

// ---- DOM väzba ----

class FakeHost extends EventTarget implements DomInputHost {
  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
}

class FakeWindow extends EventTarget implements DomInputWindow {}

/** Prvok s fokusom (tlačidlo): klávesy patria jemu. */
const button = { tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null };

function keydown(target: EventTarget, props: Record<string, unknown>): Event {
  const event = new Event('keydown', { cancelable: true });
  const full = { repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...props };
  for (const [name, value] of Object.entries(full)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}

describe('attachDomInput: Ctrl+S', () => {
  function setup() {
    const onQuickSave = vi.fn();
    const { controller } = controllerWith(onQuickSave);
    const win = new FakeWindow();
    const detach = attachDomInput(controller, { host: new FakeHost(), window: win });
    return { onQuickSave, win, detach };
  }

  it('Ctrl+S uloží a zavolá preventDefault', () => {
    const { onQuickSave, win } = setup();
    const event = keydown(win, { code: 'KeyS', ctrlKey: true, target: null });
    expect(onQuickSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+S platí aj s fokusom na tlačidle (inak by sa otvorilo „Uložiť stránku“)', () => {
    const { onQuickSave, win } = setup();
    const event = keydown(win, { code: 'KeyS', ctrlKey: true, target: button });
    expect(onQuickSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ostatné klávesy s fokusom na tlačidle ostávajú tlačidlu (hra ich ignoruje)', () => {
    const { onQuickSave, win } = setup();
    const event = keydown(win, { code: 'Space', target: button });
    expect(event.defaultPrevented).toBe(false);
    expect(onQuickSave).not.toHaveBeenCalled();
  });

  it('po detach sa Ctrl+S nespracuje', () => {
    const { onQuickSave, win, detach } = setup();
    detach();
    const event = keydown(win, { code: 'KeyS', ctrlKey: true, target: null });
    expect(onQuickSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
