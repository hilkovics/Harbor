/**
 * Demo ModuleInspector (T02-08): statické dáta bez bridge (komponent je čisto prezentačný).
 *  - kotvisko s apronom 3/4 a dokovanou loďou Feeder 1/4 TEU (odstrániť nejde — loď kotví),
 *  - žeriav v stave `blocked` (plný apron; badge žltý, banner s vysvetlením),
 *  - žeriav pri vykladaní (badge zelený, vysoká vyťaženosť),
 *  - kotvisko bez lode so štartovým modulom (odstrániť nejde — má žeriav).
 * Tlačidlá Odstrániť / Zavrieť zapíšu poslednú akciu pod panel, aby šlo overiť zapojenie callbackov.
 */
import { useState } from 'react';
import {
  ModuleInspector,
  craneStateLabel,
  craneStateOk,
  type ModuleInspectorData,
} from '../module-inspector';
import './demo-base';

/** Kotvisko z F2 (prototyp: kotvisko + apron): 3 z 4 slotov obsadené, Feeder vyložený z 3/4. */
export const BERTH_DOCKED: ModuleInspectorData = {
  id: 7,
  defId: 'berth_standard',
  displayName: 'Kotvisko štandard',
  kind: 'berth',
  footprint: { w: 8, h: 3 },
  stateLabel: 'Loď kotví',
  ok: true,
  apron: { used: 3, reserved: 0, capacity: 4 },
  dockedShip: { classLabel: 'Feeder', unitsOnBoard: 1, capacityUnits: 4, unitLabel: 'TEU' },
  refundCents: 20_000_000,
  removable: false,
  removeBlockedReason: 'Pri kotvisku kotví loď.',
};

/** Žeriav so zablokovaným cyklom (plný apron). */
export const CRANE_BLOCKED: ModuleInspectorData = {
  id: 8,
  defId: 'crane_container_gantry',
  displayName: 'Kontajnerový žeriav',
  kind: 'crane',
  footprint: { w: 2, h: 3 },
  stateLabel: craneStateLabel('blocked'),
  ok: craneStateOk('blocked'),
  crane: { state: 'blocked', utilizationPct: 72, blockedPct: 21 },
  refundCents: 30_000_000,
  removable: true,
};

/** Žeriav pri práci (fáza `grabbing` sa hráčovi ukáže ako „Vykladá"). */
export const CRANE_WORKING: ModuleInspectorData = {
  id: 9,
  defId: 'crane_container_gantry',
  displayName: 'Kontajnerový žeriav',
  kind: 'crane',
  footprint: { w: 2, h: 3 },
  stateLabel: craneStateLabel('grabbing'),
  ok: craneStateOk('grabbing'),
  crane: { state: 'grabbing', utilizationPct: 88, blockedPct: 0 },
  refundCents: 30_000_000,
  removable: true,
};

/** Štartové kotvisko bez lode: apron prázdny, odstrániť nejde (má žeriav), vrátenie $0. */
export const BERTH_FREE: ModuleInspectorData = {
  id: 1,
  defId: 'berth_standard',
  displayName: 'Kotvisko štandard',
  kind: 'berth',
  footprint: { w: 8, h: 3 },
  stateLabel: 'Voľné',
  ok: true,
  apron: { used: 0, reserved: 0, capacity: 4 },
  dockedShip: null,
  refundCents: 0,
  removable: false,
  removeBlockedReason: 'Kotvisko so žeriavom nejde odstrániť.',
};

/** R2: blok stohu (yard block) so stohmi kontajnerov (bay view). */
export const YARD_BLOCK: ModuleInspectorData = {
  id: 10,
  defId: 'container_yard_small',
  displayName: 'RTG blok B2',
  kind: 'storage',
  footprint: { w: 12, h: 6 },
  stateLabel: 'V prevádzke',
  ok: true,
  yardBlock: {
    geometry: { bays: 12, rows: 6, maxTier: 5 },
    capacityTeu: 1440,
    usedTeu: 1064,
    rehandlesPerMove: 0.32,
    stacks: Array.from({ length: 12 }, (_, bay) =>
      Array.from({ length: 6 }, (_, row) => ({
        bay,
        row,
        height: Math.random() > 0.3 ? Math.floor(Math.random() * 4) + 1 : 0,
        top:
          Math.random() > 0.4
            ? {
                sizeFt: (Math.random() > 0.5 ? 20 : 40) as 20 | 40,
                containerType: 'dry',
                lineId: null,
                direction: 'export',
              }
            : null,
      }))
    ).flat(),
  },
  refundCents: 25_000_000,
  removable: true,
};

/** Lokálny záznam poslednej akcie (`onRemove(id)` / `onClose()`), aby šlo overiť zapojenie callbackov. */
export function useActionLog(): {
  readonly text: string;
  readonly onRemove: (id: number) => void;
  readonly onClose: () => void;
} {
  const [lastAction, setLastAction] = useState<string | null>(null);
  return {
    text: lastAction === null ? 'Posledná akcia: \u2014' : `Posledná akcia: ${lastAction}`,
    onRemove: (id) => {
      setLastAction(`onRemove(${String(id)})`);
    },
    onClose: () => {
      setLastAction('onClose()');
    },
  };
}

function InspectorFrame({ title, data }: { title: string; data: ModuleInspectorData }) {
  const log = useActionLog();
  return (
    <figure className="f2-demo__figure">
      <figcaption className="f2-demo__caption">{title}</figcaption>
      <div className="f2-demo__map f2-demo__map--panel">
        <ModuleInspector data={data} onRemove={log.onRemove} onClose={log.onClose} />
      </div>
      <span className="f2-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

/** Kontrolný rad panelov: blokovaný žeriav, žeriav pri práci, voľné štartové kotvisko, blok stohu. */
export function ModuleInspectorDemo() {
  return (
    <div className="f2-demo__row">
      <InspectorFrame title="Žeriav — blocked (plný apron)" data={CRANE_BLOCKED} />
      <InspectorFrame title="Žeriav — vykladá (vyťaženosť ≥ 75 %)" data={CRANE_WORKING} />
      <InspectorFrame title="Kotvisko — bez lode, štartový modul" data={BERTH_FREE} />
      <InspectorFrame title="Blok stohu — RTG blok B2" data={YARD_BLOCK} />
    </div>
  );
}
