/**
 * Blok skladu kontajnerov so stohmi (ADR-039 bod 3–6; pravidlo 7) — základ `ContainerYard` (straddle blok) aj `EmptyDepot` (depo prázdnych).
 * Geometria `bays × rows × maxTier` je v `params` skladu; bez nej je blok plochý (`bays = capacityUnits`, `rows = 1`, `maxTier = 1`).
 *
 * - **Slot** kóduje bunku `((row × bays) + bay) × maxTier + tier` (`slotOfCell`); poloha jednotky ostáva `in_storage { moduleId, slot }`.
 *   20′ zaberá bunku svojho slotu, 40′ pár buniek `(2k, 2k+1)` rovnakého `(row, tier)` — slot je bunka v párnom bay.
 * - **Pravidlá stohu** (`assertCanPlace`, `assertCanTake`, volá ich `CargoLedger.move` cez `StorageGuard`; porušenie je chyba): ukladá sa len na
 *   zem alebo na vrchol stohu rovnakej veľkosti (40′ na pár stohov s rovnakou výškou, vrchom 40′ alebo zemou), nie nad `maxTier`; berie sa len vrchný kontajner.
 * - **`StackGrid`** je odvodená cache (nie je v save): zostaví sa z ledgera pri vzniku modulu (nový aj obnovený svet) a udržiavajú ju hákmi
 *   `placed` / `taken`; krok 12 ju porovnáva s ledgerom (`findStackProblem`).
 * - **Rezervácie** (job → bunka) drží `SlotReservations` (anchor slot) a bloky navyše po bunkách (id jednotky a veľkosť; 40′ rezervuje aj bunku tieňa),
 *   takže plánovač vidí „efektívnu“ výšku stohu vrátane rozbehnutých jobov (`effectiveHeight`). Vozidlá môžu prísť v inom poradí, než sa rezervovalo —
 *   skutočnú vrstvu určí výška stohu pri vykládke (`settleReservation`), rezervácie sa vymenia (`logistics/yard-settle.ts`).
 * - **Kapacita** je v TEU (`capacityTeu` = `params.capacityUnits`, v defoch `bays × rows × maxTier`; def ju môže znížiť), `freeCount` = `capacityTeu − usedTeu − reservedTeu`.
 * - **Rehandling** (presun vrchných kontajnerov, aby sa dalo vybrať cieľový): počíta `rehandles` (save `runtime`); logiku robí `logistics/yard-rehandle.ts`.
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import type { StorageGuard } from '../cargo/storage-guard';
import { teuOf, type CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { Module, ModuleInit } from './module';
import { ModuleError } from './module-error';
import { checkRuntimeKeys, readCount } from './runtime-state';
import { StackGrid, geometryCapacity, positionOfCell, slotOfCell, type YardGeometry, type YardPosition } from './stack-grid';
import { StorageModule, type StorageRuntimeState } from './storage-module';
import type { CargoCategory } from '../defs/types';

/** Dynamický stav bloku v save: počítadlá skladu + `rehandles` (počet presunov kontajnerov nad cieľom, ADR-039 bod 6). */
export type YardRuntimeState = StorageRuntimeState & { readonly rehandles: number };

const YARD_RUNTIME_KEYS: readonly (keyof YardRuntimeState)[] = ['unitsIn', 'unitsOut', 'rehandles'];

/** Veľkosť kontajnera v rezervácii bunky → 20 / 40. */
const SIZE_OF_CODE = [0, 20, 40] as const;

/** Veľkosť rezervácie: 1 = 20′, 2 = 40′ (TEU). */
function codeOfSize(sizeFt: number): 1 | 2 {
  return sizeFt === 40 ? 2 : 1;
}

