// T05-07: oznámenia o kontraktoch — nové ponuky (zlúčené za deň), prijatie, výplata, penalizácia (dedup), zlyhanie,
// mesačný výkaz; expirácia ponuky a koniec hry toast nemajú; akcia „Zobraziť“ otvára panel kontraktov.
import { describe, expect, it } from 'vitest';
import { AcceptContractCommand } from '@sim/commands';
import type { ContractId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { ToastCenter, toastSpecsForEvents, TOAST_SHOW_PANEL_LABEL, newOffersText } from '@app/toast-center';
import { createApp } from './app-fixtures';
import { firstOfferId } from './contracts-fixtures';

function appWithOffers() {
  const app = createApp();
  app.loop.frame(app.loop.tickMs);
  return { ...app, id: firstOfferId(app) as ContractId };
}

describe('newOffersText: skloňovanie', () => {
  it('1 nová ponuka, 2–4 nové ponuky, 5+ nových ponúk', () => {
    expect([1, 2, 4, 5, 6].map(newOffersText)).toEqual(['1 nová ponuka', '2 nové ponuky', '4 nové ponuky', '5 nových ponúk', '6 nových ponúk']);
  });
});

describe('toastSpecsForEvents: kontrakty', () => {
  it('ContractOffered: jedna dávka = jeden toast za deň s počtom ponúk a akciou na panel', () => {
    const { world, id } = appWithOffers();
    const events: SimEvent[] = [1, 2, 3].map(() => ({ type: 'ContractOffered', contractId: id }));
    const specs = toastSpecsForEvents(world, events);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      key: `contracts_offered:${String(world.clock.gameDay)}`,
      tone: 'info',
      icon: 'ic_contract',
      title: 'Nové ponuky kontraktov',
      text: '3 nové ponuky',
      panel: 'contracts',
    });
  });

  it('ContractAccepted: info s objemom, jednotkou a časom do príchodu lode', () => {
    const { world, bridge, loop, id } = appWithOffers();
    bridge.dispatch(new AcceptContractCommand(id));
    const events: SimEvent[] = [];
    bridge.onEvents((batch) => events.push(...batch));
    loop.frame(loop.tickMs);
    const specs = toastSpecsForEvents(world, events);
    const accepted = specs.find((spec) => spec.title === 'Kontrakt prijatý');
    const contract = world.contracts.get(id);
    expect(accepted).toMatchObject({ tone: 'info', key: `contract_accepted:${String(id)}`, panel: 'contracts' });
    expect(accepted?.text).toContain(`#${String(id)} · ${String(contract?.volumeUnits)} TEU`);
    expect(accepted?.text).toContain('loď príde o');
  });

  it('ContractCompleted: success s čistou výplatou a XP (`+$… a +N XP`), s meškaním má iný názov', () => {
    const { world, id } = appWithOffers();
    const onTime = toastSpecsForEvents(world, [{ type: 'ContractCompleted', contractId: id, rewardCents: 4_500_000, penaltiesCents: 0, xp: 120, onTime: true }]);
    expect(onTime).toHaveLength(1);
    expect(onTime[0]).toMatchObject({ tone: 'success', title: 'Kontrakt splnený', key: `contract_completed:${String(id)}` });
    expect(onTime[0]?.text).toMatch(/ · \+\$45,000 a \+120 XP$/);

    const late = toastSpecsForEvents(world, [{ type: 'ContractCompleted', contractId: id, rewardCents: 4_500_000, penaltiesCents: 500_000, xp: 60, onTime: false }]);
    expect(late[0]).toMatchObject({ tone: 'success', title: 'Kontrakt splnený s meškaním' });
    expect(late[0]?.text).toMatch(/ · \+\$40,000 a \+60 XP \(penalizácie −\$5,000\)$/);
  });

  it('PenaltyApplied: warning, sumy z dávky sa sčítajú podľa kontraktu a druhu, rôzne druhy sú samostatné toasty', () => {
    const { world, id } = appWithOffers();
    const events: SimEvent[] = [
      { type: 'PenaltyApplied', contractId: id, kind: 'demurrage', amountCents: 100_000 },
      { type: 'PenaltyApplied', contractId: id, kind: 'demurrage', amountCents: 100_000 },
      { type: 'PenaltyApplied', contractId: id, kind: 'late', amountCents: 250_000 },
    ];
    const specs = toastSpecsForEvents(world, events);
    expect(specs.map((spec) => spec.key)).toEqual([`penalty:${String(id)}:demurrage`, `penalty:${String(id)}:late`]);
    expect(specs.map((spec) => spec.title)).toEqual(['Penalizácia: státie lode', 'Penalizácia: meškanie exportu']);
    expect(specs.every((spec) => spec.tone === 'warning')).toBe(true);
    expect(specs[0]?.text).toMatch(/ · −\$2,000$/);
    expect(specs[1]?.text).toMatch(/ · −\$2,500$/);
  });

  it('ContractFailed: danger, odmena prepadla, penalizácia v texte', () => {
    const { world, id } = appWithOffers();
    const specs = toastSpecsForEvents(world, [{ type: 'ContractFailed', contractId: id, penaltiesCents: 900_000 }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ tone: 'danger', title: 'Kontrakt zlyhal', key: `contract_failed:${String(id)}` });
    expect(specs[0]?.text).toContain('odmena prepadla');
    expect(specs[0]?.text).toContain('−$9,000');
  });

  it('MonthlyReport: info so súčtom príjmov a výdavkov a hotovosťou na konci mesiaca', () => {
    const { world } = appWithOffers();
    const specs = toastSpecsForEvents(world, [
      {
        type: 'MonthlyReport',
        month: 0,
        summary: { month: 0, incomeCents: { contract_revenue: 10_000_000, module_sale: 500_000 }, expenseCents: { maintenance: 2_000_000, wages: 750_000 }, cashEndCents: 120_000_000 },
      },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ tone: 'info', title: 'Mesačný výkaz', key: 'monthly:0' });
    expect(specs[0]?.text).toBe('Mesiac 1: príjmy $105,000, výdavky $27,500, hotovosť $1,200,000');
  });

  it('expirácia ponuky, zmena stavu a koniec hry toast nemajú (GameOver rieši modál)', () => {
    const { world, id } = appWithOffers();
    const specs = toastSpecsForEvents(world, [
      { type: 'ContractExpired', contractId: id, reason: 'timeout' },
      { type: 'ContractExpired', contractId: id, reason: 'declined' },
      { type: 'ContractStateChanged', contractId: id, from: 'offered', to: 'accepted' },
      { type: 'GameOver', reason: 'bankruptcy', day: 3 },
    ]);
    expect(specs).toEqual([]);
  });
});

