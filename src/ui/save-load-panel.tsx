/**
 * SaveLoadPanel (T06-04; vzhľad v štýle overlayu `settings` z prototypu design/ui/game-ui.source.html): dialóg „Uložiť
 * a načítať hru" so štyrmi slotmi (automatický + 1–3) a preview v každom riadku — deň a čas, hotovosť, XP, dátum uloženia.
 * Prázdny slot ukazuje „Prázdny". Akcie slotu: Uložiť (len sloty 1–3, nie do automatického), Načítať, Vymazať s
 * potvrdením priamo v riadku. V päte Export do súboru, Import zo súboru (skrytý `<input type=file>`) a Zavrieť.
 *
 * Čistý komponent s props: žiadny `useSimSnapshot`, žiadne úložisko — zoznam slotov a všetky akcie dodáva rodič (T06-03).
 * `SaveLoadPanelView` je bez hookov (testovateľný bez DOM), `SaveLoadPanel` k nemu pridáva stav potvrdenia mazania a
 * správu fokusu. Peniaze a XP idú cez `formatMoney`/`formatXp` (tabular-nums v CSS).
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactElement, type RefObject } from 'react';
import { formatDateTime, formatMoney, formatXp } from './format';
import { Icon } from './icon';
import { ModalDialog } from './modal-dialog';
import type { SavePreview, SaveSlotId, SaveSlotInfo } from './save-types';
import './save-load-panel.css';

/** Poradie slotov v zozname. */
export const SAVE_SLOT_IDS: readonly SaveSlotId[] = ['auto', '1', '2', '3'];

/** Hodnota `accept` skrytého výberu súboru. */
export const IMPORT_ACCEPT = '.json,application/json';

/** Text prázdneho slotu. */
export const EMPTY_SLOT_TEXT = 'Prázdny';

/** Viditeľný názov slotu. */
export function slotName(slot: SaveSlotId): string {
  return slot === 'auto' ? 'Automatické uloženie' : `Slot ${slot}`;
}

/** Slot v slovenskej vete pre prístupné názvy tlačidiel (`Načítať slot 2`, `Načítať automatické uloženie`). */
export function slotReference(slot: SaveSlotId): string {
  return slot === 'auto' ? 'automatické uloženie' : `slot ${slot}`;
}

/** Deň a čas z preview: `Deň 12 · 14:20` (`day` je 0-based ako v HUD, hráč vidí `day + 1`). */
export function previewTimeText(preview: SavePreview): string {
  return `Deň ${String(Math.trunc(preview.day) + 1)} · ${preview.timeLabel}`;
}

/** Obsadený slot zo zoznamu (prázdne sloty v zozname nie sú); pri duplicite vyhrá prvý. */
export function findSlot(slots: readonly SaveSlotInfo[], slot: SaveSlotId): SaveSlotInfo | undefined {
  return slots.find((info) => info.slot === slot);
}

export interface SaveLoadPanelProps {
  /** Obsadené sloty (prázdne v zozname chýbajú; panel vždy ukáže všetky štyri). */
  readonly slots: readonly SaveSlotInfo[];
  /** Uložiť hru do slotu 1–3 (panel nikdy nevolá s `'auto'`). */
  readonly onSave: (slot: SaveSlotId) => void;
  readonly onLoad: (slot: SaveSlotId) => void;
  /** Volá sa až po potvrdení v riadku slotu. */
  readonly onDelete: (slot: SaveSlotId) => void;
  /** Stiahnutie aktuálnej hry ako súboru. */
  readonly onExport: () => void;
  /** Súbor vybraný v dialógu Import. */
  readonly onImport: (file: File) => void;
  readonly onClose: () => void;
}

export interface SaveLoadPanelViewProps extends SaveLoadPanelProps {
  /** Slot, pri ktorom beží potvrdenie vymazania; `null` = žiadne. */
  readonly confirmingSlot: SaveSlotId | null;
  readonly onRequestDelete: (slot: SaveSlotId) => void;
  readonly onCancelDelete: () => void;
  readonly fileInputRef: RefObject<HTMLInputElement>;
  readonly listRef: RefObject<HTMLUListElement>;
}

