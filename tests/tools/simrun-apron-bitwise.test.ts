// Režim `apron` je po T6D-02 (vozidlo pod hákom, nábrežie v A*, dispatcher vopred) v správaní zhodný s F2–F6c: metriky (`cashEnd`, `exportedUnits`)
// troch scenárov v pripnutom režime `apron` (`DEFS` z `tests/sim/world/world-fixtures`) sa zhodujú s hodnotami z commitu pred T6D-02 (b1c7faf).
// Metrika `directHandoverPct` je v režime `apron` 0 (každá jednotka ide cez apron).
// `stateHash` je odtlačok `WorldState` v10 (clean break savov, ADR-036: `version` 10, tvar ako v9), preto sa líši od hashov v9
// (vertical_slice c76d41c5, full_import_chain bdbe7fb8, export_roundtrip 79ba9543); metriky sa nezmenili. Od v8 z b1c7faf (vertical_slice 161cef25,
// full_import_chain 001b8fb0, export_roundtrip 1c477527) sa líšia aj tvarom (`hinterland`, T6D-01). export_roundtrip sa od T6D-01 líši aj obsahom:
// posledný kamión po otvorení cesty čaká vo vnútrozemí na zaručené miesto na docku (ADR-035), takže prejde bránou neskôr (metriky ostali rovnaké).
// R1 (TR1-03, ADR-037): stojace nosiče držia sloty a `idle` vozidlá blokujú cesty (uviaznutie do TR1-04 / TR1-08) → hodnoty nižšie než pred R1 (78 / 120 / 58 exportovaných).
// R1 (TR1-02, ADR-037): nosiče nesú `body`, `ahead`, `blockedTicks`, `rerouteCooldown` a jazdia po pruhových slotoch → nové hashe
// (vertical_slice 5990df8f → e76d294b, full_import_chain 4774ec6e → 788ef948, export_roundtrip 8c436f3d → 90d9926e); `cashEnd` a `exportedUnits` ostali.
import { describe, expect, it } from 'vitest';
import { loadScenario, runScenario } from '../../tools/simrun';
import { DEFS } from '../sim/world/world-fixtures';

const HEAVY_TIMEOUT_MS = 180_000;

describe('režim apron: bitovo zhodný s F2–F6c', () => {
  it.each([
    { name: 'vertical_slice', ticks: 30_000, stateHash: 'aafa0067', cashEnd: 37_227_000, exportedUnits: 71 },
    { name: 'full_import_chain', ticks: 40_000, stateHash: 'a5333aa5', cashEnd: 31_964_000, exportedUnits: 62 },
    { name: 'export_roundtrip', ticks: 40_000, stateHash: '2b8c0874', cashEnd: 37_016_800, exportedUnits: 54 },
  ])('$name ($ticks tickov): stateHash $stateHash, apron → directHandoverPct 0', ({ name, ticks, stateHash, cashEnd, exportedUnits }) => {
    const report = runScenario(loadScenario(`data/scenarios/${name}.json`), ticks, DEFS, { hash: true });
    expect(report).toMatchObject({ stateHash, cashEnd, exportedUnits, lostUnits: 0, directHandoverPct: 0 });
  }, HEAVY_TIMEOUT_MS);
});
