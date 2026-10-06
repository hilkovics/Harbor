/**
 * Zoznam ozdôb modulu (`ModuleDecorFactory`), ktoré `ModuleView` vytvára podľa voliteľných polí `ModuleVM`.
 * Nový druh modulu s vlastnou dynamickou grafikou = nová ozdoba a jeden riadok tu.
 */
import { depotDecorFactory } from './depot-decor';
import { gateDecorFactory } from './gate-decor';
import { holdDecorFactory } from './hold-decor';
import type { ModuleDecorFactory } from './module-decor';
import { parkedVehiclesDecorFactory } from './parked-vehicles-decor';
import { rampDecorFactory } from './ramp-decor';
import { stacksDecorFactory } from './stacks-decor';
import { waitingAreaDecorFactory } from './waiting-area-decor';
import { yardCraneDecorFactory } from './yard-crane-decor';

export const MODULE_DECORS: readonly ModuleDecorFactory[] = [stacksDecorFactory, gateDecorFactory, waitingAreaDecorFactory, rampDecorFactory, yardCraneDecorFactory, holdDecorFactory, depotDecorFactory, parkedVehiclesDecorFactory];