/** Riadky sú obyčajné funkcie vracajúce elementy (nie komponenty), aby strom zostal plochý a testy ho prešli bez DOM. */
function renderPreview(info: SaveSlotInfo): ReactElement {
  return (
    <dl className="save-slot__stats">
      <div className="save-slot__stat" data-field="slot-time">
        <dt className="save-slot__stat-label">
          <Icon name="ic_calendar" className="save-slot__icon save-slot__icon--time" />
          <span className="save-slot__sr-only">Herný čas</span>
        </dt>
        <dd className="save-slot__stat-value">{previewTimeText(info.preview)}</dd>
      </div>
      <div className="save-slot__stat" data-field="slot-cash">
        <dt className="save-slot__stat-label">
          <Icon name="ic_cash" className="save-slot__icon save-slot__icon--cash" />
          <span className="save-slot__sr-only">Hotovosť</span>
        </dt>
        <dd className="save-slot__stat-value">{formatMoney(info.preview.cashCents)}</dd>
      </div>
      <div className="save-slot__stat" data-field="slot-xp">
        <dt className="save-slot__stat-label">
          <Icon name="ic_xp" className="save-slot__icon save-slot__icon--xp" />
          <span className="save-slot__sr-only">Skúsenosti</span>
        </dt>
        <dd className="save-slot__stat-value">{formatXp(info.preview.xp)}</dd>
      </div>
    </dl>
  );
}

/**
 * Dva stavy riadku (bežné akcie / potvrdenie) majú rôzne `key`, takže React ich vymení celé: bez toho by sa tlačidlá
 * prepísali na mieste a fokus by z „Vymazať" skončil rovno na potvrdzujúcom „Vymazať" (a `autoFocus` by sa nepoužil).
 */
function renderActions(slot: SaveSlotId, empty: boolean, view: SaveLoadPanelViewProps): ReactElement {
  const name = slotName(slot);
  if (view.confirmingSlot === slot) {
    return (
      <div key="confirm" className="save-slot__actions save-slot__actions--confirm" role="group" aria-label={`Potvrdenie vymazania: ${name}`} data-field="delete-confirm">
        <span className="save-slot__confirm-text">Vymazať natrvalo?</span>
        <button type="button" className="modal-btn modal-btn--sm" data-action="delete-cancel" data-slot={slot} autoFocus onClick={view.onCancelDelete}>
          Zrušiť
        </button>
        <button
          type="button"
          className="modal-btn modal-btn--sm modal-btn--danger"
          data-action="delete-confirm"
          data-slot={slot}
          aria-label={`Vymazať ${slotReference(slot)} natrvalo`}
          onClick={() => {
            view.onDelete(slot);
          }}
        >
          Vymazať
        </button>
      </div>
    );
  }
  return (
    <div key="actions" className="save-slot__actions">
      {slot !== 'auto' && (
        <button
          type="button"
          className="modal-btn modal-btn--sm modal-btn--secondary"
          data-action="save"
          data-slot={slot}
          aria-label={`Uložiť do slotu ${slot}`}
          onClick={() => {
            view.onSave(slot);
          }}
        >
          Uložiť
        </button>
      )}
      <button
        type="button"
        className="modal-btn modal-btn--sm modal-btn--secondary"
        data-action="load"
        data-slot={slot}
        aria-label={`Načítať ${slotReference(slot)}`}
        disabled={empty}
        onClick={() => {
          view.onLoad(slot);
        }}
      >
        Načítať
      </button>
      <button
        type="button"
        className="modal-btn modal-btn--sm"
        data-action="delete"
        data-slot={slot}
        aria-label={`Vymazať ${slotReference(slot)}`}
        disabled={empty}
        onClick={() => {
          view.onRequestDelete(slot);
        }}
      >
        Vymazať
      </button>
    </div>
  );
}

