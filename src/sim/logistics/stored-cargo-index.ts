/**
 * Index uskladneného nákladu podľa kontraktu (ARCHITECTURE §7.3 bod 2; docs/tasks/phase-05.md rozhodnutia 9 a 12;
 * ADR-027) — odvodená cache pre outbound joby dispatchera, **nie je v save**.
 *
 * Pre každý kontrakt (a zvlášť pre jednotky bez kontraktu, kľúč `null`) drží jednotky, ktoré ležia `in_storage`,
 * v poradí **sklad vzostupne podľa id, v rámci skladu FIFO** (poradie príchodu v ledgeri) — teda presne v poradí,
 * v akom ich prechádzal dispatcher F4 (sklady vzostupne, jednotky FIFO), len rozdelené podľa kontraktu. Dispatcher tak
 * prejde len jednotky kontraktov, ktoré smú na rampu, a nečíta jednotky ostatných (žiadny sken jednotky × kontrakty).
 *
 * - Udržiava ho háčik `CargoLedger.move` (`cargoMoved`, O(dĺžka zoznamu kontraktu) na presun do/zo skladu):
 *   `→ in_storage` zaradí jednotku za poslednú jednotku kontraktu v sklade s id ≤ cieľový sklad, `in_storage →`
 *   ju vyradí. Ostatné presuny ignoruje.
 * - Poradie je odvodené z ledgera, preto ho obnova save zostaví rovnako (`rebuild`: sklady vzostupne podľa id, ich
 *   jednotky FIFO) a obnovený svet vytvára rovnaké joby ako originál.
 * - Zoznam, ktorý sa vyprázdni, zanikne — v indexe sú len kontrakty s aspoň jednou uskladnenou jednotkou.
 * - **Prázdne kontajnery** (`direction: 'empty'`, F6c, ADR-034 bod 14) nie sú „voľný“ náklad na odvoz: nemajú kontrakt, takže by padli
 *   do skupiny `null` a dispatcher by ich poslal na rampu ako jednotky bez kontraktu. Preto ich index vedie **zvlášť podľa linky**
 *   (`emptiesOf`, bez poradia — výber prázdneho určuje najmenšie id, takže poradie nezávisí od obnovy save) a do skupín nepatria;
 *   `size` ich počíta (= `cargo.countByKind('in_storage')`, invariant kroku 12), `emptySize` len prázdne.
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId, EntityId } from '../core/entity-id';

/** Uskladnené jednotky jedného kontraktu (alebo bez kontraktu) v poradí sklad ↑, FIFO. Paralelné polia. */
export interface StoredCargoGroup {
  /** Kontrakt jednotiek, `null` = jednotky bez kontraktu (scenáre F2–F4, `SpawnShipDebug`). */
  readonly contractId: ContractId | null;
  /** Id jednotiek. */
  readonly units: readonly EntityId[];
  /** Sklad jednotky na rovnakom indexe (neklesajúco). */
  readonly storages: readonly EntityId[];
}

interface MutableGroup {
  readonly contractId: ContractId | null;
  readonly units: EntityId[];
  readonly storages: EntityId[];
}

/** Čítanie ledgera pri obnove (`World.cargo` ho spĺňa). */
export interface StoredCargoSource {
  countAt(kind: 'in_storage', holderId: EntityId): number;
  unitAtIndex(kind: 'in_storage', holderId: EntityId, index: number): EntityId | undefined;
  get(unitId: EntityId): CargoUnit | undefined;
}

/** Spoločný prázdny výsledok `emptiesOf` pre linku bez uskladnených prázdnych. */
const NO_EMPTIES: readonly EntityId[] = Object.freeze([]);

export class StoredCargoIndex {
  private readonly groups = new Map<ContractId | null, MutableGroup>();
  private readonly empties = new Map<string, EntityId[]>();
  private total = 0;
  private emptyTotal = 0;

  /** Skupiny s aspoň jednou jednotkou (poradie mapy nie je významné — dispatcher si ich zoradí). */
  get entries(): Iterable<StoredCargoGroup> {
    return this.groups.values();
  }

  /** Skupina kontraktu (`null` = bez kontraktu), alebo `undefined`, ak v sklade nemá nič. */
  groupOf(contractId: ContractId | null): StoredCargoGroup | undefined {
    return this.groups.get(contractId);
  }

