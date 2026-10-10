/**
 * RTG blok (R3, ADR-040 bod 2; docs/TERMINAL_2.md §4.1) — sklad kontajnerov so stohmi `bays × rows × maxTier` (6 radov × 5 vrstiev), ktorý obsluhuje stroj
 * `RtgCrane` (`machines/rtg-crane.ts`), nie vozidlo: ťahač kontajner len privezie na odovzdávacie miesto (TP) a stroj ho zdvihne, alebo naň položí.
 *
 * **Pruh** je jednosmerný, beží pozdĺž bloku (lokálne `y`, pri rotácii 0) v stĺpci `params.laneCol`: bay `b` leží na bunke pruhu `b`, vjazd je na začiatku (bay 0)
 * a výjazd na konci (bay `bays − 1`). Konektory defu sú vjazd a výjazd; vozidlo sa k bloku dostane cez vonkajšiu bunku konektora (`ADR-040`: pohyb vnútri
 * pruhu je simulačný údaj len pre polohu TP a stroja, jazda po bunkách pruhu príde s kotviskom 8×4 v TR3-02). **TP** majú bays s rozstupom `params.tpSpacingBays`.
 *
 * Správanie skladu (sloty, rezervácie, rehandling, save) je celé v `YardBlock`; trieda dodáva len geometriu pruhu a TP.
 */
import { ModuleError } from './module-error';
import type { ModuleInit } from './module';
import { YardBlock, type HandlingSystem } from './yard-block';

/** Kategória nákladu, ktorú RTG blok skladuje. */
export const RTG_BLOCK_CATEGORY = 'container';

/** Smer jednosmerného pruhu: pozdĺž bloku od vjazdu (bay 0) k výjazdu (posledný bay). */
export const RTG_LANE_DIRECTION = 'forward';

export class RtgBlock extends YardBlock {
  /** Stĺpec pruhu vo footprinte pri rotácii 0 (`params.laneCol`). */
  readonly laneCol: number;
  /** Rozstup TP v bays (`params.tpSpacingBays`). */
  readonly tpSpacingBays: number;

  /** Def musí byť sklad kontajnerov s `params.role = 'rtg_block'`, geometriou bloku, `laneCol` a `tpSpacingBays` (inak `ModuleError('invalid_input')`). */
  constructor(init: ModuleInit) {
    super(init, RTG_BLOCK_CATEGORY);
    const { role, laneCol, tpSpacingBays, bays, rows, maxTier } = this.params;
    // `rail_terminal` je RTG blok s koľajami (`RailTerminal`, R6): pruh s TP a stroj bloku (RMG) má rovnaký.
    if ((role !== 'rtg_block' && role !== 'rail_terminal') || laneCol === undefined || tpSpacingBays === undefined || bays === undefined || rows === undefined || maxTier === undefined) {
      throw new ModuleError('invalid_input', `${this.label}: RTG blok vyžaduje params.role 'rtg_block', geometriu bloku, laneCol a tpSpacingBays`);
    }
    this.laneCol = laneCol;
    this.tpSpacingBays = tpSpacingBays;
  }

  /** OOG plocha (`params.acceptsOog`, R5, ADR-042 TR5-02): prijíma len OOG a obsluhuje ho reach stacker. */
  override get acceptsOog(): boolean {
    return this.params.acceptsOog === true;
  }

  override get handlingSystem(): HandlingSystem {
    return 'rtg';
  }

  /** Bay odovzdávacieho miesta najbližšieho k bayu `bay` (TP majú bays s rozstupom `tpSpacingBays`, posledný bay pruhu je vždy TP výjazdu). */
  tpBayNear(bay: number): number {
    const last = this.geometry.bays - 1;
    return Math.min(last, Math.round(bay / this.tpSpacingBays) * this.tpSpacingBays);
  }

  /** TP, pri ktorom stojí vozidlo, ktoré prišlo na vonkajšiu bunku konektora s indexom `connectorIndex` v poradí defu (vjazd 0, výjazd 1): bay podľa lokálneho `y` konektora. */
  tpBayOfConnector(connectorIndex: number): number {
    const connector = this.def.connectors[connectorIndex];
    if (connector === undefined) throw new ModuleError('invalid_input', `${this.label}: konektor ${String(connectorIndex)} neexistuje`);
    return this.tpBayNear(connector.y);
  }
}
