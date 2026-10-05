// T6A-07: ContractsPanel — export booking (cieľ, cut-off, dovezené / naložené, zadržané VGM, rolled, vrátené) a spoločná karta
// voyage (roundtrip: import + export, jedno „Prijať oba“) nad fixture dátami (ADR-032).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ContractCard,
  ContractsPanel,
  VoyageCard,
  bookingBars,
  bookingCounters,
  contractKind,
  contractPayoutCents,
  contractStatus,
  contractVoyageId,
  cutoffInfo,
  exportTitle,
  pendingArrivalsText,
  tabCounts,
  voyageCardsForTab,
  voyageGroups,
  voyageKind,
  voyagePayoutCents,
  voyageTab,
  type ContractBookingData,
  type ContractCardData,
  type ContractsTab,
  type ContractsTimeScale,
} from '@ui/contracts-panel';
import { fieldText, findAll, propsOf } from './react-tree';

const MINUS = '−';
const HOUR = 360;
const DAY = 8640;
const NOW = 100_000;
const TIME: ContractsTimeScale = { nowTick: NOW, ticksPerHour: HOUR, ticksPerDay: DAY };

function booking(patch: Partial<ContractBookingData> = {}): ContractBookingData {
  return {
    destinationPort: 'Rotterdam',
    cutoffTick: NOW + 5 * HOUR,
    bookedUnits: 24,
    pendingArrivals: 8,
    arrivedUnits: 10,
    loadedUnits: 0,
    lastMinuteUnits: 0,
    rolledUnits: 0,
    returnedUnits: 0,
    heldUnits: 0,
    ...patch,
  };
}

/** Export booking v stave `exporting` (prijatý, loď pri kotvisku). */
function exportContract(patch: Partial<ContractCardData> = {}): ContractCardData {
  return {
    id: 4,
    kind: 'export',
    voyageId: 4,
    state: 'ship_en_route',
    cargoCategory: 'container',
    cargoLabel: 'Kontajnery',
    unit: 'TEU',
    volumeUnits: 24,
    rewardCents: 96_000_000,
    xpReward: 24,
    shipClassId: 'feeder',
    shipClassLabel: 'Feeder',
    offerExpiresTick: NOW + DAY,
    unitsUnloaded: 0,
    unitsExported: 0,
    penaltiesCents: 0,
    slaDeadlineTick: NOW + 4 * DAY,
    shipArrivalTick: NOW + 7 * HOUR,
    booking: booking(),
    ...patch,
  };
}

function importContract(patch: Partial<ContractCardData> = {}): ContractCardData {
  return {
    id: 3,
    kind: 'import',
    voyageId: 4,
    state: 'ship_en_route',
    cargoCategory: 'container',
    cargoLabel: 'Kontajnery',
    unit: 'TEU',
    volumeUnits: 48,
    rewardCents: 180_000_000,
    xpReward: 48,
    shipClassId: 'feeder',
    shipClassLabel: 'Feeder',
    offerExpiresTick: NOW + DAY,
    unitsUnloaded: 0,
    unitsExported: 0,
    penaltiesCents: 0,
    slaDeadlineTick: NOW + 5 * DAY,
    shipArrivalTick: NOW + 7 * HOUR,
    ...patch,
  };
}

const renderCard = (data: ContractCardData): string =>
  renderToStaticMarkup(createElement(ContractCard, { contract: data, time: TIME, onAccept: vi.fn(), onDecline: vi.fn() }));

const renderVoyage = (parts: readonly ContractCardData[], onAccept = vi.fn(), onDecline = vi.fn()): string =>
  renderToStaticMarkup(createElement(VoyageCard, { group: { voyageId: parts[0]?.voyageId ?? 0, parts }, time: TIME, onAccept, onDecline }));