function renderSlot(slot: SaveSlotId, info: SaveSlotInfo | undefined, view: SaveLoadPanelViewProps): ReactElement {
  const empty = info === undefined;
  return (
    <li key={slot} className="save-slot" data-slot={slot} data-empty={empty}>
      <div className="save-slot__info">
        <div className="save-slot__head">
          <span className="save-slot__name" data-field="slot-name">
            {slotName(slot)}
          </span>
          {info === undefined ? (
            <span className="save-slot__empty" data-field="slot-empty">
              {EMPTY_SLOT_TEXT}
            </span>
          ) : (
            <span className="save-slot__saved" data-field="slot-saved">
              {formatDateTime(info.savedAtIso)}
            </span>
          )}
        </div>
        {info !== undefined && renderPreview(info)}
      </div>
      {renderActions(slot, empty, view)}
    </li>
  );
}

export function SaveLoadPanelView(view: SaveLoadPanelViewProps) {
  const { slots, onExport, onImport, onClose, fileInputRef, listRef } = view;
  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Vyprázdnenie hodnoty umožní vybrať ten istý súbor znova (inak `change` nenastane).
    event.target.value = '';
    if (file !== undefined) onImport(file);
  };
  return (
    <ModalDialog label="Uložiť a načítať hru" title="Uložiť a načítať" onClose={onClose} className="save-load-panel" dialogId="save-load">
      <div className="modal-dialog__body">
        <ul className="save-list" ref={listRef} aria-label="Sloty uloženia">
          {SAVE_SLOT_IDS.map((slot) => renderSlot(slot, findSlot(slots, slot), view))}
        </ul>
        <span className="save-load-panel__hint">Ctrl+S uloží hru do slotu 1. Autosave zapisuje len do automatického uloženia.</span>
      </div>
      <div className="modal-dialog__footer">
        <div className="modal-dialog__footer-group">
          <button type="button" className="modal-btn modal-btn--secondary" data-action="export" onClick={onExport}>
            Export do súboru
          </button>
          <button
            type="button"
            className="modal-btn modal-btn--secondary"
            data-action="import"
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            Import zo súboru
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_ACCEPT}
            hidden
            tabIndex={-1}
            aria-label="Súbor uloženej hry na import"
            data-field="import-input"
            onChange={onFileChange}
          />
        </div>
        <button type="button" className="modal-btn" data-action="close" onClick={onClose}>
          Zavrieť
        </button>
      </div>
    </ModalDialog>
  );
}

export function SaveLoadPanel(props: SaveLoadPanelProps) {
  const [confirmingSlot, setConfirmingSlot] = useState<SaveSlotId | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Po skončení potvrdenia (Zrušiť / Vymazať) vráť fokus do riadku slotu, inak by zostal na zaniknutom tlačidle.
  const lastConfirmed = useRef<SaveSlotId | null>(null);
  useEffect(() => {
    if (confirmingSlot !== null) {
      lastConfirmed.current = confirmingSlot;
      return;
    }
    const slot = lastConfirmed.current;
    lastConfirmed.current = null;
    const row = slot === null ? null : listRef.current?.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    const target = row?.querySelector<HTMLElement>('[data-action="delete"]:not(:disabled)') ?? row?.querySelector<HTMLElement>('button:not(:disabled)');
    target?.focus({ preventScroll: true });
  }, [confirmingSlot]);

  return (
    <SaveLoadPanelView
      {...props}
      confirmingSlot={confirmingSlot}
      onRequestDelete={setConfirmingSlot}
      onCancelDelete={() => {
        setConfirmingSlot(null);
      }}
      onDelete={(slot) => {
        props.onDelete(slot);
        setConfirmingSlot(null);
      }}
      fileInputRef={fileInputRef}
      listRef={listRef}
    />
  );
}
