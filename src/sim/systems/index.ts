// Systémy volané z World.tick() (jeden systém = jeden súbor; poradie ARCHITECTURE §6): krok 3 lode, krok 4 žeriavy.
export { ShipSystem } from './ship-system';
export { CraneSystem, MIN_CRANE_PHASE_TICKS, cranePhaseTicks } from './crane-system';
export type { CranePhaseTicks } from './crane-system';
