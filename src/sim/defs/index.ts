// Typované načítanie dátových definícií (DefRegistry).
// Explicitný zoznam: pomocné validačné funkcie z `def-registry.ts` (napr. `checkNumber`) nie sú verejné API simu.
export * from './types';
export { DefError, DefRegistry, loadBundledDefs } from './def-registry';
export type { RawDefs } from './def-registry';