describe('druh kontraktu a voyage', () => {
  it('bez kind je import, bez voyageId je voyage = id', () => {
    const legacy = { ...importContract(), kind: undefined, voyageId: undefined } as ContractCardData;
    expect(contractKind(legacy)).toBe('import');
    expect(contractVoyageId(legacy)).toBe(3);
    expect(contractKind(exportContract())).toBe('export');
    expect(contractVoyageId(exportContract())).toBe(4);
  });

  it('voyageGroups: skupiny v poradí prvého výskytu, kontrakty skupiny vzostupne podľa id', () => {
    const list = [
      exportContract({ id: 4, voyageId: 4 }),
      importContract({ id: 7, voyageId: 7 }),
      importContract({ id: 3, voyageId: 4 }),
    ];
    const groups = voyageGroups(list);
    expect(groups.map((group) => group.voyageId)).toEqual([4, 7]);
    expect(groups[0]?.parts.map((part) => part.id)).toEqual([3, 4]);
    expect(groups[1]?.parts.map((part) => part.id)).toEqual([7]);
  });

  it('voyageKind: import-only, export-only, roundtrip', () => {
    expect(voyageKind({ voyageId: 3, parts: [importContract()] })).toBe('import');
    expect(voyageKind({ voyageId: 4, parts: [exportContract()] })).toBe('export');
    expect(voyageKind({ voyageId: 4, parts: [importContract(), exportContract()] })).toBe('roundtrip');
  });

  it('voyageTab: ponuka, kým je ponukou niektorý kontrakt; aktívna, kým je aktívny niektorý; inak história', () => {
    const tab = (...states: ContractCardData['state'][]): ContractsTab =>
      voyageTab({ voyageId: 4, parts: states.map((state, index) => importContract({ id: index + 1, state })) });
    expect(tab('offered', 'offered')).toBe('offers');
    expect(tab('exporting', 'ship_en_route')).toBe('active');
    expect(tab('completed', 'exporting')).toBe('active');
    expect(tab('completed', 'failed')).toBe('history');
    expect(tab('expired')).toBe('history');
  });

  it('tabCounts počíta karty (roundtrip = jedna karta), voyageCardsForTab vracia skupiny záložky', () => {
    const list = [
      importContract({ id: 3, voyageId: 4, state: 'offered' }),
      exportContract({ id: 4, voyageId: 4, state: 'offered' }),
      importContract({ id: 5, voyageId: 5, state: 'offered' }),
      importContract({ id: 6, voyageId: 6, state: 'exporting' }),
      exportContract({ id: 8, voyageId: 8, state: 'completed' }),
    ];
    expect(tabCounts(list)).toEqual({ offers: 2, active: 1, history: 1 });
    expect(voyageCardsForTab(list, 'offers').map((group) => group.parts.map((part) => part.id))).toEqual([[3, 4], [5]]);
    expect(voyageCardsForTab(list, 'history').map((group) => group.voyageId)).toEqual([8]);
  });
});

describe('contractPayoutCents: export', () => {
  it('splnený export = odmena pomerne k naloženým − penalizácie; zlyhaný −penalizácie; aktívny plná odmena', () => {
    const done = exportContract({ state: 'completed', penaltiesCents: 1_000_000, booking: booking({ loadedUnits: 18, bookedUnits: 24 }) });
    expect(contractPayoutCents(done)).toBe(Math.floor((96_000_000 * 18) / 24) - 1_000_000);
    expect(contractPayoutCents({ ...done, state: 'failed' })).toBe(-1_000_000);
    expect(contractPayoutCents(exportContract({ state: 'exporting' }))).toBe(96_000_000);
  });

  it('splnený import ostáva odmena − penalizácie; súčet voyage sčíta časti', () => {
    const imported = importContract({ state: 'completed', penaltiesCents: 500_000 });
    expect(contractPayoutCents(imported)).toBe(179_500_000);
    expect(voyagePayoutCents({ voyageId: 4, parts: [importContract(), exportContract()] })).toBe(180_000_000 + 96_000_000);
  });
});

describe('cutoffInfo', () => {
  it('prijatý booking: odpočet, žltý pod 6 h, zelený inak', () => {
    expect(cutoffInfo(exportContract({ booking: booking({ cutoffTick: NOW + 5 * HOUR }) }), TIME)).toMatchObject({ text: 'Cut-off o 5 h', tone: 'warn' });
    expect(cutoffInfo(exportContract({ booking: booking({ cutoffTick: NOW + 6 * HOUR }) }), TIME)).toMatchObject({ text: 'Cut-off o 6 h', tone: 'ok' });
    expect(cutoffInfo(exportContract({ booking: booking({ cutoffTick: NOW + DAY + 2 * HOUR }) }), TIME)).toMatchObject({ text: 'Cut-off o 1 d 2 h', tone: 'ok' });
  });

  it('po cut-off: „Cut-off uplynul“ (neutrálne)', () => {
    expect(cutoffInfo(exportContract({ booking: booking({ cutoffTick: NOW }) }), TIME)).toMatchObject({ text: 'Cut-off uplynul', tone: 'muted' });
    expect(cutoffInfo(exportContract({ booking: booking({ cutoffTick: NOW - HOUR }) }), TIME)?.text).toBe('Cut-off uplynul');
  });

  it('ponuka: odstup pred príchodom lode, ak je známy; inak všeobecný text', () => {
    const offer = (b: Partial<ContractBookingData>): ContractCardData => exportContract({ state: 'offered', booking: booking({ cutoffTick: undefined, ...b }) });
    expect(cutoffInfo(offer({ cutoffLeadTicks: 12 * HOUR }), TIME)?.text).toBe('Cut-off 12 h pred príchodom lode');
    expect(cutoffInfo(offer({}), TIME)?.text).toBe('Cut-off pred príchodom lode');
  });

  it('import, uzavretý export a export bez bookingu nemajú cut-off', () => {
    expect(cutoffInfo(importContract(), TIME)).toBeNull();
    expect(cutoffInfo(exportContract({ state: 'completed' }), TIME)).toBeNull();
    expect(cutoffInfo(exportContract({ booking: undefined }), TIME)).toBeNull();
  });
});

