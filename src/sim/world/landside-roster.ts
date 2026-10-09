/**
 * Register pozemných modulov sveta (review T04-11, pravidlo 7; ARCHITECTURE §7.5, §17 bod 5): brány, predbránové a odstavné plochy
 * vzostupne podľa id, ako ich vráti `LandExportModule.enlist` (double dispatch — generický kód sa nepýta `instanceof`
 * na konkrétne triedy). Obnoví sa lenivo pri zmene `moduleVersion`; nie je stav simulácie a do save nepatrí.
 *
 * Čítajú ho: `LandsideSystem` (krok 8), `LandsideNetwork` (strany brán, trasy), zverejnenie reťazca vo `World`,
 * TOS kamiónov (TP, odstavná plocha), invarianty kroku 12 a obnova save.
 */
import type { EntityId } from '../core/entity-id';
import { LandExportModule, type LandsideRoster } from '../modules/land-export-module';
import type { Module } from '../modules/module';
import type { PreGateBuffer } from '../modules/pre-gate-buffer';
import type { TruckHolding } from '../modules/truck-holding';
import type { TruckGate } from '../modules/truck-gate';

/** Pohľad na register (len na čítanie). */
export interface LandsideModules {
  /** Brány vzostupne podľa id. */
  readonly gates: readonly TruckGate[];
  /** Predbránové plochy vzostupne podľa id (R4). */
  readonly preGates: readonly PreGateBuffer[];
  /** Odstavné plochy vzostupne podľa id (R4). */
  readonly holdings: readonly TruckHolding[];
}

/** Register s lenivou obnovou podľa verzie množiny modulov (vlastní ho `World`). */
export class LandsideRosterCache implements LandsideModules {
  private readonly roster: LandsideRoster = { gates: [], preGates: [], holdings: [] };
  private version = Number.NaN;

  get gates(): readonly TruckGate[] {
    return this.roster.gates;
  }

  get preGates(): readonly PreGateBuffer[] {
    return this.roster.preGates;
  }

  get holdings(): readonly TruckHolding[] {
    return this.roster.holdings;
  }

  /**
   * Register pre moduly `modules` (vzostupne podľa id) pri verzii `moduleVersion`; pri nezmenenej verzii bez práce.
   * Polia sa pri obnove vyprázdnia a naplnia znova (znovupoužiteľné, nie nové).
   */
  refresh(modules: ReadonlyMap<EntityId, Module>, moduleVersion: number): LandsideModules {
    if (moduleVersion === this.version) return this;
    this.version = moduleVersion;
    const { roster } = this;
    roster.gates.length = 0;
    roster.preGates.length = 0;
    roster.holdings.length = 0;
    for (const module of modules.values()) {
      // Jediná kontrola triedy: abstraktná báza rozšírenia, nie výber konkrétneho druhu (ten robí `enlist`).
      if (module instanceof LandExportModule) module.enlist(roster);
    }
    return this;
  }
}
