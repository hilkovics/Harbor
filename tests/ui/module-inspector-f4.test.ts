// T04-07: ModuleInspector — brána, čakacia plocha (stojiská) a rampa (docky, staging, „Neprevádzková"). Čisté pomocné
// funkcie + vykreslenie do HTML (renderToStaticMarkup) + spätná kompatibilita (moduly bez nových polí sú nezmenené).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCONNECTED_TITLE,
  INOPERATIVE_BADGE_LABEL,
  INOPERATIVE_TITLE,
  ModuleInspector,
  RAMP_INOPERATIVE_FALLBACK,
  RAMP_INOPERATIVE_TEXTS,
  bayStates,
  dockTruckLabel,
  gateStats,
  gateThroughputText,
  inspectorBadge,
  moduleCode,
  moduleKindIcon,
  rampInoperativeReason,
  rampInoperativeText,
  rampStats,
  rampTotals,
  stagingSlots,
  waitingAreaFree,
  waitingAreaStats,
  type ModuleInspectorData,
  type RampData,
} from '@ui/module-inspector';
import { fieldText, findAll, propsOf } from './react-tree';

const GATE: ModuleInspectorData = {
  id: 1,
  defId: 'truck_gate',
  displayName: 'Brána kamiónov',
  kind: 'gate',
  footprint: { w: 2, h: 2 },
  stateLabel: 'V prevádzke',
  ok: true,
  gate: { queueLength: 3, throughputPerHour: 20, processTicks: 18 },
  connected: true,
  refundCents: 8_000_000,
  removable: true,
};

const WAITING: ModuleInspectorData = {
  id: 3,
  defId: 'truck_waiting_area',
  displayName: 'Čakacia plocha',
  kind: 'waiting_area',
  footprint: { w: 4, h: 3 },
  stateLabel: 'V prevádzke',
  ok: true,
  waitingArea: { bays: 6, occupied: 3, reserved: 1 },
  connected: true,
  refundCents: 6_000_000,
  removable: false,
  removeBlockedReason: 'Stojisko používa kamión.',
};

const RAMP_OK: RampData = {
  docks: [
    { staged: 2, capacity: 2, truck: true },
    { staged: 1, capacity: 2, truck: false },
  ],
  operational: true,
};

const RAMP: ModuleInspectorData = {
  id: 5,
  defId: 'loading_ramp_container',
  displayName: 'Rampa · kontajnery',
  kind: 'ramp',
  footprint: { w: 4, h: 2 },
  stateLabel: 'V prevádzke',
  ok: true,
  ramp: RAMP_OK,
  connected: true,
  refundCents: 10_000_000,
  removable: true,
};

const RAMP_NO_GATE: ModuleInspectorData = {
  ...RAMP,
  ramp: { docks: [{ staged: 0, capacity: 2, truck: false }], operational: false, inoperativeReason: 'Chýba brána na ceste.' },
};

const render = (data: ModuleInspectorData): string =>
  renderToStaticMarkup(createElement(ModuleInspector, { data, onRemove: vi.fn(), onClose: vi.fn() }));

const tileValues = (html: string, keys: readonly string[]) => keys.map((key) => fieldText(html, `stat-${key}`));