describe('bookingBars a bookingCounters', () => {
  it('pruhy: dovezené a naložené voči bookovaným TEU', () => {
    expect(bookingBars(booking({ arrivedUnits: 10, loadedUnits: 4 }))).toEqual([
      { field: 'arrived', label: 'Dovezené', part: 10, total: 24 },
      { field: 'loaded', label: 'Naložené', part: 4, total: 24 },
    ]);
  });

  it('počítadlá: len nenulové v poradí zadržané, last minute, rolled, vrátené', () => {
    expect(bookingCounters(booking())).toEqual([]);
    const all = bookingCounters(booking({ heldUnits: 1, lastMinuteUnits: 2, rolledUnits: 3, returnedUnits: 4 }));
    expect(all.map((counter) => [counter.key, counter.count, counter.tone])).toEqual([
      ['held', 1, 'warn'],
      ['last-minute', 2, 'warn'],
      ['rolled', 3, 'danger'],
      ['returned', 4, 'muted'],
    ]);
    expect(bookingCounters(booking({ rolledUnits: 2 })).map((counter) => counter.key)).toEqual(['rolled']);
  });

  it('pendingArrivalsText: len aktívny kontrakt s ešte plánovanými príchodmi', () => {
    expect(pendingArrivalsText(exportContract())).toBe('Ešte príde 8 TEU');
    expect(pendingArrivalsText(exportContract({ booking: booking({ pendingArrivals: 0 }) }))).toBeNull();
    expect(pendingArrivalsText(exportContract({ state: 'offered' }))).toBeNull();
    expect(pendingArrivalsText(importContract())).toBeNull();
  });

  it('exportTitle nesie cieľ', () => {
    expect(exportTitle(exportContract())).toBe('Export → Rotterdam');
    expect(exportTitle(exportContract({ booking: undefined }))).toBe('Export');
  });
});

describe('contractStatus: export', () => {
  it('exporting = „Nakladá sa“ (nie „Exportuje sa“), ostatné stavy ako import', () => {
    expect(contractStatus(exportContract({ state: 'exporting', slaDeadlineTick: NOW + 3 * DAY }), TIME)).toMatchObject({ label: 'Nakladá sa', icon: 'ic_busy', tone: 'accent' });
    expect(contractStatus(importContract({ state: 'exporting', slaDeadlineTick: NOW + 3 * DAY }), TIME).label).toBe('Exportuje sa');
    expect(contractStatus(exportContract({ state: 'ship_en_route' }), TIME).label).toBe('Loď na ceste');
    expect(contractStatus(exportContract({ state: 'exporting', slaDeadlineTick: NOW + HOUR }), TIME).label).toBe('Ohrozené');
  });
});

