/**
 * Staging miesta na dockoch rampy (ARCHITECTURE §7.1 `at_ramp { rampId, dock }`, §7.5; rozhodnutie orchestrátora F4
 * č. 4; ADR-022). Každý dock má `perDock` miest pre jednotky pripravené na kamión.
 *
 * Model je ten istý ako pri slotoch apronu a skladu (ADR-017): **obsadenie je len v ledgeri**, modul drží iba
 * rezervácie pre prichádzajúce jednotky (outbound job ich vytvorí pri vzniku, T04-03). Rozdiel: dock nie je jedinečné
 * miesto (`CARGO_HOLDER_SPECS.at_ramp.uniqueSlot = false` — na docku čaká viac jednotiek), preto sa rezervácie
 * nevedú po slotoch (`SlotReservations`), ale ako počet na dock, a obsadenie docku sa počíta prechodom jednotiek rampy
 * v ledgeri (`unitAtIndex`, najviac `docks × perDock` jednotiek, bez alokácie).
 *
 * Na docku ležia dva druhy jednotiek (ADR-032 bod 13): **náklad na odvoz** kamiónom (`isPickup` — import, export vrátený
 * odosielateľovi) a **export na prijatie** (práve vyložený kamiónom s exportom, čaká na vozidlo do skladu). Kapacita docku
 * (`freeAt`, `firstFreeDock`, `stagedCount`, `staged + reserved ≤ perDock`) počíta všetky jednotky; `stagedAt`,
 * `firstUnitAt` a `unitsAt` (pripravené na kamión) len náklad na odvoz. Bez testu `isPickup` platí každá jednotka za
 * náklad na odvoz (F4).
 *
 * Tok: `reserve(dock)` pri vzniku jobu → pred presunom `assertCommittable(dock, unit)` → `CargoLedger.move(unit,
 * at_ramp(rampId, dock))` → `commit(dock, unit)` (rezervácia zaniká). Odchod jednotky (`at_ramp → in_truck`) je len
 * presun v ledgeri. Zrušený job: `release(dock)`. Operácie sú atomické: pri chybe (`ModuleError`) sa nič nezmení.
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { ModuleError } from './module-error';

/** Vstup `DockStaging`. */
export interface DockStagingInit {
  /** Rampa — držiteľ lokácie `at_ramp`. */
  readonly rampId: EntityId;
  /** Počet dockov (celé ≥ 1). */
  readonly docks: number;
  /** Staging miest na dock (celé ≥ 1). */
  readonly perDock: number;
  /** Ledger sveta — zdroj obsadenia (len čítanie). */
  readonly cargo: CargoReader;
  /** Popis do chybových správ (`rampa loading_ramp_container #7`). */
  readonly label: string;
  /** Čaká jednotka na docku na kamión (náklad na odvoz)? Predvolene áno (F4); viď hlavička. */
  readonly isPickup?: (unit: CargoUnit) => boolean;
}

const KIND = 'at_ramp';

export class DockStaging {
  readonly rampId: EntityId;
  readonly docks: number;
  readonly perDock: number;
  /** Staging miest spolu (`docks × perDock`). */
  readonly capacity: number;
  private readonly cargo: CargoReader;
  private readonly label: string;
  private readonly isPickup: (unit: CargoUnit) => boolean;
  /** Dock → počet rezervácií. */
  private readonly reservedPerDock: number[];
  private reserved = 0;

