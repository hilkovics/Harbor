/**
 * Náklad vo vlaku (R6, ADR-043): miesta TEU vagónov nad `CargoLedger` (poloha `in_train { trainId, slot }`, slot = poradie TEU miesta od lokomotívy, vagón = `⌊slot / wagonTeu⌋`). Ledger drží
 * jednotky a jedinečnosť slotu; tu je len účtovanie miest: jednotka 20′ zaberie jedno miesto, 40′ dve po sebe idúce **v jednom vagóne** (vagón 60′ = 3 TEU: 40′ + 20′ alebo 3× 20′),
 * a výber miesta — vagóny sa plnia po jednom od lokomotívy (rozhodnutie 5 ADR-043), v rámci vagóna od prvého voľného miesta.
 */
import { teuOf, type CargoUnit } from '../cargo/cargo-unit';
import type { CargoReader } from '../cargo/cargo-ledger';
import type { Train } from './train';

/** Obsadenie miest vlaku: `true` = miesto zaberá jednotka (aj druhá polovica 40′). */
export function trainSlotMap(cargo: CargoReader, train: Train): boolean[] {
  const taken = new Array<boolean>(train.slotCount).fill(false);
  for (const unitId of cargo.unitsAt('in_train', train.id)) {
    const unit = cargo.get(unitId);
    if (unit === undefined || unit.location.kind !== 'in_train') continue;
    const first = unit.location.slot;
    for (let i = 0; i < teuOf(unit); i++) if (first + i < taken.length) taken[first + i] = true;
  }
  return taken;
}

/** Obsadené TEU po vagónoch od lokomotívy. */
export function wagonFillTeu(cargo: CargoReader, train: Train): number[] {
  const taken = trainSlotMap(cargo, train);
  const { wagonTeu } = train.def;
  return Array.from({ length: train.wagons }, (_, wagon) => taken.slice(wagon * wagonTeu, (wagon + 1) * wagonTeu).filter(Boolean).length);
}

/** Je vlak plný (všetky miesta obsadené)? */
export function isTrainFull(cargo: CargoReader, train: Train): boolean {
  return wagonFillTeu(cargo, train).every((fill) => fill >= train.def.wagonTeu);
}

/** Prvé voľné miesto pre `teu` TEU v jednom vagóne (vagóny od lokomotívy), alebo `undefined`, keď sa jednotka nezmestí. */
export function findTrainSlot(cargo: CargoReader, train: Train, teu: number): number | undefined {
  const taken = trainSlotMap(cargo, train);
  const { wagonTeu } = train.def;
  for (let wagon = 0; wagon < train.wagons; wagon++) {
    for (let offset = 0; offset + teu <= wagonTeu; offset++) {
      const first = wagon * wagonTeu + offset;
      if (taken.slice(first, first + teu).every((slot) => !slot)) return first;
    }
  }
  return undefined;
}

/** Zmestí sa jednotka do vlaku? */
export function trainFits(cargo: CargoReader, train: Train, unit: Pick<CargoUnit, 'sizeFt'>): boolean {
  return findTrainSlot(cargo, train, teuOf(unit)) !== undefined;
}