describe('ContractCard: export booking', () => {
  it('aktívny booking: titulok „Export · …“, cieľ, cut-off, pruhy dovezené / naložené, plánované príchody', () => {
    const html = renderCard(exportContract({ booking: booking({ arrivedUnits: 10, loadedUnits: 0 }) }));
    expect(html).toContain('data-kind="export"');
    expect(fieldText(html, 'cargo')).toBe('Export · Kontajnery');
    expect(fieldText(html, 'volume')).toBe('24 TEU');
    expect(html).toMatch(/data-field="destination"[^>]*>(?:<svg[^]*?<\/svg>)Rotterdam</);
    expect(html).toMatch(/data-field="cutoff"[^>]*data-tone="warn"[^>]*>(?:<svg[^]*?<\/svg>)Cut-off o 5 h</);
    expect(fieldText(html, 'pending')).toBe('Ešte príde 8 TEU');
    expect(fieldText(html, 'arrived-value')).toBe('10 / 24 TEU');
    expect(fieldText(html, 'loaded-value')).toBe('0 / 24 TEU');
    expect(html).not.toContain('data-field="unloaded"');
    expect(html).toContain('aria-label="Export: Kontajnery, 24 TEU"');
  });

  it('počítadlá zadržané (VGM) / rolled / vrátené sa ukážu len keď sú nenulové, so zhodným číslom', () => {
    const html = renderCard(exportContract({ booking: booking({ heldUnits: 2, rolledUnits: 1, returnedUnits: 0, lastMinuteUnits: 0 }) }));
    expect(html).toContain('data-counter="held"');
    expect(html).toContain('data-counter="rolled"');
    expect(html).not.toContain('data-counter="returned"');
    expect(html).not.toContain('data-counter="last-minute"');
    expect(html).toMatch(/data-counter="held"[^>]*>(?:<svg[^]*?<\/svg>)Zadržané \(VGM\)<span[^>]*>2</);
    expect(renderCard(exportContract())).not.toContain('contract-card__counters');
  });

  it('história: súhrn naložených namiesto pruhov, výplata pomerne k naloženým a penalizácie', () => {
    const html = renderCard(
      exportContract({
        state: 'completed',
        closedTick: NOW - HOUR,
        slaDeadlineTick: NOW,
        penaltiesCents: 2_400_000,
        booking: booking({ loadedUnits: 22, bookedUnits: 24, arrivedUnits: 24, rolledUnits: 2, returnedUnits: 1, lastMinuteUnits: 1, pendingArrivals: 0 }),
      }),
    );
    expect(fieldText(html, 'loaded-summary')).toBe('Naložené 22 / 24 TEU');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('data-field="cutoff"');
    expect(fieldText(html, 'reward')).toBe(`+$${String(Math.floor((960_000 * 22) / 24 - 24_000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
    expect(fieldText(html, 'penalties-value')).toBe(`${MINUS}$24,000`);
    expect(html).toContain('data-counter="rolled"');
    expect(html).toContain('data-counter="returned"');
    expect(html).toContain('data-counter="last-minute"');
  });

  it('ponuka exportu: cut-off, Prijať / Odmietnuť s id, bez pruhov a počítadiel', () => {
    const onAccept = vi.fn();
    const data = exportContract({ id: 9, state: 'offered', slaWindowTicks: 4 * DAY, booking: booking({ cutoffTick: undefined, cutoffLeadTicks: 12 * HOUR, arrivedUnits: 0, pendingArrivals: 24 }) });
    const html = renderCard(data);
    expect(html).toContain('Cut-off 12 h pred príchodom lode');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('data-field="pending"');
    const tree = ContractCard({ contract: data, time: TIME, onAccept, onDecline: vi.fn() });
    const [accept] = findAll(tree, (element) => propsOf(element)['data-action'] === 'accept');
    (propsOf(accept as never).onClick as () => void)();
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('import karta sa nezmenila: bez data-kind=export, s pruhmi vyložené / exportované a bez booking sekcie', () => {
    const html = renderCard(importContract({ state: 'unloading', unitsUnloaded: 12, unitsExported: 3 }));
    expect(html).toContain('data-kind="import"');
    expect(fieldText(html, 'cargo')).toBe('Kontajnery');
    expect(fieldText(html, 'unloaded-value')).toBe('12 / 48 TEU');
    expect(fieldText(html, 'exported-value')).toBe('3 / 48 TEU');
    expect(html).not.toContain('contract-card__booking');
  });
});

describe('VoyageCard: roundtrip', () => {
  const parts = [
    importContract({ id: 3, state: 'unloading', unitsUnloaded: 20, unitsExported: 4, penaltiesCents: 800_000 }),
    exportContract({ id: 4, state: 'ship_en_route', penaltiesCents: 200_000, booking: booking({ heldUnits: 1 }) }),
  ];

  it('jedna karta s časťou Import a časťou Export, súčtom odmien a penalizácií', () => {
    const html = renderVoyage(parts);
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('data-voyage-id="4"');
    expect(html).toContain('data-kind="roundtrip"');
    expect(html.match(/class="contract-card__part"/g)).toHaveLength(2);
    expect(fieldText(html, 'cargo')).toBe('Import + export · Kontajnery');
    expect(fieldText(html, 'volume')).toBe('72 TEU');
    expect(html).toContain('aria-label="Kontrakt: Kontajnery, Import 48 TEU · Export 24 TEU"');
    expect(fieldText(html, 'xp-reward')).toBe('72 XP');
    expect(fieldText(html, 'reward')).toBe('+$2,760,000');
    expect(fieldText(html, 'penalties-value')).toBe(`${MINUS}$10,000`);
    expect(fieldText(html, 'import-title')).toBe('Import');
    expect(fieldText(html, 'export-title')).toBe('Export → Rotterdam');
    expect(fieldText(html, 'import-volume')).toBe('48 TEU');
    expect(fieldText(html, 'export-volume')).toBe('24 TEU');
    expect(fieldText(html, 'import-unloaded-value')).toBe('20 / 48 TEU');
    expect(fieldText(html, 'export-arrived-value')).toBe('10 / 24 TEU');
    expect(html).toContain('data-field="export-counter-held"');
    expect(html.match(/data-field="ship"/g)).toHaveLength(1);
  });

  it('každá časť má vlastné SLA a stav (Import vykladá, Export loď na ceste)', () => {
    const html = renderVoyage(parts);
    expect(html).toMatch(/data-field="import-status"[^>]*>(?:<svg[^]*?<\/svg>)Vykladá sa</);
    expect(html).toMatch(/data-field="export-status"[^>]*>(?:<svg[^]*?<\/svg>)Loď na ceste</);
    expect(html).toMatch(/data-field="import-sla"/);
    expect(html).toMatch(/data-field="export-sla"/);
  });

  it('ponuka: jedno „Prijať oba“ a „Odmietnuť oba“ s id prvého kontraktu; zablokované nesie prvý dôvod', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const offers = [
      importContract({ id: 3, state: 'offered', slaWindowTicks: 4 * DAY }),
      exportContract({ id: 4, state: 'offered', slaWindowTicks: 3 * DAY, booking: booking({ cutoffTick: undefined, arrivedUnits: 0, pendingArrivals: 24 }) }),
    ];
    const html = renderVoyage(offers, onAccept, onDecline);
    expect(html.match(/data-action="accept"/g)).toHaveLength(1);
    expect(html.match(/data-action="decline"/g)).toHaveLength(1);
    expect(html).toContain('Prijať oba');
    expect(html).toContain('Odmietnuť oba');

    const tree = VoyageCard({ group: { voyageId: 4, parts: offers }, time: TIME, onAccept, onDecline });
    const [accept] = findAll(tree, (element) => propsOf(element)['data-action'] === 'accept');
    const [decline] = findAll(tree, (element) => propsOf(element)['data-action'] === 'decline');
    (propsOf(accept as never).onClick as () => void)();
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(3);
    (propsOf(decline as never).onClick as () => void)();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith(3);

    const blockedOffers = [offers[0] as ContractCardData, { ...(offers[1] as ContractCardData), disabledReason: 'V prístave chýba žeriav.' }];
    const blockedHtml = renderVoyage(blockedOffers);
    expect(blockedHtml).toMatch(/aria-disabled="true"[^>]*title="V prístave chýba žeriav\."[^>]*data-action="accept"/);
    expect(fieldText(blockedHtml, 'accept-reason')).toBe('V prístave chýba žeriav.');
    const blockedTree = VoyageCard({ group: { voyageId: 4, parts: blockedOffers }, time: TIME, onAccept, onDecline });
    const [blockedAccept] = findAll(blockedTree, (element) => propsOf(element)['data-action'] === 'accept');
    (propsOf(blockedAccept as never).onClick as () => void)();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('aktívny roundtrip nemá tlačidlá ponuky', () => {
    const html = renderVoyage(parts);
    expect(html).not.toContain('data-action="accept"');
    expect(html).not.toContain('data-field="expiry"');
  });
});

describe('ContractsPanel: roundtrip', () => {
  const list: ContractCardData[] = [
    importContract({ id: 3, voyageId: 4, state: 'offered' }),
    exportContract({ id: 4, voyageId: 4, state: 'offered', booking: booking({ cutoffTick: undefined }) }),
    importContract({ id: 5, voyageId: 5, state: 'offered' }),
    exportContract({ id: 6, voyageId: 6, state: 'exporting', slaDeadlineTick: NOW + 3 * DAY }),
  ];
  const renderPanel = (tab: ContractsTab, onAccept = vi.fn()): string =>
    renderToStaticMarkup(createElement(ContractsPanel, { contracts: list, tab, time: TIME, onTabChange: vi.fn(), onAccept, onDecline: vi.fn() }));

  it('záložky počítajú karty: Ponuky · 2 (roundtrip + import), Aktívne · 1', () => {
    const html = renderPanel('offers');
    expect(html).toMatch(/data-tab="offers"[^>]*>Ponuky · 2</);
    expect(html).toMatch(/data-tab="active"[^>]*>Aktívne · 1</);
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain('data-voyage-id="4"');
    expect(html.match(/class="contract-card__part"/g)).toHaveLength(2);
  });

  it('aktívna záložka: samostatná export karta s „Nakladá sa“', () => {
    const html = renderPanel('active');
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('data-kind="export"');
    expect(html).toContain('Nakladá sa');
  });
});
