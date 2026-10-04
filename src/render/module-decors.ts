/**
 * Zoznam ozdôb modulu (`ModuleDecorFactory`), ktoré `ModuleView` vytvára podľa voliteľných polí `ModuleVM`.
 * Nový druh modulu s vlastnou dynamickou grafikou = nová ozdoba a jeden riadok tu.
 */
import { gateDecorFactory } from './gate-decor';
import { holdDecorFactory } from './hold-decor';
import type { ModuleDecorFactory } from './module-decor';
import { rampDecorFactory } from './ramp-decor';
import { waitingAreaDecorFactory } from './waiting-area-decor';
import { yardCraneDecorFactory } from './yard-crane-decor';

export const MODULE_DECORS: readonly ModuleDecorFactory[] = [gateDecorFactory, waitingAreaDecorFactory, rampDecorFactory, yardCraneDecorFactory, holdDecorFactory];
