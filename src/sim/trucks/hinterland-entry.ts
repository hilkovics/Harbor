/**
 * Vjazd kamióna s dovozom z vnútrozemia do prístavu (F6d, ADR-035; R4, ADR-041; `trucks/hinterland.ts`): kamión `delivery` (export, návrat prázdneho) dostane vjazd, len keď má **lístok** —
 * pre jeho kontajner existuje blok so zaručeným miestom na uloženie (YardPlanner, `chooseYardSlot` nad skúšobnou jednotkou) a token cieľa (TP bloku, alebo státie odstavnej plochy).
 * Miesto v bloku sa rezervuje hneď pri vzniku (job `deliver`, `logistics/truck-jobs.ts`), takže kamión nikdy nevyloží do plného skladu.
 *
 * Výsledok pokusu: `admitted` (kamión vznikol na road portáli, plán sa spotrebuje), `declined` (len návrat prázdneho: depo prázdnych nemá štrukturálne žiadne miesto a čakať nemá zmysel, plán sa
 * zahodí) alebo `waiting` (kamión čaká vo vnútrozemí, plán ostáva — chýba blok, token alebo voľný portál).
 *
 * `Rng`: hmotnostnú triedu exportu losuje až skutočný vznik kamióna (`DeliverySpec.final`); skúšobná jednotka používa strednú triedu (`DeliverySpec.probe`), takže čakanie `Rng` nespotrebúva.
 */
import type { CargoUnit, CargoUnitLabels } from '../cargo/cargo-unit';
import type { ContractId, EntityId } from '../core/entity-id';
import { depotFreeSlots } from '../logistics/empty-stock';
import { chooseYardSlot } from '../logistics/yard-planner';
import { openDeliverJob } from '../logistics/truck-jobs';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import { nearBayOfSlot, reserveToken, tokenCell } from './destination';
import { pickGate, pickInPortalFor } from './gate-choice';
import { NO_ACCESS } from '../logistics/module-access';
import { spawnTruck, truckDefFor } from './truck-spawner';

/** Výsledok pokusu o vjazd (viď hlavička). */
export type AdmissionOutcome = 'admitted' | 'declined' | 'waiting';

/** Smer jednotky kamióna s dovozom: `export` (booking) alebo `empty` (návrat prázdneho). */
export type DeliveryDirection = 'export' | 'empty';

/** Čo kamión privezie: typ nákladu, kontrakt a štítky (skúšobné bez `Rng`, konečné pri vzniku). */
export interface DeliverySpec {
  readonly typeId: string;
  readonly contractId: ContractId | null;
  /** Štítky skúšobnej jednotky (bez `Rng`). */
  readonly probe: CargoUnitLabels;
  /** Štítky skutočnej jednotky (môže losovať `Rng`); volá sa raz, pri vzniku kamióna. */
  readonly final: () => CargoUnitLabels;
}

/** Skúšobná jednotka pre plánovač (`id` 0, bez polohy v ledgeri): plánovač čítá len jej štítky a kontrakt. */
function probeUnit(world: World, spec: DeliverySpec): CargoUnit {
  return {
    id: 0 as EntityId,
    typeId: spec.typeId,
    contractId: spec.contractId,
    hold: null,
    status: 'available',
    repairUntilTick: null,
    reefer: null,
    quantity: world.defs.cargoTypes.get(spec.typeId).unitsPerBatch,
    location: { kind: 'in_truck', truckId: 0 as EntityId },
    ...spec.probe,
  };
}

/**
 * Pokus o vjazd kamióna s dovozom `spec` (viď hlavička): skúšobná jednotka dostane od plánovača blok a slot (zdrojom je prvý platný vstupný pruh), blok token cieľa, portál voľný vstup; až potom
 * vznikne kamión, skutočná jednotka v ňom (`CargoLedger.create` v `in_truck`) a job `deliver` s rezervovaným slotom.
 */
export function tryAdmitDelivery(world: World, direction: DeliveryDirection, spec: DeliverySpec): AdmissionOutcome {
  // Zdrojový pruh plánu miesta: plánovač (`chooseYardSlot`) potrebuje pruh ešte pred výberom bloku, kým skutočný vstup (`pickGate`) závisí od bloku a tokenu, takže vstupný pruh sa vyberá až potom;
  // plán miesta v bloku od pruhu závisí len pri zdroji vzdialenosti (všetky vstupné pruhy sú v jednej sieti), preto stačí prvý platný pruh.
  const lane = world.landside.inLanes[0];
  const def = truckDefFor(world.defs, world.defs.cargoTypes.get(spec.typeId).category);
  if (lane === undefined || def === undefined) return 'waiting';
  const probe = probeUnit(world, spec);
  const choice = chooseYardSlot(world, probe, lane);
  if (choice === null) {
    // Návrat prázdneho do depa bez jediného voľného miesta nemá na čo čakať (depo sa nevyprázdňuje); ostatné prípady sa vyriešia samy.
    if (direction === 'empty') {
      const free = depotFreeSlots(world, lane, world.defs.cargoTypes.get(spec.typeId).category);
      if (free !== undefined && free <= 0) return 'declined';
    }
    return 'waiting';
  }
  const block = world.modules.get(choice.moduleId);
  if (!(block instanceof YardBlock)) return 'waiting';
  const token = reserveToken(world, block, nearBayOfSlot(block, choice.slot), true);
  if (token === null) return 'waiting';
  const cell = tokenCell(world, token);
  // Portál je cesta (ADR-037, R1 č. 10): kým ho drží nosič, kamión nevznikne — vnútrozemie čaká pri každom portáli zvlášť (ADR-041 bod 3).
  const portal = pickInPortalFor(world, def, cell);
  if (portal === NO_ACCESS) return 'waiting';
  const gate = pickGate(world, portal, def, cell);
  if (gate === undefined) return 'waiting';
  const labels = spec.final();
  spawnTruck(world, def, portal, 'delivery', block, token, gate, (truck) => {
    const unit = world.cargo.create(spec.typeId, { kind: 'in_truck', truckId: truck.id }, spec.contractId, labels);
    // Slot z plánovača platí pre skúšobnú jednotku; skutočná sa líši najviac triedou hmotnosti — plánovač ju zaradí znovu (rovnaký stav sveta), pri zhode berie rovnaký slot.
    const real = chooseYardSlot(world, unit, lane) ?? choice;
    const target = real.moduleId === block.id ? real : choice;
    block.reserveFor(target.slot, unit);
    openDeliverJob(world, truck, unit, block, target.slot);
  });
  return 'admitted';
}
