import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { FOCUSABLE_SELECTOR, ModalDialog, handleDialogKeyDown, isQuickSaveShortcut, trapTarget, type DialogKeyEvent } from '@ui/modal-dialog';

interface FakeElement {
  readonly name: string;
  focus: () => void;
}

const element = (name: string): FakeElement => ({ name, focus: vi.fn<() => void>() });

interface FakeKeyEvent extends DialogKeyEvent {
  readonly preventDefault: Mock<() => void>;
  readonly stopPropagation: Mock<() => void>;
}

function keyEvent(key: string, shiftKey = false): FakeKeyEvent {
  return { key, shiftKey, preventDefault: vi.fn<() => void>(), stopPropagation: vi.fn<() => void>() };
}

describe('trapTarget (Tab ostáva v dialógu)', () => {
  const [a, b, c] = [element('a'), element('b'), element('c')] as [FakeElement, FakeElement, FakeElement];
  const all = [a, b, c];

  it('Tab uprostred a Shift+Tab uprostred nechá prehliadač (undefined)', () => {
    expect(trapTarget(all, b, false)).toBeUndefined();
    expect(trapTarget(all, b, true)).toBeUndefined();
    expect(trapTarget(all, a, false)).toBeUndefined();
    expect(trapTarget(all, c, true)).toBeUndefined();
  });

  it('Tab na poslednom → prvý, Shift+Tab na prvom → posledný', () => {
    expect(trapTarget(all, c, false)).toBe(a);
    expect(trapTarget(all, a, true)).toBe(c);
  });

  it('fokus mimo dialógu (body po kliknutí na zásterku) → prvý, Shift+Tab → posledný', () => {
    expect(trapTarget(all, null, false)).toBe(a);
    expect(trapTarget(all, { name: 'body' }, false)).toBe(a);
    expect(trapTarget(all, null, true)).toBe(c);
  });

  it('jediný prvok drží fokus; bez prvkov nie je čo vynucovať', () => {
    expect(trapTarget([a], a, false)).toBe(a);
    expect(trapTarget([a], a, true)).toBe(a);
    expect(trapTarget([], null, false)).toBeUndefined();
  });
});

describe('handleDialogKeyDown', () => {
  it('Esc zavrie dialóg a zruší predvolenú akciu', () => {
    const [a, b] = [element('a'), element('b')] as [FakeElement, FakeElement];
    const onClose = vi.fn();
    const event = keyEvent('Escape');
    handleDialogKeyDown(event, onClose, [a, b], a);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('každý kláves sa zastaví (herné skratky nereagujú pod overlayom), ale zatvára len Esc', () => {
    const [a, b] = [element('a'), element('b')] as [FakeElement, FakeElement];
    const onClose = vi.fn();
    for (const key of ['Escape', 'Tab', ' ', 'r', '2', 'Enter']) {
      const event = keyEvent(key);
      handleDialogKeyDown(event, onClose, [a, b], a);
      expect(event.stopPropagation, key).toHaveBeenCalledTimes(1);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    const space = keyEvent(' ');
    handleDialogKeyDown(space, onClose, [a, b], a);
    expect(space.preventDefault).not.toHaveBeenCalled(); // Space/Enter ostáva aktiváciou tlačidla
  });

  it('Tab na poslednom prvku presunie fokus na prvý, Shift+Tab na prvom na posledný', () => {
    const [a, b] = [element('a'), element('b')] as [FakeElement, FakeElement];
    const onClose = vi.fn();
    const forward = keyEvent('Tab');
    handleDialogKeyDown(forward, onClose, [a, b], b);
    expect(forward.preventDefault).toHaveBeenCalledTimes(1);
    expect(a.focus).toHaveBeenCalledTimes(1);

    const backward = keyEvent('Tab', true);
    handleDialogKeyDown(backward, onClose, [a, b], a);
    expect(backward.preventDefault).toHaveBeenCalledTimes(1);
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Tab uprostred sa neruší (prehliadač posunie fokus sám)', () => {
    const middle = [element('x'), element('y'), element('z')] as [FakeElement, FakeElement, FakeElement];
    const event = keyEvent('Tab');
    handleDialogKeyDown(event, vi.fn(), middle, middle[1]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    for (const item of middle) expect(item.focus).not.toHaveBeenCalled();
  });
});

describe('Ctrl+S v dialógu (T06-03b)', () => {
  const combo = (props: Partial<Pick<DialogKeyEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>>): FakeKeyEvent => ({ ...keyEvent('s'), code: 'KeyS', ...props });

  it('isQuickSaveShortcut: Ctrl+S a Cmd+S podľa fyzickej klávesy, nie Alt a nie samotné S', () => {
    expect(isQuickSaveShortcut(combo({ ctrlKey: true }))).toBe(true);
    expect(isQuickSaveShortcut(combo({ metaKey: true }))).toBe(true);
    expect(isQuickSaveShortcut(combo({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isQuickSaveShortcut(combo({}))).toBe(false);
    expect(isQuickSaveShortcut(combo({ ctrlKey: true, code: 'KeyD' }))).toBe(false);
    expect(isQuickSaveShortcut(keyEvent('s'))).toBe(false); // atrapa bez `code`
  });

  it('Ctrl+S sa nezastaví ani nezruší: bubláva do okna, kde ho spracuje ovládanie hry (rýchle uloženie)', () => {
    const [a, b] = [element('a'), element('b')] as [FakeElement, FakeElement];
    const onClose = vi.fn();
    const event = combo({ ctrlKey: true });
    handleDialogKeyDown(event, onClose, [a, b], a);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('samotné S a Ctrl+Alt+S sa zastavia ako každý iný kláves', () => {
    const [a] = [element('a')] as [FakeElement];
    for (const props of [{}, { ctrlKey: true, altKey: true }]) {
      const event = combo(props);
      handleDialogKeyDown(event, vi.fn(), [a], a);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('berie tlačidlá a vstupy, ktoré nie sú disabled, skryté ani `tabindex="-1"`', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled]):not([type="hidden"])');
    for (const part of FOCUSABLE_SELECTOR.split(',')) {
      expect(part).toContain(':not([tabindex="-1"]):not([hidden])');
    }
  });
});

describe('ModalDialog (markup)', () => {
  const html = renderToStaticMarkup(
    createElement(ModalDialog, {
      label: 'Nastavenia',
      title: 'Nastavenia hry',
      onClose: vi.fn(),
      className: 'settings-panel',
      dialogId: 'settings',
      children: createElement('p', null, 'obsah'),
    }),
  );

  it('role dialog, aria-modal, aria-label, záložný fokus (tabindex -1) a modifikátor triedy', () => {
    expect(html).toMatch(/<div class="modal-dialog settings-panel" role="dialog" aria-modal="true" aria-label="Nastavenia" tabindex="-1" data-dialog="settings">/);
  });

  it('záhlavie: nadpis a tlačidlo ✕ s názvom a ikonou ic_close; obsah za záhlavím', () => {
    expect(html).toContain('<span class="modal-dialog__title">Nastavenia hry</span>');
    expect(html).toMatch(/<button type="button" class="modal-dialog__close" title="Zavrieť \(Esc\)" aria-label="Zavrieť"[^>]*>/);
    expect(html).toContain('#ic_close');
    expect(html.indexOf('modal-dialog__header')).toBeLessThan(html.indexOf('<p>obsah</p>'));
  });
});
