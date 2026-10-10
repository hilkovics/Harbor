import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ContractCard,
  ContractsPanel,
  contractPayoutCents,
  contractSla,
  contractStatus,
  contractTab,
  contractsForTab,
  emptyState,
  offerExpiryText,
  progressPercent,
  shipText,
  tabCounts,
  type ContractCardData,
  type ContractCardState,
  type ContractsTab,
  type ContractsTimeScale,
} from '@ui/contracts-panel';
import { fieldText, findAll, propsOf } from './react-tree';

const MINUS = '−';
const HOUR = 360;
const DAY = 8640;
const NOW = 100_000;
const TIME: ContractsTimeScale = { nowTick: NOW, ticksPerHour: HOUR, ticksPerDay: DAY };

function contract(patch: Partial<ContractCardData> = {}): ContractCardData {
  return {
    id: 1,
    state: 'exporting',
    cargoCategory: 'container',
    cargoLabel: 'Kontajnery',
    unit: 'TEU',
    volumeUnits: 1000,
    rewardCents: 10_000_000,
    xpReward: 100,
    shipClassId: 'feeder',
    shipClassLabel: 'Feeder',
    offerExpiresTick: NOW + DAY,
    unitsUnloaded: 1000,
    unitsExported: 250,
    penaltiesCents: 0,
    slaDeadlineTick: NOW + 5 * DAY,
    ...patch,
  };
}

const render = (data: ContractCardData): string =>
  renderToStaticMarkup(createElement(ContractCard, { contract: data, time: TIME, onAccept: vi.fn(), onDecline: vi.fn() }));

describe('contractTab', () => {
  const table: ReadonlyArray<readonly [ContractCardState, ContractsTab]> = [
    ['offered', 'offers'],
    ['accepted', 'active'],
    ['ship_en_route', 'active'],
    ['unloading', 'active'],
    ['exporting', 'active'],
    ['completed', 'history'],
    ['failed', 'history'],
    ['expired', 'history'],
  ];
  it.each(table)('%s → %s', (state, tab) => {
    expect(contractTab(state)).toBe(tab);
  });

  it('tabCounts a contractsForTab rozdelia zoznam bez straty poradia', () => {
    const list = [contract({ id: 1, state: 'offered' }), contract({ id: 2 }), contract({ id: 3, state: 'failed' }), contract({ id: 4, state: 'offered' })];
    expect(tabCounts(list)).toEqual({ offers: 2, active: 1, history: 1 });
    expect(contractsForTab(list, 'offers').map((item) => item.id)).toEqual([1, 4]);
  });
});

describe('contractPayoutCents', () => {
  it('ponuka a aktívny = odmena; splnený = odmena − penalizácie; zlyhaný = −penalizácie', () => {
    expect(contractPayoutCents(contract({ state: 'offered' }))).toBe(10_000_000);
    expect(contractPayoutCents(contract({ penaltiesCents: 500_000 }))).toBe(10_000_000);
    expect(contractPayoutCents(contract({ state: 'completed', penaltiesCents: 500_000 }))).toBe(9_500_000);
    expect(contractPayoutCents(contract({ state: 'failed', penaltiesCents: 2_400_000 }))).toBe(-2_400_000);
  });
});

