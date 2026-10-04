// Režim `apron` je po T6D-02 (vozidlo pod hákom, nábrežie v A*, dispatcher vopred) bitovo zhodný s F2–F6c: `stateHash` a metriky troch
// scenárov v pripnutom režime `apron` (`DEFS` z `tests/sim/world/world-fixtures`) sa zhodujú s hodnotami z commitu pred T6D-02 (b1c7faf).
// Metrika `directHandoverPct` je v režime `apron` 0 (každá jednotka ide cez apron).
import { describe, expect, it } from 'vitest';
import { loadScenario, runScenario } from '../../tools/simrun';
import { DEFS } from '../sim/world/world-fixtures';

const HEAVY_TIMEOUT_MS = 180_000;

describe('režim apron: bitovo zhodný s F2–F6c', () => {
  it.each([
    { name: 'vertical_slice', ticks: 30_000, stateHash: '161cef25', cashEnd: 41_790_000, exportedUnits: 78 },
    { name: 'full_import_chain', ticks: 40_000, stateHash: '001b8fb0', cashEnd: 31_964_000, exportedUnits: 120 },
    { name: 'export_roundtrip', ticks: 40_000, stateHash: '1c477527', cashEnd: 41_887_900, exportedUnits: 58 },
  ])('$name ($ticks tickov): stateHash $stateHash, apron → directHandoverPct 0', ({ name, ticks, stateHash, cashEnd, exportedUnits }) => {
    const report = runScenario(loadScenario(`data/scenarios/${name}.json`), ticks, DEFS, { hash: true });
    expect(report).toMatchObject({ stateHash, cashEnd, exportedUnits, lostUnits: 0, directHandoverPct: 0 });
  }, HEAVY_TIMEOUT_MS);
});
