// T06-03b: App s `saves` skladá overlaye Nastavenia a Uložiť/načítať (skutočné panely, bez atrap); bez `saves` ich nevykreslí.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '@app/app';
import type { FeedbackSource } from '@app/build-feedback';
import { OverlaySelection } from '@app/overlay-selection';
import { saveHarness } from './save/save-fixtures';

const NO_FEEDBACK: FeedbackSource = { feedback: () => null, subscribeFeedback: () => () => undefined };

function render(open: 'settings' | 'saves' | null, withSaves = true): string {
  const { bridge, controller } = saveHarness();
  const overlays = new OverlaySelection();
  if (open !== null) overlays.open(open);
  return renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK, overlays, ...(withSaves ? { saves: controller } : {}) }));
}

describe('App: overlaye', () => {
  it('zatvorené: žiadny dialóg ani `.app__modal` (mapa ostáva klikateľná)', () => {
    const html = render(null);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('app__modal');
  });

  it('`saves` otvorí dialóg Uložiť a načítať so všetkými štyrmi slotmi', () => {
    const html = render('saves');
    expect(html).toContain('data-dialog="save-load"');
    expect(html).toContain('class="app__modal"');
    expect(html.match(/class="save-slot"/g)).toHaveLength(4);
    expect(html).not.toContain('data-dialog="settings"');
  });

  it('`settings` otvorí dialóg Nastavenia s ponukou rýchlostí 1×–8× (bez pauzy) a intervalov autosave', () => {
    const html = render('settings');
    expect(html).toContain('data-dialog="settings"');
    const speeds = /data-field="default-speed">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect([...speeds.matchAll(/data-value="(\d+)"/g)].map((match) => match[1])).toEqual(['1', '2', '4', '8']);
    const autosave = /data-field="autosave">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect([...autosave.matchAll(/data-value="(\d+)"/g)].map((match) => match[1])).toEqual(['0', '1', '3', '7']);
    expect(html).not.toContain('data-dialog="save-load"');
  });

  it('HUD má obe ikony overlayov aktívne (disketa a ⚙) a bez `saves` aj tak nič neotvoria', () => {
    const html = render(null);
    expect(html).toMatch(/data-field="panel-saves"(?![^>]*disabled)/);
    expect(html).toMatch(/data-field="panel-settings"(?![^>]*disabled)/);
    const without = render('saves', false);
    expect(without).not.toContain('role="dialog"'); // overlay bez SaveController nemá čo ukázať (ani zablokovať klávesy)
  });
});