  /** `docks` a `perDock` musia byť celé ≥ 1 (`ModuleError('invalid_input')`). */
  constructor(init: DockStagingInit) {
    for (const [name, value] of [
      ['docks', init.docks],
      ['perDock', init.perDock],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new ModuleError('invalid_input', `${init.label}: ${name} musí byť celé číslo ≥ 1, dostal ${String(value)}`);
    }
    this.rampId = init.rampId;
    this.docks = init.docks;
    this.perDock = init.perDock;
    this.capacity = init.docks * init.perDock;
    this.cargo = init.cargo;
    this.label = init.label;
    this.isPickup = init.isPickup ?? ((): boolean => true);
    this.reservedPerDock = new Array<number>(init.docks).fill(0);
  }

  /** Jednotky na všetkých dockoch rampy (ledger; náklad na odvoz aj export na prijatie). */
  get stagedCount(): number {
    return this.cargo.countAt(KIND, this.rampId);
  }

  /** Rezervácie na všetkých dockoch. */
  get reservedCount(): number {
    return this.reserved;
  }

  /** `capacity − staged − reserved`. */
  get freeCount(): number {
    return this.capacity - this.stagedCount - this.reserved;
  }

  /**
   * Jednotky na docku **pripravené na kamión** (náklad na odvoz, ledger; bez alokácie). Export na prijatie sa nepočíta
   * (`intakeAt`). Dock mimo rozsahu → `ModuleError('invalid_slot')`.
   */
  stagedAt(dock: number): number {
    this.assertDock(dock, 'stagedAt');
    return this.countOnDock(dock, true);
  }

  /** Jednotky na docku, ktoré čakajú na vozidlo do skladu (export práve vyložený kamiónom; ledger, bez alokácie). */
  intakeAt(dock: number): number {
    this.assertDock(dock, 'intakeAt');
    return this.countOnDock(dock, false);
  }

  /** Rezervácie na docku. Dock mimo rozsahu → `ModuleError('invalid_slot')`. */
  reservedAt(dock: number): number {
    this.assertDock(dock, 'reservedAt');
    return this.reservedPerDock[dock];
  }

  /** `perDock − staged − reserved` na docku — koľko ďalších `reserve(dock)` uspeje. */
  freeAt(dock: number): number {
    this.assertDock(dock, 'freeAt');
    return this.perDock - this.countOnDock(dock, undefined) - this.reservedPerDock[dock];
  }

  /** Najnižší dock s voľným miestom, alebo −1. */
  firstFreeDock(): number {
    for (let dock = 0; dock < this.docks; dock++) {
      if (this.perDock - this.countOnDock(dock, undefined) - this.reservedPerDock[dock] > 0) return dock;
    }
    return -1;
  }

  /** Najstaršia jednotka **na odvoz** na docku (FIFO podľa ledgera) bez alokácie; dock bez nej → `undefined`. */
  firstUnitAt(dock: number): EntityId | undefined {
    this.assertDock(dock, 'firstUnitAt');
    const count = this.cargo.countAt(KIND, this.rampId);
    for (let i = 0; i < count; i++) {
      const unitId = this.cargo.unitAtIndex(KIND, this.rampId, i);
      if (unitId !== undefined && this.dockOfUnit(unitId) === dock && this.pickupMatches(unitId, true)) return unitId;
    }
    return undefined;
  }

  /** Jednotky na docku **na odvoz** v poradí príchodu (kópia). */
  unitsAt(dock: number): readonly EntityId[] {
    this.assertDock(dock, 'unitsAt');
    const units: EntityId[] = [];
    for (const unitId of this.cargo.unitsAt(KIND, this.rampId)) {
      if (this.dockOfUnit(unitId) === dock && this.pickupMatches(unitId, true)) units.push(unitId);
    }
    return units;
  }

  /** Rezervuje miesto na docku. Chyby: mimo rozsahu → `invalid_slot`, dock bez voľného miesta → `no_free_slot`. */
  reserve(dock: number): void {
    this.assertDock(dock, 'reserve');
    if (this.perDock - this.countOnDock(dock, undefined) - this.reservedPerDock[dock] <= 0) {
      throw new ModuleError('no_free_slot', `${this.label}.reserve: dock ${String(dock)} nemá voľné miesto (${String(this.perDock)} na dock)`);
    }
    this.reservedPerDock[dock] += 1;
    this.reserved += 1;
  }

  /** Zruší rezerváciu na docku (zrušený job). Chyby: mimo rozsahu → `invalid_slot`, bez rezervácie → `slot_not_reserved`. */
  release(dock: number): void {
    this.assertDock(dock, 'release');
    this.assertReserved(dock, 'release');
    this.reservedPerDock[dock] -= 1;
    this.reserved -= 1;
  }

  /**
   * Overí, že presun jednotky na dock a následný `commit` prejdú, bez zmeny stavu — volá sa **pred**
   * `CargoLedger.move(unit, at_ramp(rampId, dock))`. Chyby: mimo rozsahu → `invalid_slot`, bez rezervácie →
   * `slot_not_reserved`.
   */
  assertCommittable(dock: number, unitId: EntityId): void {
    this.assertDock(dock, `assertCommittable(#${String(unitId)})`);
    this.assertReserved(dock, `assertCommittable(#${String(unitId)})`);
  }

  /**
   * Premení rezerváciu na obsadenie: volá sa **po** `CargoLedger.move(unit, at_ramp(rampId, dock))`. Chyby: mimo
   * rozsahu → `invalid_slot`, bez rezervácie → `slot_not_reserved`, ledger nemá jednotku na tomto docku →
   * `unit_not_at_slot`.
   */
  commit(dock: number, unitId: EntityId): void {
    this.assertDock(dock, 'commit');
    this.assertReserved(dock, 'commit');
    const location = this.cargo.get(unitId)?.location;
    if (location?.kind !== KIND || location.rampId !== this.rampId || location.dock !== dock) {
      throw new ModuleError('unit_not_at_slot', `${this.label}.commit: jednotka #${String(unitId)} podľa ledgera neleží na docku ${String(dock)}`);
    }
    this.reservedPerDock[dock] -= 1;
    this.reserved -= 1;
  }

  /**
   * Prvé porušenie súladu s ledgerom (krok 12, bez alokácie): jednotka na docku mimo rozsahu, súčet rezervácií,
   * `staged + reserved ≤ perDock` na každom docku.
   */
  findProblem(): string | undefined {
    let sum = 0;
    for (let dock = 0; dock < this.docks; dock++) sum += this.reservedPerDock[dock];
    if (sum !== this.reserved) return `${this.label}: reservedCount ${String(this.reserved)} ≠ súčet rezervácií dockov ${String(sum)}`;
    const count = this.cargo.countAt(KIND, this.rampId);
    for (let i = 0; i < count; i++) {
      const unitId = this.cargo.unitAtIndex(KIND, this.rampId, i);
      const dock = unitId === undefined ? -1 : this.dockOfUnit(unitId);
      if (dock < 0 || dock >= this.docks) {
        return `${this.label}: jednotka #${String(unitId)} leží na docku ${String(dock)} mimo 0…${String(this.docks - 1)}`;
      }
    }
    for (let dock = 0; dock < this.docks; dock++) {
      const staged = this.countOnDock(dock, undefined);
      const reserved = this.reservedPerDock[dock];
      if (staged + reserved > this.perDock) {
        return `${this.label}: dock ${String(dock)}: pripravené ${String(staged)} + rezervované ${String(reserved)} > ${String(this.perDock)}`;
      }
    }
    return undefined;
  }

  /** Dock jednotky podľa ledgera (−1, ak jednotka nie je `at_ramp` tejto rampy). */
  private dockOfUnit(unitId: EntityId): number {
    const location = this.cargo.get(unitId)?.location;
    return location?.kind === KIND && location.rampId === this.rampId ? location.dock : -1;
  }

  /** Jednotka `unitId` je náklad na odvoz práve vtedy, keď `wanted` (a export na prijatie práve vtedy, keď `!wanted`). */
  private pickupMatches(unitId: EntityId, wanted: boolean): boolean {
    const unit = this.cargo.get(unitId);
    return unit !== undefined && this.isPickup(unit) === wanted;
  }

  /** Jednotky na docku: `pickup` `true` = len náklad na odvoz, `false` = len export na prijatie, `undefined` = všetky. */
  private countOnDock(dock: number, pickup: boolean | undefined): number {
    const count = this.cargo.countAt(KIND, this.rampId);
    let onDock = 0;
    for (let i = 0; i < count; i++) {
      const unitId = this.cargo.unitAtIndex(KIND, this.rampId, i);
      if (unitId === undefined || this.dockOfUnit(unitId) !== dock) continue;
      if (pickup === undefined || this.pickupMatches(unitId, pickup)) onDock += 1;
    }
    return onDock;
  }

  private assertDock(dock: number, method: string): void {
    if (!Number.isInteger(dock) || dock < 0 || dock >= this.docks) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: dock musí byť celé číslo 0…${String(this.docks - 1)}, dostal ${String(dock)}`);
    }
  }

  private assertReserved(dock: number, method: string): void {
    if (this.reservedPerDock[dock] <= 0) throw new ModuleError('slot_not_reserved', `${this.label}.${method}: dock ${String(dock)} nemá rezerváciu`);
  }
}
