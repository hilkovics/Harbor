/**
 * Nakladacia rampa (ARCHITECTURE §5.3 `loading_ramp_container`, §7.1 `at_ramp`, §7.5; rozhodnutia orchestrátora F4
 * č. 1 a 4; ADR-022) — posledný modul na mape pred exportom: interné vozidlá sem vozia jednotky zo skladov
 * (`in_vehicle → at_ramp`, T04-03) a kamióny ich nakladajú (`at_ramp → in_truck`, T04-04).
 *
 * - **Docky a staging:** `params.docks` dockov, na každom `params.stagingPerDock` miest (`DockStaging`: obsadenie
 *   v ledgeri, modul drží len rezervácie outbound jobov). Kategóriu nákladu určuje `params.category`.
 * - **Prevádzkovosť** (rozhodnutie 1, ADR-022): rampa je prevádzková, keď vedie cesta road portál → vstupná strana
 *   brány a výstupná strana brány → stojisko (priechod) → konektor rampy. Počíta ju svet (`LandsideNetwork`) pri zmene
 *   ciest alebo množiny modulov a po každom príkaze zverejní sem (`publishStatus`) — `operational` a
 *   `inoperativeReason` sú teda zverejnený stav (pre UI a render); systémy sa pýtajú `World.isRampOperational`, ktorý
 *   je vždy aktuálny. Neprevádzková rampa nedostane outbound joby ani kamióny.
 *
 * - **Outbound joby** (T04-03, ADR-023): dispatcher pri vzniku jobu rezervuje miesto `reserve(firstFreeDock())`, job
 *   drží rezerváciu celý život a vozidlo pri vykládke `assertCommittable → CargoLedger.move → commit` (cez
 *   `cargoDropTarget()`); zrušený `open` job (rampa stratila prevádzkovosť) `release(dock)`.
 *
 * - **Docky pre kamióny** (T04-04, ADR-024): na každý dock mieri najviac jeden kamión — od spawnu po koniec nakládky
 *   ho drží (`assignDock` / `releaseDock`, `dockTruck`). Držiteľ docku sa neukladá: obnoví sa z kamiónov (`rampId`,
 *   `dock`, stav) ako bays stojiska.
 * - **`NoWaitingBay`** (T04-04): hodina posledného hlásenia rampy `lastNoWaitingBayHour` (najviac 1× za hodinu, vzor
 *   `BerthModule.lastNoStorageHour`, ADR-018) — ide do save, aby obnovený svet nehlásil v tej istej hodine znova.
 *
 * `runtime` v save je `{ lastNoWaitingBayHour }`: rezervácie staging miest patria outbound jobom a obnovia sa z nich
 * (T04-03), držitelia dockov z kamiónov, obsadenie je v ledgeri a prevádzkovosť sa odvodí z ciest a modulov.
 */
import type { EntityId } from '../core/entity-id';
import { rampParams } from '../defs/module-def';
import type { CargoCategory, RampParams } from '../defs/types';
import type { CargoDropTarget } from './cargo-drop-target';
import { DockStaging } from './dock-staging';
import { LandExportModule, type LandsideRole, type LandsideRoster } from './land-export-module';
import type { ModuleInit } from './module';
import { ModuleError } from './module-error';
import { checkRuntimeKeys, readOptionalCount } from './runtime-state';

/**
 * Dôvody neprevádzkovosti rampy v poradí vyhodnotenia (ADR-022): `not_connected` — konektor rampy nemá cestu alebo
 * k rampe nevedie cesta zo žiadneho stojiska za bránou; `no_gate` — nie je platná brána (vstup z portálu + výstup
 * s cestou); `no_waiting_area` — za žiadnou platnou bránou nie je dosiahnuteľné stojisko.
 */
export const RAMP_INOPERATIVE_REASONS = ['not_connected', 'no_gate', 'no_waiting_area'] as const;

export type RampInoperativeReason = (typeof RAMP_INOPERATIVE_REASONS)[number];

/** Prevádzkový stav rampy: `operational` ⇔ `reason === null`. */
export interface RampStatus {
  readonly operational: boolean;
  readonly reason: RampInoperativeReason | null;
}

/** Prevádzková rampa. */
export const RAMP_OPERATIONAL: RampStatus = Object.freeze({ operational: true, reason: null });

/** Dynamický stav rampy v save (`WorldState.modules[i].runtime`, v4, ADR-024). */
export type RampRuntimeState = {
  /** Herná hodina posledného `NoWaitingBay` tejto rampy; `null` = ešte nebol. */
  readonly lastNoWaitingBayHour: number | null;
};

const RUNTIME_KEYS: readonly (keyof RampRuntimeState)[] = ['lastNoWaitingBayHour'];

/** Stav rampy, ktorej svet prevádzkovosť ešte nezverejnil (napr. mimo sveta): neprevádzková, nepripojená. */
const RAMP_UNPUBLISHED: RampStatus = Object.freeze({ operational: false, reason: 'not_connected' });

