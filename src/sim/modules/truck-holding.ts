/**
 * Odstavná plocha kamiónov (R4, ADR-041 bod 5; GDD 8.4) — parkovisko so státiami 1 × 3 za vstupnou bránou pre kamióny, ktoré prišli pred termínom alebo čakajú na
 * kontajner. V TR4-01 je to len def a modul bez dynamiky (stub): kamióny ju zatiaľ nepoužívajú, správanie (odstavenie, volanie k TP) prináša TR4-02.
 * `runtime` v save je `{}`.
 */
import { holdingParams } from '../defs/module-def';
import type { HoldingParams } from '../defs/types';
import { LandExportModule, type LandsideRole, type LandsideRoster } from './land-export-module';
import type { ModuleInit } from './module';

export class TruckHolding extends LandExportModule {
  /** Typované `params` defu (`holdingParams`). */
  readonly params: HoldingParams;

  /** Def iného druhu než `holding` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = holdingParams(init.def);
  }

  override get landsideRole(): LandsideRole {
    return 'holding';
  }

  override get internalTicks(): number | undefined {
    return undefined;
  }

  override enlist(roster: LandsideRoster): void {
    roster.holdings.push(this);
  }

  /** Počet státí (`params.stalls`). */
  get stalls(): number {
    return this.params.stalls;
  }
}
