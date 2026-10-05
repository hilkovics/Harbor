// Invariant konzervácie nákladu (ARCHITECTURE §6 krok 12, §16): findConservationViolation nad pohľadom na vnútro
// ledgera. Vnútro CargoLedger je privátne a cez verejné API sa pokaziť nedá, preto test skladá konzistentný pohľad
// a potom ho cielene poškodí — každé porušenie musí pomenovať jednotku aj lokácie.
import { describe, expect, it } from 'vitest';
import {
  CARGO_HOLDER_KINDS,
  CARGO_HOLDER_SPECS,
  CARGO_LOCATION_KINDS,
  CargoConservationError,
  CargoError,
  findConservationViolation,
  holderIdOf,
  uniqueSlotOf,
  type CargoBucketView,
  type CargoLedgerView,
  type CargoLocation,
  type CargoLocationKind,
  type CargoUnit,
} from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { TEU, at, createHarness, id, importUnit } from './cargo-fixtures';

interface MutableBucket {
  units: EntityId[];
  slots: Map<number, EntityId> | null;
  exports?: number;
}

interface MutableView {
  units: Map<EntityId, CargoUnit>;
  buckets: Map<CargoLocationKind, Map<EntityId, MutableBucket>>;
  counts: Record<CargoLocationKind, number>;
  createdCount: number;
}

const unit = (unitId: number, location: CargoLocation): CargoUnit => importUnit({ id: id(unitId), location });

/** Konzistentný pohľad ako v CargoLedger: jednotky v poradí zoznamu, `exported` len počtom. */
function buildView(units: readonly CargoUnit[], exported = 0): MutableView {
  const buckets = new Map(CARGO_HOLDER_KINDS.map((kind) => [kind as CargoLocationKind, new Map<EntityId, MutableBucket>()]));
  const counts = Object.fromEntries(CARGO_LOCATION_KINDS.map((kind) => [kind, 0])) as Record<CargoLocationKind, number>;
  counts.exported = exported;
  for (const item of units) {
    const kind = item.location.kind;
    const holderId = holderIdOf(item.location) as EntityId;
    const holders = buckets.get(kind) as Map<EntityId, MutableBucket>;
    let bucket = holders.get(holderId);
    if (bucket === undefined) {
      bucket = { units: [], slots: CARGO_HOLDER_SPECS[kind as keyof typeof CARGO_HOLDER_SPECS].uniqueSlot ? new Map() : null };
      holders.set(holderId, bucket);
    }
    bucket.units.push(item.id);
    const slot = uniqueSlotOf(item.location);
    if (slot !== null) bucket.slots?.set(slot, item.id);
    counts[kind] += 1;
  }
  return { units: new Map(units.map((item) => [item.id, item])), buckets, counts, createdCount: units.length + exported };
}

const bucketOf = (view: MutableView, kind: CargoLocationKind, holderId: number): MutableBucket =>
  view.buckets.get(kind)?.get(id(holderId)) as MutableBucket;

/** Referenčný stav: dve jednotky na lodi, dve na aprone, jedna v sklade, dve na docku rampy, jedna exportovaná. */
const BASE: readonly CargoUnit[] = [
  unit(1, at.ship(100)),
  unit(3, at.ship(100)),
  unit(5, at.apron(10, 2)),
  unit(2, at.apron(10, 0)),
  unit(4, at.storage(40, 1)),
  unit(6, at.ramp(50, 0)),
  unit(7, at.ramp(50, 0)),
];
const base = (): MutableView => buildView(BASE, 1);

const violation = (view: MutableView): string | undefined => findConservationViolation(view as CargoLedgerView);

