/**
 * Demo F6 UI (T06-04): overlay Nastavenia a Uložiť/načítať v kontexte „hry" (TopHUD hore s ikonami Uložiť a Nastavenia, ktoré overlay
 * otvárajú; zásterka kryje celú „mapu") a pod tým kontrolné rámiky oboch dialógov vždy otvorených. Statické dáta, žiadna
 * simulácia ani úložisko: Uložiť / Vymazať v demu len upravujú lokálny zoznam slotov, ostatné akcie sa zapisujú do záznamu.
 * Spustenie: dev server → /src/ui/__demo__/f6-ui-demo.html; screenshot a kontrolu klávesnice robí tests/e2e/f6-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SaveLoadPanel } from '../save-load-panel';
import type { SaveSlotId, SaveSlotInfo, Settings } from '../save-types';
import { SettingsPanel } from '../settings-panel';
import { TopHUDView } from '../top-hud';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f6-ui-demo.css';

/** Hodnoty prototypu: 1 234 560 USD, Deň 12 · 14:20, 340 XP. */
const DEMO_CASH_CENTS = 123_456_000;
const DEMO_DELTA_CENTS = 1_230_000;
const DEMO_XP = 340;

export const DEMO_SLOTS: readonly SaveSlotInfo[] = [
  { slot: 'auto', label: 'Automatické uloženie', savedAtIso: '2026-10-01T09:12:00.000Z', preview: { day: 11, timeLabel: '14:20', cashCents: 123_456_000, xp: 340 } },
  { slot: '1', label: 'Slot 1', savedAtIso: '2026-09-30T18:40:00.000Z', preview: { day: 7, timeLabel: '06:00', cashCents: 98_000_000, xp: 210 } },
  { slot: '3', label: 'Slot 3', savedAtIso: '2026-09-12T21:05:00.000Z', preview: { day: 141, timeLabel: '23:40', cashCents: 584_000_000, xp: 12_340 } },
];

export const DEMO_SETTINGS: Settings = { settingsVersion: 1, defaultSpeed: 1, autosaveEveryDays: 1, sound: false };

function noop(): void {
  // Demo: rýchlosť v HUD sa nemení.
}

/** Záznam posledných akcií (najviac 4, najstaršia vľavo), aby bolo vidieť poradie napr. `onChange(…) → onClose()`. */
function useActionLog(): { readonly text: string; readonly record: (action: string) => void } {
  const [actions, setActions] = useState<readonly string[]>([]);
  return {
    text: actions.length === 0 ? 'Posledná akcia: —' : `Posledná akcia: ${actions.join(' → ')}`,
    record: (action) => {
      setActions((current) => [...current, action].slice(-4));
    },
  };
}

interface SavesState {
  readonly slots: readonly SaveSlotInfo[];
  readonly save: (slot: SaveSlotId) => void;
  readonly remove: (slot: SaveSlotId) => void;
}

/** Zoznam slotov v lokálnom stave: Uložiť zapíše aktuálne hodnoty HUD, Vymazať slot odstráni. */
function useDemoSlots(): SavesState {
  const [slots, setSlots] = useState<readonly SaveSlotInfo[]>(DEMO_SLOTS);
  return {
    slots,
    save: (slot) => {
      const info: SaveSlotInfo = {
        slot,
        label: `Slot ${slot}`,
        savedAtIso: '2026-10-01T12:35:00.000Z',
        preview: { day: 11, timeLabel: '14:20', cashCents: DEMO_CASH_CENTS, xp: DEMO_XP },
      };
      setSlots((current) => [...current.filter((item) => item.slot !== slot), info]);
    },
    remove: (slot) => {
      setSlots((current) => current.filter((item) => item.slot !== slot));
    },
  };
}

type Overlay = 'none' | 'saves' | 'settings';

