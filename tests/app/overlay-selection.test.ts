// T06-03b: otvorený overlay (Nastavenia / Uložiť a načítať) — samostatný stav vedľa PanelSelection.
import { describe, expect, it, vi } from 'vitest';
import { OverlaySelection, isOverlayId } from '@app/overlay-selection';
import { PanelSelection, isPanelId } from '@app/panel-selection';

describe('OverlaySelection', () => {
  it('na začiatku je zatvorený', () => {
    const overlays = new OverlaySelection();
    expect(overlays.get()).toBeNull();
    expect(overlays.isOpen()).toBe(false);
  });

  it('open otvorí overlay, iný overlay ho nahradí, close zatvorí', () => {
    const overlays = new OverlaySelection();
    overlays.open('saves');
    expect(overlays.get()).toBe('saves');
    expect(overlays.isOpen()).toBe(true);
    overlays.open('settings');
    expect(overlays.get()).toBe('settings');
    overlays.close();
    expect(overlays.get()).toBeNull();
    expect(overlays.isOpen()).toBe(false);
  });

  it('odberateľov volá len pri skutočnej zmene; metódy sú stabilné (priamo do useSyncExternalStore / DOM väzby)', () => {
    const overlays = new OverlaySelection();
    const listener = vi.fn();
    const stop = overlays.subscribe(listener);
    const { open, close, isOpen } = overlays; // odpojené od inštancie
    open('settings');
    open('settings');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(true);
    close();
    close();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    open('saves');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isOverlayId pozná len overlaye; panely a overlaye sa nemiešajú', () => {
    expect(isOverlayId('settings')).toBe(true);
    expect(isOverlayId('saves')).toBe(true);
    expect(isOverlayId('contracts')).toBe(false);
    expect(isOverlayId('finance')).toBe(false);
    expect(isPanelId('settings')).toBe(false);
    expect(isPanelId('saves')).toBe(false);
  });

  it('overlay nezasahuje do pravého panelu: otvorený panel kontraktov ostane po zatvorení overlaya', () => {
    const panels = new PanelSelection();
    const overlays = new OverlaySelection();
    panels.toggle('contracts');
    overlays.open('saves');
    overlays.close();
    expect(panels.get()).toBe('contracts');
  });
});