export abstract class YardBlock extends StorageModule implements StorageGuard {
  readonly geometry: YardGeometry;
  private readonly ledger: CargoReader;
  private readonly grid: StackGrid;
  /** Bunka → id rezervujúcej jednotky (0 = bez rezervácie, −1 = jednotka neznáma — rezervácia bez `unitId`). */
  private readonly reservedUnit: Int32Array;
  /** Bunka → veľkosť rezervácie (0 = nič, 1 = 20′, 2 = 40′). */
  private readonly reservedSize: Uint8Array;
  /** Stĺpec → počet rezervovaných buniek (vrátane tieňov 40′). */
  private readonly columnReserved: Uint8Array;
  private reservedCells = 0;
  private rehandleCount = 0;

  protected constructor(init: ModuleInit, category: CargoCategory) {
    super(init, category);
    const { bays, rows, maxTier } = this.params;
    this.geometry = bays !== undefined && rows !== undefined && maxTier !== undefined ? { bays, rows, maxTier } : { bays: this.params.capacityUnits, rows: 1, maxTier: 1 };
    this.ledger = init.cargo;
    this.grid = new StackGrid(this.geometry);
    const cells = geometryCapacity(this.geometry);
    this.reservedUnit = new Int32Array(cells);
    this.reservedSize = new Uint8Array(cells);
    this.columnReserved = new Uint8Array(this.geometry.bays * this.geometry.rows);
    this.rebuildGrid();
  }

  // ---- geometria a obsadenie ----

  /** Kapacita bloku v TEU (`params.capacityUnits` ≤ `bays × rows × maxTier`). */
  get capacityTeu(): number {
    return this.capacity;
  }

  /** Obsadené TEU (ledger, O(1)). */
  get usedTeu(): number {
    return this.ledger.teuAt('in_storage', this.id);
  }

  /** Rezervované TEU (bunky rezervované rozbehnutými jobmi). */
  get reservedTeu(): number {
    return this.reservedCells;
  }

  /** Voľné TEU po odpočítaní rezervácií. */
  override get freeCount(): number {
    return this.capacity - this.usedTeu - this.reservedCells;
  }

  /** Kumulatívny počet presunov kontajnerov nad cieľom (rehandling). */
  get rehandles(): number {
    return this.rehandleCount;
  }

  /** Zapíše jeden rehandling (volá `logistics/yard-rehandle.ts` po presune). */
  recordRehandle(): void {
    this.rehandleCount += 1;
  }

  /** Poloha bunky slotu (`slot` mimo rozsahu → `ModuleError('invalid_slot')`). */
  positionOfSlot(slot: number): YardPosition {
    this.assertCell(slot, 'positionOfSlot');
    return positionOfCell(this.geometry, slot);
  }

  /** Jednotka na slote z ledgera, alebo slot jednotky: `slotOf(unitId)` (slot jednotky v sklade) / `slotOf(bay, row, tier)` (slot bunky). */
  override slotOf(unitId: EntityId): number | undefined;
  override slotOf(bay: number, row: number, tier: number): number;
  override slotOf(first: number, row?: number, tier?: number): number | undefined {
    if (row === undefined || tier === undefined) return super.slotOf(first as EntityId);
    const { bays, rows, maxTier } = this.geometry;
    if (![first, row, tier].every(Number.isInteger) || first < 0 || first >= bays || row < 0 || row >= rows || tier < 0 || tier >= maxTier) {
      throw new ModuleError('invalid_slot', `${this.label}.slotOf: bunka (${String(first)}, ${String(row)}, ${String(tier)}) je mimo bloku ${String(bays)}×${String(rows)}×${String(maxTier)}`);
    }
    return slotOfCell(this.geometry, first, row, tier);
  }

  /** Výška stohu `(bay, row)` — počet obsadených vrstiev (bez rezervácií). */
  stackHeight(bay: number, row: number): number {
    return this.grid.height(bay, row);
  }

  /** Vrchná jednotka stohu `(bay, row)`, alebo `null`. */
  topUnit(bay: number, row: number): EntityId | null {
    return this.grid.top(bay, row);
  }

  /** Jednotka zaberajúca bunku `(bay, row, tier)` (40′ aj z bunky tieňa), alebo `null`. */
  unitInCell(bay: number, row: number, tier: number): EntityId | null {
    return this.grid.at(bay, row, tier);
  }