describe('contractSla', () => {
  it('ponuka: dĺžka okna, farba podľa dní (≥ 5 zelená, ≥ 3 žltá, inak červená)', () => {
    const offered = (days: number) => contractSla(contract({ state: 'offered', slaDeadlineTick: undefined, slaWindowTicks: days * DAY }), TIME);
    expect(offered(6)).toMatchObject({ text: '6 dní', tone: 'ok' });
    expect(offered(5)).toMatchObject({ tone: 'ok' });
    expect(offered(4)).toMatchObject({ text: '4 dni', tone: 'warn' });
    expect(offered(3)).toMatchObject({ tone: 'warn' });
    expect(offered(2)).toMatchObject({ text: '2 dni', tone: 'danger' });
    expect(offered(1)).toMatchObject({ text: '1 deň', tone: 'danger' });
  });

  it('aktívny: zostávajúci čas do slaDeadlineTick; po termíne červené „po termíne o …"', () => {
    expect(contractSla(contract({ slaDeadlineTick: NOW + 2 * DAY + 5 * HOUR }), TIME)).toMatchObject({ text: '2 d 5 h', tone: 'danger' });
    expect(contractSla(contract({ slaDeadlineTick: NOW + 5 * DAY }), TIME)).toMatchObject({ text: '5 dní', tone: 'ok' });
    expect(contractSla(contract({ slaDeadlineTick: NOW - 3 * HOUR }), TIME)).toMatchObject({ text: 'po termíne o 3 h', tone: 'danger' });
  });

  it('história: včas / o … neskôr podľa closedTick; bez closedTick a expirovaná bez SLA', () => {
    const deadline = NOW - DAY;
    expect(contractSla(contract({ state: 'completed', slaDeadlineTick: deadline, closedTick: deadline - HOUR }), TIME)).toMatchObject({ text: 'včas', tone: 'ok' });
    expect(contractSla(contract({ state: 'completed', slaDeadlineTick: deadline, closedTick: deadline }), TIME)).toMatchObject({ text: 'včas' });
    expect(contractSla(contract({ state: 'failed', slaDeadlineTick: deadline, closedTick: deadline + 2 * DAY }), TIME)).toMatchObject({
      text: 'o 2 dni neskôr',
      tone: 'danger',
    });
    expect(contractSla(contract({ state: 'completed', slaDeadlineTick: deadline }), TIME)).toBeNull();
    expect(contractSla(contract({ state: 'expired' }), TIME)).toBeNull();
  });

  it('chýbajúci termín aktívneho kontraktu = neutrálna pomlčka', () => {
    expect(contractSla(contract({ slaDeadlineTick: undefined }), TIME)).toMatchObject({ text: '—', tone: 'muted' });
  });
});

describe('contractStatus', () => {
  it('základné stavy', () => {
    expect(contractStatus(contract({ state: 'offered' }), TIME).label).toBe('Ponuka');
    expect(contractStatus(contract({ state: 'unloading' }), TIME)).toMatchObject({ label: 'Vykladá sa', icon: 'ic_busy' });
    expect(contractStatus(contract({ state: 'ship_en_route' }), TIME)).toMatchObject({ label: 'Loď na ceste', icon: 'ic_ship' });
    expect(contractStatus(contract({ state: 'completed' }), TIME)).toMatchObject({ label: 'Splnené', tone: 'ok' });
    expect(contractStatus(contract({ state: 'failed' }), TIME)).toMatchObject({ label: 'Zlyhané', tone: 'danger' });
    expect(contractStatus(contract({ state: 'expired' }), TIME)).toMatchObject({ label: 'Expirovaná', tone: 'muted' });
  });

  it('aktívny pod 1 deň do SLA = Ohrozené, po termíne = Po termíne; uzavretý sa neprepisuje', () => {
    expect(contractStatus(contract({ slaDeadlineTick: NOW + DAY - 1 }), TIME)).toMatchObject({ label: 'Ohrozené', tone: 'warn' });
    expect(contractStatus(contract({ slaDeadlineTick: NOW + DAY }), TIME).label).toBe('Exportuje sa');
    expect(contractStatus(contract({ slaDeadlineTick: NOW - 1 }), TIME)).toMatchObject({ label: 'Po termíne', tone: 'danger' });
    expect(contractStatus(contract({ state: 'completed', slaDeadlineTick: NOW - DAY }), TIME).label).toBe('Splnené');
  });
});