export class LoadingRamp extends LandExportModule {
  /** Typované `params` defu (`rampParams`). */
  readonly params: RampParams;
  private readonly staging: DockStaging;
  /** Cieľ doručenia outbound jobu (`at_ramp`, dock = miesto) — jeden objekt na rampu, vracia ho `cargoDropTarget()`. */
  private readonly drop: CargoDropTarget;
  private status: RampStatus = RAMP_UNPUBLISHED;
  private published = false;
  /** Dock → kamión, ktorý naň mieri alebo na ňom nakladá; `null` = voľný. */
  private readonly dockTrucks: (EntityId | null)[];
  private assigned = 0;
  /** Herná hodina posledného `NoWaitingBay` (throttle 1×/h); mení ju `landsideSystem`. */
  lastNoWaitingBayHour: number | null = null;

  /** Def iného druhu než `ramp` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = rampParams(init.def);
    this.staging = new DockStaging({
      rampId: this.id,
      docks: this.params.docks,
      perDock: this.params.stagingPerDock,
      cargo: init.cargo,
      label: `rampa ${this.label}`,
    });
    this.dockTrucks = new Array<EntityId | null>(this.params.docks).fill(null);
    const { staging } = this;
    this.drop = Object.freeze({
      kind: 'at_ramp',
      category: this.params.category,
      places: this.params.docks,
      reservationsAt: (dock: number): number => (Number.isInteger(dock) && dock >= 0 && dock < staging.docks ? staging.reservedAt(dock) : 0),
      restoreReservation: (dock: number): void => {
        staging.reserve(dock);
      },
      release: (dock: number): void => {
        staging.release(dock);
      },
      assertCommittable: (dock: number, unitId: EntityId): void => {
        staging.assertCommittable(dock, unitId);
      },
      commit: (dock: number, unitId: EntityId): void => {
        staging.commit(dock, unitId);
      },
    });
  }

  override get landsideRole(): LandsideRole {
    return 'ramp';
  }

  override get internalTicks(): number | undefined {
    return this.params.internalTicks;
  }

  override enlist(roster: LandsideRoster): void {
    roster.ramps.push(this);
  }

  /** Počet dockov (`params.docks`). */
  get docks(): number {
    return this.params.docks;
  }

  /** Staging miest na dock (`params.stagingPerDock`). */
  get stagingPerDock(): number {
    return this.params.stagingPerDock;
  }

  /** Staging miest spolu (`docks × stagingPerDock`). */
  get capacity(): number {
    return this.staging.capacity;
  }

  /** Kategória nákladu, ktorú rampa nakladá. */
  get category(): CargoCategory {
    return this.params.category;
  }

  /** Zverejnená prevádzkovosť (viď hlavička); aktuálny stav dáva `World.isRampOperational`. */
  get operational(): boolean {
    return this.status.operational;
  }

  /** Zverejnený dôvod neprevádzkovosti; `null` pri prevádzkovej rampe. */
  get inoperativeReason(): RampInoperativeReason | null {
    return this.status.reason;
  }

  /** Zverejnený stav ako objekt (zmrazený). */
  get operationalStatus(): RampStatus {
    return this.status;
  }

  /**
   * Zverejní stav (volá len `World`, ADR-022) a vráti, či sa zmenil — prvé zverejnenie je vždy zmena (svet podľa toho
   * emituje `RampOperationalChanged`).
   */
  publishStatus(status: RampStatus): boolean {
    const changed = !this.published || status.operational !== this.status.operational || status.reason !== this.status.reason;
    this.published = true;
    this.status = status;
    return changed;
  }

  /** Jednotky na všetkých dockoch (ledger). */
  get stagedCount(): number {
    return this.staging.stagedCount;
  }

  /** Rezervované staging miesta na všetkých dockoch. */
  get reservedCount(): number {
    return this.staging.reservedCount;
  }

  /** Voľné staging miesta spolu. */
  get freeCount(): number {
    return this.staging.freeCount;
  }

  /** Jednotky na docku (ledger). Dock mimo rozsahu → `ModuleError('invalid_slot')`. */
  stagedAt(dock: number): number {
    return this.staging.stagedAt(dock);
  }

  /** Rezervácie na docku. */
  reservedAt(dock: number): number {
    return this.staging.reservedAt(dock);
  }

  /** Voľné miesta na docku. */
  freeAt(dock: number): number {
    return this.staging.freeAt(dock);
  }

  /** Najnižší dock s voľným miestom, alebo −1. */
  firstFreeDock(): number {
    return this.staging.firstFreeDock();
  }

  /** Najstaršia jednotka na docku (FIFO) bez alokácie. */
  firstUnitAt(dock: number): EntityId | undefined {
    return this.staging.firstUnitAt(dock);
  }

  /** Jednotky na docku v poradí príchodu (kópia). */
  unitsAt(dock: number): readonly EntityId[] {
    return this.staging.unitsAt(dock);
  }

  /** Rezervuje staging miesto na docku (outbound job, T04-03); chyby ako `DockStaging.reserve`. */
  reserve(dock: number): void {
    this.staging.reserve(dock);
  }

