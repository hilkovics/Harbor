// Spoločné pomôcky pre testy src/app (T01-07). Skutočné príkazy (PlaceRoad, SetGameSpeed) sú v T01-04 — tu sú
// minimálne testovacie príkazy, ktoré implementujú rozhranie `Command` a menia svet priamo.
import type { Command, SerializedCommand, ValidationResult } from '@sim/commands';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';

export const SEED = 20260929;

export function createWorld(): World {
  return World.create(loadBundledDefs(), loadBundledMap(), SEED);
}

/** World + SimBridge + GameLoop prepojené tak, ako ich zapojí bootstrap (loop publikuje do bridge). */
export function createApp(): { world: World; bridge: SimBridge; loop: GameLoop } {
  const world = createWorld();
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  return { world, bridge, loop };
}

const OK: ValidationResult = Object.freeze({ ok: true, reasons: [], cells: [], costCents: 0 });

abstract class TestCommand implements Command {
  abstract readonly type: string;
  validateCalls = 0;
  applyCalls = 0;

  validate(): ValidationResult {
    this.validateCalls += 1;
    return OK;
  }

  apply(world: World): void {
    this.applyCalls += 1;
    this.doApply(world);
  }

  protected abstract doApply(world: World): void;

  toJSON(): SerializedCommand {
    return { type: this.type };
  }
}

/** Nastaví rýchlosť hry a emituje `GameSpeedChanged` (zástupca `SetGameSpeed` z T01-04). */
export class TestSetSpeed extends TestCommand {
  readonly type = 'TestSetSpeed';

  constructor(private readonly speed: number) {
    super();
  }

  protected doApply(world: World): void {
    world.clock.setSpeed(this.speed);
    world.events.emit({ type: 'GameSpeedChanged', speed: this.speed });
  }
}

/** Zmení hotovosť o `deltaCents` a emituje `MoneyChanged`. */
export class TestAdjustCash extends TestCommand {
  readonly type = 'TestAdjustCash';

  constructor(private readonly deltaCents: number) {
    super();
  }

  protected doApply(world: World): void {
    world.cashCents += this.deltaCents;
    world.events.emit({ type: 'MoneyChanged', cashCents: world.cashCents, deltaCents: this.deltaCents, reason: 'road_capex' });
  }
}

/** Príkaz, ktorý neprejde validáciou (`insufficient_funds`); `apply` sa nesmie zavolať. */
export class TestRejected extends TestCommand {
  readonly type = 'TestRejected';

  override validate(): ValidationResult {
    this.validateCalls += 1;
    return { ok: false, reasons: ['insufficient_funds'], cells: [], costCents: 0 };
  }

  protected doApply(): void {
    throw new Error('TestRejected.apply sa nesmie zavolať');
  }
}
