/**
 * `data/defs/modules.json` s pripnutým režimom odovzdávania kotviska `apron` (F6a, ADR-033). Bundled default je `under_hook`
 * (vozidlo čaká pod hákom žeriava), no testy fáz 2–6 stoja na odkladaní jednotiek na apron (sloty apronu, rezervácie,
 * `CraneCycleDone` = `in_crane → on_apron`) — namiesto prepisu očakávaní si pripínajú starý režim cez def (rozhodnutie
 * používateľa 2026-10-04). Od R4 (ADR-041) sa tu pripínajú aj šance na problém pruhov brány (`gateIssueChance`, `sealIssueChance`) na 0: prechod pruhom má presné trvanie
 * a brána nespotrebuje `Rng` (testy stavu `Rng` a presných časov); losovanie problémov a režimy pruhov testuje `tests/sim/gates/**` s bundled defmi. Modul nemá žiadne závislosti od simu, aby ho mohli importovať aj najnižšie fixtures.
 */
import modulesJson from '@data/defs/modules.json';

/** Zoznam modulov bundled defov; každé kotvisko má `handoverMode: 'apron'`, ostatné parametre nedotknuté. */
export const APRON_MODULES = {
  ...modulesJson,
  items: modulesJson.items.map((item) => {
    if ('handoverMode' in item.params) return { ...item, params: { ...item.params, handoverMode: 'apron' } };
    if ('gateIssueChance' in item.params) return { ...item, params: { ...item.params, gateIssueChance: 0 } };
    if ('sealIssueChance' in item.params) return { ...item, params: { ...item.params, sealIssueChance: 0 } };
    return item;
  }),
};
