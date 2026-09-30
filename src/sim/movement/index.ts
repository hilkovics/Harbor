// Zdieľaný pohyb po cestách (ARCHITECTURE §7.3–§7.6; ADR-019, ADR-020, ADR-021, ADR-024): Carrier (trasa, progres,
// rýchlosť podľa typu cesty, obrat, zastavenie, prechod modulom), plánovanie trasy a kontrola súladu pohybu so stavom —
// jedna implementácia pre interné vozidlá aj kamióny.
export { Carrier, PROGRESS_NOISE, carrierPoseProblem, carrierPosition, carrierRouteProblem, isValidProgress } from './carrier';
export type { CarrierInit, CarrierPosition } from './carrier';
export { advanceCarrier, planRouteToCell, planRouteToModule, routeAnchor, takePath } from './route-planning';
export type { MovementWorld } from './route-planning';
export { carrierMotionProblem } from './motion-check';
export type { CarrierMotion, MotionField, MotionProblem, MotionTarget, MotionTraits } from './motion-check';
