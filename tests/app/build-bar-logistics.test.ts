// T03-10: BuildBar kategórie Sklady a Logistika z defov (F3) — vozidlá ako `buy`, zámok podľa cieľa nákupu.
import { describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { buildBarCategories, vehicleBuyItem } from '@app/build-bar-data';
import type { VehicleBuyTarget } from '@app/vehicle-purchase';
import { itemStatus } from '@ui/build-bar';

const defs = loadBundledDefs();
const CARRIER_COST = defs.vehicles.get('straddle_carrier').purchaseCents;
const CONNECTED_DEPOT: VehicleBuyTarget = { depotId: 3 as never, reason: null };

function category(id: string, cash = defs.economy.startingCashCents, target?: VehicleBuyTarget) {
  const found = buildBarCategories(defs, cash, target).find((c) => c.id === id);
  if (found === undefined) throw new Error(`kategória ${id} chýba`);
  return found;
}

function carrier(cash = defs.economy.startingCashCents, target?: VehicleBuyTarget) {
  const item = category('logistics', cash, target).items[0];
  if (item === undefined) throw new Error('vozidlo chýba v Logistike');
  return item;
}

describe('BuildBar: Sklady', () => {
  it('container_yard_small ako stavba (build) s cenou a rozmerom z defu', () => {
    const [yard, depot, rtg, reefer, oog, rail, ...rest] = category('storage').items;
    expect(rest).toEqual([]);
    // Reefer blok (R5, ADR-042) je v Skladoch z defu; vlastný odznak a inšpektor zásuviek dodá TR5-04.
    expect(reefer).toMatchObject({ defId: 'reefer_block_8', costCents: defs.modules.get('reefer_block_8').costCents, footprint: { w: 4, h: 8 }, locked: false });
    // Železničný terminál (R6, ADR-043) je v Skladoch z defu; vlastný odznak a inšpektor dodá TR6-04.
    expect(rail).toMatchObject({ defId: 'rmg_rail_block', costCents: defs.modules.get('rmg_rail_block').costCents, footprint: { w: 6, h: 16 }, locked: false });
    // OOG plocha (R5, TR5-02) je v Skladoch z defu; odznak a inšpektor reach stackera dodá TR5-04.
    expect(oog).toMatchObject({ defId: 'oog_area', costCents: defs.modules.get('oog_area').costCents, footprint: { w: 4, h: 6 }, locked: false });
    // RTG blok (R3, ADR-040) je v kategórii Sklady z defu; vlastný odznak a inšpektor stroja dodá TR3-04.
    expect(rtg).toMatchObject({ defId: 'rtg_block', costCents: defs.modules.get('rtg_block').costCents, footprint: { w: 5, h: 12 }, locked: false });
    // Depo prázdnych (F6c, ADR-034) je v kategórii Sklady z defu; jeho odznak a text dodá T6C-05.
    expect(depot).toMatchObject({ defId: 'empty_depot', costCents: defs.modules.get('empty_depot').costCents, footprint: { w: 4, h: 4 }, locked: false });
    expect(yard).toMatchObject({
      defId: 'container_yard_small',
      displayName: 'Kontajnerový dvor S',
      costCents: defs.modules.get('container_yard_small').costCents,
      footprint: { w: 4, h: 4 },
      icon: 'ic_yard',
      locked: false,
      affordable: true,
    });
    expect(yard?.action ?? 'build').toBe('build');
  });
});

describe('BuildBar: Logistika', () => {
  it('najprv vozidlo (buy), potom depo (build) — poradie prototypu', () => {
    const items = category('logistics').items;
    expect(items.map((item) => [item.defId, item.action ?? 'build'])).toEqual([
      ['straddle_carrier', 'buy'],
      ['empty_handler', 'buy'], // F6c, ADR-034: vozidlo len pre prázdne kontajnery
      ['terminal_tractor', 'buy'], // R3, ADR-040: ťahač bez zdvihu (RTG blok ho obsluhuje)
      ['vehicle_depot', 'build'],
    ]);
    expect(items[3]).toMatchObject({ costCents: defs.modules.get('vehicle_depot').costCents, footprint: { w: 3, h: 3 }, icon: 'ic_depot', locked: false });
  });

  it('vozidlo bez cieľa nákupu je zamknuté „Postav a pripoj depo vozidiel“; bez rozmeru, cena z defu', () => {
    const item = carrier();
    expect(item).toMatchObject({ displayName: 'Straddle carrier', costCents: CARRIER_COST, icon: 'ic_vehicle', locked: true, lockedReason: 'Postav a pripoj depo vozidiel' });
    expect(item).not.toHaveProperty('footprint');
    expect(itemStatus(item)).toBe('locked');
  });

  it('pripojené depo s voľným státím odomkne nákup: dostupné a bez lockedReason', () => {
    const item = carrier(defs.economy.startingCashCents, CONNECTED_DEPOT);
    expect(item).toMatchObject({ locked: false, affordable: true });
    expect(item).not.toHaveProperty('lockedReason');
    expect(itemStatus(item)).toBe('available');
  });

  it('plné depá: zamknuté s dôvodom „Depá sú plné“', () => {
    expect(carrier(defs.economy.startingCashCents, { depotId: null, reason: 'Depá sú plné' })).toMatchObject({ locked: true, lockedReason: 'Depá sú plné' });
  });

  it('nákup bez peňazí: nezamknuté, ale unaffordable a chýba rozdiel', () => {
    const item = carrier(CARRIER_COST - 1_000_000, CONNECTED_DEPOT);
    expect(item).toMatchObject({ locked: false, affordable: false, missingCents: 1_000_000 });
    expect(itemStatus(item)).toBe('unaffordable');
  });

  it('hranica: hotovosť presne rovná cene vozidla stačí', () => {
    expect(carrier(CARRIER_COST, CONNECTED_DEPOT).affordable).toBe(true);
    expect(carrier(CARRIER_COST - 1, CONNECTED_DEPOT).missingCents).toBe(1);
  });

  it('def vozidla s technológiou je zamknutý technológiou (prednosť pred depom)', () => {
    const base = defs.vehicles.get('straddle_carrier');
    const item = vehicleBuyItem({ ...base, id: 'agv', techRequired: 'automation_1' }, CARRIER_COST * 10, CONNECTED_DEPOT);
    expect(item).toMatchObject({ defId: 'agv', locked: true, lockedReason: 'Vyžaduje technológiu automation_1', action: 'buy' });
  });

  it('žiadna položka nie je vo viacerých kategóriách (vozidlá + moduly)', () => {
    const all = buildBarCategories(defs, 0).flatMap((c) => c.items.map((item) => item.defId));
    expect(new Set(all).size).toBe(all.length);
  });
});
