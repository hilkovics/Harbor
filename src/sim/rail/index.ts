// Železnica (R6, ADR-043): vlak, cestovný poriadok, trasy a náklad vo vlaku.
export { Rail, RAIL_RUNTIME_KEYS, type RailClock, type RailCounters, type RailRuntimeState } from './rail';
export { MILLI_PER_CELL, SERIALIZED_TRAIN_KEYS, Train, type SerializedTrain, type TrainCarSpan, type TrainInit } from './train';
export { TRAIN_MOVING, TRAIN_STATES, TRAIN_TRANSITIONS, isTrainState, isTrainTransitionAllowed, type TrainState } from './train-fsm';
export { computeRailRoutes, findRailPath, type RailRoute } from './rail-routes';
export { railPoseAt, type RailPose } from './rail-geometry';
export { findTrainSlot, isTrainFull, trainFits, trainSlotMap, wagonFillTeu } from './train-cargo';
export { crossingBarrier, crossingStates, crossingsHeld, releaseCrossings, syncCrossings } from './rail-crossings';
export { isRailExportDue, isRailExportIndex, loadRailExports } from './rail-exports';