  /** Zruší rezerváciu na docku (zrušený job). */
  release(dock: number): void {
    this.staging.release(dock);
  }

  /** Kontrola pred `CargoLedger.move(unit, at_ramp(id, dock))`. */
  assertCommittable(dock: number, unitId: EntityId): void {
    this.staging.assertCommittable(dock, unitId);
  }

  /** Po presune na dock: rezervácia zaniká; chyby ako `DockStaging.commit`. */
  commit(dock: number, unitId: EntityId): void {
    this.staging.commit(dock, unitId);
  }

  /**
   * Cieľ outbound jobu: dock rampy (`at_ramp`, ADR-023). Obnova rezervácie zo save = `reserve(dock)` — zlyhá
   * (`no_free_slot`), ak by dock prekročil `stagingPerDock`.
   */
  override cargoDropTarget(): CargoDropTarget {
    return this.drop;
  }

  /** Kamión, ktorý dock drží (mieri naň alebo na ňom nakladá); `null` = voľný. Dock mimo rozsahu → `invalid_slot`. */
  dockTruck(dock: number): EntityId | null {
    this.assertDock(dock, 'dockTruck');
    return this.dockTrucks[dock];
  }

  /** Počet dockov, ktoré drží kamión. */
  get assignedDocks(): number {
    return this.assigned;
  }

  /**
   * Kamión si drží dock (spawn alebo obnova, T04-04). Chyby (`ModuleError`, nič sa nezmení): dock mimo rozsahu →
   * `invalid_slot`, id nie je celé ≥ 1 → `invalid_input`, dock drží iný kamión → `slot_reserved`, kamión už drží iný
   * dock tejto rampy → `duplicate_id`.
   */
  assignDock(dock: number, truckId: EntityId): void {
    this.assertDock(dock, 'assignDock');
    if (!Number.isSafeInteger(truckId) || truckId < 1) {
      throw new ModuleError('invalid_input', `${this.label}.assignDock: id kamióna musí byť celé číslo ≥ 1, dostal ${String(truckId)}`);
    }
    const holder = this.dockTrucks[dock];
    if (holder !== null) throw new ModuleError('slot_reserved', `${this.label}.assignDock: dock ${String(dock)} drží kamión #${String(holder)}`);
    const other = this.dockTrucks.indexOf(truckId);
    if (other >= 0) throw new ModuleError('duplicate_id', `${this.label}.assignDock: kamión #${String(truckId)} už drží dock ${String(other)}`);
    this.dockTrucks[dock] = truckId;
    this.assigned += 1;
  }

  /** Kamión dock uvoľní (koniec nakládky). Chyby: mimo rozsahu → `invalid_slot`, dock nedrží tento kamión → `slot_not_reserved`. */
  releaseDock(dock: number, truckId: EntityId): void {
    this.assertDock(dock, 'releaseDock');
    if (this.dockTrucks[dock] !== truckId) {
      throw new ModuleError('slot_not_reserved', `${this.label}.releaseDock: dock ${String(dock)} nedrží kamión #${String(truckId)} (drží ${String(this.dockTrucks[dock])})`);
    }
    this.dockTrucks[dock] = null;
    this.assigned -= 1;
  }

  /** Staging rezervácie hlási pravidlu `has_cargo` (§8 bod 8). */
  override cargoReservations(): { readonly kind: 'at_ramp'; readonly count: number } {
    return { kind: 'at_ramp', count: this.staging.reservedCount };
  }

  /**
   * Súlad staging rezervácií s ledgerom a počítadlo držiteľov dockov (krok 12, O(docky), bez alokácie). Že kamión drží
   * najviac jeden dock a dock drží existujúci kamión, overí svet (`checkTrucks`: držiteľ docku každého kamióna + súčet
   * držaných dockov = počet kamiónov s `holdsDock`, review T04-11) — `assignDock` duplicitu nepustí.
   */
  override findRuntimeProblem(): string | undefined {
    const staging = this.staging.findProblem();
    if (staging !== undefined) return staging;
    let assigned = 0;
    for (let dock = 0; dock < this.dockTrucks.length; dock++) {
      if (this.dockTrucks[dock] !== null) assigned += 1;
    }
    return assigned === this.assigned ? undefined : `${this.label}: počítadlo držaných dockov ${String(this.assigned)} ≠ ${String(assigned)}`;
  }

  override getRuntimeState(): RampRuntimeState {
    return { lastNoWaitingBayHour: this.lastNoWaitingBayHour };
  }

  /** Kontroly: presne kľúče `RampRuntimeState`, hodina `null` alebo celé ≥ 0 (`ModuleStateError`, obnova je atomická). */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    this.lastNoWaitingBayHour = readOptionalCount(fields['lastNoWaitingBayHour'], '/lastNoWaitingBayHour');
  }

  private assertDock(dock: number, method: string): void {
    if (!Number.isInteger(dock) || dock < 0 || dock >= this.params.docks) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: dock musí byť celé číslo 0…${String(this.params.docks - 1)}, dostal ${String(dock)}`);
    }
  }
}
