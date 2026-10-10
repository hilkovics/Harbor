// T06-03b: ConnectedSaveLoad, ConnectedSettings a napojenie ikon v ConnectedTopHUD. Panely a TopHUD sú čisto prezentačné
// (ich vzhľad testuje tests/ui) — tu ich nahradíme atrapami, ktoré zachytia props, a overíme napojenie na SaveController
// a OverlaySelection: dáta, akcie, zatvorenie a ponuku nastavení odvodenú z app konštánt.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedSaveLoad } from '@app/connected-save-load';
import { ConnectedSettings, OFFERED_SPEEDS } from '@app/connected-settings';
import { ConnectedTopHUD } from '@app/connected-hud';
import { OverlaySelection } from '@app/overlay-selection';
import { PanelSelection } from '@app/panel-selection';
import { SAVE_SLOT_IDS as APP_SLOT_IDS } from '@app/save/save-game';
import { DEFAULT_SETTINGS, MAX_AUTOSAVE_EVERY_DAYS, SETTINGS_SPEEDS, normalizeSettings } from '@app/settings';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { SAVE_SLOT_IDS } from '@ui/save-types';
import { AUTOSAVE_OPTIONS, DEFAULT_SPEED_OPTIONS, type SettingsPanelProps } from '@ui/settings-panel';
import type { SaveLoadPanelProps } from '@ui/save-load-panel';
import type { TopHUDProps } from '@ui/top-hud';
import { saveHarness } from './save/save-fixtures';

const captured = vi.hoisted(() => ({
  saveLoad: null as SaveLoadPanelProps | null,
  settings: null as SettingsPanelProps | null,
  hud: null as TopHUDProps | null,
}));

vi.mock('@ui/save-load-panel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/save-load-panel')>();
  return {
    ...original,
    SaveLoadPanel: (props: SaveLoadPanelProps) => {
      captured.saveLoad = props;
      return null;
    },
  };
});

vi.mock('@ui/settings-panel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/settings-panel')>();
  return {
    ...original,
    SettingsPanel: (props: SettingsPanelProps) => {
      captured.settings = props;
      return null;
    },
  };
});

vi.mock('@ui/top-hud', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/top-hud')>();
  return {
    ...original,
    TopHUD: (props: TopHUDProps) => {
      captured.hud = props;
      return null;
    },
  };
});

beforeEach(() => {
  captured.saveLoad = null;
  captured.settings = null;
  captured.hud = null;
});

const saveLoadProps = (): SaveLoadPanelProps => {
  if (captured.saveLoad === null) throw new Error('SaveLoadPanel sa nevykreslil');
  return captured.saveLoad;
};
const settingsProps = (): SettingsPanelProps => {
  if (captured.settings === null) throw new Error('SettingsPanel sa nevykreslil');
  return captured.settings;
};
const hudProps = (): TopHUDProps => {
  if (captured.hud === null) throw new Error('TopHUD sa nevykreslil');
  return captured.hud;
};

describe('ConnectedSaveLoad', () => {
  it('zatvorený overlay nevykreslí nič (mapa ostáva klikateľná)', () => {
    const { controller } = saveHarness();
    const overlays = new OverlaySelection();
    expect(renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }))).toBe('');
    overlays.open('settings'); // iný overlay
    expect(renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }))).toBe('');
    expect(captured.saveLoad).toBeNull();
  });

  it('otvorený: v `.app__modal` (berie myš) a panel dostane sloty zo SaveController', () => {
    const { controller } = saveHarness();
    controller.save('2');
    const overlays = new OverlaySelection();
    overlays.open('saves');
    const html = renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    expect(html).toContain('class="app__modal"');
    expect(saveLoadProps().slots).toBe(controller.getState().slots);
    expect(saveLoadProps().slots.map((slot) => slot.slot)).toEqual(['2']);
  });

  it('onSave / onDelete idú na kontrolér a zoznam slotov sa obnoví', () => {
    const { controller, storage } = saveHarness();
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    saveLoadProps().onSave('3');
    expect(storage.data.has('mh.save.3')).toBe(true);
    expect(controller.getState().slots.map((slot) => slot.slot)).toEqual(['3']);
    saveLoadProps().onDelete('3');
    expect(storage.data.has('mh.save.3')).toBe(false);
    expect(controller.getState().slots).toEqual([]);
  });

  it('onLoad obnoví svet zo slotu a žiada reštart (loadWorld)', () => {
    const { controller, loaded, world } = saveHarness();
    controller.save('1');
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    saveLoadProps().onLoad('1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).not.toBe(world);
    expect(loaded[0]?.clock.tick).toBe(world.clock.tick);
  });

  it('onLoad prázdneho slotu: toast s dôvodom, overlay ostáva otvorený', () => {
    const { controller, loaded, toasts } = saveHarness();
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    saveLoadProps().onLoad('2');
    expect(loaded).toHaveLength(0);
    expect(toasts.at(-1)).toMatchObject({ tone: 'danger', title: 'Načítanie zlyhalo' });
    expect(overlays.get()).toBe('saves');
  });

  it('onExport stiahne súbor aktuálnej hry', () => {
    const { controller, downloads } = saveHarness();
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    saveLoadProps().onExport();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.fileName).toMatch(/^modular-harbor-.*\.json$/);
  });

  it('onImport načíta súbor (asynchrónne) a žiada reštart; chybný súbor len ohlási toast', async () => {
    const { controller, loaded, toasts, world, storage } = saveHarness();
    controller.save('1');
    const exported = storage.data.get('mh.save.1') ?? '';
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));

    saveLoadProps().onImport(new Blob(['toto nie je save']) as File);
    await vi.waitFor(() => {
      expect(toasts.at(-1)).toMatchObject({ tone: 'danger', title: 'Import zlyhal' });
    });
    expect(loaded).toHaveLength(0);

    saveLoadProps().onImport(new Blob([exported]) as File);
    await vi.waitFor(() => {
      expect(loaded).toHaveLength(1);
    });
    expect(loaded[0]?.clock.tick).toBe(world.clock.tick);
  });

  it('onClose zatvorí overlay', () => {
    const { controller } = saveHarness();
    const overlays = new OverlaySelection();
    overlays.open('saves');
    renderToStaticMarkup(createElement(ConnectedSaveLoad, { overlays, saves: controller }));
    saveLoadProps().onClose();
    expect(overlays.get()).toBeNull();
  });
});