describe('findConservationViolation', () => {
  it('konzistentný pohľad (aj prázdny) nemá porušenie', () => {
    expect(violation(base())).toBeUndefined();
    expect(violation(buildView([]))).toBeUndefined();
  });

  it('počítadlo exportných jednotiek indexu (T6A-09b): zhoda prejde, nezhoda sa pomenuje; pohľad bez počítadla sa nekontroluje', () => {
    const view = base();
    bucketOf(view, 'on_ship', 100).exports = 0;
    expect(violation(view)).toBeUndefined();
    bucketOf(view, 'on_ship', 100).exports = 1;
    expect(violation(view)).toBe('index on_ship(shipId=100): počítadlo exportných jednotiek 1, v indexe ich je 0');
  });

  it.each<[string, (view: MutableView) => void, RegExp]>([
    [
      'jednotka v dvoch indexoch',
      (view) => bucketOf(view, 'at_ramp', 50).units.push(id(1)),
      /^jednotka #1 je v dvoch indexoch: index on_ship\(shipId=100\) a index at_ramp\(rampId=50\)$/,
    ],
    [
      'jednotka dvakrát v tom istom indexe',
      (view) => bucketOf(view, 'at_ramp', 50).units.push(id(6)),
      /jednotka #6 je v index at_ramp\(rampId=50\) dvakrát/,
    ],
    [
      'index nezodpovedá lokácii (iný držiteľ)',
      (view) => {
        const holders = view.buckets.get('on_ship') as Map<EntityId, MutableBucket>;
        holders.set(id(101), { units: [id(3)], slots: null });
        bucketOf(view, 'on_ship', 100).units.splice(1, 1);
      },
      /jednotka #3 je v index on_ship\(shipId=101\), ale jej lokácia je on_ship\(shipId=100\)/,
    ],
    [
      'index nezodpovedá lokácii (iný druh)',
      (view) => {
        view.units.set(id(4), unit(4, at.crane(20)));
      },
      /jednotka #4 je v index in_storage\(moduleId=40\), ale jej lokácia je in_crane\(craneId=20\)/,
    ],
    [
      'jednotka nie je v žiadnom indexe',
      (view) => {
        bucketOf(view, 'on_ship', 100).units.splice(0, 1);
        view.counts.on_ship -= 1;
      },
      /jednotka #1 \(on_ship\(shipId=100\)\) nie je v žiadnom indexe/,
    ],
    [
      'index obsahuje stratenú jednotku',
      (view) => {
        view.units.delete(id(4));
        view.createdCount -= 1;
      },
      /index in_storage\(moduleId=40\) obsahuje jednotku #4, ktorá v ledgeri nie je \(stratená jednotka\)/,
    ],
    [
      'slot apronu obsadený dvakrát',
      (view) => view.units.set(id(5), unit(5, at.apron(10, 0))),
      /slot 0 v index on_apron\(berthId=10\) obsadený dvakrát: #5 a #2/,
    ],
    [
      'mapa slotov nemá obsadený slot',
      (view) => bucketOf(view, 'on_apron', 10).slots?.delete(2),
      /index on_apron\(berthId=10\): mapa miest nemá slot 2 pre #5/,
    ],
    [
      'mapa slotov eviduje slot, na ktorom jednotka nie je',
      (view) => bucketOf(view, 'in_storage', 40).slots?.set(9, id(4)),
      /index in_storage\(moduleId=40\): mapa miest eviduje slot 9 pre #4, ktorá na ňom nie je/,
    ],
    [
      'druh bez jedinečných miest má mapu miest',
      (view) => {
        bucketOf(view, 'at_ramp', 50).slots = new Map([[0, id(6)]]);
      },
      /index at_ramp\(rampId=50\) má mapu miest, hoci druh 'at_ramp' nemá jedinečné miesta/,
    ],
    [
      'druh s jedinečnými miestami nemá mapu miest',
      (view) => {
        bucketOf(view, 'on_apron', 10).slots = null;
      },
      /index on_apron\(berthId=10\) nemá mapu miest \(slot\)/,
    ],
    [
      'index lode nie je zoradený podľa id',
      (view) => bucketOf(view, 'on_ship', 100).units.reverse(),
      /index on_ship\(shipId=100\) nie je zoradený vzostupne podľa id \(#3 pred #1\)/,
    ],
    [
      'prázdny index',
      (view) => view.buckets.get('in_crane')?.set(id(20), { units: [], slots: null }),
      /index in_crane\(craneId=20\) je prázdny/,
    ],
    [
      'chýba index druhu',
      (view) => view.buckets.delete('in_pipeline'),
      /chýba index druhu 'in_pipeline'/,
    ],
    [
      'index pre exported',
      (view) => view.buckets.set('exported', new Map()),
      /index pre druh 'exported', ktorý nemá držiteľa/,
    ],
    [
      'počítadlo druhu nesedí s indexmi',
      (view) => {
        view.counts.at_ramp = 3;
      },
      /počítadlo 'at_ramp' = 3, v indexoch je 2 jednotiek/,
    ],
    [
      'createdCount ≠ živé + exported',
      (view) => {
        view.createdCount = 10;
      },
      /createdCount 10 ≠ živé 7 \+ exported 1 \+ shipped 0 \(rozdiel 2\)/,
    ],
    [
      'createdCount počíta aj odplávané (shipped, ADR-032)',
      (view) => {
        view.counts.shipped = 2;
      },
      /createdCount 8 ≠ živé 7 \+ exported 1 \+ shipped 2 \(rozdiel -2\)/,
    ],
    [
      'živá jednotka s lokáciou shipped',
      (view) => {
        view.units.set(id(9), unit(9, at.shipped()));
        view.createdCount += 1;
      },
      /živá jednotka #9 má lokáciu shipped/,
    ],
    [
      'jednotka uložená pod iným id',
      (view) => view.units.set(id(3), unit(8, at.ship(100))),
      /^jednotka #8 je uložená pod id #3$/,
    ],
    [
      'živá jednotka s lokáciou exported',
      (view) => {
        view.units.set(id(9), unit(9, at.exported()));
        view.createdCount += 1;
      },
      /živá jednotka #9 má lokáciu exported/,
    ],
  ])('%s', (_name, corrupt, expected) => {
    const view = base();
    corrupt(view);
    expect(violation(view)).toMatch(expected);
  });
});

describe('CargoLedger.assertConservation a CargoConservationError', () => {
  it('CargoConservationError: kód conservation, názov a správa s porušením', () => {
    const error = new CargoConservationError('jednotka #5 je v dvoch indexoch');
    expect(error).toBeInstanceOf(CargoError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('conservation');
    expect(error.name).toBe('CargoConservationError');
    expect(error.message).toBe('CargoLedger: porušená konzervácia nákladu — jednotka #5 je v dvoch indexoch');
  });

  it('verejné API nedovolí poškodiť ledger: snímky sú zmrazené a zoznamy sú kópie', () => {
    const { ledger } = createHarness();
    const created = ledger.create(TEU, at.ship(100));
    expect(() => {
      (created as { location: CargoLocation }).location = at.crane(20);
    }).toThrow(TypeError);
    expect(() => {
      (created.location as { shipId: number }).shipId = 7;
    }).toThrow(TypeError);
    const listed = ledger.unitsOnShip(id(100)) as EntityId[];
    listed.push(id(99));
    const state = ledger.getState() as { createdCount: number };
    state.createdCount = 42;
    expect(ledger.unitsOnShip(id(100))).toEqual([created.id]);
    expect(ledger.createdCount).toBe(1);
    expect(() => ledger.assertConservation()).not.toThrow();
  });

  it('pohľad typu CargoBucketView zodpovedá tvaru indexu (typová kontrola testovacieho staviteľa)', () => {
    const bucket: CargoBucketView = bucketOf(base(), 'on_apron', 10);
    expect(bucket.units).toEqual([5, 2]);
    expect([...(bucket.slots ?? new Map<number, EntityId>())]).toEqual([
      [2, 5],
      [0, 2],
    ]);
  });
});
