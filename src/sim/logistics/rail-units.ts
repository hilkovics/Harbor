/**
 * Železničný podiel jednotiek (R6, ADR-043 TR6-02): ktoré jednotky importu odídu vlakom. `Contract.railShareBp` je podiel importu, ktorý odíde vlakom; o konkrétnej jednotke rozhoduje čistá funkcia
 * jej id (`isRailImportUnit`: viac než `railShareBp` z 10 000 sa nedostane cez celočíselný hash id), bez ďalšieho `Rng` — rovnaká jednotka je železničná pri plánovaní aj po obnove save.
 * Reefery a nadrozmerný náklad po koľaji nejdú (terminál nemá zásuvky ani OOG plochu; ReeferSystem preto vo vlaku nič nesleduje — dôvod voľby: ADR-043 dodatok TR6-02).
 * Železničné jednotky plánovač ukladá do bufferu železničného terminálu (`railTerminalTakes`), kamióny ich z neho neberú, kým je železničná služba (`isRailBound`).
 */
import { needsPlug, type CargoUnit } from '../cargo/cargo-unit';
import { BASIS_POINTS } from '../economy/basis-points';
import type { Module } from '../modules/module';
import { RailTerminal } from '../modules/rail-terminal';
import type { World } from '../world/world';

/** Násobok hashu id (Knuthova multiplikatívna konštanta 2^32 / φ): rozloží po sebe idúce id rovnomerne cez `0 … BASIS_POINTS − 1`. */
const ID_HASH_MULTIPLIER = 0x9e3779b1;

/** Je import `unit` určený na odvoz vlakom? (Vo svete musí byť železničná služba; jednotka musí mať kontrakt s podielom a smie ísť po koľaji.) */
export function isRailImportUnit(world: World, unit: CargoUnit): boolean {
  if (unit.direction !== 'import' || unit.contractId === null || unit.oog || !world.hasRailService) return false;
  const contract = world.contractBook.get(unit.contractId);
  if (contract === undefined || contract.railShareBp === 0) return false;
  if (needsPlug(unit, world.defs.containerTypes)) return false;
  return (Math.imul(unit.id, ID_HASH_MULTIPLIER) >>> 0) % BASIS_POINTS < contract.railShareBp;
}

/** Prijme terminál `terminal` jednotku `unit` zo zdroja `from`? Import len železničný, export len z vlaka tohto terminálu (`from` = terminál). */
export function railTerminalTakes(world: World, terminal: RailTerminal, unit: CargoUnit, from: Module): boolean {
  if (unit.direction === 'import') return isRailImportUnit(world, unit);
  return unit.direction === 'export' && from === terminal;
}

/** Je jednotka v buffere železničného terminálu určená na odvoz vlakom (kamión ju nesmie vziať)? Bez železničnej služby sa správa ako bežná jednotka skladu. */
export function isRailBound(world: World, unit: CargoUnit): boolean {
  if (unit.direction !== 'import' || unit.location.kind !== 'in_storage' || !world.hasRailService) return false;
  return world.modules.get(unit.location.moduleId) instanceof RailTerminal;
}
