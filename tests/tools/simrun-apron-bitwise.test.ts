// Režim `apron` je po T6D-02 (vozidlo pod hákom, nábrežie v A*, dispatcher vopred) v správaní zhodný s F2–F6c: metriky (`cashEnd`, `exportedUnits`)
// troch scenárov v pripnutom režime `apron` (`DEFS` z `tests/sim/world/world-fixtures`) sa zhodujú s hodnotami z commitu pred T6D-02 (b1c7faf).
// Metrika `directHandoverPct` je v režime `apron` 0 (každá jednotka ide cez apron).
// `stateHash` je odtlačok `WorldState` v9 (po zlúčení T6D-01 a T6D-03: `version` 9 a kľúč `hinterland`), preto sa líši od hashov v8 z b1c7faf
// (vertical_slice 161cef25, full_import_chain 001b8fb0, export_roundtrip 1c477527). Pri vertical_slice a full_import_chain je hash stavu po zhodení
// na v8 tvar (bez `hinterland`, verzia 8) rovnaký ako pôvodný — bitová zhoda platí. export_roundtrip sa od T6D-01 líši aj obsahom: posledný kamión
// po otvorení cesty čaká vo vnútrozemí na zaručené miesto na docku (ADR-035), takže prejde bránou neskôr (metriky ostali rovnaké).
import { describe, expect, it } from 'vitest';
import { loadScenario, runScenario } from '../../tools/simrun';
import { DEFS } from '../sim/world/world-fixtures';

const HEAVY_TIMEOUT_MS = 180_000;

describe('režim apron: bitovo zhodný s F2–F6c', () => {
  it.each([
    { name: 'vertical_slice', ticks: 30_000, stateHash: 'c76d41c5', cashEnd: 41_790_000, exportedUnits: 78 },
    { name: 'full_import_chain', ticks: 40_000, stateHash: 'bdbe7fb8', cashEnd: 31_964_000, exportedUnits: 120 },
    { name: 'export_roundtrip', ticks: 40_000, stateHash: '79ba9543', cashEnd: 41_887_900, exportedUnits: 58 },
  ])('$name ($ticks tickov): stateHash $stateHash, apron → directHandoverPct 0', ({ name, ticks, stateHash, cashEnd, exportedUnits }) => {
    const report = runScenario(loadScenario(`data/scenarios/${name}.json`), ticks, DEFS, { hash: true });
    expect(report).toMatchObject({ stateHash, cashEnd, exportedUnits, lostUnits: 0, directHandoverPct: 0 });
  }, HEAVY_TIMEOUT_MS);
});
