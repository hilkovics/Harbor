/**
 * Stavový automat stroja bloku (RTG; ADR-040 bod 3; docs/TERMINAL_2.md §5.3). Žiadne skryté prechody — stav mení výlučne `YardMachine.transition(to)` podľa
 * `MACHINE_TRANSITIONS`.
 *
 * Cyklus jednej kontajnerovej operácie: `idle → travel` (pojazd žeriavu a vozíka k miestu zdvihu, spúšťač klesne) `→ lift` (uchopenie a zdvih; na konci sa jednotka
 * presunie do `in_handler`) `→ (shift)*` (pojazd žeriavu k bayu odkladu) `→ trolley` (vozík k radu odkladu) `→ lower` (spustenie a pustenie; na konci sa jednotka
 * presunie z `in_handler` na cieľ) `→ idle`. Fázy bez dráhy (žeriav už stojí v správnom bayi, vozík v správnom rade) sa preskočia, preto sú povolené aj prechody
 * `lift → trolley | lower` a `shift → lower`.
 */
import { MACHINE_STATES, type MachineState } from './machine-state-types';

export { MACHINE_STATES };

/** Povolené prechody `from → [to…]`. */
export const MACHINE_TRANSITIONS: ReadonlyMap<MachineState, readonly MachineState[]> = new Map<MachineState, readonly MachineState[]>([
  ['idle', Object.freeze(['travel'] as const)],
  ['travel', Object.freeze(['shift', 'lift'] as const)],
  ['shift', Object.freeze(['shift', 'lift', 'trolley', 'lower'] as const)],
  ['lift', Object.freeze(['shift', 'trolley', 'lower'] as const)],
  ['trolley', Object.freeze(['shift', 'lower'] as const)],
  ['lower', Object.freeze(['idle'] as const)],
]);

/** Je prechod `from → to` v tabuľke? */
export function isMachineTransitionAllowed(from: MachineState, to: MachineState): boolean {
  return MACHINE_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Je hodnota jeden zo stavov stroja? */
export function isMachineState(value: unknown): value is MachineState {
  return (MACHINE_STATES as readonly unknown[]).includes(value);
}