describe('pomocné texty', () => {
  it('progressPercent: zaokrúhlené, orezané na 0–100, objem 0 → 0', () => {
    expect(progressPercent(1820, 2400)).toBe(76);
    expect(progressPercent(3, 2)).toBe(100);
    expect(progressPercent(-5, 10)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(Number.NaN, 10)).toBe(0);
  });

  it('offerExpiryText a shipText', () => {
    expect(offerExpiryText(contract({ offerExpiresTick: NOW + DAY + 4 * HOUR }), TIME)).toBe('Expiruje o 1 d 4 h');
    expect(shipText(contract(), TIME)).toBe('Feeder');
    expect(shipText(contract({ shipClassLabel: undefined }), TIME)).toBe('feeder');
    expect(shipText(contract({ state: 'ship_en_route', shipArrivalTick: NOW + 5 * HOUR }), TIME)).toBe('Feeder · o 5 h');
    expect(shipText(contract({ state: 'unloading', shipArrivalTick: NOW - 5 * HOUR }), TIME)).toBe('Feeder');
  });

  it('emptyState: Ponuky s časom ďalšej ponuky, ostatné záložky vlastný text', () => {
    expect(emptyState('offers', TIME, 2 * DAY)).toEqual({ title: 'Žiadne ponuky', text: 'Ďalšia ponuka príde o 2 dni.' });
    expect(emptyState('offers', TIME).text).toBe('Nové ponuky prichádzajú každý deň.');
    expect(emptyState('active', TIME).title).toBe('Žiadne aktívne kontrakty');
    expect(emptyState('history', TIME).title).toBe('Zatiaľ žiadna história');
  });
});

