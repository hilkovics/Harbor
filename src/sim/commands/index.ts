// Príkazy (Command pattern): rozhranie, výsledok validácie, register typ → factory.
// Implementácie príkazov (PlaceRoad, RemoveRoad, SetGameSpeed) dopĺňa T01-04.
export type { Command, SerializedCommand } from './command';
export { VALIDATION_REASONS } from './validation';
export type { ValidationReason, ValidationResult } from './validation';
export { CommandError, CommandRegistry, commandFromJSON, commandRegistry } from './command-registry';
export type { CommandFactory } from './command-registry';
