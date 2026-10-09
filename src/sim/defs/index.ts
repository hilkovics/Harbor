// Typované načítanie dátových definícií (DefRegistry) a katalógy (ADR-009).
// Explicitný zoznam: pomocné validačné funkcie (`def-spec.ts`, napr. `checkNumber`) nie sú verejné API simu.
export * from './types';
export { DefError } from './def-error';
export { DefRegistry, loadBundledDefs } from './def-registry';
export type { RawDefs } from './def-registry';
export type { Catalog } from './catalog';
export {
  MODULE_PARAM_SPECS,
  berthParams,
  craneParams,
  depotParams,
  gateParams,
  holdingParams,
  preGateParams,
  rampParams,
  storageParams,
  waitingAreaParams,
} from './module-def';
