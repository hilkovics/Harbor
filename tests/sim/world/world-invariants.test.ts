// Invarianty sveta (T02-03, ARCHITECTURE §6 krok 12, §16, ADR-014): findWorldViolation / World.assertInvariants
// odhalia nesúlad mriežky, modulov, žeriavov, apronov, skupín kotvísk a ledgera. Každý test pokazí jednu vec
// na inak konzistentnom svete (ručne, mimo verejných operácií) a overí, že invariant to pomenuje.
import { describe, expect, it } from 'vitest';
import { CargoConservationError } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import type { BerthModule, CraneModule } from '@sim/modules';
import { WorldInvariantError, findWorldViolation, type World } from '@sim/world';
import { newWorld, placeBerth, placeCrane } from '../modules/harbor-fixtures';
import { id } from '../modules/module-fixtures';
import { driveCrane, restoreCrane } from '../helpers/crane-state';

const TEU = 'container_teu';

interface Harbor {
  readonly world: World;
  readonly berth: BerthModule;
  readonly crane: CraneModule;
  readonly other: BerthModule;
}

/** Berth (40,14) so žeriavom (43,14) a susedný berth (48,14); konzistentný svet bez nákladu. */
function harbor(): Harbor {
  const world = newWorld();
  const berth = placeBerth(world, 40);
  const crane = placeCrane(world, 43);
  const other = placeBerth(world, 48);
  return { world, berth, crane, other };
}

/** Jednotka presunutá cez žeriav až na apron (obsadenie apronu je len v ledgeri, ADR-017). */
function unitOnApron(world: World, berth: BerthModule, crane: CraneModule, slot: number): EntityId {
  const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
  world.cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot });
  return unit;
}

describe('findWorldViolation — konzistentný svet', () => {
  it('prázdny svet, moduly aj náklad na aprone/v žeriave → žiadne porušenie', () => {
    expect(findWorldViolation(newWorld())).toBeUndefined();
    const { world, berth, crane } = harbor();
    unitOnApron(world, berth, crane, 3);
    unitOnApron(world, berth, crane, 1);
    const held = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
    world.cargo.move(held, { kind: 'in_crane', craneId: crane.id });
    restoreCrane(crane, { state: 'placing', reservedSlot: berth.apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 3 });
    crane.heldUnitId = held;
    expect(findWorldViolation(world)).toBeUndefined();
    expect(() => world.assertInvariants()).not.toThrow();
  });
});

describe('findWorldViolation — porušenia', () => {
  const CASES: readonly [string, RegExp, (h: Harbor) => void][] = [
    ['náklad u neexistujúcej lode', /on_ship.*neexistujúceho držiteľa/, ({ world }) => void world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) })],
    [
      'náklad vo vozidle (vozidlá vo F2 neexistujú)',
      /in_vehicle/,
      ({ world }) => {
        const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
        world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(901) });
      },
    ],
    [
      'náklad na aprone neexistujúceho berthu',
      /on_apron.*neexistujúceho držiteľa/,
      ({ world, crane }) => {
        const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
        world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
        world.cargo.move(unit, { kind: 'on_apron', berthId: id(777), slot: 0 });
        crane.heldUnitId = null;
      },
    ],
    ['bunka berthu bez moduleId', /bunka \(45, 15\).*moduleId null/, ({ world }) => void (world.grid.at(45, 15).moduleId = null)],
    ['cesta pod modulom', /vrstva 'road'/, ({ world }) => void (world.grid.at(41, 16).road = 'road')],
    ['bunka odkazuje na neexistujúci modul', /neexistujúci modul #99/, ({ world }) => void (world.grid.at(10, 30).moduleId = id(99))],
    ['bunka odkazuje na žeriav', /nezaberá/, ({ world, crane }) => void (world.grid.at(10, 30).moduleId = crane.id)],
    ['žeriav chýba v craneIds', /chýba v craneIds|craneIds/, ({ berth, crane }) => berth.detachCrane(crane.id)],
    ['cudzí žeriav v craneIds', /craneIds/, ({ other, crane }) => other.attachCrane(crane.id)],
    ['žeriav s inou rotáciou', /rotáciu 90/, ({ crane }) => Object.assign(crane, { rotation: 90 })],
    [
      'heldUnitId bez jednotky v ledgeri',
      /heldUnitId 55/,
      ({ crane }) => {
        driveCrane(crane, 'placing');
        crane.heldUnitId = id(55);
      },
    ],
    [
      'jednotka in_crane bez heldUnitId',
      /heldUnitId null, ledger in_crane/,
      ({ world, crane }) => {
        const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
        world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
      },
    ],
    ['grabbing bez rezervácie', /'grabbing' nemá rezervovaný slot/, ({ crane }) => driveCrane(crane, 'grabbing')],
    [
      'rezervácia žeriavu, ktorú apron nemá',
      /slot 2 nie je rezervovaný/,
      ({ crane }) => {
        driveCrane(crane, 'grabbing');
        crane.reservedSlot = 2;
      },
    ],
    [
      'fáza nesedí so stavom: placing so skončenou fázou (T02-14)',
      /'placing' má bežiacu fázu, phaseTicksLeft musí byť ≥ 1/,
      ({ world, berth, crane }) => {
        const held = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }).id;
        world.cargo.move(held, { kind: 'in_crane', craneId: crane.id });
        restoreCrane(crane, { state: 'placing', reservedSlot: berth.apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 3 });
        crane.heldUnitId = held;
        crane.phaseTicksLeft = 0;
      },
    ],
    [
      'fáza nesedí so stavom: blocked s bežiacou fázou (T02-14)',
      /'blocked' je mimo fázy, phaseTicksLeft musí byť 0/,
      ({ crane }) => {
        driveCrane(crane, 'blocked');
        crane.enterPhase(4);
      },
    ],
    ['rezervácia apronu bez žeriavu', /rezervované sloty apronu \[0\]/, ({ berth }) => void berth.apron.reserve()],
    // T03-02 (ADR-017): apron obsadenie nezrkadlí — nesúlad apron ↔ ledger nemôže vzniknúť; stráži sa rezervácia vs ledger.
    [
      'rezervovaný slot apronu obsadila jednotka (presun bez commit)',
      /apron berth_standard #1: rezervovaný slot 0 obsadila jednotka #\d+/,
      ({ world, berth, crane }) => {
        restoreCrane(crane, { state: 'grabbing', reservedSlot: berth.apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 3 });
        unitOnApron(world, berth, crane, 0);
      },
    ],
    [
      'jednotka na slote mimo kapacity apronu',
      /apron berth_standard #1: jednotka #\d+ leží na slote 7 mimo 0…3/,
      ({ world, berth, crane }) => void unitOnApron(world, berth, crane, 7),
    ],
    ['zastarané groupId berthu', /groupId 5/, ({ other }) => (other.groupId = 5)],
  ];

  it.each(CASES)('%s', (_name, message, corrupt) => {
    const h = harbor();
    corrupt(h);
    const violation = findWorldViolation(h.world);
    expect(violation).toMatch(message);
  });

  it('assertInvariants: porušenie sveta → WorldInvariantError, porušenie ledgera → CargoConservationError (najprv)', () => {
    const { world, berth } = harbor();
    berth.apron.reserve();
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
    expect(() => world.assertInvariants()).toThrow(/^World: porušený invariant — /);
    const ledger = world.cargo;
    const original = ledger.assertConservation.bind(ledger);
    ledger.assertConservation = () => {
      throw new CargoConservationError('test');
    };
    expect(() => world.assertInvariants()).toThrow(CargoConservationError);
    ledger.assertConservation = original;
  });
});
