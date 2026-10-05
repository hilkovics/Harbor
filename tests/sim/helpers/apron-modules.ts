/**
 * `data/defs/modules.json` s pripnutým režimom odovzdávania kotviska `apron` (F6a, ADR-033). Bundled default je `under_hook`
 * (vozidlo čaká pod hákom žeriava), no testy fáz 2–6 stoja na odkladaní jednotiek na apron (sloty apronu, rezervácie,
 * `CraneCycleDone` = `in_crane → on_apron`) — namiesto prepisu očakávaní si pripínajú starý režim cez def (rozhodnutie
 * používateľa 2026-10-04). Modul nemá žiadne závislosti od simu, aby ho mohli importovať aj najnižšie fixtures.
 */
import modulesJson from '@data/defs/modules.json';

/** Zoznam modulov bundled defov; každé kotvisko má `handoverMode: 'apron'`, ostatné parametre nedotknuté. */
export const APRON_MODULES = {
  ...modulesJson,
  items: modulesJson.items.map((item) => ('handoverMode' in item.params ? { ...item, params: { ...item.params, handoverMode: 'apron' } } : item)),
};
