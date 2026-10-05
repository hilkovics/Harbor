/**
 * Priepustnosť kamiónov (T5B-02, ADR-029; spätná väzba 2 „sklady sa zapĺňajú, nechodí dosť kamiónov"): scenár
 * `full_import_chain` (feeder 120 TEU, 3 vozidlá, brána, stojisko so 6 bays, rampa s 2 dockmi) po zmene toku kamiónov —
 * kamión si pri spawne nárokuje náklad docku (pripravený alebo vezený vozidlom), dock si vezme až pri odchode zo
 * stojiska a v stojisku čaká FIFO.
 *
 * Pred ADR-029 držal kamión dock od spawnu, takže na rampu jazdili naraz najviac 2 kamióny a 120 TEU bolo vyvezených
 * v ticku 9 836 (ADR-024, Dôsledky). Teraz je v okruhu toľko kamiónov, koľko dovolia bays a náklad dockov, a úzkym
 * miestom je brána: každý kamión ňou prejde dvakrát (spoločná FIFO fronta, `processTicks` na prechod), teda export
 * nemôže byť rýchlejší ako `2 × processTicks` na kamión — a pri dostatku kamiónov k tejto hranici aj dosiahne.
 *
 * Po každom ticku beží `assertCargoConservation` a krok 12 (invarianty kamiónov vrátane nárokov na náklad).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { gateParams, rampParams, waitingAreaParams } from '@sim/defs';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from '../world/world-fixtures';

const UNITS = 120;
const MAX_TICKS = 40_000;
/** `ticksToAllExported` scenára pred ADR-029 (ADR-024, Dôsledky; `simrun full_import_chain`). */
const TICKS_BEFORE_ADR_029 = 9_836;
/** Nová hranica: aspoň o 15 % skôr (namerané 8 150). */
const MAX_TICKS_TO_ALL_EXPORTED = Math.floor(TICKS_BEFORE_ADR_029 * 0.85);
/** Rezerva nad hranicou brány: prvý kamión musí prísť z portálu a posledný odísť (≈ 2 × 50 tickov jazdy + pobyt). */
const GATE_BOUND_SLACK_TICKS = 300;
const SAMPLE_TICKS = 500;

const PROCESS_TICKS = gateParams(DEFS.modules.get('truck_gate')).processTicks;
const BAYS = waitingAreaParams(DEFS.modules.get('truck_waiting_area')).bays;
const DOCKS = rampParams(DEFS.modules.get('loading_ramp_container')).docks;
const TRUCK_CAPACITY = DEFS.trucks.get('truck_container').capacityUnits;

interface Sample {
  readonly tick: number;
  readonly stored: number;
  readonly exported: number;
}

describe('priepustnosť kamiónov: full_import_chain (ADR-029)', () => {
  let world: World;
  let allStoredAt = -1;
  let allExportedAt = -1;
  let maxTrucks = 0;
  let maxBayHolders = 0;
  let maxDockHolders = 0;
  const samples: Sample[] = [];

  beforeAll(() => {
    const scenario = loadScenarioFile('full_import_chain');
    world = World.create(DEFS, MAP, scenario.seed);
    runScenario(world, scenario, MAX_TICKS, {
      afterTick: (w) => {
        assertCargoConservation(w);
        const { cargo } = w;
        const inTransit = cargo.countByKind('on_ship') + cargo.countByKind('on_apron') + cargo.countByKind('in_crane') + cargo.countByKind('in_vehicle');
        if (allStoredAt < 0 && cargo.createdCount > 0 && inTransit === 0) allStoredAt = w.clock.tick;
        if (allExportedAt < 0 && cargo.createdCount > 0 && cargo.exportedCount === cargo.createdCount) allExportedAt = w.clock.tick;
        const trucks = [...w.trucks.values()];
        maxTrucks = Math.max(maxTrucks, trucks.length);
        maxBayHolders = Math.max(maxBayHolders, trucks.filter((truck) => truck.bay !== null).length);
        maxDockHolders = Math.max(maxDockHolders, trucks.filter((truck) => truck.bonds.holdsDock).length);
        if (w.clock.tick % SAMPLE_TICKS === 0) samples.push({ tick: w.clock.tick, stored: cargo.countByKind('in_storage'), exported: cargo.exportedCount });
      },
    });
  }, 300_000);

  it(`vyvezie všetkých ${String(UNITS)} TEU bez straty, najneskôr v ticku ${String(MAX_TICKS_TO_ALL_EXPORTED)} (pred ADR-029 ${String(TICKS_BEFORE_ADR_029)})`, () => {
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(world.cargo.createdCount - (world.cargo.liveCount + world.cargo.exportedCount)).toBe(0);
    expect(allExportedAt).toBeGreaterThan(0);
    expect(allExportedAt).toBeLessThanOrEqual(MAX_TICKS_TO_ALL_EXPORTED);
  });

  it('na jednu rampu jazdí viac kamiónov ako dockov; bays ani docky sa neprekročia', () => {
    expect(maxTrucks).toBeGreaterThan(DOCKS);
    expect(maxBayHolders).toBeLessThanOrEqual(BAYS);
    expect(maxDockHolders).toBeLessThanOrEqual(DOCKS);
  });

  it('po uskladnení je úzkym miestom brána: export trvá 2 × processTicks na kamión (+ príjazd prvého a odjazd posledného)', () => {
    const trucks = UNITS / TRUCK_CAPACITY;
    const gateBound = trucks * 2 * PROCESS_TICKS;
    const exportPhase = allExportedAt - allStoredAt;
    expect(allStoredAt).toBeGreaterThan(0);
    expect(exportPhase).toBeGreaterThanOrEqual(gateBound - GATE_BOUND_SLACK_TICKS);
    expect(exportPhase).toBeLessThanOrEqual(gateBound + GATE_BOUND_SLACK_TICKS);
  });

  it('sklad sa po uskladnení vyprázdňuje priebežne: zásoba v každej vzorke klesne, export v každom okne rastie', () => {
    const phase = samples.filter((sample) => sample.tick > allStoredAt && sample.tick <= allExportedAt);
    expect(phase.length).toBeGreaterThan(4);
    for (let i = 1; i < phase.length; i++) {
      expect(phase[i].stored, `tick ${String(phase[i].tick)}`).toBeLessThan(phase[i - 1].stored);
      // Hranica brány: SAMPLE_TICKS / (2 × processTicks) kamiónov za okno; pred ADR-029 ~10 TEU za 500 tickov. Od R1 (ADR-037) kamióny
      // jazdia po slotoch a okno sa môže o jeden kamión rozkolísať navyše — celkovú hranicu brány drží test vyššie.
      expect(phase[i].exported - phase[i - 1].exported, `tick ${String(phase[i].tick)}`).toBeGreaterThanOrEqual(Math.floor(SAMPLE_TICKS / (2 * PROCESS_TICKS)) - 2);
    }
  });
});