  /**
   * Výška stohu vrátane rezervácií — vrstva, na ktorú sa rezervuje ďalší príchod: nad najvyššou rezervovanou bunkou (po odobratí vrchného kontajnera
   * môže pod rezerváciou vzniknúť voľná bunka; tú využije až usadenie rezervácie pri vykládke), inak výška stohu.
   */
  effectiveHeight(bay: number, row: number): number {
    const height = this.grid.height(bay, row);
    if (this.columnReserved[row * this.geometry.bays + bay] === 0) return height;
    for (let tier = this.geometry.maxTier - 1; tier >= height; tier--) {
      if (this.reservedSize[slotOfCell(this.geometry, bay, row, tier)] !== 0) return tier + 1;
    }
    return height;
  }

  /** Najvyššia jednotka stohu vrátane rezervácií (rezervácia bez známej jednotky sa preskočí), alebo `null`. */
  effectiveTopUnit(bay: number, row: number): EntityId | null {
    if (this.columnReserved[row * this.geometry.bays + bay] === 0) return this.grid.top(bay, row);
    for (let tier = this.geometry.maxTier - 1; tier >= this.grid.height(bay, row); tier--) {
      const id = this.reservedUnit[slotOfCell(this.geometry, bay, row, tier)];
      if (id > 0) return id as EntityId;
    }
    return this.grid.top(bay, row);
  }

  /** Veľkosť vrchného kontajnera stohu vrátane rezervácií (20 / 40), `0` = prázdny stoh. */
  effectiveTopSize(bay: number, row: number): 0 | 20 | 40 {
    const height = this.effectiveHeight(bay, row);
    if (height === 0) return 0;
    const cell = slotOfCell(this.geometry, bay, row, height - 1);
    if (this.reservedSize[cell] !== 0) return SIZE_OF_CODE[this.reservedSize[cell]];
    const top = this.grid.at(bay, row, height - 1);
    const unit = top === null ? undefined : this.ledger.get(top);
    return unit?.sizeFt === 40 ? 40 : 20;
  }

  /** Počet kontajnerov nad jednotkou `unitId` v jej stohu (0 = navrchu); jednotka mimo bloku → 0. */
  burialDepth(unitId: EntityId): number {
    const slot = super.slotOf(unitId);
    if (slot === undefined) return 0;
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    return Math.max(0, this.grid.height(bay, row) - tier - 1);
  }

  /** Vrchný kontajner nad jednotkou `unitId` (ten, ktorý treba odložiť ako prvý), alebo `null`, ak je navrchu / mimo bloku. */
  topBlockerOf(unitId: EntityId): EntityId | null {
    const slot = super.slotOf(unitId);
    if (slot === undefined) return null;
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    return this.grid.height(bay, row) > tier + 1 ? this.grid.top(bay, row) : null;
  }

  /**
   * Pridá do `into` jednotky nad `unitId` v jeho stohu zdola nahor — uložené kontajnery a potom jednotky, ktoré sa nad ňu práve uložia (rezervácie
   * rozbehnutých jobov; rezervácia bez známej jednotky sa preskočí). Jednotka mimo bloku → nič.
   */
  unitsAbove(unitId: EntityId, into: EntityId[]): void {
    const slot = super.slotOf(unitId);
    if (slot === undefined) return;
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    for (let t = tier + 1; t < this.geometry.maxTier; t++) {
      const id = this.grid.at(bay, row, t) ?? (this.reservedUnit[slotOfCell(this.geometry, bay, row, t)] > 0 ? (this.reservedUnit[slotOfCell(this.geometry, bay, row, t)] as EntityId) : null);
      if (id !== null) into.push(id);
    }
  }

  /** Pridá do `into` jednotky stohu `(bay, row)` zdola nahor: obsadené bunky, potom rezervované (id > 0). */
  columnUnits(bay: number, row: number, into: EntityId[]): void {
    const { maxTier } = this.geometry;
    for (let tier = 0; tier < maxTier; tier++) {
      const id = this.grid.at(bay, row, tier) ?? (this.reservedUnit[slotOfCell(this.geometry, bay, row, tier)] > 0 ? (this.reservedUnit[slotOfCell(this.geometry, bay, row, tier)] as EntityId) : null);
      if (id !== null && into[into.length - 1] !== id) into.push(id);
    }
  }

