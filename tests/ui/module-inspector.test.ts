import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CRANE_STATE_LABELS,
  DISCONNECTED_BADGE_LABEL,
  DISCONNECTED_TITLE,
  ModuleInspector,
  SELL_BLOCKED_TEXT,
  UTILIZATION_DANGER_PCT,
  UTILIZATION_WARN_PCT,
  VEHICLE_STATE_INFO,
  apronFree,
  badgeText,
  berthStats,
  canSellVehicle,
  clampPercent,
  craneStateLabel,
  craneStateOk,
  craneStats,
  craneTimeSplit,
  depotStats,
  depotVehicleCounts,
  inspectorBadge,
  moduleCode,
  moduleKindIcon,
  moduleSubtitle,
  sellTitle,
  shareOf,
  storageFillPct,
  storageFree,
  storageStats,
  utilizationTone,
  vehicleCode,
  type CraneStateName,
  type DepotVehicleData,
  type ModuleInspectorData,
  type ModuleInspectorProps,
} from '@ui/module-inspector';
import { fieldText, findAll, propsOf } from './react-tree';

const BERTH: ModuleInspectorData = {
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

const CRANE_BLOCKED: ModuleInspectorData = {
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

function makeProps(data: ModuleInspectorData, overrides: Partial<ModuleInspectorProps> = {}): ModuleInspectorProps {
  return { data, onRemove: vi.fn(), onClose: vi.fn(), ...overrides };
}

function render(data: ModuleInspectorData): string {
  return renderToStaticMarkup(createElement(ModuleInspector, makeProps(data)));
}

describe('stavy žeriavu', () => {
  it('slovenské popisy: nečinný, pracovné fázy = „Vykladá", blokovaný s dôvodom', () => {
    const expected: Record<CraneStateName, string> = {
      idle: 'Nečinný',
      grabbing: 'Vykladá',
      swinging: 'Vykladá',
      placing: 'Vykladá',
      blocked: 'Blokovaný — plný apron',
    };
    expect(CRANE_STATE_LABELS).toEqual(expected);
    for (const state of Object.keys(expected) as CraneStateName[]) expect(craneStateLabel(state)).toBe(expected[state]);
  });

  it('badge je zelený všade okrem blocked', () => {
    expect(craneStateOk('blocked')).toBe(false);
    for (const state of ['idle', 'grabbing', 'swinging', 'placing'] as const) expect(craneStateOk(state)).toBe(true);
  });
});

describe('čisté pomocné funkcie', () => {
  it('badgeText skracuje popis pri „ — ", krátky nechá', () => {
    expect(badgeText('Blokovaný — plný apron')).toBe('Blokovaný');
    expect(badgeText('Vykladá')).toBe('Vykladá');
    expect(badgeText('')).toBe('');
  });

  it('moduleKindIcon: tabuľka druhov, neznámy druh → ic_inspect', () => {
    expect(moduleKindIcon('berth')).toBe('ic_berth');
    expect(moduleKindIcon('crane')).toBe('ic_crane');
    expect(moduleKindIcon('storage')).toBe('ic_yard');
    expect(moduleKindIcon('pipeline')).toBe('ic_pipe');
    expect(moduleKindIcon('nieco_nove')).toBe('ic_inspect');
  });

  it('moduleCode / moduleSubtitle: druh + id na dve číslice, rozmer len keď je známy', () => {
    expect(moduleCode('crane', 8)).toBe('CRN-08');
    expect(moduleCode('berth', 12)).toBe('BRT-12');
    expect(moduleCode('nieco_nove', 3)).toBe('NIE-03');
    expect(moduleSubtitle({ kind: 'crane', id: 8, footprint: { w: 2, h: 3 } })).toBe('CRN-08 · 2×3');
    expect(moduleSubtitle({ kind: 'crane', id: 8 })).toBe('CRN-08');
  });

  it('clampPercent a shareOf: orezanie na 0–100, neplatné vstupy a nulový celok dávajú 0', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(shareOf(3, 4)).toBe(75);
    expect(shareOf(5, 4)).toBe(100);
    expect(shareOf(1, 0)).toBe(0);
  });

  it('utilizationTone: prahy 75 % (žltá) a 90 % (červená) podľa prototypu', () => {
    expect([UTILIZATION_WARN_PCT, UTILIZATION_DANGER_PCT]).toEqual([75, 90]);
    expect(utilizationTone(74)).toBe('normal');
    expect(utilizationTone(75)).toBe('warn');
    expect(utilizationTone(89)).toBe('warn');
    expect(utilizationTone(90)).toBe('danger');
    expect(utilizationTone(100)).toBe('danger');
  });

  it('craneTimeSplit: celé percentá so súčtom presne 100, aj pri nezmyselných vstupoch', () => {
    expect(craneTimeSplit({ utilizationPct: 72, blockedPct: 21 })).toEqual({ busy: 72, blocked: 21, idle: 7 });
    expect(craneTimeSplit({ utilizationPct: 72.4, blockedPct: 20.6 })).toEqual({ busy: 72, blocked: 21, idle: 7 });
    for (const [utilizationPct, blockedPct] of [[90, 30], [-10, 500], [Number.NaN, 40], [100, 100], [0, 0]] as const) {
      const split = craneTimeSplit({ utilizationPct, blockedPct });
      expect(split.busy + split.blocked + split.idle).toBe(100);
      expect(Math.min(split.busy, split.blocked, split.idle)).toBeGreaterThanOrEqual(0);
    }
    expect(craneTimeSplit({ utilizationPct: 90, blockedPct: 30 })).toEqual({ busy: 90, blocked: 10, idle: 0 });
  });

  it('apronFree nikdy nie je záporné; dlaždice kotviska: voľné 0 = varovanie', () => {
    expect(apronFree({ used: 3, reserved: 0, capacity: 4 })).toBe(1);
    expect(apronFree({ used: 3, reserved: 1, capacity: 4 })).toBe(0);
    expect(apronFree({ used: 5, reserved: 1, capacity: 4 })).toBe(0);
    const full = berthStats({ used: 3, reserved: 1, capacity: 4 });
    expect(full.map((stat) => [stat.key, stat.value, stat.tone])).toEqual([
      ['used', '3', 'normal'],
      ['reserved', '1', 'normal'],
      ['free', '0', 'warn'],
    ]);
    expect(berthStats({ used: 3, reserved: 0, capacity: 4 })[2]).toMatchObject({ value: '1', tone: 'normal' });
  });

  it('dlaždice žeriavu: vyťaženosť s tónom podľa prahov, blokovaný žltý len keď > 0, súčet 100 %', () => {
    const stats = craneStats({ utilizationPct: 92, blockedPct: 0 });
    expect(stats.map((stat) => [stat.key, stat.value, stat.tone])).toEqual([
      ['busy', '92 %', 'danger'],
      ['blocked', '0 %', 'normal'],
      ['idle', '8 %', 'normal'],
    ]);
    expect(craneStats({ utilizationPct: 72, blockedPct: 21 })[1]).toMatchObject({ value: '21 %', tone: 'warn' });
  });
});

describe('ModuleInspector — kotvisko', () => {
  it('hlavička: názov, podtitul s kódom a rozmerom, zelený badge, zavrieť', () => {
    const html = render(BERTH);
    expect(fieldText(html, 'title')).toBe('Kotvisko štandard');
    expect(fieldText(html, 'sub')).toBe('BRT-07 · 8×3');
    expect(html).toContain('title="berth_standard"');
    expect(html).toContain('module-inspector__badge--ok');
    expect(html).not.toContain('module-inspector__badge--warn');
    expect(html).toMatch(/data-field="badge" data-ok="true"[^>]*><svg[^>]*><use href="[^"]*#ic_check"/);
    expect(html).toContain('#ic_berth');
    expect(html).toContain('aria-label="Zavrieť inšpektor"');
    expect(html).toContain('data-module-id="7"');
  });

  it('apron 3/4: dlaždice, počet slotov a pruh (75 %); bez rezervácie 0 %', () => {
    const html = render(BERTH);
    expect(fieldText(html, 'stat-used')).toBe('3');
    expect(fieldText(html, 'stat-reserved')).toBe('0');
    expect(fieldText(html, 'stat-free')).toBe('1');
    expect(fieldText(html, 'apron-count')).toBe('3 / 4 slotov');
    expect(html).toMatch(/aria-label="Zaplnenie apronu" aria-valuemin="0" aria-valuemax="4" aria-valuenow="3"/);
    expect(html).toContain('module-inspector__bar-fill--used" style="width:75%"');
    expect(html).toContain('module-inspector__bar-fill--reserved" style="width:0%"');
  });

  it('dokovaná loď Feeder 1/4 TEU s pruhom 25 %', () => {
    const html = render(BERTH);
    expect(html).toContain('Zakotvená loď');
    expect(fieldText(html, 'ship-class')).toBe('Feeder');
    expect(fieldText(html, 'ship-units')).toBe('1 / 4 TEU');
    expect(html).toMatch(/aria-label="Náklad na lodi"[^>]*><div class="module-inspector__bar-fill module-inspector__bar-fill--used" style="width:25%"/);
  });

  it('bez lode: zástupný text; bez údaja o lodi sa sekcia nevykreslí; bez jednotky „jedn."', () => {
    expect(fieldText(render({ ...BERTH, dockedShip: null }), 'ship-class')).toBe('Žiadna loď pri kotvisku');
    expect(render({ ...BERTH, dockedShip: undefined })).not.toContain('Zakotvená loď');
    const noUnit = { ...BERTH, dockedShip: { classLabel: 'Handy', unitsOnBoard: 10, capacityUnits: 12 } };
    expect(fieldText(render(noUnit), 'ship-units')).toBe('10 / 12 jedn.');
  });

  it('vrátenie pri odstránení cez formatMoney', () => {
    expect(fieldText(render(BERTH), 'refund')).toBe('$200,000');
    expect(fieldText(render({ ...BERTH, refundCents: 0 }), 'refund')).toBe('$0');
    expect(fieldText(render({ ...BERTH, refundCents: 123_456_700 }), 'refund')).toBe('$1,234,567');
  });

  it('nedá sa odstrániť: tlačidlo aria-disabled, dôvod pod ním aj v title, klik nevolá onRemove', () => {
    const html = render(BERTH);
    expect(html).toMatch(/aria-disabled="true"[^>]*title="Pri kotvisku kotví loď\."[^>]*data-action="remove"/);
    expect(fieldText(html, 'remove-reason')).toBe('Pri kotvisku kotví loď.');

    const onRemove = vi.fn();
    const tree = ModuleInspector(makeProps(BERTH, { onRemove }));
    const [button] = findAll(tree, (element) => propsOf(element)['data-action'] === 'remove');
    (propsOf(button!)['onClick'] as () => void)();
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe('ModuleInspector — žeriav', () => {
  it('blocked: žltý badge so skráteným textom, banner s plným popisom a vysvetlením', () => {
    const html = render(CRANE_BLOCKED);
    expect(html).toContain('module-inspector__badge--warn');
    expect(html).not.toContain('module-inspector__badge--ok');
    expect(html).toMatch(/title="Blokovaný — plný apron" data-field="badge" data-ok="false"/);
    expect(html).toMatch(/#ic_warning"><\/use><\/svg>Blokovaný<\/span>/);
    expect(html).toContain('data-section="blocked"');
    expect(html).toContain('<span class="module-inspector__banner-title">Blokovaný — plný apron</span>');
    expect(html).toContain('Apron kotviska nemá voľný slot.');
    expect(fieldText(html, 'sub')).toBe('CRN-08 · 2×3');
  });

  it('dlaždice 72 % / 21 % / 7 % so súčtom 100 a pruh času', () => {
    const html = render(CRANE_BLOCKED);
    expect(fieldText(html, 'stat-busy')).toBe('72 %');
    expect(fieldText(html, 'stat-blocked')).toBe('21 %');
    expect(fieldText(html, 'stat-idle')).toBe('7 %');
    expect(fieldText(html, 'crane-busy')).toBe('72 %');
    expect(html).toContain('module-inspector__bar-fill--busy" style="width:72%"');
    expect(html).toContain('module-inspector__bar-fill--blocked" style="width:21%"');
    expect(html).toContain('module-inspector__stat-value--warn" data-field="stat-blocked"');
  });

  it('žeriav nemá sekciu apronu ani lode', () => {
    const html = render(CRANE_BLOCKED);
    expect(html).not.toContain('data-section="apron"');
    expect(html).not.toContain('Zakotvená loď');
  });

  it('pri práci: zelený badge „Vykladá", bez banneru; vysoká vyťaženosť je žltá / červená', () => {
    const working: ModuleInspectorData = {
      ...CRANE_BLOCKED,
      stateLabel: craneStateLabel('grabbing'),
      ok: craneStateOk('grabbing'),
      crane: { state: 'grabbing', utilizationPct: 88, blockedPct: 0 },
    };
    const html = render(working);
    expect(html).toContain('module-inspector__badge--ok');
    expect(html).toContain('>Vykladá</span>');
    expect(html).not.toContain('data-section="blocked"');
    expect(html).toContain('module-inspector__stat-value--warn" data-field="stat-busy"');

    const overloaded = { ...working, crane: { state: 'grabbing' as const, utilizationPct: 95, blockedPct: 0 } };
    expect(render(overloaded)).toContain('module-inspector__stat-value--danger" data-field="stat-busy"');
  });

  it('odstrániť volá onRemove(id); zavrieť volá onClose()', () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    const tree = ModuleInspector(makeProps(CRANE_BLOCKED, { onRemove, onClose }));

    const [remove] = findAll(tree, (element) => propsOf(element)['data-action'] === 'remove');
    expect(propsOf(remove!)['aria-disabled']).toBe(false);
    (propsOf(remove!)['onClick'] as () => void)();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(8);

    const [close] = findAll(tree, (element) => propsOf(element)['title'] === 'Zavrieť (Esc)');
    (propsOf(close!)['onClick'] as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('bez dôvodu a s removable === true sa dôvod nevykreslí', () => {
    expect(render(CRANE_BLOCKED)).not.toContain('data-field="remove-reason"');
  });
});

// --- F3 (T03-09): sklad, depo vozidiel, „Nepripojené" -----------------------------------------------------------------

/** Prototyp `insp_yard` (Zaplnenie 72 %): 46 / 64 TEU = 71,9 % → 72 %. */
const YARD: ModuleInspectorData = {
  id: 3,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU' },
  connected: true,
  refundCents: 7_500_000,
  removable: false,
  removeBlockedReason: 'Sklad obsahuje náklad.',
};

const CARRIER_IDLE: DepotVehicleData = { id: 11, label: 'Straddle carrier', state: 'idle', code: 'SC-01', refundCents: 2_400_000 };
const CARRIER_BUSY: DepotVehicleData = { id: 12, label: 'Straddle carrier', state: 'busy', code: 'SC-02' };
const CARRIER_STUCK: DepotVehicleData = { id: 13, label: 'Straddle carrier', state: 'no_path' };

/** Prototyp `insp_depot`: depo s dvoma vozidlami, nákup dostupný. */
const DEPOT: ModuleInspectorData = {
  id: 5,
  defId: 'vehicle_depot',
  displayName: 'Depo vozidiel',
  kind: 'depot',
  footprint: { w: 3, h: 3 },
  stateLabel: 'V prevádzke',
  ok: true,
  depot: { vehicles: [CARRIER_IDLE, CARRIER_BUSY], capacity: 6, canBuy: true, buyPriceCents: 4_800_000 },
  connected: true,
  refundCents: 4_500_000,
  removable: false,
  removeBlockedReason: 'Depo s vozidlami nejde odstrániť.',
};

const tileValues = (html: string, keys: readonly string[]) => keys.map((key) => fieldText(html, `stat-${key}`));

describe('sklad — čisté pomocné funkcie', () => {
  it('storageFree: kapacita − uložené − rezervované, nikdy záporné', () => {
    expect(storageFree({ stored: 46, reserved: 3, capacity: 64 })).toBe(15);
    expect(storageFree({ stored: 60, reserved: 4, capacity: 64 })).toBe(0);
    expect(storageFree({ stored: 70, reserved: 4, capacity: 64 })).toBe(0);
  });

  it('storageFillPct: len uložené jednotky, celé percentá, orezané na 0–100, prázdna kapacita = 0', () => {
    expect(storageFillPct({ stored: 46, capacity: 64 })).toBe(72);
    expect(storageFillPct({ stored: 0, capacity: 64 })).toBe(0);
    expect(storageFillPct({ stored: 80, capacity: 64 })).toBe(100);
    expect(storageFillPct({ stored: 5, capacity: 0 })).toBe(0);
  });

  it('storageStats: zaplnenie s tónom podľa prahov 75 / 90 %, voľné 0 = varovanie', () => {
    const rows = (stored: number, reserved: number) =>
      storageStats({ stored, reserved, capacity: 64 }).map((stat) => [stat.key, stat.value, stat.tone, stat.swatch]);
    expect(rows(46, 3)).toEqual([
      ['fill', '72 %', 'normal', 'used'],
      ['reserved', '3', 'normal', 'reserved'],
      ['free', '15', 'normal', 'free'],
    ]);
    expect(rows(48, 0)[0]).toEqual(['fill', '75 %', 'warn', 'used']); // 48 / 64 = 75 %
    expect(rows(58, 6)).toEqual([
      ['fill', '91 %', 'danger', 'used'],
      ['reserved', '6', 'normal', 'reserved'],
      ['free', '0', 'warn', 'free'],
    ]);
  });
});

describe('ModuleInspector — sklad', () => {
  it('hlavička: ikona dvora, kód YRD-03 · 4×4, zelený badge', () => {
    const html = render(YARD);
    expect(fieldText(html, 'sub')).toBe('YRD-03 · 4×4');
    expect(html).toContain('#ic_yard');
    expect(html).toContain('module-inspector__badge--ok');
    expect(html).toMatch(/data-field="badge" data-ok="true"[^>]*><svg[^>]*><use href="[^"]*#ic_check"/);
    expect(html).toContain('>V prevádzke</span>');
    expect(html).toContain('data-kind="storage"');
  });

  it('dlaždice: zaplnenie 72 %, rezervované 3, voľné 15 (swatch used / reserved / free)', () => {
    const html = render(YARD);
    expect(tileValues(html, ['fill', 'reserved', 'free'])).toEqual(['72 %', '3', '15']);
    expect(html).toMatch(/data-stat="fill"[\s\S]*?module-inspector__swatch--used/);
    expect(html).toMatch(/data-stat="reserved"[\s\S]*?module-inspector__swatch--reserved/);
    expect(html).toContain('module-inspector__stat-value--normal" data-field="stat-fill"');
  });

  it('pruh kapacity: „46 / 64 TEU", segmenty uložené 71,875 % a rezervované 4,6875 %', () => {
    const html = render(YARD);
    expect(fieldText(html, 'storage-count')).toBe('46 / 64 TEU');
    expect(html).toMatch(/aria-label="Zaplnenie skladu" aria-valuemin="0" aria-valuemax="64" aria-valuenow="46"/);
    expect(html).toContain('module-inspector__bar-fill--used" style="width:71.875%"');
    expect(html).toContain('module-inspector__bar-fill--reserved" style="width:4.6875%"');
  });

  it('bez jednotky sa ukáže „jedn."', () => {
    const noUnit = { ...YARD, storage: { ...YARD.storage!, unitLabel: undefined } };
    expect(fieldText(render(noUnit), 'storage-count')).toBe('46 / 64 jedn.');
  });

  it('prijaté / vydané celkom cez formatCount (čiarka pri tisícoch, jednotka)', () => {
    const html = render(YARD);
    expect(fieldText(html, 'units-in')).toBe('1,240 TEU');
    expect(fieldText(html, 'units-out')).toBe('12 TEU');
    const noUnit = { ...YARD, storage: { ...YARD.storage!, unitLabel: undefined } };
    expect(fieldText(render(noUnit), 'units-in')).toBe('1,240');
  });

  it('plný a takmer plný sklad: červené zaplnenie a žlté voľné', () => {
    const full = { ...YARD, storage: { ...YARD.storage!, stored: 58, reserved: 6 } };
    const html = render(full);
    expect(html).toContain('module-inspector__stat-value--danger" data-field="stat-fill"');
    expect(html).toContain('module-inspector__stat-value--warn" data-field="stat-free"');
  });

  it('nevykreslí sekcie apronu, lode ani vozidiel; odstránenie s dôvodom „has_cargo"', () => {
    const html = render(YARD);
    expect(html).not.toContain('data-section="apron"');
    expect(html).not.toContain('Zakotvená loď');
    expect(html).not.toContain('data-section="vehicles"');
    expect(html).not.toContain('data-action="buy-vehicle"');
    expect(fieldText(html, 'remove-reason')).toBe('Sklad obsahuje náklad.');
    expect(fieldText(html, 'refund')).toBe('$75,000');
  });

  it('pripojený dvor (connected: true aj bez poľa) nemá banner „Nepripojené"', () => {
    expect(render(YARD)).not.toContain('data-section="disconnected"');
    expect(render({ ...YARD, connected: undefined })).not.toContain('data-section="disconnected"');
  });
});

describe('ModuleInspector — nepripojený modul (vzor insp_gate)', () => {
  const disconnected: ModuleInspectorData = { ...YARD, connected: false };

  it('inspectorBadge: „Nepripojené" má prednosť pred stavom modulu, inak skrátený stav', () => {
    expect(DISCONNECTED_BADGE_LABEL).toBe('Nepripojené');
    expect(inspectorBadge(disconnected)).toEqual({ label: 'Nepripojené', title: DISCONNECTED_TITLE, ok: false });
    expect(inspectorBadge({ stateLabel: 'Blokovaný — plný apron', ok: false, connected: true })).toEqual({
      label: 'Blokovaný',
      title: 'Blokovaný — plný apron',
      ok: false,
    });
    expect(inspectorBadge({ stateLabel: 'Voľné', ok: true })).toEqual({ label: 'Voľné', title: 'Voľné', ok: true });
  });

  it('žltý badge s ikonou varovania, banner s vysvetlením, ostatný obsah ostáva', () => {
    const html = render(disconnected);
    expect(html).toContain('module-inspector__badge--warn');
    expect(html).not.toContain('module-inspector__badge--ok');
    expect(html).toMatch(/title="Nepripojené k ceste" data-field="badge" data-ok="false"/);
    expect(html).toMatch(/#ic_warning"><\/use><\/svg>Nepripojené<\/span>/);
    expect(html).toContain('data-section="disconnected"');
    expect(html).toContain('<span class="module-inspector__banner-title">Nepripojené k ceste</span>');
    expect(html).toContain('Konektor modulu nemá cestu.');
    expect(fieldText(html, 'stat-fill')).toBe('72 %');
  });

  it('platí aj pre depo a kotvisko; žeriav bez `connected` banner nemá', () => {
    expect(render({ ...DEPOT, connected: false })).toContain('data-section="disconnected"');
    expect(render({ ...BERTH, connected: false })).toContain('data-section="disconnected"');
    expect(render(CRANE_BLOCKED)).not.toContain('data-section="disconnected"');
  });

  it('banner „Nepripojené" sa nezmieša s bannerom blokovaného žeriavu', () => {
    const html = render({ ...CRANE_BLOCKED, connected: false });
    expect(html).toContain('data-section="disconnected"');
    expect(html).toContain('data-section="blocked"');
  });
});

describe('depo — čisté pomocné funkcie', () => {
  it('depotVehicleCounts: pracuje / nečinné / bez cesty', () => {
    expect(depotVehicleCounts([CARRIER_IDLE, CARRIER_BUSY, CARRIER_STUCK, CARRIER_BUSY])).toEqual({ busy: 2, idle: 1, noPath: 1 });
    expect(depotVehicleCounts([])).toEqual({ busy: 0, idle: 0, noPath: 0 });
  });

  it('depotStats: vozidlá „2 / 6", plné depo = varovanie; pracuje / nečinné', () => {
    const rows = (vehicles: readonly DepotVehicleData[], capacity: number) =>
      depotStats({ vehicles, capacity }).map((stat) => [stat.key, stat.value, stat.tone]);
    expect(rows([CARRIER_IDLE, CARRIER_BUSY], 6)).toEqual([
      ['vehicles', '2 / 6', 'normal'],
      ['busy', '1', 'normal'],
      ['idle', '1', 'normal'],
    ]);
    expect(rows([CARRIER_IDLE, CARRIER_BUSY], 2)[0]).toEqual(['vehicles', '2 / 2', 'warn']);
    expect(rows([], 0)[0]).toEqual(['vehicles', '0 / 0', 'normal']);
  });

  it('stavy vozidla: slovenský popis, ikona a tón; predať sa dá len nečinné', () => {
    expect(VEHICLE_STATE_INFO).toEqual({
      busy: { label: 'Pracuje', icon: 'ic_busy', tone: 'success' },
      idle: { label: 'Nečinné', icon: 'ic_idle', tone: 'muted' },
      no_path: { label: 'Bez cesty', icon: 'ic_warning', tone: 'warn' },
    });
    expect(canSellVehicle(CARRIER_IDLE)).toBe(true);
    expect(canSellVehicle(CARRIER_BUSY)).toBe(false);
    expect(canSellVehicle(CARRIER_STUCK)).toBe(false);
  });

  it('vehicleCode a sellTitle: kód z dát alebo #id; refund cez formatMoney; dôvod pri zablokovaní', () => {
    expect(vehicleCode(CARRIER_IDLE)).toBe('SC-01');
    expect(vehicleCode(CARRIER_STUCK)).toBe('#13');
    expect(sellTitle(CARRIER_IDLE)).toBe('Predať SC-01 · vráti $24,000');
    expect(sellTitle({ ...CARRIER_IDLE, refundCents: undefined })).toBe('Predať SC-01');
    expect(sellTitle(CARRIER_BUSY)).toBe(`${SELL_BLOCKED_TEXT} (SC-02)`);
  });
});

describe('ModuleInspector — depo vozidiel', () => {
  it('hlavička: ikona depa, DEP-05 · 3×3; dlaždice 2 / 6, pracuje 1, nečinné 1', () => {
    const html = render(DEPOT);
    expect(fieldText(html, 'sub')).toBe('DEP-05 · 3×3');
    expect(html).toContain('#ic_depot');
    expect(tileValues(html, ['vehicles', 'busy', 'idle'])).toEqual(['2 / 6', '1', '1']);
  });

  it('dlaždice depa nemajú farebné značky (depo nemá pruh); dlaždice skladu a kotviska áno', () => {
    expect(render(DEPOT)).not.toContain('module-inspector__swatch');
    expect(depotStats({ vehicles: [CARRIER_IDLE], capacity: 6 }).every((stat) => stat.swatch === undefined)).toBe(true);
    expect(render(YARD).match(/module-inspector__swatch /g)).toHaveLength(3);
    expect(render(BERTH).match(/module-inspector__swatch /g)).toHaveLength(3);
  });

  it('zoznam „Vozidlá v depe": riadok na vozidlo s kódom, druhom a stavom; striedavé pozadie rieši CSS', () => {
    const html = render(DEPOT);
    expect(html).toContain('Vozidlá v depe');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.match(/data-field="vehicle-code">([^<]*)</g)).toEqual(['data-field="vehicle-code">SC-01<', 'data-field="vehicle-code">SC-02<']);
    expect(html.match(/module-inspector__vehicle-label">([^<]*)</g)).toHaveLength(2);
    expect(html).toContain('module-inspector__vehicle-label">Straddle carrier<');
    expect(html).toMatch(/data-vehicle-id="11" data-state="idle"/);
    expect(html).toMatch(/data-vehicle-id="12" data-state="busy"/);
    expect(html).toMatch(/vehicle-state--muted" data-field="vehicle-state"><svg[^>]*><use href="[^"]*#ic_idle"><\/use><\/svg>Nečinné</);
    expect(html).toMatch(/vehicle-state--success" data-field="vehicle-state"><svg[^>]*><use href="[^"]*#ic_busy"><\/use><\/svg>Pracuje</);
  });

  it('vozidlo bez cesty: žltá ikona a text „Bez cesty"; bez kódu sa ukáže #id', () => {
    const html = render({ ...DEPOT, depot: { ...DEPOT.depot!, vehicles: [CARRIER_STUCK] } });
    expect(html).toMatch(/vehicle-state--warn" data-field="vehicle-state"><svg[^>]*><use href="[^"]*#ic_warning"><\/use><\/svg>Bez cesty</);
    expect(html).toContain('data-field="vehicle-code">#13<');
  });

  it('prázdne depo: zástupný text namiesto zoznamu, dlaždice 0 / 6', () => {
    const html = render({ ...DEPOT, depot: { ...DEPOT.depot!, vehicles: [] } });
    expect(fieldText(html, 'vehicles-empty')).toBe('V depe zatiaľ nie sú žiadne vozidlá.');
    expect(html).not.toContain('<li ');
    expect(fieldText(html, 'stat-vehicles')).toBe('0 / 6');
  });

  it('tlačidlo predaja: nečinné vozidlo je aktívne s tooltipom „vráti $24,000", pracujúce a bez cesty sú aria-disabled', () => {
    const html = render(DEPOT);
    expect(html).toMatch(/aria-disabled="false" aria-label="Predať SC-01 · vráti \$24,000" title="Predať SC-01 · vráti \$24,000" data-action="sell-vehicle" data-vehicle-id="11"/);
    expect(html).toMatch(/aria-disabled="true" aria-label="Predať sa dá len nečinné vozidlo\. \(SC-02\)"[^>]*data-action="sell-vehicle" data-vehicle-id="12"/);
    const stuck = render({ ...DEPOT, depot: { ...DEPOT.depot!, vehicles: [CARRIER_STUCK] } });
    expect(stuck).toMatch(/aria-disabled="true"[^>]*data-action="sell-vehicle" data-vehicle-id="13"/);
  });

  it('predaj volá onSellVehicle(vehicleId) len pre nečinné vozidlo', () => {
    const onSellVehicle = vi.fn();
    const tree = ModuleInspector(makeProps(DEPOT, { onSellVehicle }));
    const sell = (vehicleId: number) => {
      const [button] = findAll(tree, (element) => propsOf(element)['data-action'] === 'sell-vehicle' && propsOf(element)['data-vehicle-id'] === vehicleId);
      (propsOf(button!)['onClick'] as () => void)();
    };
    sell(12); // pracuje
    expect(onSellVehicle).not.toHaveBeenCalled();
    sell(11); // nečinné
    expect(onSellVehicle).toHaveBeenCalledExactlyOnceWith(11);
  });

  it('nákup: „Kúpiť vozidlo v depe · $48,000" (cena cez formatMoney), aktívne tlačidlo bez dôvodu', () => {
    const html = render(DEPOT);
    expect(html).toMatch(/module-inspector__btn--primary" aria-disabled="false" data-action="buy-vehicle"/);
    expect(html).toContain('Kúpiť vozidlo v depe · <span data-field="buy-price">$48,000</span>');
    expect(html).not.toContain('data-field="buy-reason"');
    expect(html).toContain('#ic_vehicle');
  });

  it('bez ceny v dátach tlačidlo nemá „·" ani sumu', () => {
    const html = render({ ...DEPOT, depot: { ...DEPOT.depot!, buyPriceCents: undefined } });
    expect(html).not.toContain('data-field="buy-price"');
    expect(html).toMatch(/Kúpiť vozidlo v depe<\/button>/);
  });

  it('nákup nejde (depo plné / nepripojené / bez peňazí): aria-disabled, dôvod v title aj pod tlačidlom, klik nevolá onBuyVehicle', () => {
    const blocked: ModuleInspectorData = { ...DEPOT, depot: { ...DEPOT.depot!, canBuy: false, buyBlockedReason: 'Depo je plné.' } };
    const html = render(blocked);
    expect(html).toMatch(/aria-disabled="true" title="Depo je plné\." data-action="buy-vehicle"/);
    expect(fieldText(html, 'buy-reason')).toBe('Depo je plné.');

    const onBuyVehicle = vi.fn();
    const [button] = findAll(ModuleInspector(makeProps(blocked, { onBuyVehicle })), (element) => propsOf(element)['data-action'] === 'buy-vehicle');
    (propsOf(button!)['onClick'] as () => void)();
    expect(onBuyVehicle).not.toHaveBeenCalled();
  });

  it('nákup volá onBuyVehicle(depotId) s id depa', () => {
    const onBuyVehicle = vi.fn();
    const [button] = findAll(ModuleInspector(makeProps(DEPOT, { onBuyVehicle })), (element) => propsOf(element)['data-action'] === 'buy-vehicle');
    (propsOf(button!)['onClick'] as () => void)();
    expect(onBuyVehicle).toHaveBeenCalledExactlyOnceWith(5);
  });

  it('bez onBuyVehicle / onSellVehicle (F2 rodič) klik nepadá', () => {
    const tree = ModuleInspector(makeProps(DEPOT));
    for (const action of ['buy-vehicle', 'sell-vehicle']) {
      const [button] = findAll(tree, (element) => propsOf(element)['data-action'] === action);
      expect(() => {
        (propsOf(button!)['onClick'] as () => void)();
      }).not.toThrow();
    }
  });

  it('tlačidlo Odstrániť ostáva pod nákupom; depo nemá sekciu skladu ani apronu', () => {
    const html = render(DEPOT);
    expect(html.indexOf('data-action="buy-vehicle"')).toBeLessThan(html.indexOf('data-action="remove"'));
    expect(fieldText(html, 'remove-reason')).toBe('Depo s vozidlami nejde odstrániť.');
    expect(html).not.toContain('data-section="storage"');
    expect(html).not.toContain('data-section="apron"');
    expect(html).not.toContain('data-field="units-in"');
  });

  it('kotvisko a žeriav z F2 sú nedotknuté: bez tlačidla nákupu a bez zoznamu vozidiel', () => {
    for (const data of [BERTH, CRANE_BLOCKED]) {
      const html = render(data);
      expect(html).not.toContain('data-action="buy-vehicle"');
      expect(html).not.toContain('data-section="vehicles"');
      expect(html).not.toContain('module-inspector__btn--primary');
    }
  });
});
