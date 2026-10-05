import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModalDialog } from '@ui/modal-dialog';
import type { Settings } from '@ui/save-types';
import {
  AUTOSAVE_OPTIONS,
  DEFAULT_SPEED_OPTIONS,
  SOUND_NOTE,
  SettingsPanel,
  SettingsPanelView,
  commitSettings,
  settingsEqual,
  withAutosave,
  withDefaultSpeed,
  type SettingsPanelViewProps,
} from '@ui/settings-panel';
import { findAll, propsOf } from './react-tree';

const SETTINGS: Settings = { settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: 1, sound: false };

function viewProps(overrides: Partial<SettingsPanelViewProps> = {}): SettingsPanelViewProps {
  return { draft: SETTINGS, onDraftChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), ...overrides };
}

const renderView = (overrides: Partial<SettingsPanelViewProps> = {}): string =>
  renderToStaticMarkup(createElement(SettingsPanelView, viewProps(overrides)));

/** Tlačidlá v skupine s `data-field="<field>"` (segmentovaný výber) v poradí dokumentu. */
function segmentButtons(tree: ReactElement, field: string): ReactElement[] {
  const group = findAll(tree, (element) => propsOf(element)['data-field'] === field)[0];
  if (group === undefined) throw new Error(`Skupina ${field} chýba`);
  return findAll(group, (element) => element.type === 'button');
}

const click = (button: ReactElement): void => {
  (propsOf(button).onClick as () => void)();
};

describe('SettingsPanelView: ponuka od rodiča (T06-03b)', () => {
  const speedValues = (html: string): string[] => {
    const group = /data-field="default-speed">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    return [...group.matchAll(/data-value="(\d+)"/g)].map((match) => match[1] ?? '');
  };
  const autosaveValues = (html: string): string[] => {
    const group = /data-field="autosave">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    return [...group.matchAll(/data-value="(\d+)"/g)].map((match) => match[1] ?? '');
  };

  it('`speeds` nahradí predvolenú ponuku rýchlostí (0 sa ukáže ako Pauza)', () => {
    const html = renderView({ speeds: [0, 2, 8] });
    expect(speedValues(html)).toEqual(['0', '2', '8']);
    expect(html).toContain('>Pauza<');
  });

  it('`maxAutosaveDays` vynechá dlhšie intervaly; bez neho platí celá ponuka', () => {
    expect(autosaveValues(renderView())).toEqual(['0', '1', '3', '7']);
    expect(autosaveValues(renderView({ maxAutosaveDays: 3 }))).toEqual(['0', '1', '3']);
    expect(autosaveValues(renderView({ maxAutosaveDays: 0 }))).toEqual(['0']);
  });
});