describe('ContractCard', () => {
  it('ponuka: typ, objem + XP, odmena, SLA, loď, stav, expirácia a obe tlačidlá', () => {
    const html = render(
      contract({ state: 'offered', slaDeadlineTick: undefined, slaWindowTicks: 6 * DAY, volumeUnits: 1200, rewardCents: 18_400_000, offerExpiresTick: NOW + DAY + 4 * HOUR }),
    );
    expect(html).toContain('class="contract-card contract-card--container"');
    expect(html).toContain('data-state="offered"');
    expect(fieldText(html, 'cargo')).toBe('Kontajnery');
    expect(fieldText(html, 'volume')).toBe('1,200 TEU');
    expect(fieldText(html, 'xp-reward')).toBe('100 XP');
    expect(fieldText(html, 'reward')).toBe('+$184,000');
    expect(html).toMatch(/data-field="sla" data-tone="ok">.*6 dní/);
    expect(html).toContain('data-field="ship"');
    expect(html).toContain('>Ponuka<');
    expect(html).toContain('Expiruje o 1 d 4 h');
    expect(html).toContain('data-action="accept"');
    expect(html).toContain('data-action="decline"');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('aria-disabled="false"');
  });

  it('aktívny: progres Vyložené / Exportované voči objemu a bez tlačidiel', () => {
    const html = render(contract({ state: 'unloading', volumeUnits: 2400, unitsUnloaded: 1820, unitsExported: 640 }));
    expect(fieldText(html, 'unloaded-value')).toBe('1,820 / 2,400 TEU');
    expect(fieldText(html, 'exported-value')).toBe('640 / 2,400 TEU');
    expect(html).toContain('aria-valuenow="76"');
    expect(html).toContain('aria-valuenow="27"');
    expect(html).toContain('style="width:76%"');
    expect(html).not.toContain('data-action=');
    expect(html).not.toContain('data-field="penalties"');
  });

  it('penalizácie sa ukážu so znamienkom mínus (U+2212), nula sa neukáže', () => {
    expect(fieldText(render(contract({ penaltiesCents: 880_000 })), 'penalties-value')).toBe(`${MINUS}$8,800`);
    expect(render(contract({ penaltiesCents: 0 }))).not.toContain('data-field="penalties"');
  });

  it('odmena podľa stavu: splnený net, zlyhaný záporný, expirovaná bez znamienka', () => {
    expect(fieldText(render(contract({ state: 'completed', penaltiesCents: 2_100_000, rewardCents: 46_500_000 })), 'reward')).toBe('+$444,000');
    expect(fieldText(render(contract({ state: 'failed', penaltiesCents: 2_400_000 })), 'reward')).toBe(`${MINUS}$24,000`);
    const expired = render(contract({ state: 'expired', rewardCents: 9_600_000 }));
    expect(fieldText(expired, 'reward')).toBe('$96,000');
    expect(expired).toContain('contract-card__reward--muted');
  });

  it('zablokované Prijať: aria-disabled, title a viditeľný dôvod; klik nevolá onAccept, Odmietnuť áno', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const data = contract({ id: 7, state: 'offered', disabledReason: 'Chýba sklad.' });
    const html = render(data);
    expect(html).toMatch(/aria-disabled="true"[^>]*title="Chýba sklad\."[^>]*data-action="accept"/);
    expect(fieldText(html, 'accept-reason')).toBe('Chýba sklad.');

    const tree = ContractCard({ contract: data, time: TIME, onAccept, onDecline });
    const [accept] = findAll(tree, (element) => propsOf(element)['data-action'] === 'accept');
    const [decline] = findAll(tree, (element) => propsOf(element)['data-action'] === 'decline');
    (propsOf(accept as never).onClick as () => void)();
    expect(onAccept).not.toHaveBeenCalled();
    (propsOf(decline as never).onClick as () => void)();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('povolené Prijať volá onAccept(id) a nemá dôvod', () => {
    const onAccept = vi.fn();
    const data = contract({ id: 'c-9', state: 'offered' });
    const tree = ContractCard({ contract: data, time: TIME, onAccept, onDecline: vi.fn() });
    const [accept] = findAll(tree, (element) => propsOf(element)['data-action'] === 'accept');
    (propsOf(accept as never).onClick as () => void)();
    expect(onAccept).toHaveBeenCalledExactlyOnceWith('c-9');
    expect(render(data)).not.toContain('accept-reason');
  });

  it('expirácia do 1 dňa je zvýraznená', () => {
    expect(render(contract({ state: 'offered', offerExpiresTick: NOW + 5 * HOUR }))).toContain('contract-card__expiry--soon');
    expect(render(contract({ state: 'offered', offerExpiresTick: NOW + 2 * DAY }))).not.toContain('contract-card__expiry--soon');
  });
});

describe('ContractsPanel', () => {
  const list = [
    contract({ id: 1, state: 'offered', slaWindowTicks: 6 * DAY }),
    contract({ id: 2, state: 'offered', slaWindowTicks: 3 * DAY }),
    contract({ id: 3 }),
    contract({ id: 4, state: 'completed', closedTick: NOW - HOUR }),
  ];
  const renderPanel = (tab: ContractsTab, contracts = list, extra: { nextOfferInTicks?: number | null } = {}): string =>
    renderToStaticMarkup(
      createElement(ContractsPanel, { contracts, tab, time: TIME, onTabChange: vi.fn(), onAccept: vi.fn(), onDecline: vi.fn(), ...extra }),
    );

  it('záložky s počtami (História bez počtu), aktívna je aria-selected', () => {
    const html = renderPanel('offers');
    expect(html).toContain('<aside class="contracts-panel" aria-label="Kontrakty" data-tab="offers">');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-selected="true"[^>]*data-tab="offers"[^>]*>Ponuky · 2</);
    expect(html).toMatch(/aria-selected="false"[^>]*data-tab="active"[^>]*>Aktívne · 1</);
    expect(html).toMatch(/data-tab="history"[^>]*>História</);
  });

  it('ukáže len karty vybranej záložky', () => {
    expect(renderPanel('offers').match(/<article/g)).toHaveLength(2);
    expect(renderPanel('active').match(/<article/g)).toHaveLength(1);
    expect(renderPanel('history')).toContain('data-contract-id="4"');
    expect(renderPanel('history').match(/<article/g)).toHaveLength(1);
  });

  it('prázdny stav záložky Ponuky (contracts_empty) s časom ďalšej ponuky', () => {
    const html = renderPanel('offers', [contract({ id: 3 })], { nextOfferInTicks: 2 * DAY });
    expect(html).toContain('data-section="empty"');
    expect(fieldText(html, 'empty-title')).toBe('Žiadne ponuky');
    expect(fieldText(html, 'empty-text')).toBe('Ďalšia ponuka príde o 2 dni.');
    expect(html).not.toContain('<article');
    expect(html).toContain('Ponuky · 0');
  });

  it('zavrieť volá onClose (kliky na záložky pokrýva e2e f5-ui-demo)', () => {
    const onTabChange = vi.fn();
    const onClose = vi.fn();
    const tree = ContractsPanel({ contracts: list, tab: 'offers', time: TIME, onTabChange, onAccept: vi.fn(), onDecline: vi.fn(), onClose });
    const [close] = findAll(tree, (element) => propsOf(element)['aria-label'] === 'Zavrieť kontrakty');
    (propsOf(close as never).onClick as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