describe('brána — čisté pomocné funkcie', () => {
  it('gateThroughputText: celé kamióny za hodinu s „/ h"; zaokrúhli, tisíce s čiarkou, neplatná hodnota → —', () => {
    expect(gateThroughputText(20)).toBe('20 / h');
    expect(gateThroughputText(0)).toBe('0 / h');
    expect(gateThroughputText(33.3)).toBe('33 / h');
    expect(gateThroughputText(1_200)).toBe('1,200 / h');
    expect(gateThroughputText(Number.NaN)).toBe('—');
    expect(gateThroughputText(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('gateStats: fronta / priepustnosť / ticky na kamión, bez farebných značiek', () => {
    const stats = gateStats({ queueLength: 3, throughputPerHour: 20, processTicks: 18 });
    expect(stats.map((stat) => [stat.key, stat.value, stat.tone])).toEqual([
      ['queue', '3', 'normal'],
      ['throughput', '20 / h', 'normal'],
      ['process', '18', 'normal'],
    ]);
    expect(stats.every((stat) => stat.swatch === undefined)).toBe(true);
  });
});

describe('čakacia plocha — čisté pomocné funkcie', () => {
  it('bayStates: obsadené → rezervované → voľné, dĺžka vždy = počet stojísk', () => {
    expect(bayStates({ bays: 6, occupied: 3, reserved: 1 })).toEqual(['occupied', 'occupied', 'occupied', 'reserved', 'free', 'free']);
    expect(bayStates({ bays: 3, occupied: 0, reserved: 0 })).toEqual(['free', 'free', 'free']);
    expect(bayStates({ bays: 0, occupied: 2, reserved: 1 })).toEqual([]);
  });

  it('bayStates: preplnené alebo nezmyselné počty sa orežú (súčet nikdy nepresiahne stojiská), NaN a záporné = 0', () => {
    expect(bayStates({ bays: 4, occupied: 3, reserved: 5 })).toEqual(['occupied', 'occupied', 'occupied', 'reserved']);
    expect(bayStates({ bays: 2, occupied: 9, reserved: 9 })).toEqual(['occupied', 'occupied']);
    expect(bayStates({ bays: 2, occupied: -1, reserved: Number.NaN })).toEqual(['free', 'free']);
    expect(bayStates({ bays: 3, occupied: 1.9, reserved: 0.4 })).toEqual(['occupied', 'free', 'free']);
  });

  it('waitingAreaFree a dlaždice: voľné 0 = varovanie, swatch used / reserved / free', () => {
    expect(waitingAreaFree({ bays: 6, occupied: 3, reserved: 1 })).toBe(2);
    expect(waitingAreaFree({ bays: 6, occupied: 4, reserved: 2 })).toBe(0);
    expect(waitingAreaFree({ bays: 6, occupied: 8, reserved: 0 })).toBe(0);
    const rows = (occupied: number, reserved: number) =>
      waitingAreaStats({ bays: 6, occupied, reserved }).map((stat) => [stat.key, stat.value, stat.tone, stat.swatch]);
    expect(rows(3, 1)).toEqual([
      ['used', '3', 'normal', 'used'],
      ['reserved', '1', 'normal', 'reserved'],
      ['free', '2', 'normal', 'free'],
    ]);
    expect(rows(4, 2)[2]).toEqual(['free', '0', 'warn', 'free']);
  });
});

describe('rampa — čisté pomocné funkcie', () => {
  it('rampTotals: docky, uložené v staging slotoch (orezané na kapacitu docku), kapacita a kamióny v dockoch', () => {
    expect(rampTotals(RAMP_OK)).toEqual({ docks: 2, staged: 3, capacity: 4, trucks: 1 });
    expect(rampTotals({ docks: [] })).toEqual({ docks: 0, staged: 0, capacity: 0, trucks: 0 });
    expect(rampTotals({ docks: [{ staged: 5, capacity: 2, truck: false }] })).toEqual({ docks: 1, staged: 2, capacity: 2, trucks: 0 });
  });

  it('rampStats: docky / staging „3 / 4" s farbou nákladu / kamióny', () => {
    const stats = rampStats(RAMP_OK);
    expect(stats.map((stat) => [stat.key, stat.value, stat.swatch])).toEqual([
      ['docks', '2', undefined],
      ['staged', '3 / 4', 'used'],
      ['trucks', '1', undefined],
    ]);
    expect(rampStats({ docks: [] })[1]?.value).toBe('0 / 0');
  });

  it('stagingSlots: dĺžka = kapacita docku, obsadené zľava, orezanie a neplatné hodnoty', () => {
    expect(stagingSlots({ staged: 1, capacity: 3 })).toEqual([true, false, false]);
    expect(stagingSlots({ staged: 0, capacity: 2 })).toEqual([false, false]);
    expect(stagingSlots({ staged: 9, capacity: 2 })).toEqual([true, true]);
    expect(stagingSlots({ staged: Number.NaN, capacity: 2 })).toEqual([false, false]);
    expect(stagingSlots({ staged: 1, capacity: 0 })).toEqual([]);
  });

  it('dôvody neprevádzkovosti: kódy simu → slovenský text, neznámy / chýbajúci kód → undefined, fallback', () => {
    expect(RAMP_INOPERATIVE_TEXTS).toEqual({
      no_gate: 'Chýba brána na ceste.',
      no_waiting_area: 'Chýba stojisko na ceste.',
      not_connected: 'Chýba súvislá cesta k rampe.',
      no_return_path: 'Kamióny sa nemajú ako vrátiť cez bránu k portálu.',
    });
    expect(rampInoperativeText('no_return_path')).toBe('Kamióny sa nemajú ako vrátiť cez bránu k portálu.');
    expect(rampInoperativeText('no_gate')).toBe('Chýba brána na ceste.');
    expect(rampInoperativeText('no_waiting_area')).toBe('Chýba stojisko na ceste.');
    expect(rampInoperativeText('nieco_nove')).toBeUndefined();
    expect(rampInoperativeText(null)).toBeUndefined();
    expect(rampInoperativeText(undefined)).toBeUndefined();
    expect(rampInoperativeReason({ inoperativeReason: 'Chýba stojisko na ceste.' })).toBe('Chýba stojisko na ceste.');
    expect(rampInoperativeReason({})).toBe(RAMP_INOPERATIVE_FALLBACK);
  });

  it('dockTruckLabel: „Kamión" / „Bez kamióna"', () => {
    expect(dockTruckLabel({ truck: true })).toBe('Kamión');
    expect(dockTruckLabel({ truck: false })).toBe('Bez kamióna');
  });

  it('ikony a kódy druhov: gate → ic_gate GTE, waiting_area → ic_waiting WAI, ramp → ic_ramp RMP', () => {
    expect(moduleKindIcon('gate')).toBe('ic_gate');
    expect(moduleKindIcon('waiting_area')).toBe('ic_waiting');
    expect(moduleKindIcon('ramp')).toBe('ic_ramp');
    expect(moduleCode('gate', 1)).toBe('GTE-01');
    expect(moduleCode('waiting_area', 3)).toBe('WAI-03');
    expect(moduleCode('ramp', 12)).toBe('RMP-12');
  });
});

describe('inspectorBadge — neprevádzková rampa', () => {
  it('„Neprevádzková" s dôvodom v title; prednosť pred stavom modulu, ale po „Nepripojené"', () => {
    expect(INOPERATIVE_BADGE_LABEL).toBe('Neprevádzková');
    const base = { stateLabel: 'V prevádzke', ok: true } as const;
    expect(inspectorBadge({ ...base, ramp: { docks: [], operational: false, inoperativeReason: 'Chýba brána na ceste.' } })).toEqual({
      label: 'Neprevádzková',
      title: 'Neprevádzková — Chýba brána na ceste.',
      ok: false,
    });
    expect(inspectorBadge({ ...base, ramp: { docks: [], operational: false } }).title).toBe(`Neprevádzková — ${RAMP_INOPERATIVE_FALLBACK}`);
    expect(inspectorBadge({ ...base, connected: false, ramp: { docks: [], operational: false } })).toEqual({
      label: 'Nepripojené',
      title: DISCONNECTED_TITLE,
      ok: false,
    });
    expect(inspectorBadge({ ...base, ramp: { docks: [], operational: true } })).toEqual({ label: 'V prevádzke', title: 'V prevádzke', ok: true });
    expect(inspectorBadge(base)).toEqual({ label: 'V prevádzke', title: 'V prevádzke', ok: true });
  });
});

describe('ModuleInspector — brána', () => {
  it('hlavička: ikona brány, GTE-01 · 2×2, zelený badge; dlaždice fronta 3, 20 / h, 18 tickov', () => {
    const html = render(GATE);
    expect(fieldText(html, 'title')).toBe('Brána kamiónov');
    expect(fieldText(html, 'sub')).toBe('GTE-01 · 2×2');
    expect(html).toContain('#ic_gate');
    expect(html).toContain('data-kind="gate"');
    expect(html).toContain('module-inspector__badge--ok');
    expect(tileValues(html, ['queue', 'throughput', 'process'])).toEqual(['3', '20 / h', '18']);
    expect(html).not.toContain('module-inspector__swatch');
    expect(html).not.toContain('data-section="disconnected"');
  });

  it('nepripojená brána (vzor insp_gate): badge „Nepripojené", banner a 0 / h; fronta 0', () => {
    const html = render({ ...GATE, connected: false, gate: { queueLength: 0, throughputPerHour: 0, processTicks: 18 } });
    expect(html).toContain('module-inspector__badge--warn');
    expect(html).toContain('data-section="disconnected"');
    expect(tileValues(html, ['queue', 'throughput'])).toEqual(['0', '0 / h']);
  });

  it('brána nemá sekciu stojísk ani dockov; vrátenie cez formatMoney', () => {
    const html = render(GATE);
    expect(html).not.toContain('data-section="bays"');
    expect(html).not.toContain('data-section="docks"');
    expect(fieldText(html, 'refund')).toBe('$80,000');
  });
});

describe('ModuleInspector — čakacia plocha', () => {
  it('dlaždice obsadené 3, rezervované 1, voľné 2 so značkami; počet stojísk „3 / 6 stojísk"', () => {
    const html = render(WAITING);
    expect(fieldText(html, 'sub')).toBe('WAI-03 · 4×3');
    expect(html).toContain('#ic_waiting');
    expect(tileValues(html, ['used', 'reserved', 'free'])).toEqual(['3', '1', '2']);
    expect(html.match(/module-inspector__swatch /g)).toHaveLength(3);
    expect(fieldText(html, 'bays-count')).toBe('3 / 6 stojísk');
  });

  it('rad stojísk: 6 políčok v poradí obsadené → rezervované → voľné, kamión len na zaplnených, popis v title', () => {
    const html = render(WAITING);
    expect(html.match(/<li /g)).toHaveLength(6);
    expect([...html.matchAll(/data-bay="(\d+)" data-state="(\w+)"/g)].map((match) => match[2])).toEqual([
      'occupied',
      'occupied',
      'occupied',
      'reserved',
      'free',
      'free',
    ]);
    expect(html).toContain('title="Stojisko 1 · obsadené"');
    expect(html).toContain('title="Stojisko 4 · rezervované"');
    expect(html).toContain('title="Stojisko 6 · voľné"');
    expect(html.match(/module-inspector__bay-icon/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Obsadenosť stojísk"');
  });

  it('plná čakacia plocha: voľné 0 je žlté a rad nemá voľné políčko', () => {
    const html = render({ ...WAITING, waitingArea: { bays: 6, occupied: 4, reserved: 2 } });
    expect(html).toContain('module-inspector__stat-value--warn" data-field="stat-free"');
    expect(html).not.toContain('data-state="free"');
    expect(fieldText(html, 'bays-count')).toBe('4 / 6 stojísk');
  });

  it('odstrániť nejde, kým stojisko používa kamión: dôvod pod tlačidlom', () => {
    expect(fieldText(render(WAITING), 'remove-reason')).toBe('Stojisko používa kamión.');
  });
});

describe('ModuleInspector — rampa', () => {
  it('dlaždice docky 2, staging 3 / 4 (farba nákladu), kamióny 1; podtitul RMP-05 · 4×2', () => {
    const html = render(RAMP);
    expect(fieldText(html, 'sub')).toBe('RMP-05 · 4×2');
    expect(html).toContain('#ic_ramp');
    expect(tileValues(html, ['docks', 'staged', 'trucks'])).toEqual(['2', '3 / 4', '1']);
    expect(html.match(/module-inspector__swatch /g)).toHaveLength(1);
    expect(html).toContain('module-inspector__badge--ok');
    expect(html).not.toContain('data-section="inoperative"');
  });

  it('zoznam dockov: názov, sloty staging (obsadené = --filled), počet a stav kamióna s ikonou', () => {
    const html = render(RAMP);
    expect(html).toContain('Docky rampy');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect([...html.matchAll(/data-field="dock-name">([^<]*)</g)].map((match) => match[1])).toEqual(['Dock 1', 'Dock 2']);
    expect([...html.matchAll(/data-field="dock-staged">([^<]*)</g)].map((match) => match[1])).toEqual(['2 / 2', '1 / 2']);
    expect(html.match(/module-inspector__pip module-inspector__pip--filled/g)).toHaveLength(3);
    expect(html.match(/class="module-inspector__pip"/g)).toHaveLength(1);
    expect(html).toMatch(/data-dock="0" data-truck="true"/);
    expect(html).toMatch(/data-dock="1" data-truck="false"/);
    expect(html).toMatch(/dock-truck--present" data-field="dock-truck"><svg[^>]*><use href="[^"]*#ic_truck"><\/use><\/svg>Kamión</);
    expect(html).toMatch(/dock-truck--absent" data-field="dock-truck"><svg[^>]*><use href="[^"]*#ic_idle"><\/use><\/svg>Bez kamióna</);
    expect(html).toContain('aria-label="Pripravené jednotky: 1 / 2"');
  });

  it('rampa bez dockov: zástupný text namiesto zoznamu', () => {
    const html = render({ ...RAMP, ramp: { docks: [], operational: true } });
    expect(fieldText(html, 'docks-empty')).toBe('Rampa nemá žiadne docky.');
    expect(html).not.toContain('<li ');
    expect(tileValues(html, ['docks', 'staged', 'trucks'])).toEqual(['0', '0 / 0', '0']);
  });

  it('neprevádzková rampa: žltý badge „Neprevádzková" s ikonou varovania, banner s dôvodom, ostatný obsah ostáva', () => {
    const html = render(RAMP_NO_GATE);
    expect(html).toContain('module-inspector__badge--warn');
    expect(html).not.toContain('module-inspector__badge--ok');
    expect(html).toMatch(
      /title="Neprevádzková — Chýba brána na ceste\." data-field="badge" data-ok="false"[^>]*><svg[^>]*><use href="[^"]*#ic_warning"><\/use><\/svg>Neprevádzková<\/span>/,
    );
    expect(html).toContain('data-section="inoperative"');
    expect(html).toContain(`<span class="module-inspector__banner-title">${INOPERATIVE_TITLE}</span>`);
    expect(fieldText(html, 'inoperative-reason')).toBe('Chýba brána na ceste.');
    expect(html).not.toContain('data-section="disconnected"');
    expect(tileValues(html, ['docks', 'staged', 'trucks'])).toEqual(['1', '0 / 2', '0']);
    expect(html).toContain('data-section="docks"');
  });

  it('neprevádzková rampa bez zadaného dôvodu ukáže všeobecný text', () => {
    const html = render({ ...RAMP, ramp: { docks: [], operational: false } });
    expect(fieldText(html, 'inoperative-reason')).toBe(RAMP_INOPERATIVE_FALLBACK);
  });

  it('nepripojená a zároveň neprevádzková rampa: badge „Nepripojené", oba bannery', () => {
    const html = render({ ...RAMP_NO_GATE, connected: false });
    expect(html).toMatch(/data-field="badge" data-ok="false"[^>]*><svg[^>]*><use href="[^"]*#ic_warning"><\/use><\/svg>Nepripojené<\/span>/);
    expect(html).toContain('data-section="disconnected"');
    expect(html).toContain('data-section="inoperative"');
  });

  it('prevádzková rampa (operational: true) banner nemá; reason sa vtedy ignoruje', () => {
    const html = render({ ...RAMP, ramp: { ...RAMP_OK, inoperativeReason: 'Chýba brána na ceste.' } });
    expect(html).not.toContain('data-section="inoperative"');
    expect(html).toContain('module-inspector__badge--ok');
  });

  it('odstránenie ide cez onRemove(id), rampa nemá tlačidlo nákupu vozidla', () => {
    const onRemove = vi.fn();
    const tree = ModuleInspector({ data: RAMP, onRemove, onClose: vi.fn() });
    const [button] = findAll(tree, (element) => propsOf(element)['data-action'] === 'remove');
    (propsOf(button!)['onClick'] as () => void)();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(5);
    expect(render(RAMP)).not.toContain('data-action="buy-vehicle"');
  });
});

describe('spätná kompatibilita — moduly bez polí F4', () => {
  it('kotvisko, sklad a depo bez gate / waitingArea / ramp nevykreslia žiadnu sekciu F4', () => {
    const plain: ModuleInspectorData = {
      id: 3,
      defId: 'container_yard_small',
      displayName: 'Kontajnerový dvor S',
      kind: 'storage',
      stateLabel: 'V prevádzke',
      ok: true,
      storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 0, unitsOut: 0 },
      refundCents: 0,
      removable: true,
    };
    const html = render(plain);
    for (const marker of ['data-section="bays"', 'data-section="docks"', 'data-section="inoperative"', 'dock-name', 'stat-queue', 'stat-throughput']) {
      expect(html).not.toContain(marker);
    }
    expect(html).toContain('module-inspector__badge--ok');
  });
});