  // ---- pravidlá stohu (StorageGuard) ----

  assertCanPlace(unit: CargoUnit, slot: number): void {
    this.assertCell(slot, 'assertCanPlace');
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    const { bays, maxTier } = this.geometry;
    const fail = (why: string): never => {
      throw new ModuleError('stack_rule', `${this.label}: jednotku #${String(unit.id)} (${String(unit.sizeFt)}′) nemožno uložiť na bunku (${String(bay)}, ${String(row)}, ${String(tier)}): ${why}`);
    };
    if (unit.sizeFt === 40) {
      if (bay % 2 !== 0 || bay + 1 >= bays) return fail('40′ zaberá pár bays (2k, 2k+1)');
      if (this.grid.height(bay, row) !== tier || this.grid.height(bay + 1, row) !== tier) return fail('40′ sa ukladá len na rovnako vysoký pár stohov');
      if (tier > 0 && (this.sizeOfCell(bay, row, tier - 1) !== 40 || this.grid.at(bay, row, tier - 1) !== this.grid.at(bay + 1, row, tier - 1))) return fail('pod 40′ smie byť len 40′ alebo zem');
    } else {
      if (this.grid.height(bay, row) !== tier) return fail('ukladá sa len na vrchol stohu');
      if (tier > 0 && this.sizeOfCell(bay, row, tier - 1) !== 20) return fail('pod 20′ smie byť len 20′ alebo zem');
    }
    if (tier >= maxTier) fail('nad maxTier');
  }

  assertCanTake(unit: CargoUnit): void {
    const slot = unit.location.kind === 'in_storage' && unit.location.moduleId === this.id ? unit.location.slot : -1;
    this.assertCell(slot, 'assertCanTake');
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    if (this.grid.top(bay, row) !== unit.id) {
      throw new ModuleError('not_top', `${this.label}: jednotka #${String(unit.id)} nie je navrchu stohu (${String(bay)}, ${String(row)}), nad ňou je ${String(this.grid.height(bay, row) - tier - 1)} kontajnerov`);
    }
  }

  placed(unit: CargoUnit, slot: number): void {
    this.grid.place(unit.id, unit.sizeFt, slot);
  }

  taken(unit: CargoUnit): void {
    if (unit.location.kind === 'in_storage') this.grid.remove(unit.location.slot, unit.sizeFt);
  }

  /** Veľkosť kontajnera v bunke (20 / 40), `0` = voľná. */
  private sizeOfCell(bay: number, row: number, tier: number): 0 | 20 | 40 {
    const id = this.grid.at(bay, row, tier);
    if (id === null) return 0;
    return this.ledger.get(id)?.sizeFt === 40 ? 40 : 20;
  }

