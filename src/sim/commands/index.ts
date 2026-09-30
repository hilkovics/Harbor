// Príkazy (Command pattern, ARCHITECTURE §12.2): rozhranie, výsledok validácie, register typ → factory
// a vstavané príkazy (F1: PlaceRoad, RemoveRoad, SetGameSpeed; F2: PlaceModule, RemoveModule, SpawnShipDebug;
// F3: BuyVehicle, SellVehicle; F5: AcceptContract, DeclineContract). Predvolený register ich pozná od načítania.
export type { Command, SerializedCommand } from './command';
export { SimCommand, withGameOver } from './sim-command';
export { VALIDATION_REASONS, orderReasons } from './validation';
export type { ValidationReason, ValidationResult } from './validation';
export { CommandError } from './command-error';
export { CommandRegistry, commandFromJSON, commandRegistry } from './command-registry';
export type { CommandFactory } from './command-registry';
export { BUILTIN_COMMANDS, registerBuiltinCommands } from './builtin-commands';
export type { RegistrableCommand } from './builtin-commands';
export { RoadLayerCommand } from './road-layer-command';
export type { CellVerdict, RoadPosting, PlannedCell, RoadPrice, RoadQuote } from './road-layer-command';
export { PlaceRoadCommand } from './place-road';
export { RemoveRoadCommand } from './remove-road';
export { SetGameSpeedCommand } from './set-game-speed';
export { PLACEMENT_REASON, PlaceModuleCommand } from './place-module';
export type { PlaceModuleInput } from './place-module';
export { RemoveModuleCommand } from './remove-module';
export { SpawnShipDebugCommand } from './spawn-ship-debug';
export type { SpawnShipDebugInput } from './spawn-ship-debug';
export { BuyVehicleCommand } from './buy-vehicle';
export type { BuyVehicleInput } from './buy-vehicle';
export { SellVehicleCommand } from './sell-vehicle';
export { ContractOfferCommand } from './contract-command';
export { AcceptContractCommand } from './accept-contract';
export { DeclineContractCommand } from './decline-contract';
export { BASIS_POINTS_PER_UNIT, rateToBasisPoints, refundCents } from './refund';
