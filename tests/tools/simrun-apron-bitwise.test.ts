// Režim `apron` je po T6D-02 (vozidlo pod hákom, nábrežie v A*, dispatcher vopred) v správaní zhodný s F2–F6c: metriky (`cashEnd`, `exportedUnits`)
// troch scenárov v pripnutom režime `apron` (`DEFS` z `tests/sim/world/world-fixtures`) sa zhodujú s hodnotami z commitu pred T6D-02 (b1c7faf).
// Metrika `directHandoverPct` je v režime `apron` 0 (každá jednotka ide cez apron).
// `stateHash` je odtlačok `WorldState` v10 (clean break savov, ADR-036: `version` 10, tvar ako v9), preto sa líši od hashov v9
// (vertical_slice c76d41c5, full_import_chain bdbe7fb8, export_roundtrip 79ba9543); metriky sa nezmenili. Od v8 z b1c7faf (vertical_slice 161cef25,
// full_import_chain 001b8fb0, export_roundtrip 1c477527) sa líšia aj tvarom (`hinterland`, T6D-01). export_roundtrip sa od T6D-01 líši aj obsahom:
// posledný kamión po otvorení cesty čaká vo vnútrozemí na zaručené miesto na docku (ADR-035), takže prejde bránou neskôr (metriky ostali rovnaké).
// R1 (TR1-04, ADR-037): parkovanie vozidiel, jednosmerná slučka `harbor_01` a scenáre napojené na ňu (zhoda s hodnotami pred R1: 78 / 120 / 58 exportovaných;
// uviaznutie z TR1-03 je preč) → nové hashe a `cashEnd` (cena úpravy ciest pri napojení scenára na slučku, `PORT_BRIDGE`).
// R1 (TR1-09b, dodatok ADR-037): zlom uviaznutia (obrat s pruhom, otočka na mieste, pretočenie cyklu) mení poradie slotov → nové hashe
// (vertical_slice 9e557180 → 3ad5f8b4, full_import_chain 7ea1228e → 7e9a7aa2, export_roundtrip cccc2579 → a11a9237); `cashEnd` a `exportedUnits` ostali.
// R1 (TR1-02, ADR-037): nosiče nesú `body`, `ahead`, `blockedTicks`, `rerouteCooldown` a jazdia po pruhových slotoch → nové hashe
// (vertical_slice 5990df8f → e76d294b, full_import_chain 4774ec6e → 788ef948, export_roundtrip 8c436f3d → 90d9926e); `cashEnd` a `exportedUnits` ostali.
import { describe, expect, it } from 'vitest';
import { loadScenario, runScenario } from '../../tools/simrun';
import { DEFS } from '../sim/world/world-fixtures';

const HEAVY_TIMEOUT_MS = 180_000;

describe('režim apron: bitovo zhodný s F2–F6c', () => {
  // TR5-01 (R5, ADR-042): `WorldState` v14 (`version`, kľúč `reefer` jednotky, `unitTypes` kontraktu, kategória `energy` v súhrnoch) → nové hashe (vertical_slice 868db23a → 1931044d, full_import_chain faac6f76 → 98bb417b, export_roundtrip 58915ba8 → 0df6a880); `cashEnd`, `exportedUnits` ostali, tok sveta sa nezmenil (typeMix bez reefer bloku nespotrebuje `Rng`).
  // TR4-02 (R4, ADR-041 dodatok): obsluha kamiónov na TP v blokoch, odstavná plocha, `WorldState` v13, bez rampy a čakacej plochy (−16 000 000 ceny stavby, údržba 293 000 za deň) → nové hashe (vertical_slice dac93b99 → 868db23a, full_import_chain d7e859c3 → faac6f76, export_roundtrip f8b64c01 → 58915ba8) a `cashEnd`; `exportedUnits` ostali (50 / 120 / 31), `lostUnits` 0.
  // TR4-01 (R4, ADR-041): pruhy brány (2 × $25 000, údržba 323 000 namiesto 330 000 za deň), `WorldState` v12, brána losuje problémy z Rng → nové hashe (vertical_slice 7b73e817 → dac93b99, full_import_chain dfc91c96 → d7e859c3, export_roundtrip 707c1880 → f8b64c01) a `cashEnd`; `exportedUnits` ostali (50 / 120 / 31), `lostUnits` 0.
  // R2 (ADR-039): hashe prepísané po plánovači stohov (cashEnd a počty exportovaných jednotiek ostali; stav obsahuje `rehandles` a stohové sloty).
  // TR3-06b: `WorldState` v11 (clean break, `version` je v hashi) → nové hashe (vertical_slice 6b803284 → 7b73e817, full_import_chain bf12387f → dfc91c96, export_roundtrip e1aa153d → 707c1880); `cashEnd` a `exportedUnits` ostali, tok sveta sa nezmenil.
  // TR3-02 (ADR-040 dodatok): berth 8 × 4, obchádzka a jednosmerné pruhy (cesty v riadku y = 17 odpadli, +obchádzka), nové runtime kľúče žeriavov → nové hashe (vertical_slice b2dd39a3 → 6b803284, full_import_chain f6a160e0 → bf12387f, export_roundtrip 9bc73b8a → e1aa153d); `cashEnd` o bunku ciest viac (+200 000), `exportedUnits` ostali.
  // TR3-01 (ADR-040): `WorldState` nesie nový kľúč `machines: []` → nové hashe (vertical_slice 8c7ec283 → b2dd39a3, full_import_chain ba945370 → f6a160e0, export_roundtrip 9326712a → 9bc73b8a); `cashEnd` a `exportedUnits` ostali, sim sa nezmenil.
  // TR2-06b: runtime bloku nesie aj `rehandleStalls` → nové hashe (vertical_slice 80ba4d63 → 8c7ec283, full_import_chain 91ec22b0 → ba945370, export_roundtrip 1d247952 → 9326712a); `cashEnd` a `exportedUnits` ostali.
  it.each([
    { name: 'vertical_slice', ticks: 30_000, stateHash: '1931044d', cashEnd: 64_976_000, exportedUnits: 50 },
    { name: 'full_import_chain', ticks: 40_000, stateHash: '98bb417b', cashEnd: 55_187_000, exportedUnits: 120 },
    { name: 'export_roundtrip', ticks: 40_000, stateHash: '0df6a880', cashEnd: 65_303_050, exportedUnits: 31 },
  ])('$name ($ticks tickov): stateHash $stateHash, apron → directHandoverPct 0', ({ name, ticks, stateHash, cashEnd, exportedUnits }) => {
    const report = runScenario(loadScenario(`data/scenarios/${name}.json`), ticks, DEFS, { hash: true });
    expect(report).toMatchObject({ stateHash, cashEnd, exportedUnits, lostUnits: 0, directHandoverPct: 0 });
  }, HEAVY_TIMEOUT_MS);
});
