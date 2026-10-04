/**
 * Rýchlosť hry pri štarte (ADR-030 bod 5 a 2): nová hra štartuje s `defaultSpeed` z nastavení, načítaná hra v pauze
 * (pauza má prednosť pred `defaultSpeed`). Rýchlosť rozohranej hry inak nesie save (`clock`).
 *
 * Rýchlosť sa nastavuje príkazom `SetGameSpeed` zaradeným do fronty sveta (replay-friendly, žiadny zásah do hodín mimo
 * príkazov); aplikuje sa v prvom frame, ešte pred prvým tickom, takže hra pri pauze neodtikne ani jeden tick.
 */
import { SetGameSpeedCommand } from '@sim/commands';
import type { World } from '@sim/world';

/**
 * Zaradí `SetGameSpeed(speed)` do fronty `world`, ak sa rýchlosť líši od aktuálnej a patrí do `time.speeds`.
 * @param speed `undefined` = nechať rýchlosť sveta tak, ako je
 * @returns `true`, ak sa príkaz zaradil
 */
export function applyStartSpeed(world: World, speed: number | undefined): boolean {
  if (speed === undefined || speed === world.clock.speed || !world.defs.time.speeds.includes(speed)) return false;
  world.enqueue(new SetGameSpeedCommand(speed));
  return true;
}
