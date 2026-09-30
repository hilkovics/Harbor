/**
 * Pozemný (landside) modul exportného reťazca (ARCHITECTURE §1, §5, §7.5; ADR-022) — abstraktná báza brány kamiónov
 * (`TruckGate`), stojiska (`WaitingArea`) a nakladacej rampy (`LoadingRamp`); neskôr aj železničnej stanice (F10).
 * Triedu vyberá `ModuleRegistry` podľa `def.kind` (`gate`, `waiting_area`, `ramp`; pravidlo 7, §17).
 *
 * Spoločné: vnútorný čas prechodu modulom `internalTicks` z `params` (ADR-004, ADR-011) — pri bráne a stojisku je to
 * abstrahovaný prechod telom modulu (kamión sa po ňom objaví na druhej strane, rozhodnutie orchestrátora F4 č. 2),
 * pri rampe pobyt vozidla alebo kamióna v docku. Chýbajúci `internalTicks` = `logistics.defaultInternalTicks`, ktorý
 * dosadí systém (modul defy logistiky nepozná).
 *
 * Priechody a prevádzkovosť rampy (vstupná a výstupná strana brány, cesta portál → brána → stojisko → rampa) počíta
 * svet (`LandsideNetwork`, `world/landside.ts`), lebo závisia od ciest a ostatných modulov; moduly nesú len výsledok,
 * ktorý im svet zverejní (`TruckGate.entrySide`, `LoadingRamp.operational`).
 */
import { Module } from './module';

export abstract class LandExportModule extends Module {
  /** `params.internalTicks` modulu; `undefined` = platí `logistics.defaultInternalTicks`. */
  abstract get internalTicks(): number | undefined;

  /** Pobyt vozidla v module (§7.3 bod 4) = `internalTicks` (rampu obsluhujú aj interné vozidlá, T04-03). */
  override vehicleInternalTicks(): number | undefined {
    return this.internalTicks;
  }
}
