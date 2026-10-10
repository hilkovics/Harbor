import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MAX_TOASTS, TOAST_SHOW_LABEL, Toasts, visibleToasts, type ToastData, type ToastTone } from '@ui/toasts';
import { findAll, propsOf } from './react-tree';

/** Dva toasty z karty T03-09: „Chýba sklad" (warning) a „Nepripojené" (info s akciou „Ukázať"). */
const NO_STORAGE: ToastData = {
  id: 1,
  tone: 'warning',
  icon: 'ic_warning',
  title: 'Chýba sklad',
  text: 'Kotvisko BRT-01 nemá kam uložiť kontajnery (TEU)',
  onClose: vi.fn(),
};

const DISCONNECTED: ToastData = {
  id: 2,
  tone: 'info',
  icon: 'info',
  title: 'Nepripojené',
  text: 'Depo vozidiel DEP-01 nemá cestu ku konektoru',
  showLabel: 'Ukázať',
  onShow: vi.fn(),
  onClose: vi.fn(),
};

function toast(id: number, tone: ToastTone = 'info'): ToastData {
  return { id, tone, icon: 'ic_info', title: `Toast ${String(id)}`, text: 'text', onClose: vi.fn() };
}

const render = (toasts: readonly ToastData[]): string => renderToStaticMarkup(createElement(Toasts, { toasts }));

describe('visibleToasts', () => {
  it('najviac 4 toasty, v poradí rodiča (prototyp: slice(0, 4))', () => {
    expect(MAX_TOASTS).toBe(4);
    const six = [1, 2, 3, 4, 5, 6].map((id) => toast(id));
    expect(visibleToasts(six).map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(visibleToasts(six.slice(0, 2)).map((item) => item.id)).toEqual([1, 2]);
    expect(visibleToasts([])).toEqual([]);
  });
});

describe('Toasts', () => {
  it('bez toastov nevykreslí nič (žiadny prázdny landmark)', () => {
    expect(render([])).toBe('');
  });

  it('zásobník je pomenovaný region, každý toast role="status" s tónom a id', () => {
    const html = render([NO_STORAGE, DISCONNECTED]);
    expect(html).toMatch(/^<div class="toasts" role="region" aria-label="Oznámenia" data-count="2">/);
    expect(html.match(/role="status"/g)).toHaveLength(2);
    expect(html).toMatch(/class="toast toast--warning" role="status" data-toast-id="1" data-tone="warning"/);
    expect(html).toMatch(/class="toast toast--info" role="status" data-toast-id="2" data-tone="info"/);
  });

  it('názov, popis a ikona (s prefixom aj bez neho); pruh tónu je dekoratívny', () => {
    const html = render([NO_STORAGE, DISCONNECTED]);
    expect(html).toContain('data-field="toast-title">Chýba sklad<');
    expect(html).toContain('data-field="toast-text">Kotvisko BRT-01 nemá kam uložiť kontajnery (TEU)<');
    expect(html).toContain('data-field="toast-title">Nepripojené<');
    expect(html).toMatch(/#ic_warning"><\/use><\/svg><div class="toast__body">/);
    expect(html).toMatch(/#ic_info"><\/use><\/svg><div class="toast__body">/);
    expect(html.match(/<span class="toast__stripe" aria-hidden="true">/g)).toHaveLength(2);
  });

  it('odkaz akcie len pri `onShow`: predvolený popis „Zobraziť", vlastný „Ukázať"', () => {
    expect(TOAST_SHOW_LABEL).toBe('Zobraziť');
    const html = render([NO_STORAGE, DISCONNECTED]);
    expect(html.match(/data-action="show"/g)).toHaveLength(1);
    expect(html).toContain('data-action="show">Ukázať</button>');
    const withDefault = render([{ ...NO_STORAGE, onShow: vi.fn() }]);
    expect(withDefault).toContain('data-action="show">Zobraziť</button>');
  });

  it('zavrieť má názov s titulkom toastu a ikonu ic_close', () => {
    const html = render([NO_STORAGE]);
    expect(html).toContain('aria-label="Zavrieť oznámenie: Chýba sklad"');
    expect(html).toContain('title="Zavrieť"');
    expect(html).toContain('#ic_close');
  });

  it('vykreslí najviac 4 toasty', () => {
    const html = render([1, 2, 3, 4, 5, 6].map((id) => toast(id)));
    expect(html.match(/role="status"/g)).toHaveLength(4);
    expect(html).toContain('data-count="4"');
    expect(html).not.toContain('Toast 5');
  });

  it('všetky štyri tóny majú vlastnú triedu', () => {
    const tones: ToastTone[] = ['info', 'success', 'warning', 'danger'];
    const html = render(tones.map((tone, index) => toast(index + 1, tone)));
    for (const tone of tones) expect(html).toContain(`toast--${tone}`);
  });

  it('zavrieť volá onClose(id), akcia onShow(id); ďalšie toasty ostávajú nedotknuté', () => {
    const onClose = vi.fn();
    const onShow = vi.fn();
    const first: ToastData = { ...DISCONNECTED, id: 'a', onClose, onShow };
    const second: ToastData = { ...NO_STORAGE, id: 'b', onClose: vi.fn() };
    const tree = Toasts({ toasts: [first, second] });

    const [show] = findAll(tree, (element) => propsOf(element)['data-action'] === 'show');
    (propsOf(show!)['onClick'] as () => void)();
    expect(onShow).toHaveBeenCalledExactlyOnceWith('a');

    const closes = findAll(tree, (element) => propsOf(element)['data-action'] === 'close');
    expect(closes).toHaveLength(2);
    (propsOf(closes[0]!)['onClick'] as () => void)();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('a');
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it('onClose bez parametrov (prototyp: `() => …`) je platný callback', () => {
    const close = vi.fn(() => undefined);
    const data: ToastData = { ...NO_STORAGE, onClose: close };
    const [button] = findAll(Toasts({ toasts: [data] }), (element) => propsOf(element)['data-action'] === 'close');
    (propsOf(button!)['onClick'] as () => void)();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
