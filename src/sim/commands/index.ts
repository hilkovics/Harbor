// Príkazy (Command pattern, ARCHITECTURE §12.2): rozhranie, výsledok validácie, register typ → factory
// a vstavané príkazy F1 (PlaceRoad, RemoveRoad, SetGameSpeed). Predvolený register ich pozná od načítania.
export type { Command, SerializedCommand } from './command';
export { VALIDATION_REASONS } from './validation';
export type { ValidationReason, ValidationResult } from './validation';
export { CommandError } from './command-error';
export { CommandRegistry, commandFromJSON, commandRegistry } from './command-registry';
export type { CommandFactory } from './command-registry';
export { BUILTIN_COMMANDS, registerBuiltinCommands } from './builtin-commands';
export type { RegistrableCommand } from './builtin-commands';
export { RoadLayerCommand } from './road-layer-command';
export type { CellVerdict } from './road-layer-command';
export { PlaceRoadCommand } from './place-road';
export { RemoveRoadCommand } from './remove-road';
export { SetGameSpeedCommand } from './set-game-speed';