describe('ConnectedSettings', () => {
  it('zatvorený overlay nevykreslí nič', () => {
    const { controller } = saveHarness();
    const overlays = new OverlaySelection();
    expect(renderToStaticMarkup(createElement(ConnectedSettings, { overlays, saves: controller }))).toBe('');
    overlays.open('saves');
    expect(renderToStaticMarkup(createElement(ConnectedSettings, { overlays, saves: controller }))).toBe('');
    expect(captured.settings).toBeNull();
  });

  it('otvorený: v `.app__modal`, panel dostane uložené nastavenia a ponuku odvodenú z app konštánt', () => {
    const { controller } = saveHarness();
    controller.setSettings({ ...DEFAULT_SETTINGS, defaultSpeed: 4, autosaveEveryDays: 3 });
    const overlays = new OverlaySelection();
    overlays.open('settings');
    const html = renderToStaticMarkup(createElement(ConnectedSettings, { overlays, saves: controller }));
    expect(html).toContain('class="app__modal"');
    expect(settingsProps().settings).toBe(controller.getState().settings);
    expect(settingsProps().settings).toMatchObject({ defaultSpeed: 4, autosaveEveryDays: 3 });
    expect(settingsProps().speeds).toBe(OFFERED_SPEEDS);
    expect(settingsProps().maxAutosaveDays).toBe(MAX_AUTOSAVE_EVERY_DAYS);
  });

  it('onChange uloží nastavenia cez kontrolér (úložisko aj stav); onClose zatvorí overlay', () => {
    const { controller, storage } = saveHarness();
    const overlays = new OverlaySelection();
    overlays.open('settings');
    renderToStaticMarkup(createElement(ConnectedSettings, { overlays, saves: controller }));
    settingsProps().onChange({ ...DEFAULT_SETTINGS, defaultSpeed: 8, autosaveEveryDays: 7 });
    expect(controller.getState().settings).toMatchObject({ defaultSpeed: 8, autosaveEveryDays: 7 });
    expect(JSON.parse(storage.data.get('mh.settings') ?? '{}')).toMatchObject({ defaultSpeed: 8, autosaveEveryDays: 7 });
    settingsProps().onClose();
    expect(overlays.get()).toBeNull();
  });

  it('ponuka UI sa zhoduje s tým, čo úložisko nastavení prijme (žiadna hodnota sa potichu nenahradí predvolenou)', () => {
    const { world } = saveHarness();
    // Ponúkané rýchlosti: všetko z SETTINGS_SPEEDS okrem pauzy, a to sú reálne rýchlosti hry (`time.speeds`).
    expect(OFFERED_SPEEDS).toEqual(SETTINGS_SPEEDS.filter((speed) => speed !== 0));
    for (const speed of OFFERED_SPEEDS) expect(world.defs.time.speeds).toContain(speed);
    // Predvolená ponuka panelu (bez props) je podmnožina povoleného.
    for (const speed of DEFAULT_SPEED_OPTIONS) {
      expect(SETTINGS_SPEEDS).toContain(speed);
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, defaultSpeed: speed }).defaultSpeed).toBe(speed);
    }
    for (const { days } of AUTOSAVE_OPTIONS) {
      expect(days).toBeLessThanOrEqual(MAX_AUTOSAVE_EVERY_DAYS);
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, autosaveEveryDays: days }).autosaveEveryDays).toBe(days);
    }
  });
});

describe('jeden zdroj typov', () => {
  it('zoznam slotov v app je ten istý objekt ako v @ui/save-types (nie kópia)', () => {
    expect(APP_SLOT_IDS).toBe(SAVE_SLOT_IDS);
    expect(SAVE_SLOT_IDS).toEqual(['auto', '1', '2', '3']);
  });
});

describe('ConnectedTopHUD: ikony overlayov', () => {
  function renderHud(overlays: OverlaySelection | undefined): void {
    const { bridge } = saveHarness();
    renderToStaticMarkup(
      createElement(SimBridgeProvider, { bridge }, createElement(ConnectedTopHUD, { panels: new PanelSelection(), ...(overlays === undefined ? {} : { overlays }) })),
    );
  }

  it('⚙ otvorí Nastavenia a disketa Uložiť/načítať', () => {
    const overlays = new OverlaySelection();
    renderHud(overlays);
    hudProps().onOpenSettings?.();
    expect(overlays.get()).toBe('settings');
    hudProps().onOpenSaves?.();
    expect(overlays.get()).toBe('saves');
  });

  it('bez overlayov (testy, demo) HUD handlery nedostane a ikona kontraktov funguje ďalej', () => {
    renderHud(undefined);
    expect(hudProps().onOpenSettings).toBeUndefined();
    expect(hudProps().onOpenSaves).toBeUndefined();
    expect(hudProps().onTogglePanel).toBeTypeOf('function');
  });
});
