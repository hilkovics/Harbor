import { createElement, type ChangeEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '@ui/format';
import { ModalDialog } from '@ui/modal-dialog';
import {
  EMPTY_SLOT_TEXT,
  IMPORT_ACCEPT,
  INCOMPATIBLE_SLOT_TEXT,
  SAVE_SLOT_IDS,
  SaveLoadPanel,
  SaveLoadPanelView,
  findSlot,
  previewTimeText,
  slotName,
  slotReference,
  type SaveLoadPanelViewProps,
} from '@ui/save-load-panel';
import type { SaveSlotId, SaveSlotInfo } from '@ui/save-types';
import { findAll, propsOf } from './react-tree';

const AUTO: SaveSlotInfo = {
  slot: 'auto',
  label: 'Autosave',
  savedAtIso: '2026-10-01T12:35:00.000Z',
  preview: { day: 11, timeLabel: '14:20', cashCents: 123_456_000, xp: 340 },
};

const SLOT_2: SaveSlotInfo = {
  slot: '2',
  label: 'Slot 2',
  savedAtIso: '2026-09-30T07:05:00.000Z',
  preview: { day: 141, timeLabel: '06:00', cashCents: -482_000, xp: 12_340 },
};

interface Fake {
  readonly props: SaveLoadPanelViewProps;
  readonly click: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<SaveLoadPanelViewProps> = {}, slots: readonly SaveSlotInfo[] = [AUTO, SLOT_2]): Fake {
  const click = vi.fn();
  const props: SaveLoadPanelViewProps = {
    slots,
    onSave: vi.fn(),
    onLoad: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onClose: vi.fn(),
    confirmingSlot: null,
    onRequestDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    fileInputRef: { current: { click } as unknown as HTMLInputElement },
    listRef: { current: null },
    ...overrides,
  };
  return { props, click };
}

const renderView = (fake: Fake): string => renderToStaticMarkup(createElement(SaveLoadPanelView, fake.props));

/** HTML jedného riadku slotu (`<li … data-slot="id"> … </li>`). */
function slotHtml(html: string, slot: SaveSlotId): string {
  const match = new RegExp(`<li[^>]*data-slot="${slot}"[^>]*>.*?</li>`).exec(html);
  if (match === null) throw new Error(`Riadok slotu ${slot} chýba`);
  return match[0];
}

/** Tlačidlo akcie v riadku slotu (`data-action` + `data-slot`) v strome elementov. */
function slotButton(tree: ReactElement, action: string, slot: SaveSlotId): ReactElement {
  const found = findAll(tree, (element) => propsOf(element)['data-action'] === action && propsOf(element)['data-slot'] === slot)[0];
  if (found === undefined) throw new Error(`Tlačidlo ${action} pre slot ${slot} chýba`);
  return found;
}

function footerButton(tree: ReactElement, action: string): ReactElement {
  const found = findAll(tree, (element) => propsOf(element)['data-action'] === action && propsOf(element)['data-slot'] === undefined)[0];
  if (found === undefined) throw new Error(`Tlačidlo ${action} chýba`);
  return found;
}

const click = (button: ReactElement): void => {
  (propsOf(button).onClick as () => void)();
};

const dd = (html: string, field: string): string => new RegExp(`data-field="${field}">.*?<dd class="save-slot__stat-value">([^<]*)</dd>`).exec(html)?.[1] ?? '';

describe('pomocné funkcie', () => {
  it('poradie slotov auto, 1, 2, 3 a názvy', () => {
    expect(SAVE_SLOT_IDS).toEqual(['auto', '1', '2', '3']);
    expect(slotName('auto')).toBe('Automatické uloženie');
    expect(slotName('3')).toBe('Slot 3');
    expect(slotReference('auto')).toBe('automatické uloženie');
    expect(slotReference('1')).toBe('slot 1');
  });

  it('previewTimeText: deň je 0-based ako v HUD (Deň N = day + 1)', () => {
    expect(previewTimeText(AUTO.preview)).toBe('Deň 12 · 14:20');
    expect(previewTimeText({ ...AUTO.preview, day: 0, timeLabel: '00:00' })).toBe('Deň 1 · 00:00');
  });

  it('findSlot nájde obsadený slot, prázdny je undefined', () => {
    expect(findSlot([AUTO, SLOT_2], '2')).toBe(SLOT_2);
    expect(findSlot([AUTO, SLOT_2], '1')).toBeUndefined();
  });
});

describe('SaveLoadPanel (markup)', () => {
  it('dialóg: role dialog, aria-modal, aria-label, nadpis; zoznam má štyri sloty v poradí', () => {
    const html = renderView(setup());
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Uložiť a načítať hru"/);
    expect(html).toContain('<span class="modal-dialog__title">Uložiť a načítať</span>');
    expect(html).toMatch(/<ul class="save-list" aria-label="Sloty uloženia">/);
    expect([...html.matchAll(/<li[^>]*data-slot="([^"]+)"/g)].map((match) => match[1])).toEqual(['auto', '1', '2', '3']);
  });

  it('obsadený slot: deň + čas, cash cez formatMoney, XP, dátum uloženia', () => {
    const html = slotHtml(renderView(setup()), 'auto');
    expect(html).toContain('data-empty="false"');
    expect(dd(html, 'slot-time')).toBe('Deň 12 · 14:20');
    expect(dd(html, 'slot-cash')).toBe('$1,234,560');
    expect(dd(html, 'slot-xp')).toBe('340 XP');
    expect(html).toContain(`data-field="slot-saved">${formatDateTime(AUTO.savedAtIso)}<`);
    expect(html).not.toContain(EMPTY_SLOT_TEXT);
  });

  it('záporná hotovosť má znamienko mínus a XP oddeľovač tisícov', () => {
    const html = slotHtml(renderView(setup()), '2');
    expect(dd(html, 'slot-cash')).toBe('−$4,820');
    expect(dd(html, 'slot-xp')).toBe('12,340 XP');
    expect(dd(html, 'slot-time')).toBe('Deň 142 · 06:00');
  });

  it('prázdny slot ukáže „Prázdny" bez preview; Načítať a Vymazať sú disabled', () => {
    const html = slotHtml(renderView(setup()), '1');
    expect(html).toContain('data-empty="true"');
    expect(html).toContain(`data-field="slot-empty">${EMPTY_SLOT_TEXT}<`);
    expect(EMPTY_SLOT_TEXT).toBe('Prázdny');
    expect(html).not.toContain('save-slot__stats');
    expect(html).not.toContain('data-field="slot-saved"');
    expect(html).toMatch(/data-action="load"[^>]*disabled=""/);
    expect(html).toMatch(/data-action="delete"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-action="save"[^>]*disabled/);
  });

  it('bez slotov sú všetky štyri prázdne', () => {
    const html = renderView(setup({}, []));
    expect(html.match(/data-field="slot-empty"/g)).toHaveLength(4);
  });

  it('Uložiť je len pri slotoch 1–3, nie pri automatickom; Načítať a Vymazať majú prístupné názvy', () => {
    const html = renderView(setup());
    expect(slotHtml(html, 'auto')).not.toContain('data-action="save"');
    for (const slot of ['1', '2', '3'] as const) {
      expect(slotHtml(html, slot)).toContain(`aria-label="Uložiť do slotu ${slot}"`);
    }
    expect(slotHtml(html, 'auto')).toContain('aria-label="Načítať automatické uloženie"');
    expect(slotHtml(html, '2')).toContain('aria-label="Vymazať slot 2"');
    expect(slotHtml(html, '2')).not.toMatch(/data-action="(?:load|delete)"[^>]*disabled/);
  });

  it('päta: Export, Import, Zavrieť; skrytý input prijíma .json', () => {
    const html = renderView(setup());
    expect(html).toMatch(/data-action="export">Export do súboru</);
    expect(html).toMatch(/data-action="import">Import zo súboru</);
    expect(html).toMatch(/data-action="close">Zavrieť</);
    expect(IMPORT_ACCEPT).toBe('.json,application/json');
    expect(html).toMatch(/<input type="file" accept="\.json,application\/json" hidden="" tabindex="-1"[^>]*data-field="import-input"/);
  });

  it('potvrdenie mazania: riadok ukáže skupinu Zrušiť / Vymazať namiesto troch akcií', () => {
    const html = slotHtml(renderView(setup({ confirmingSlot: '2' })), '2');
    expect(html).toMatch(/role="group" aria-label="Potvrdenie vymazania: Slot 2"/);
    expect(html).toContain('Vymazať natrvalo?');
    expect(html).toContain('data-action="delete-cancel"');
    expect(html).toContain('data-action="delete-confirm"');
    expect(html).not.toContain('data-action="load"');
    expect(html).not.toContain('data-action="save"');
    // ostatné riadky ostanú v bežnom stave
    expect(slotHtml(renderView(setup({ confirmingSlot: '2' })), 'auto')).toContain('data-action="load"');
  });

  it('bežné akcie a potvrdenie majú rôzny key (React ich vymení celé: fokus nezostane na „Vymazať" → potvrdzujúce „Vymazať")', () => {
    const actionsKey = (confirmingSlot: SaveSlotId | null): string | null => {
      const tree = SaveLoadPanelView(setup({ confirmingSlot }).props);
      const row = findAll(tree, (element) => propsOf(element)['data-slot'] === '2' && element.type === 'li')[0];
      const actions = findAll(row, (element) => String(propsOf(element).className ?? '').startsWith('save-slot__actions'))[0];
      return actions?.key ?? null;
    };
    expect(actionsKey(null)).toBe('actions');
    expect(actionsKey('2')).toBe('confirm');
  });

  it('pripojený SaveLoadPanel začína bez potvrdenia', () => {
    const { slots, onSave, onLoad, onDelete, onExport, onImport, onClose } = setup().props;
    const html = renderToStaticMarkup(createElement(SaveLoadPanel, { slots, onSave, onLoad, onDelete, onExport, onImport, onClose }));
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('delete-confirm');
    expect(html.match(/<li /g)).toHaveLength(4);
  });
});

describe('SaveLoadPanel (akcie)', () => {
  it('Uložiť volá onSave so slotom', () => {
    const fake = setup();
    const tree = SaveLoadPanelView(fake.props);
    click(slotButton(tree, 'save', '2'));
    expect(fake.props.onSave).toHaveBeenCalledTimes(1);
    expect(fake.props.onSave).toHaveBeenCalledWith('2');
    click(slotButton(tree, 'save', '1')); // prázdny slot sa dá ukladať
    expect(fake.props.onSave).toHaveBeenLastCalledWith('1');
  });

  it('Načítať volá onLoad so slotom (aj pre auto)', () => {
    const fake = setup();
    const tree = SaveLoadPanelView(fake.props);
    click(slotButton(tree, 'load', 'auto'));
    expect(fake.props.onLoad).toHaveBeenCalledWith('auto');
    click(slotButton(tree, 'load', '2'));
    expect(fake.props.onLoad).toHaveBeenLastCalledWith('2');
    expect(fake.props.onLoad).toHaveBeenCalledTimes(2);
  });

  it('Vymazať len žiada o potvrdenie — onDelete sa nevolá', () => {
    const fake = setup();
    click(slotButton(SaveLoadPanelView(fake.props), 'delete', '2'));
    expect(fake.props.onRequestDelete).toHaveBeenCalledWith('2');
    expect(fake.props.onDelete).not.toHaveBeenCalled();
  });

  it('potvrdenie volá onDelete so slotom, Zrušiť potvrdenie zruší bez mazania', () => {
    const fake = setup({ confirmingSlot: 'auto' });
    const tree = SaveLoadPanelView(fake.props);
    click(slotButton(tree, 'delete-cancel', 'auto'));
    expect(fake.props.onCancelDelete).toHaveBeenCalledTimes(1);
    expect(fake.props.onDelete).not.toHaveBeenCalled();
    click(slotButton(tree, 'delete-confirm', 'auto'));
    expect(fake.props.onDelete).toHaveBeenCalledTimes(1);
    expect(fake.props.onDelete).toHaveBeenCalledWith('auto');
  });

  it('Export volá onExport', () => {
    const fake = setup();
    click(footerButton(SaveLoadPanelView(fake.props), 'export'));
    expect(fake.props.onExport).toHaveBeenCalledTimes(1);
  });

  it('Import otvorí skrytý výber súboru; vybraný súbor ide do onImport a hodnota inputu sa vyčistí', () => {
    const fake = setup();
    const tree = SaveLoadPanelView(fake.props);
    click(footerButton(tree, 'import'));
    expect(fake.click).toHaveBeenCalledTimes(1);
    expect(fake.props.onImport).not.toHaveBeenCalled();

    const input = findAll(tree, (element) => element.type === 'input')[0];
    expect(input).toBeDefined();
    const onChange = propsOf(input as ReactElement).onChange as (event: ChangeEvent<HTMLInputElement>) => void;
    const file = new File(['{"format":"modular-harbor-save"}'], 'save.json', { type: 'application/json' });
    const target = { files: [file], value: 'C:\\fakepath\\save.json' };
    onChange({ target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(fake.props.onImport).toHaveBeenCalledTimes(1);
    expect(fake.props.onImport).toHaveBeenCalledWith(file);
    expect(target.value).toBe('');
  });

  it('zrušený výber súboru (žiadny súbor) onImport nevolá', () => {
    const fake = setup();
    const input = findAll(SaveLoadPanelView(fake.props), (element) => element.type === 'input')[0];
    const onChange = propsOf(input as ReactElement).onChange as (event: ChangeEvent<HTMLInputElement>) => void;
    onChange({ target: { files: [], value: '' } } as unknown as ChangeEvent<HTMLInputElement>);
    onChange({ target: { files: null, value: '' } } as unknown as ChangeEvent<HTMLInputElement>);
    expect(fake.props.onImport).not.toHaveBeenCalled();
  });

  it('Zavrieť, ✕ a Esc (onClose dialógu) volajú onClose', () => {
    const fake = setup();
    const tree = SaveLoadPanelView(fake.props);
    click(footerButton(tree, 'close'));
    expect(fake.props.onClose).toHaveBeenCalledTimes(1);
    const dialog = findAll(tree, (element) => element.type === ModalDialog)[0];
    expect(dialog).toBeDefined();
    expect(propsOf(dialog as ReactElement).onClose).toBe(fake.props.onClose);
  });
});

describe('slot so savom staršej verzie (clean break savov, ADR-036)', () => {
  const OLD: SaveSlotInfo = { ...SLOT_2, incompatible: true };

  it('nekompatibilný slot nesie značku a data-incompatible; kompatibilné a prázdne sloty ju nemajú', () => {
    const html = renderView(setup({}, [AUTO, OLD]));
    expect(slotHtml(html, '2')).toContain('data-incompatible="true"');
    expect(slotHtml(html, '2')).toContain('data-field="slot-incompatible"');
    expect(slotHtml(html, '2')).toContain(INCOMPATIBLE_SLOT_TEXT);
    for (const slot of ['auto', '1', '3'] as const) {
      expect(slotHtml(html, slot)).toContain('data-incompatible="false"');
      expect(slotHtml(html, slot)).not.toContain(INCOMPATIBLE_SLOT_TEXT);
    }
  });

  it('Načítať ostáva aktívne (načítanie hru nezmení a vysvetlí ho hláška), Vymazať takisto', () => {
    const fake = setup({}, [OLD]);
    const tree = SaveLoadPanelView(fake.props);
    expect(propsOf(slotButton(tree, 'load', '2'))['disabled']).toBe(false);
    expect(propsOf(slotButton(tree, 'delete', '2'))['disabled']).toBe(false);
  });
});
