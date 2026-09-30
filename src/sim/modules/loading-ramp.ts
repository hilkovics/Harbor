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
 * `runtime` v save je `{}`: rezervácie staging miest patria outbound jobom a obnovia sa z nich (T04-03), obsadenie je
 * v ledgeri a prevádzkovosť sa odvodí z ciest a modulov.
 */
import type { EntityId } from '../core/entity-id';
import { rampParams } from '../defs/module-def';
import type { CargoCategory, RampParams } from '../defs/types';
import type { CargoDropTarget } from './cargo-drop-target';
import { DockStaging } from './dock-staging';
import { LandExportModule } from './land-export-module';
import type { ModuleInit } from './module';

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

  override get internalTicks(): number | undefined {
    return this.params.internalTicks;
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

  /** Staging rezervácie hlási pravidlu `has_cargo` (§8 bod 8). */
  override cargoReservations(): { readonly kind: 'at_ramp'; readonly count: number } {
    return { kind: 'at_ramp', count: this.staging.reservedCount };
  }

  /** Súlad staging rezervácií s ledgerom (krok 12). */
  override findRuntimeProblem(): string | undefined {
    return this.staging.findProblem();
  }
}