  /** Počet jednotiek v indexe vrátane prázdnych (= `cargo.countByKind('in_storage')`, kontroluje krok 12). */
  get size(): number {
    return this.total + this.emptyTotal;
  }

  /** Počet uskladnených prázdnych kontajnerov (všetky linky; F6c). */
  get emptySize(): number {
    return this.emptyTotal;
  }

  /**
   * Id uskladnených prázdnych kontajnerov linky `lineId` (živé pole len na čítanie, v poradí príchodu do skladu bez záruky po
   * obnove save; stav kvality a aktívny job rieši volajúci). Linka bez prázdnych → prázdne pole.
   */
  emptiesOf(lineId: string): readonly EntityId[] {
    return this.empties.get(lineId) ?? NO_EMPTIES;
  }

  /** Háčik `CargoLedger.move` (po presune; `unit` = jednotka pred presunom). Nesmie vyhodiť. */
  cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    if (unit.location.kind === 'in_storage') this.remove(unit);
    if (to.kind === 'in_storage') this.insert(unit, to.moduleId);
  }

  /**
   * Zostaví index nanovo z ledgera (obnova save): sklady `storageIds` vzostupne podľa id, ich jednotky FIFO — rovnaké
   * poradie, aké vzniklo presunmi v origináli.
   */
  rebuild(source: StoredCargoSource, storageIds: Iterable<EntityId>): void {
    this.groups.clear();
    this.empties.clear();
    this.total = 0;
    this.emptyTotal = 0;
    for (const storageId of storageIds) {
      const count = source.countAt('in_storage', storageId);
      for (let i = 0; i < count; i++) {
        const unitId = source.unitAtIndex('in_storage', storageId, i);
        const unit = unitId === undefined ? undefined : source.get(unitId);
        if (unit !== undefined) this.insert(unit, storageId);
      }
    }
  }

  /**
   * Zaradí jednotku: prázdny kontajner do zoznamu jeho linky (mimo skupín), inak za poslednú jednotku skupiny kontraktu v sklade
   * s id ≤ `storageId` (FIFO v rámci skladu).
   */
  private insert(unit: CargoUnit, storageId: EntityId): void {
    if (unit.direction === 'empty') {
      this.insertEmpty(unit);
      return;
    }
    const { contractId } = unit;
    const unitId = unit.id;
    let group = this.groups.get(contractId);
    if (group === undefined) {
      group = { contractId, units: [], storages: [] };
      this.groups.set(contractId, group);
    }
    let at = group.units.length;
    while (at > 0 && group.storages[at - 1] > storageId) at -= 1;
    if (at === group.units.length) {
      group.units.push(unitId);
      group.storages.push(storageId);
    } else {
      group.units.splice(at, 0, unitId);
      group.storages.splice(at, 0, storageId);
    }
    this.total += 1;
  }

  /** Prázdny kontajner do zoznamu jeho linky (jednotka bez linky nemá — `lineId` prázdneho je povinné, ledger to stráži). */
  private insertEmpty(unit: CargoUnit): void {
    const line = unit.lineId ?? '';
    const list = this.empties.get(line);
    if (list === undefined) this.empties.set(line, [unit.id]);
    else list.push(unit.id);
    this.emptyTotal += 1;
  }

  /** Vyradí prázdny kontajner zo zoznamu jeho linky; jednotka mimo indexu sa ignoruje. */
  private removeEmpty(unit: CargoUnit): void {
    const line = unit.lineId ?? '';
    const list = this.empties.get(line);
    const at = list === undefined ? -1 : list.indexOf(unit.id);
    if (list === undefined || at < 0) return;
    list.splice(at, 1);
    this.emptyTotal -= 1;
    if (list.length === 0) this.empties.delete(line);
  }

  /** Vyradí jednotku; prázdna skupina zanikne. Jednotka mimo indexu sa ignoruje (háčik nesmie vyhodiť). */
  private remove(unit: CargoUnit): void {
    if (unit.direction === 'empty') {
      this.removeEmpty(unit);
      return;
    }
    const { contractId } = unit;
    const unitId = unit.id;
    const group = this.groups.get(contractId);
    if (group === undefined) return;
    const at = group.units.indexOf(unitId);
    if (at < 0) return;
    group.units.splice(at, 1);
    group.storages.splice(at, 1);
    this.total -= 1;
    if (group.units.length === 0) this.groups.delete(contractId);
  }
}
