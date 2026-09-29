import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CRANE_STATE_LABELS,
  ModuleInspector,
  UTILIZATION_DANGER_PCT,
  UTILIZATION_WARN_PCT,
  apronFree,
  badgeText,
  berthStats,
  clampPercent,
  craneStateLabel,
  craneStateOk,
  craneStats,
  craneTimeSplit,
  moduleCode,
  moduleKindIcon,
  moduleSubtitle,
  shareOf,
  utilizationTone,
  type CraneStateName,
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
