// Vjazd kamiónov z vnútrozemia v dvoch častiach (T6D-05b, hot path): `planDeliveryAdmission` len overí podmienky a zapíše miesto vjazdu, `spawnDelivery` až
// vtedy vytvorí kamión a nakladač jeho jednotky; `DockIntake` sa počas kroku 8 prepočíta raz za tick a znova až po vzniku kamióna s dovozom.
import { describe, expect, it } from 'vitest';
import { WaitingArea } from '@sim/modules';
import type { World } from '@sim/world';
import { TruckError } from '../../../src/sim/trucks/truck-error';
import { planDeliveryAdmission, spawnDelivery } from '../../../src/sim/trucks/hinterland-entry';
import { emptyWorld, f6cDefs, rampOf, run } from '../helpers/f6c';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];

/** Stojisko sveta (jediné). */
function areaOf(world: World): WaitingArea {
  for (const module of world.modules.values()) if (module instanceof WaitingArea) return module;
  throw new Error('svet nemá stojisko');
}

/** Rampa s jediným staging miestom (1 dock × 1 miesto): kamión s dovozom naraz zaručí celú kapacitu príjmu. */
const tinyRamp = () => f6cDefs({ moduleParams: { loading_ramp_container: { docks: 1, stagingPerDock: 1 } } });

describe('planDeliveryAdmission + spawnDelivery', () => {
  it('admitted zapíše miesto vjazdu a spawnDelivery vytvorí kamión s dovozom (nakladač sa zavolá raz, až pri vzniku); druhé volanie bez nového plánu je chyba', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    expect(planDeliveryAdmission(world, 'empty', rampOf(world).category)).toBe('admitted');
    expect(world.trucks.size).toBe(0); // plán nič nevytvorí
    const loaded: number[] = [];
    spawnDelivery(world, (truck) => {
      loaded.push(truck.id);
      expect(truck.mission).toBe('delivery');
    });
    expect(world.trucks.size).toBe(1);
    expect(loaded).toEqual([...world.trucks.keys()]);
    expect(() => spawnDelivery(world, () => undefined)).toThrow(TruckError);
  });

  it('waiting (stojisko pre dovoz je plné) nič nezapíše: spawnDelivery bez admitted je TruckError a nakladač sa nezavolá', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    const area = areaOf(world);
    for (const bay of [1, 2, 3, 4]) area.reserveBay(bay as never);
    expect(planDeliveryAdmission(world, 'empty', rampOf(world).category)).toBe('waiting');
    let called = 0;
    expect(() => spawnDelivery(world, () => (called += 1))).toThrow(TruckError);
    expect(called).toBe(0);
    expect(world.trucks.size).toBe(0);
  });

  it('po vzniku kamióna s dovozom sa prisľúbené miesta docku prepočítajú: ďalší pokus v tom istom ticku vidí obsadené jediné staging miesto', () => {
    const world = emptyWorld({ defs: tinyRamp(), vehicles: TWO_STRADDLES });
    const ramp = rampOf(world);
    expect(planDeliveryAdmission(world, 'empty', ramp.category)).toBe('admitted');
    spawnDelivery(world, (truck) => {
      world.cargo.create('container_teu', { kind: 'in_truck', truckId: truck.id }, null, { direction: 'empty', voyageId: null, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
    });
    expect(planDeliveryAdmission(world, 'empty', ramp.category)).toBe('waiting');
    expect(world.dockIntake.pendingAt(ramp, 0)).toBe(1);
    expect(world.dockIntake.roomAt(ramp, 0)).toBe(0);
  });
});

describe('vjazd v kroku 8 s jedným staging miestom', () => {
  it('dva návraty splatné v tom istom ticku: vojde jeden, druhý čaká vo vnútrozemí (cache príjmu sa po prvom vjazde zneplatní)', () => {
    const world = emptyWorld({ defs: tinyRamp(), vehicles: TWO_STRADDLES });
    const due = world.clock.tick + 2;
    world.emptyFlow.scheduleReturn(due, 'blue_anchor');
    world.emptyFlow.scheduleReturn(due, 'golden_wave');
    run(world, 6);
    expect(world.trucks.size).toBe(1);
    expect(world.emptyFlow.returnPlan).toHaveLength(1);
    expect(world.hinterland.admitted('delivery')).toBe(1);
  });
});
