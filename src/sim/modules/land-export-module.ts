/**
 * Pozemný (landside) modul exportného reťazca (ARCHITECTURE §1, §5, §7.5; ADR-022) — abstraktná báza brány kamiónov
 * (`TruckGate`), stojiska (`WaitingArea`) a nakladacej rampy (`LoadingRamp`); neskôr aj železničnej stanice (F10).
 * Triedu vyberá `ModuleRegistry` podľa `def.kind` (`gate`, `waiting_area`, `ramp`; pravidlo 7, §17).
 *
 * Spoločné: `internalTicks` z `params` (ADR-004, ADR-011). Význam určuje trieda: pri bráne je to časť trvania prechodu
 * telom (`passTicks = processTicks + internalTicks`, chýbajúci = 0 — priepustnosť určuje `processTicks`, ADR-024), pri
 * stojisku pobyt kamióna v bayi (chýbajúci = `logistics.defaultInternalTicks`, dosadí systém) a pri rampe pobyt
 * **interného vozidla** v docku (§7.3 bod 4; kamión nakladá `loadTicksPerUnit` na jednotku a `internalTicks` rampy
 * nepoužíva, ADR-024).
 *
 * **Register podľa roly** (review T04-11, pravidlo 7): generický kód sveta a systémov sa nepýta `instanceof` na konkrétne
 * triedy — modul sa sám zaradí do registra `LandsideRoster` (`enlist`, double dispatch). Nová trieda (napr. stanica F10)
 * pridá vlastné pole registra a svoju `enlist`; zoznamy brán, stojísk a rámp vedie svet (`World.landsideModules`).
 *
 * Priechody a prevádzkovosť rampy (vstupná a výstupná strana brány, cesta portál → brána → stojisko → rampa a späť) počíta
 * svet (`LandsideNetwork`, `world/landside.ts`), lebo závisia od ciest a ostatných modulov; moduly nesú len výsledok,
 * ktorý im svet zverejní (`TruckGate.entrySide`, `LoadingRamp.operational`).
 */
import { Module } from './module';
import type { LoadingRamp } from './loading-ramp';
import type { PreGateBuffer } from './pre-gate-buffer';
import type { TruckHolding } from './truck-holding';
import type { TruckGate } from './truck-gate';
import type { WaitingArea } from './waiting-area';

/** Rola pozemného modulu v reťazci kamiónov. */
export type LandsideRole = 'gate' | 'pre_gate' | 'holding' | 'waiting_area' | 'ramp';

/** Register pozemných modulov podľa roly (poradie = poradie `enlist`, svet ho volá vzostupne podľa id). */
export interface LandsideRoster {
  readonly gates: TruckGate[];
  readonly preGates: PreGateBuffer[];
  readonly holdings: TruckHolding[];
  readonly waitingAreas: WaitingArea[];
  readonly ramps: LoadingRamp[];
}

export abstract class LandExportModule extends Module {
  /** Rola modulu v reťazci (diagnostika, prezentácia); zaradenie do registra robí `enlist`. */
  abstract get landsideRole(): LandsideRole;

  /** `params.internalTicks` modulu; `undefined` = trieda dosadí svoj predvolený význam (viď hlavička). */
  abstract get internalTicks(): number | undefined;

  /** Zaradí modul do poľa registra podľa svojej roly (double dispatch namiesto `instanceof` v generickom kóde). */
  abstract enlist(roster: LandsideRoster): void;

  /** Pobyt vozidla v module (§7.3 bod 4) = `internalTicks` (rampu obsluhujú aj interné vozidlá, T04-03). */
  override vehicleInternalTicks(): number | undefined {
    return this.internalTicks;
  }
}