/** „Hra": HUD s ikonami, ktoré otvárajú overlay; Esc a Zavrieť ho zatvárajú. */
function GameStage() {
  const log = useActionLog();
  const saves = useDemoSlots();
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [settings, setSettings] = useState<Settings>(DEMO_SETTINGS);
  const close = (): void => {
    setOverlay('none');
  };
  return (
    <div className="f6-demo__map f6-demo__stage" data-testid="stage">
      <span className="f6-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f6-demo__stage-hud">
        <TopHUDView
          cashCents={DEMO_CASH_CENTS}
          day={11}
          hour={14}
          minute={20}
          speed={1}
          speeds={DEMO_SPEEDS}
          onSpeedChange={noop}
          dailyDeltaCents={DEMO_DELTA_CENTS}
          xp={DEMO_XP}
          onOpenSaves={() => {
            setOverlay('saves');
          }}
          onOpenSettings={() => {
            setOverlay('settings');
          }}
        />
      </div>
      {overlay === 'saves' && (
        <SaveLoadPanel
          slots={saves.slots}
          onSave={(slot) => {
            saves.save(slot);
            log.record(`onSave(${slot})`);
          }}
          onLoad={(slot) => {
            log.record(`onLoad(${slot})`);
          }}
          onDelete={(slot) => {
            saves.remove(slot);
            log.record(`onDelete(${slot})`);
          }}
          onExport={() => {
            log.record('onExport()');
          }}
          onImport={(file) => {
            log.record(`onImport(${file.name})`);
          }}
          onClose={() => {
            log.record('onClose()');
            close();
          }}
        />
      )}
      {overlay === 'settings' && (
        <SettingsPanel
          settings={settings}
          onChange={(next) => {
            setSettings(next);
            log.record(`onChange(speed ${String(next.defaultSpeed)}×, autosave ${String(next.autosaveEveryDays)} d)`);
          }}
          onClose={() => {
            log.record('onClose()');
            close();
          }}
        />
      )}
    </div>
  );
}

/** Uložiť/načítať vždy otvorené v rámiku výšky ako v hre; akcie sa zapisujú pod rámik. */
function SavesFrame() {
  const log = useActionLog();
  const saves = useDemoSlots();
  return (
    <figure className="f6-demo__figure" data-testid="frame-saves">
      <figcaption className="f6-demo__caption">Uložiť a načítať — auto, Slot 1, Slot 3 obsadené, Slot 2 prázdny</figcaption>
      <div className="f6-demo__map f6-demo__map--modal">
        <span className="f6-demo__map-label">MAPA · PixiJS canvas</span>
        <SaveLoadPanel
          slots={saves.slots}
          onSave={(slot) => {
            saves.save(slot);
            log.record(`onSave(${slot})`);
          }}
          onLoad={(slot) => {
            log.record(`onLoad(${slot})`);
          }}
          onDelete={(slot) => {
            saves.remove(slot);
            log.record(`onDelete(${slot})`);
          }}
          onExport={() => {
            log.record('onExport()');
          }}
          onImport={(file) => {
            log.record(`onImport(${file.name})`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
        />
      </div>
      <span className="f6-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

function SettingsFrame() {
  const log = useActionLog();
  return (
    <figure className="f6-demo__figure" data-testid="frame-settings">
      <figcaption className="f6-demo__caption">Nastavenia — rýchlosť, automatické ukladanie, zvuk (zatiaľ nedostupný)</figcaption>
      <div className="f6-demo__map f6-demo__map--modal">
        <span className="f6-demo__map-label">MAPA · PixiJS canvas</span>
        <SettingsPanel
          settings={DEMO_SETTINGS}
          onChange={(next) => {
            log.record(`onChange(speed ${String(next.defaultSpeed)}×, autosave ${String(next.autosaveEveryDays)} d)`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
        />
      </div>
      <span className="f6-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

export function F6UiDemo() {
  return (
    <main className="f6-demo">
      <section className="f6-demo__section">
        <div className="f6-demo__caption">TopHUD s ikonami Uložiť a načítať a Nastavenia: klik otvorí overlay, Esc / Zavrieť ho zatvorí</div>
        <GameStage />
      </section>
      <section className="f6-demo__section">
        <div className="f6-demo__row">
          <SavesFrame />
          <SettingsFrame />
        </div>
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF6UiDemo(element: HTMLElement): void {
  createRoot(element).render(<F6UiDemo />);
}
