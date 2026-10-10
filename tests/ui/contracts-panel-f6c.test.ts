// T6C-05: ContractsPanel — karty repositioningu prázdnych (linka, počet prázdnych, plavba, dostupné prázdne, naložené) a prekládky
// (trasa loď A → loď B s odpočtom do príchodu B, vyložené / čakajúce / naložené / zmeškané / predané) nad fixture dátami (ADR-034).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ContractCard,
  ContractsPanel,
  KIND_PART_NAME,
  VoyageCard,
  availableEmptiesInfo,
  contractPayoutCents,
  contractStatus,
  cutoffInfo,
  partTitle,
  repositioningBars,
  tabCounts,
  transhipBars,
  transhipCounters,
  transhipLegs,
  transhipMissed,
  transhipWaitingUnits,
  voyageKind,
  voyageTitle,
  volumeText,
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
const BLUE = { id: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue' };
const TEAL = { id: 'golden_wave', label: 'Golden Wave Container', colorToken: 'line-teal' };

function booking(patch: Partial<ContractBookingData> = {}): ContractBookingData {
  return {
    destinationPort: 'Rotterdam',
    bookedUnits: 24,
    pendingArrivals: 0,
    arrivedUnits: 0,
    loadedUnits: 0,
    lastMinuteUnits: 0,
    rolledUnits: 0,
    returnedUnits: 0,
    heldUnits: 0,
    ...patch,
  };
}

const BASE: ContractCardData = {
  id: 1,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 24,
  rewardCents: 316_800,
  xpReward: 24,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  offerExpiresTick: NOW + DAY,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

/** Repositioning prázdnych (ponuka, ak `patch` nezmení stav). */
function repo(patch: Partial<ContractCardData> = {}): ContractCardData {
  return {
    ...BASE,
    id: 11,
    kind: 'empty_repositioning',
    voyageId: 11,
    line: BLUE,
    slaWindowTicks: 3 * DAY,
    availableEmpties: 17,
    booking: booking(),
    ...patch,
  };
}

/** Prekládka (ponuka, ak `patch` nezmení stav). */
function tranship(patch: Partial<ContractCardData> = {}): ContractCardData {
  return {
    ...BASE,
    id: 21,
    kind: 'tranship',
    voyageId: 21,
    volumeUnits: 36,
    rewardCents: 1_159_200,
    line: TEAL,
    slaWindowTicks: 5 * DAY,
    tranship: { outVoyageId: 22, outGapTicks: [DAY, 2 * DAY] },
    booking: booking({ destinationPort: 'Hamburg', bookedUnits: 36 }),
    ...patch,
  };
}

const waiting = (patch: Partial<ContractCardData> = {}): ContractCardData =>
  tranship({
    state: 'exporting',
    shipArrivalTick: NOW - 5 * HOUR,
    slaDeadlineTick: NOW + 4 * DAY,
    unitsUnloaded: 36,
    tranship: { outVoyageId: 22, outArrivalTick: NOW + DAY + 4 * HOUR },
    booking: booking({ destinationPort: 'Hamburg', bookedUnits: 36, arrivedUnits: 36 }),
    ...patch,
  });

/** Text elementu s `data-field` aj s vnorenými značkami (ikona v pilulke): značky sa odstránia. */
function textOf(html: string, name: string): string | null {
  const match = new RegExp(`data-field="${name}"[^>]*>([\\s\\S]*?)</span>`).exec(html);
  return match === null ? null : (match[1] ?? '').replace(/<[^>]*>/g, '');
}

const renderCard = (data: ContractCardData): string =>
  renderToStaticMarkup(createElement(ContractCard, { contract: data, time: TIME, onAccept: vi.fn(), onDecline: vi.fn() }));

describe('názvy druhov a objem', () => {
  it('KIND_PART_NAME, partTitle, volumeText a voyageTitle', () => {
    expect(KIND_PART_NAME).toEqual({ import: 'Import', export: 'Export', empty_repositioning: 'Prázdne', tranship: 'Tranship' });
    expect(partTitle(repo())).toBe('Prázdne → Rotterdam');
    expect(partTitle(tranship())).toBe('Tranship → Hamburg');
    expect(partTitle({ ...BASE, kind: 'export', booking: booking({ destinationPort: 'Gdańsk' }) })).toBe('Export → Gdańsk');
    expect(partTitle({ ...BASE, kind: 'import' })).toBe('Import');
    expect(volumeText(repo())).toBe('24 TEU prázdnych');
    expect(volumeText(tranship())).toBe('36 TEU');
    const exportPart: ContractCardData = { ...BASE, id: 5, kind: 'export', voyageId: 5, booking: booking() };
    const importPart: ContractCardData = { ...BASE, id: 4, kind: 'import', voyageId: 5 };
    expect(voyageTitle({ voyageId: 5, parts: [importPart, exportPart] })).toBe('Import + export');
    expect(voyageTitle({ voyageId: 5, parts: [exportPart, repo({ id: 6, voyageId: 5 })] })).toBe('Export + prázdne');
  });

  it('voyageKind: roundtrip ostáva len import + export, iná zmes je `combined`, jeden druh je on sám', () => {
    const importPart: ContractCardData = { ...BASE, id: 4, kind: 'import', voyageId: 5 };
    const exportPart: ContractCardData = { ...BASE, id: 5, kind: 'export', voyageId: 5, booking: booking() };
    expect(voyageKind({ voyageId: 5, parts: [importPart, exportPart] })).toBe('roundtrip');
    expect(voyageKind({ voyageId: 5, parts: [exportPart, repo({ voyageId: 5 })] })).toBe('combined');
    expect(voyageKind({ voyageId: 11, parts: [repo()] })).toBe('empty_repositioning');
    expect(voyageKind({ voyageId: 21, parts: [tranship()] })).toBe('tranship');
  });
});

describe('repositioning: pomocné funkcie', () => {
  it('repositioningBars: len naložené voči počtu v bookingu', () => {
    expect(repositioningBars(booking({ loadedUnits: 6 }))).toEqual([{ field: 'loaded', label: 'Naložené', part: 6, total: 24 }]);
  });

  it('availableEmptiesInfo: dostupné voči zvyšku bookingu, `ok` pri dostatku, inak `warn`; bez údaja, po naložení a v histórii null', () => {
    expect(availableEmptiesInfo(repo({ availableEmpties: 24 }))).toMatchObject({ text: 'Dostupné 24 / 24 TEU', tone: 'ok' });
    expect(availableEmptiesInfo(repo({ availableEmpties: 17 }))).toMatchObject({ text: 'Dostupné 17 / 24 TEU', tone: 'warn' });
    expect(availableEmptiesInfo(repo({ availableEmpties: 0 }))).toMatchObject({ text: 'Dostupné 0 / 24 TEU', tone: 'warn' });
    // Zvyšok = bookované − naložené (18 z 30 naložených → treba ešte 12).
    expect(availableEmptiesInfo(repo({ state: 'exporting', availableEmpties: 9, booking: booking({ bookedUnits: 30, loadedUnits: 18 }) }))).toMatchObject({ text: 'Dostupné 9 / 12 TEU', tone: 'warn' });
    expect(availableEmptiesInfo(repo({ state: 'exporting', availableEmpties: 5, booking: booking({ loadedUnits: 24 }) }))).toBeNull();
    expect(availableEmptiesInfo({ ...repo(), availableEmpties: undefined })).toBeNull();
    expect(availableEmptiesInfo(repo({ state: 'completed' }))).toBeNull();
  });

  it('cutoffInfo: repositioning ani prekládka cut-off nemajú (ani s cutoffTick v dátach)', () => {
    expect(cutoffInfo(repo({ booking: booking({ cutoffLeadTicks: 12 * HOUR }) }), TIME)).toBeNull();
    expect(cutoffInfo(tranship({ state: 'accepted', booking: booking({ cutoffTick: NOW + HOUR }) }), TIME)).toBeNull();
    expect(cutoffInfo({ ...BASE, kind: 'export', booking: booking({ cutoffLeadTicks: 12 * HOUR }) }, TIME)).toMatchObject({ text: 'Cut-off 12 h pred príchodom lode' });
  });

  it('contractStatus: repositioning v `exporting` „Nakladá sa“, ostatné stavy ako pri importe', () => {
    expect(contractStatus(repo({ state: 'exporting' }), TIME)).toMatchObject({ label: 'Nakladá sa', tone: 'accent' });
    expect(contractStatus(repo(), TIME)).toMatchObject({ label: 'Ponuka', tone: 'info' });
    expect(contractStatus(repo({ state: 'ship_en_route' }), TIME)).toMatchObject({ label: 'Loď na ceste' });
  });

  it('výplata repositioningu je pomerná k naloženým prázdnym, nesplnený booking len penalizácie', () => {
    const done = repo({ state: 'completed', rewardCents: 300_000, booking: booking({ bookedUnits: 30, arrivedUnits: 30, loadedUnits: 24 }), penaltiesCents: 10_000 });
    expect(contractPayoutCents(done)).toBe(240_000 - 10_000);
    expect(contractPayoutCents(repo({ state: 'failed', penaltiesCents: 50_000 }))).toBe(-50_000);
  });
});

describe('prekládka: pomocné funkcie', () => {
  it('transhipBars: vyložené a naložené voči počtu jednotiek', () => {
    expect(transhipBars(booking({ bookedUnits: 36, arrivedUnits: 14, loadedUnits: 3 }))).toEqual([
      { field: 'unloaded', label: 'Vyložené', part: 14, total: 36 },
      { field: 'loaded', label: 'Naložené', part: 3, total: 36 },
    ]);
  });

  it('transhipWaitingUnits: vyložené − naložené − predané, nikdy záporné', () => {
    expect(transhipWaitingUnits(booking({ arrivedUnits: 36, loadedUnits: 10, returnedUnits: 6 }))).toBe(20);
    expect(transhipWaitingUnits(booking({ arrivedUnits: 4, loadedUnits: 3, returnedUnits: 3 }))).toBe(0);
  });

  it('transhipLegs: ponuka ukáže rozstup príchodu B po lodi A, prijatá odpočet do príchodu B, zmeškaná „odplávala bez jednotiek“', () => {
    expect(transhipLegs(repo(), TIME)).toBeNull();
    expect(transhipLegs(tranship(), TIME)).toEqual([
      { key: 'a', badge: 'A', text: 'plavba #21', timing: 'príde po prijatí', tone: 'normal' },
      { key: 'b', badge: 'B', text: 'plavba #22', timing: 'o 1 deň – 2 dni po lodi A', tone: 'normal' },
    ]);
    expect(transhipLegs(tranship({ tranship: { outVoyageId: 22 } }), TIME)?.[1]?.timing).toBe('príde po lodi A');
    expect(transhipLegs(waiting(), TIME)).toEqual([
      { key: 'a', badge: 'A', text: 'plavba #21', timing: 'prišla', tone: 'normal' },
      { key: 'b', badge: 'B', text: 'plavba #22', timing: 'príde o 1 d 4 h', tone: 'normal' },
    ]);
    const missed = waiting({ tranship: { outVoyageId: 22, outArrivalTick: NOW - 3 * HOUR, rescueDeadlineTick: NOW + DAY } });
    expect(transhipLegs(missed, TIME)?.[1]).toMatchObject({ timing: 'odplávala bez jednotiek', tone: 'danger' });
    expect(transhipLegs(waiting({ state: 'ship_en_route', shipArrivalTick: NOW + 5 * HOUR }), TIME)?.[0]?.timing).toBe('príde o 5 h');
    expect(transhipLegs(waiting({ state: 'completed' }), TIME)?.map((leg) => leg.timing)).toEqual(['', '']);
  });

  it('transhipMissed: len aktívny kontrakt s lehotou záchrany; text so zostávajúcim časom alebo „Lehota záchrany uplynula“', () => {
    expect(transhipMissed(waiting(), TIME)).toBeNull();
    const missed = waiting({ booking: booking({ bookedUnits: 36, arrivedUnits: 36, loadedUnits: 6 }), tranship: { outVoyageId: 22, rescueDeadlineTick: NOW + 2 * DAY + 3 * HOUR } });
    expect(transhipMissed(missed, TIME)).toEqual({ units: 30, text: 'Na záchranu zostáva 2 d 3 h' });
    expect(transhipMissed({ ...missed, tranship: { outVoyageId: 22, rescueDeadlineTick: NOW - 1 } }, TIME)?.text).toBe('Lehota záchrany uplynula');
    expect(transhipMissed({ ...missed, state: 'completed' }, TIME)).toBeNull();
  });

  it('transhipCounters: čakajúce, po zmeškaní namiesto toho zmeškané, predané; v ponuke žiadne; nula sa neukáže', () => {
    expect(transhipCounters(tranship(), TIME)).toEqual([]);
    expect(transhipCounters(waiting({ booking: booking({ bookedUnits: 36, arrivedUnits: 14 }) }), TIME).map((counter) => [counter.key, counter.count])).toEqual([['waiting', 14]]);
    expect(transhipCounters(waiting({ booking: booking({ bookedUnits: 36, arrivedUnits: 0 }) }), TIME)).toEqual([]);
    const missed = waiting({ tranship: { outVoyageId: 22, rescueDeadlineTick: NOW + DAY }, booking: booking({ bookedUnits: 36, arrivedUnits: 36, returnedUnits: 6 }) });
    expect(transhipCounters(missed, TIME).map((counter) => [counter.key, counter.count, counter.tone])).toEqual([
      ['missed', 30, 'danger'],
      ['sold', 6, 'muted'],
    ]);
  });

  it('contractStatus: prekládka v `exporting` čaká na loď B, po prvej naloženej jednotke „Nakladá sa“; Ohrozené / Po termíne má prednosť', () => {
    expect(contractStatus(waiting(), TIME)).toMatchObject({ label: 'Čaká na loď B', tone: 'accent' });
    expect(contractStatus(waiting({ booking: booking({ bookedUnits: 36, arrivedUnits: 36, loadedUnits: 1 }) }), TIME)).toMatchObject({ label: 'Nakladá sa' });
    expect(contractStatus(tranship({ state: 'unloading' }), TIME)).toMatchObject({ label: 'Vykladá sa' });
    expect(contractStatus(waiting({ slaDeadlineTick: NOW + 2 * HOUR }), TIME)).toMatchObject({ label: 'Ohrozené', tone: 'warn' });
  });

  it('tabCounts: nové druhy sa počítajú ako karty podľa stavu', () => {
    expect(tabCounts([repo(), tranship(), waiting({ id: 30, voyageId: 30 }), repo({ id: 12, voyageId: 12, state: 'completed' })])).toEqual({ offers: 2, active: 1, history: 1 });
  });
});

describe('karta repositioningu', () => {
  it('ponuka: názov „Prázdne · Kontajnery“, počet prázdnych, odznak linky s farbou z tokenu, cieľ, plavba, dostupné prázdne', () => {
    const html = renderCard(repo());
    expect(html).toContain('data-kind="empty_repositioning"');
    expect(html).toContain('aria-label="Prázdne kontajnery: Kontajnery, 24 TEU prázdnych"');
    expect(fieldText(html, 'cargo')).toBe('Prázdne · Kontajnery');
    expect(fieldText(html, 'volume')).toBe('24 TEU prázdnych');
    expect(html).toContain('data-field="line"');
    expect(html).toContain('data-line="blue_anchor"');
    expect(html).toContain('style="--line-color:var(--line-blue, var(--ui-text-2))"');
    expect(html).toContain('Blue Anchor Lines');
    expect(textOf(html, 'destination')).toBe('Rotterdam');
    expect(html).toMatch(/data-field="voyage"[^>]*>(?:<svg[^]*?<\/svg>)?Plavba #11</);
    expect(html).toMatch(/data-field="stock"[^>]*data-tone="warn"/);
    expect(html).toContain('Dostupné 17 / 24 TEU');
    expect(html).not.toContain('data-field="cutoff"');
    expect(html).not.toContain('data-field="pending"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('data-action="accept"');
  });

  it('aktívny: pruh Naložené (len ten), stav „Nakladá sa“, bez Dovezené', () => {
    const html = renderCard(repo({ state: 'exporting', slaDeadlineTick: NOW + 3 * DAY, shipArrivalTick: NOW - 3 * HOUR, booking: booking({ bookedUnits: 30, arrivedUnits: 30, loadedUnits: 18 }), volumeUnits: 30 }));
    expect(fieldText(html, 'loaded-value')).toBe('18 / 30 TEU');
    expect(html).toMatch(/aria-label="Naložené"[^>]*aria-valuenow="60"/);
    expect(html).not.toContain('data-field="arrived"');
    expect(textOf(html, 'status')).toBe('Nakladá sa');
    expect(html).not.toContain('data-action="accept"');
  });

  it('história: súhrn naložených a výplata pomerne k naloženým', () => {
    const html = renderCard(repo({ state: 'completed', closedTick: NOW - DAY, slaDeadlineTick: NOW - 2 * DAY, rewardCents: 300_000, booking: booking({ arrivedUnits: 24, loadedUnits: 12 }) }));
    expect(fieldText(html, 'loaded-summary')).toBe('Naložené 12 / 24 TEU');
    expect(fieldText(html, 'reward')).toBe('+$1,500');
    expect(html).not.toContain('data-field="stock"');
  });

  it('bez linky sa odznak nekreslí (karty spred F6c)', () => {
    const html = renderCard(repo({ line: undefined }));
    expect(html).not.toContain('data-field="line"');
    expect(html).not.toContain('--line-color');
  });

  it('neznámy token farby linky: náhradná farba textu, nie nevalidné CSS', () => {
    const html = renderCard(repo({ line: { id: 'x', label: 'X', colorToken: '' } }));
    expect(html).toContain('style="--line-color:var(--ui-text-2)"');
  });
});

describe('karta prekládky', () => {
  it('ponuka: „Tranship · Kontajnery“, trasa A → B s rozstupom príchodu B, cieľ, bez pruhov a počítadiel', () => {
    const html = renderCard(tranship());
    expect(html).toContain('data-kind="tranship"');
    expect(html).toContain('aria-label="Prekládka: Kontajnery, 36 TEU"');
    expect(fieldText(html, 'cargo')).toBe('Tranship · Kontajnery');
    expect(textOf(html, 'destination')).toBe('Hamburg');
    expect(html).toContain('aria-label="Trasa prekládky: loď A privezie, loď B odvezie"');
    expect(fieldText(html, 'leg-a')).toBe('Loď A · plavba #21');
    expect(fieldText(html, 'leg-b')).toBe('Loď B · plavba #22');
    expect(fieldText(html, 'leg-a-time')).toBe('príde po prijatí');
    expect(fieldText(html, 'leg-b-time')).toBe('o 1 deň – 2 dni po lodi A');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('data-counter');
    expect(html).not.toContain('data-field="cutoff"');
  });

  it('čaká na loď B: pruhy Vyložené a Naložené, počítadlo čakajúcich, odpočet do príchodu B, stav „Čaká na loď B“', () => {
    const html = renderCard(waiting());
    expect(fieldText(html, 'unloaded-value')).toBe('36 / 36 TEU');
    expect(fieldText(html, 'loaded-value')).toBe('0 / 36 TEU');
    expect(fieldText(html, 'leg-b-time')).toBe('príde o 1 d 4 h');
    expect(html).toMatch(/data-counter="waiting"/);
    expect(html).toMatch(/data-field="counter-waiting"[^>]*>(?:<svg[^]*?<\/svg>)?Čakajú na loď B<span[^>]*>36</);
    expect(textOf(html, 'status')).toBe('Čaká na loď B');
    expect(html).not.toContain('data-field="rescue"');
  });

  it('zmeškaná loď B: červená trasa, pilulka s lehotou záchrany, počítadlo Zmeškané namiesto Čakajú, penalizácia', () => {
    const html = renderCard(
      waiting({
        penaltiesCents: 168_000,
        booking: booking({ bookedUnits: 36, arrivedUnits: 36, loadedUnits: 12 }),
        tranship: { outVoyageId: 22, outArrivalTick: NOW - 3 * HOUR, rescueDeadlineTick: NOW + 2 * DAY + 3 * HOUR },
      }),
    );
    expect(html).toContain('contract-card__leg contract-card__leg--danger');
    expect(fieldText(html, 'leg-b-time')).toBe('odplávala bez jednotiek');
    expect(html).toMatch(/data-field="rescue"[^>]*data-tone="danger"/);
    expect(html).toContain('Na záchranu zostáva 2 d 3 h');
    expect(html).toMatch(/data-field="counter-missed"[^>]*>(?:<svg[^]*?<\/svg>)?Zmeškané<span[^>]*>24</);
    expect(html).not.toContain('data-counter="waiting"');
    expect(fieldText(html, 'penalties-value')).toBe(`${MINUS}$1,680`);
  });

  it('história: výplata pomerná k naloženým, predané jednotky, trasa bez časov', () => {
    const html = renderCard(
      tranship({
        state: 'completed',
        closedTick: NOW - DAY,
        slaDeadlineTick: NOW - 2 * DAY,
        penaltiesCents: 252_000,
        unitsExported: 6,
        unitsUnloaded: 36,
        tranship: { outVoyageId: 22, outArrivalTick: NOW - 2 * DAY },
        booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 36, arrivedUnits: 36, loadedUnits: 30, returnedUnits: 6 }),
      }),
    );
    expect(fieldText(html, 'loaded-summary')).toBe('Naložené 30 / 36 TEU');
    expect(html).toMatch(/data-field="counter-sold"[^>]*>(?:<svg[^]*?<\/svg>)?Predané<span[^>]*>6</);
    expect(html).not.toContain('data-field="leg-a-time"');
    expect(fieldText(html, 'reward')).toBe('+$7,140');
  });

  it('trasa je číslovaný zoznam s pomenovaním (čítačka) a odznaky A / B sú dekoratívne', () => {
    const html = renderCard(waiting());
    expect(html).toMatch(/<ol class="contract-card__route" aria-label="Trasa prekládky[^"]*"/);
    expect(html).toMatch(/<span class="contract-card__leg-badge" aria-hidden="true">A<\/span>/);
    expect(html).toMatch(/<span class="contract-card__leg-badge" aria-hidden="true">B<\/span>/);
  });
});

describe('karta voyage: export + prázdne v jednej plavbe', () => {
  const exportPart: ContractCardData = {
    ...BASE,
    id: 15,
    kind: 'export',
    voyageId: 15,
    line: BLUE,
    volumeUnits: 24,
    slaWindowTicks: 3 * DAY,
    booking: booking({ cutoffLeadTicks: 12 * HOUR }),
  };
  const repoPart = repo({ id: 16, voyageId: 15, volumeUnits: 12, booking: booking({ bookedUnits: 12 }) });
  const render = (onAccept = vi.fn(), onDecline = vi.fn()): string =>
    renderToStaticMarkup(createElement(VoyageCard, { group: { voyageId: 15, parts: [exportPart, repoPart] }, time: TIME, onAccept, onDecline }));

  it('spoločná karta „Export + prázdne“: dve časti s vlastnými názvami, jeden odznak linky v hlavičke, jedno „Prijať oba“', () => {
    const html = render();
    expect(html).toContain('data-kind="combined"');
    expect(fieldText(html, 'cargo')).toBe('Export + prázdne · Kontajnery');
    expect(fieldText(html, 'volume')).toBe('36 TEU');
    expect(html).toContain('aria-label="Kontrakt: Kontajnery, Export 24 TEU · Prázdne 12 TEU prázdnych"');
    expect(fieldText(html, 'export-title')).toBe('Export → Rotterdam');
    expect(fieldText(html, 'empty_repositioning-title')).toBe('Prázdne → Rotterdam');
    expect(html.match(/data-field="line"/g)).toHaveLength(1);
    expect(textOf(html, 'export-cutoff')).toBe('Cut-off 12 h pred príchodom lode');
    expect(html).not.toContain('data-field="empty_repositioning-cutoff"');
    expect(html.match(/data-action="accept"/g)).toHaveLength(1);
    expect(html).toContain('Prijať oba');
  });

  it('„Prijať oba“ pošle id prvého kontraktu skupiny, zablokované nesie dôvod prvého kontraktu s dôvodom', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const tree = VoyageCard({ group: { voyageId: 15, parts: [exportPart, { ...repoPart, disabledReason: 'Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)' }] }, time: TIME, onAccept, onDecline });
    const [accept] = findAll(tree, (element) => propsOf(element)['data-action'] === 'accept');
    const [decline] = findAll(tree, (element) => propsOf(element)['data-action'] === 'decline');
    expect(propsOf(accept as never)['aria-disabled']).toBe(true);
    expect(propsOf(accept as never)['title']).toBe('Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)');
    (propsOf(accept as never)['onClick'] as () => void)();
    expect(onAccept).not.toHaveBeenCalled();
    (propsOf(decline as never)['onClick'] as () => void)();
    expect(onDecline).toHaveBeenCalledWith(15);
  });
});

describe('ContractsPanel: nové druhy', () => {
  const panel = (contracts: readonly ContractCardData[], tab: ContractsTab): string =>
    renderToStaticMarkup(createElement(ContractsPanel, { contracts, tab, time: TIME, onTabChange: vi.fn(), onAccept: vi.fn(), onDecline: vi.fn() }));

  it('záložky podľa stavu a karty nových druhov v poradí; prekládka v ponukách má „Prijať“ a rozstup lode B', () => {
    const list = [repo(), tranship(), waiting({ id: 30, voyageId: 30 })];
    const offers = panel(list, 'offers');
    expect(offers).toContain('Ponuky · 2');
    expect(offers).toContain('Aktívne · 1');
    expect(offers.match(/<article /g)).toHaveLength(2);
    expect(offers.indexOf('data-kind="empty_repositioning"')).toBeLessThan(offers.indexOf('data-kind="tranship"'));
    expect(offers.match(/data-action="accept"/g)).toHaveLength(2);
    const active = panel(list, 'active');
    expect(active.match(/<article /g)).toHaveLength(1);
    expect(active).not.toContain('data-action="accept"');
  });
});