describe('SettingsPanel (markup)', () => {
  it('dialóg „Nastavenia": role dialog, aria-modal, aria-label, nadpis a ✕', () => {
    const html = renderView();
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Nastavenia"/);
    expect(html).toContain('<span class="modal-dialog__title">Nastavenia</span>');
    expect(html).toContain('aria-label="Zavrieť"');
  });

  it('skupiny Hra a Zvuk s názvami riadkov', () => {
    const html = renderView();
    expect(html).toContain('<h3 class="settings-group__title">Hra</h3>');
    expect(html).toContain('<h3 class="settings-group__title">Zvuk</h3>');
    expect(html).toContain('>Predvolená rýchlosť<');
    expect(html).toContain('>Automatické ukladanie<');
  });

  it('predvolená rýchlosť 1× 2× 4× 8×; vybraná má aria-pressed a --active', () => {
    expect(DEFAULT_SPEED_OPTIONS).toEqual([1, 2, 4, 8]);
    const html = renderView();
    const group = /data-field="default-speed">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect([...group.matchAll(/data-value="(\d+)">([^<]*)</g)].map((match) => `${match[1] ?? ''}:${match[2] ?? ''}`)).toEqual(['1:1×', '2:2×', '4:4×', '8:8×']);
    expect(group).toMatch(/class="segmented__btn segmented__btn--active" aria-pressed="true" data-value="2"/);
    expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('automatické ukladanie: Vypnuté / Každý deň / Každé 3 dni / Každý týždeň', () => {
    expect(AUTOSAVE_OPTIONS.map((option) => option.label)).toEqual(['Vypnuté', 'Každý deň', 'Každé 3 dni', 'Každý týždeň']);
    expect(AUTOSAVE_OPTIONS.map((option) => option.days)).toEqual([0, 1, 3, 7]);
    const html = renderView({ draft: { ...SETTINGS, autosaveEveryDays: 3 } });
    const group = /data-field="autosave">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect([...group.matchAll(/>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Vypnuté', 'Každý deň', 'Každé 3 dni', 'Každý týždeň']);
    expect(group).toMatch(/segmented__btn--active" aria-pressed="true" data-value="3">Každé 3 dni</);
  });

  it('hodnota mimo ponuky (napr. 0 = pauza) nezvýrazní nič', () => {
    const html = renderView({ draft: { ...SETTINGS, defaultSpeed: 0, autosaveEveryDays: 2 } });
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('zvuk je zatiaľ neaktívny: vypnutý prepínač (switch, disabled) s poznámkou', () => {
    const html = renderView();
    expect(html).toMatch(/<button type="button" role="switch" class="toggle" aria-checked="false"[^>]*data-field="sound" disabled="">/);
    expect(html).toContain(`data-field="sound-note">${SOUND_NOTE}<`);
    expect(html).toContain('aria-describedby="settings-note-sound"');
  });

  it('päta: Zrušiť a Uložiť (hlavné tlačidlo)', () => {
    const html = renderView();
    expect(html).toMatch(/class="modal-btn" data-action="cancel">Zrušiť</);
    expect(html).toMatch(/class="modal-btn modal-btn--primary" data-action="save">Uložiť</);
  });

  it('pripojený SettingsPanel začína s uloženými hodnotami', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { settings: { ...SETTINGS, defaultSpeed: 8, autosaveEveryDays: 7 }, onChange: vi.fn(), onClose: vi.fn() }));
    expect(html).toMatch(/aria-pressed="true" data-value="8">8×</);
    expect(html).toMatch(/aria-pressed="true" data-value="7">Každý týždeň</);
  });
});

describe('SettingsPanel (akcie)', () => {
  it('výber rýchlosti pošle koncept s novou hodnotou, ostatné polia ostanú', () => {
    const onDraftChange = vi.fn();
    const tree = SettingsPanelView(viewProps({ onDraftChange }));
    const buttons = segmentButtons(tree, 'default-speed');
    expect(buttons.map((button) => propsOf(button)['data-value'])).toEqual([1, 2, 4, 8]);
    const eight = buttons[3];
    if (eight === undefined) throw new Error('chýba 8×');
    click(eight);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith({ settingsVersion: 1, defaultSpeed: 8, autosaveEveryDays: 1, sound: false });
  });

  it('výber automatického ukladania pošle počet dní (0 = Vypnuté)', () => {
    const onDraftChange = vi.fn();
    const buttons = segmentButtons(SettingsPanelView(viewProps({ onDraftChange })), 'autosave');
    for (const [index, days] of [0, 1, 3, 7].entries()) {
      const button = buttons[index];
      if (button === undefined) throw new Error(`chýba možnosť ${String(index)}`);
      click(button);
      expect(onDraftChange).toHaveBeenLastCalledWith({ ...SETTINGS, autosaveEveryDays: days });
    }
    expect(onDraftChange).toHaveBeenCalledTimes(4);
  });

  it('Zrušiť, ✕ a Esc (onClose dialógu) volajú onCancel; Uložiť volá onSave', () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const tree = SettingsPanelView(viewProps({ onCancel, onSave }));
    const action = (name: string): ReactElement => {
      const found = findAll(tree, (element) => propsOf(element)['data-action'] === name)[0];
      if (found === undefined) throw new Error(`Tlačidlo ${name} chýba`);
      return found;
    };
    click(action('cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    click(action('save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // ✕ a Esc sú v ModalDialog; ten dostane rovnaký onClose ako Zrušiť.
    const dialog = findAll(tree, (element) => element.type === ModalDialog)[0];
    expect(dialog).toBeDefined();
    expect(propsOf(dialog as ReactElement).onClose).toBe(onCancel);
  });

  it('commitSettings: zmena → onChange(nové) + onClose; bez zmeny len onClose', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const changed = withDefaultSpeed(withAutosave(SETTINGS, 7), 4);
    commitSettings(changed, SETTINGS, onChange, onClose);
    expect(onChange).toHaveBeenCalledWith({ settingsVersion: 1, defaultSpeed: 4, autosaveEveryDays: 7, sound: false });
    expect(onClose).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    onClose.mockClear();
    commitSettings({ ...SETTINGS }, SETTINGS, onChange, onClose);
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pomocníci nemenia pôvodný objekt', () => {
    const next = withDefaultSpeed(SETTINGS, 8);
    expect(next).not.toBe(SETTINGS);
    expect(SETTINGS.defaultSpeed).toBe(2);
    expect(settingsEqual(SETTINGS, { ...SETTINGS })).toBe(true);
    expect(settingsEqual(SETTINGS, next)).toBe(false);
    expect(settingsEqual(SETTINGS, withAutosave(SETTINGS, 3))).toBe(false);
  });
});