  /** Zostaví `StackGrid` z ledgera (nový aj obnovený svet); jednotky mimo geometrie sa preskočia — nájde ich `findStackProblem`. */
  rebuildGrid(): void {
    this.grid.clear();
    const { bays, rows, maxTier } = this.geometry;
    for (const unitId of this.ledger.unitsAt('in_storage', this.id)) {
      const unit = this.ledger.get(unitId);
      if (unit === undefined || unit.location.kind !== 'in_storage') continue;
      const { slot } = unit.location;
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity) continue;
      const { bay, row, tier } = positionOfCell(this.geometry, slot);
      if (unit.sizeFt === 40 && bay + 1 >= bays) continue;
      if (bay >= bays || row >= rows || tier >= maxTier) continue;
      this.grid.place(unit.id, unit.sizeFt, slot);
    }
  }

  // ---- rezervácie ----

  /** Rezervuje bunku `slot` pre jednotku (veľkosť ≙ 1 / 2 bunky); chyby ako `reserveSlot` + `stack_rule` (40′ mimo páru, tieň obsadený). */
  reserveFor(slot: number, unit: Pick<CargoUnit, 'id' | 'sizeFt'>): void {
    this.reserveCells(slot, unit.id, unit.sizeFt);
  }

  /**
   * Rezervuje najnižšiu voľnú bunku pre kontajner neznámej veľkosti (20′) — jednoduchý variant bez plánovača (testy, nástroje); plánovač rezervuje
   * konkrétnu bunku cez `reserveFor`. Bez voľnej bunky `ModuleError('no_free_slot')`.
   */
  override reserve(): number {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.slots.isReserved(slot) || this.reservedSize[slot] !== 0 || this.slots.unitAt(slot) !== null) continue;
      const { bay, row, tier } = positionOfCell(this.geometry, slot);
      if (this.grid.at(bay, row, tier) !== null) continue;
      this.reserveCells(slot, -1, 20);
      return slot;
    }
    throw new ModuleError('no_free_slot', `${this.label}.reserve: žiadna voľná nerezervovaná bunka (kapacita ${String(this.capacity)} TEU)`);
  }

  override reserveSlot(slot: number, unitId?: EntityId): void {
    const sizeFt = unitId === undefined ? 20 : (this.ledger.get(unitId)?.sizeFt ?? 20);
    this.reserveCells(slot, unitId ?? (-1 as EntityId), sizeFt);
  }

  override release(slot: number): void {
    const size = this.reservedSize[slot] === undefined ? 0 : this.reservedSize[slot];
    super.release(slot);
    this.clearReservedCells(slot, size);
  }

  override commit(slot: number, unitId: EntityId): void {
    const size = this.reservedSize[slot];
    super.commit(slot, unitId);
    this.clearReservedCells(slot, size);
  }

  /**
   * Skutočná vrstva pre rezerváciu `slot` pri vykládke: stoh sa mohol zaplniť v inom poradí, než sa rezervovalo (vozidlá prídu v rôznom poradí),
   * preto sa ukladá na vrstvu = výška stohu. Rezervácia sa presunie na túto vrstvu; ak ju držala iná rezervácia (job), vymenia sa.
   * Vráti skutočný slot a slot, ktorý po výmene drží druhá rezervácia (`displaced`, inak `null`).
   */
  settleReservation(slot: number): { readonly slot: number; readonly displaced: number | null } {
    this.assertCell(slot, 'settleReservation');
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    const actualTier = this.grid.height(bay, row);
    if (actualTier === tier) return { slot, displaced: null };
    if (actualTier >= this.geometry.maxTier) {
      throw new ModuleError('stack_rule', `${this.label}: stoh (${String(bay)}, ${String(row)}) je plný, rezerváciu slotu ${String(slot)} nemožno usadiť`);
    }
    const actual = slotOfCell(this.geometry, bay, row, actualTier);
    const size = this.reservedSize[slot];
    const unit = this.reservedUnit[slot];
    const otherSize = this.reservedSize[actual];
    const otherUnit = this.reservedUnit[actual];
    if (otherSize !== 0 && otherSize !== size) {
      throw new ModuleError('stack_rule', `${this.label}: rezervácie slotov ${String(slot)} a ${String(actual)} majú rôzne veľkosti, výmena nie je možná`);
    }
    this.writeReservedCells(slot, 0, 0);
    this.writeReservedCells(actual, size, unit);
    if (otherSize === 0) {
      // Voľná bunka: rezervácia sa presúva (príznaky `SlotReservations` sa preložia), nikto nie je vytlačený.
      this.slots.release(slot);
      this.slots.reserveSlot(actual);
      return { slot: actual, displaced: null };
    }
    this.writeReservedCells(slot, otherSize, otherUnit);
    return { slot: actual, displaced: slot };
  }

  /**
   * Uvoľní bunku `slot` (vrstva = výška stohu) pre kontajner, ktorý tam uloží rehandling: ak ju držala rezervácia jobu, presunie sa na prvú voľnú bunku nad
   * stohom (množina rezervovaných buniek sa tým posunie o vrstvu vyššie). Vráti `{ from, to }` (job rezervácie treba presmerovať) alebo `null`, keď bunka
   * rezervovaná nebola.
   */
  vacateReservation(slot: number): { readonly from: number; readonly to: number } | null {
    this.assertCell(slot, 'vacateReservation');
    const size = this.reservedSize[slot];
    if (size === 0) return null;
    const { bay, row } = positionOfCell(this.geometry, slot);
    const top = this.effectiveHeight(bay, row);
    if (top >= this.geometry.maxTier) throw new ModuleError('stack_rule', `${this.label}: stoh (${String(bay)}, ${String(row)}) je plný, rezerváciu slotu ${String(slot)} nemožno presunúť`);
    const unit = this.reservedUnit[slot];
    const to = slotOfCell(this.geometry, bay, row, top);
    this.writeReservedCells(slot, 0, 0);
    this.slots.release(slot);
    this.writeReservedCells(to, size, unit);
    this.slots.reserveSlot(to);
    return { from: slot, to };
  }

  private reserveCells(slot: number, unitId: number, sizeFt: number): void {
    this.assertCell(slot, 'reserve');
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    const code = codeOfSize(sizeFt);
    if (code === 2) {
      if (bay % 2 !== 0 || bay + 1 >= this.geometry.bays) throw new ModuleError('stack_rule', `${this.label}.reserve: 40′ zaberá pár bays (2k, 2k+1), bunka (${String(bay)}, ${String(row)}, ${String(tier)})`);
      const shadow = slotOfCell(this.geometry, bay + 1, row, tier);
      if (this.reservedSize[shadow] !== 0 || this.grid.at(bay + 1, row, tier) !== null) {
        throw new ModuleError('slot_occupied', `${this.label}.reserve: bunka tieňa 40′ (${String(bay + 1)}, ${String(row)}, ${String(tier)}) je obsadená alebo rezervovaná`);
      }
    }
    this.slots.reserveSlot(slot);
    this.writeReservedCells(slot, code, unitId);
  }

  private clearReservedCells(slot: number, size: number): void {
    if (size !== 0) this.writeReservedCells(slot, 0, 0, size);
  }

  /** Zapíše (alebo zmaže, `code = 0`) rezerváciu bunky `slot` s veľkosťou `code` (pri mazaní `eraseCode` = veľkosť rezervácie) a udrží počítadlá stĺpcov. */
  private writeReservedCells(slot: number, code: number, unitId: number, eraseCode = 0): void {
    const { bay, row, tier } = positionOfCell(this.geometry, slot);
    const size = code === 0 ? (eraseCode === 0 ? this.reservedSize[slot] : eraseCode) : code;
    for (let i = 0; i < size; i++) {
      const cell = slotOfCell(this.geometry, bay + i, row, tier);
      const column = row * this.geometry.bays + bay + i;
      const had = this.reservedSize[cell] !== 0;
      this.reservedSize[cell] = code;
      this.reservedUnit[cell] = code === 0 ? 0 : unitId;
      if (code !== 0 && !had) {
        this.columnReserved[column] += 1;
        this.reservedCells += 1;
      } else if (code === 0 && had) {
        this.columnReserved[column] -= 1;
        this.reservedCells -= 1;
      }
    }
  }

  // ---- invariant kroku 12 ----

  protected override slotProblem(): string | undefined {
    return this.findStackProblem();
  }

  /**
   * Súlad stohov s ledgerom (krok 12): každá jednotka leží v rozsahu bloku, 40′ v párnom bay a v oboch bays, `tier < maxTier`; stohy sú súvislé
   * od zeme, rovnakej veľkosti (40′ v oboch stĺpcoch tou istou jednotkou) a `StackGrid` zodpovedá ledgeru (aj počet TEU); počítadlá rezervácií sedia.
   */
  findStackProblem(): string | undefined {
    const { bays, rows, maxTier } = this.geometry;
    let teu = 0;
    for (const unitId of this.ledger.unitsAt('in_storage', this.id)) {
      const unit = this.ledger.get(unitId);
      if (unit === undefined || unit.location.kind !== 'in_storage') return `${this.label}: jednotka #${String(unitId)} nie je v ledgeri v sklade`;
      const { slot } = unit.location;
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity) return `${this.label}: jednotka #${String(unitId)} leží na slote ${String(slot)} mimo bloku`;
      const { bay, row, tier } = positionOfCell(this.geometry, slot);
      if (bay >= bays || row >= rows || tier >= maxTier) return `${this.label}: jednotka #${String(unitId)} leží mimo geometrie bloku`;
      const wide = unit.sizeFt === 40;
      if (wide && (bay % 2 !== 0 || bay + 1 >= bays)) return `${this.label}: 40′ jednotka #${String(unitId)} neleží na páre bays (2k, 2k+1), bay ${String(bay)}`;
      if (this.grid.at(bay, row, tier) !== unit.id || (wide && this.grid.at(bay + 1, row, tier) !== unit.id)) {
        return `${this.label}: StackGrid nezodpovedá ledgeru pre jednotku #${String(unitId)} na (${String(bay)}, ${String(row)}, ${String(tier)})`;
      }
      if (tier > 0) {
        const below = this.grid.at(bay, row, tier - 1);
        const belowUnit = below === null ? undefined : this.ledger.get(below);
        if (belowUnit === undefined) return `${this.label}: pod jednotkou #${String(unitId)} na (${String(bay)}, ${String(row)}, ${String(tier)}) je prázdna bunka (stoh nie je súvislý)`;
        if (belowUnit.sizeFt !== unit.sizeFt) return `${this.label}: jednotka #${String(unitId)} (${String(unit.sizeFt)}′) leží na ${String(belowUnit.sizeFt)}′ jednotke #${String(below)}`;
        if (wide && this.grid.at(bay + 1, row, tier - 1) !== below) return `${this.label}: 40′ jednotka #${String(unitId)} nesedí na tej istej 40′ v oboch bays`;
      }
      teu += teuOf(unit);
    }
    if (this.grid.occupiedCells !== teu || teu !== this.usedTeu) {
      return `${this.label}: StackGrid má ${String(this.grid.occupiedCells)} buniek, ledger ${String(teu)} TEU`;
    }
    let reserved = 0;
    for (let column = 0; column < bays * rows; column++) {
      let inColumn = 0;
      for (let tier = 0; tier < maxTier; tier++) {
        const cell = column * maxTier + tier;
        if (this.reservedSize[cell] !== 0) inColumn += 1;
        const bay = column % bays;
        const row = (column - bay) / bays;
        if (tier > this.grid.height(bay, row) && this.grid.at(bay, row, tier) !== null) return `${this.label}: stoh (${String(bay)}, ${String(row)}) má medzeru pod vrstvou ${String(tier)}`;
      }
      if (inColumn !== this.columnReserved[column]) return `${this.label}: stĺpec ${String(column)} hlási ${String(this.columnReserved[column])} rezervovaných buniek, je ich ${String(inColumn)}`;
      reserved += inColumn;
    }
    return reserved === this.reservedCells ? undefined : `${this.label}: reservedTeu ${String(this.reservedCells)} ≠ počet rezervovaných buniek ${String(reserved)}`;
  }

  // ---- save ----

  override getRuntimeState(): YardRuntimeState {
    return { ...super.getRuntimeState(), rehandles: this.rehandleCount };
  }

  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, YARD_RUNTIME_KEYS);
    const rehandles = readCount(fields['rehandles'], '/rehandles');
    super.restoreRuntimeState({ unitsIn: fields['unitsIn'], unitsOut: fields['unitsOut'] });
    this.rehandleCount = rehandles;
  }

  private assertCell(slot: number, method: string): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: slot musí byť celé číslo 0…${String(this.capacity - 1)}, dostal ${String(slot)}`);
    }
  }
}

/** Je modul blok skladu so stohmi? */
export function isYardBlock(module: Module | undefined): module is YardBlock {
  return module instanceof YardBlock;
}