describe('ToastCenter: kontrakty', () => {
  it('penalizácia: rovnaký kontrakt a druh sa, kým je toast zobrazený, nezdvojí; nový druh áno', () => {
    const { bridge, id } = appWithOffers();
    const center = new ToastCenter(bridge);
    const penalty = (kind: 'demurrage' | 'late'): SimEvent => ({ type: 'PenaltyApplied', contractId: id, kind, amountCents: 1000 });
    const feed = (events: SimEvent[]): void => {
      // `ToastCenter` odoberá udalosti z mosta — rozošleme ich cez `publish` (nemenia svet).
      bridge.publish(events);
    };
    feed([penalty('demurrage')]);
    feed([penalty('demurrage')]);
    expect(center.get()).toHaveLength(1);
    feed([penalty('late')]);
    expect(center.get().map((toast) => toast.title)).toEqual(['Penalizácia: státie lode', 'Penalizácia: meškanie exportu']);
    center.dispose();
  });

  it('akcia „Zobraziť“ otvorí panel kontraktov; bez `openPanel` ju toast nemá', () => {
    const { bridge, id } = appWithOffers();
    const opened: string[] = [];
    const center = new ToastCenter(bridge, {
      openPanel: (panel) => {
        opened.push(panel);
      },
    });
    bridge.publish([{ type: 'ContractOffered', contractId: id }]);
    const [toast] = center.get();
    expect(toast?.showLabel).toBe(TOAST_SHOW_PANEL_LABEL);
    toast?.onShow?.(toast.id);
    expect(opened).toEqual(['contracts']);
    center.dispose();

    const plain = new ToastCenter(bridge);
    bridge.publish([{ type: 'ContractFailed', contractId: id, penaltiesCents: 100 }]);
    expect(plain.get()[0]?.onShow).toBeUndefined();
    plain.dispose();
  });

  it('ponuky na štarte hry: skutočný frame dá jeden toast „Nové ponuky kontraktov“', () => {
    const app = createApp();
    const center = new ToastCenter(app.bridge);
    app.loop.frame(app.loop.tickMs);
    expect(center.get().map((toast) => [toast.tone, toast.title, toast.text])).toEqual([
      ['info', 'Nové ponuky kontraktov', newOffersText(app.world.defs.economy.offersPerDay)],
    ]);
    center.dispose();
  });
});
