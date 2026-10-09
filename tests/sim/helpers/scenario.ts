/**
 * Pomocníci scenárových testov (ARCHITECTURE §12.2, §16): načítanie `data/scenarios/*.json` a prehratie
 * (replay) príkazov nad skutočným `World`.
 *
 * Replay podľa „Spoločné rozhrania" (docs/tasks/phase-01.md): príkaz s `atTick = T` sa enqueuene a aplikuje
 * cez `applyPending()` v okamihu, keď `world.clock.tick === T`, pred ďalším `tick()`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AcceptContractCommand, commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import type { World } from '@sim/world';

/** Koreň repozitára (absolútna cesta s koncovým lomítkom), nezávisle od cwd. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Jeden riadok replaye: `Command` v serializovanej podobe a tick, pri ktorom sa aplikuje. */
export interface ScenarioEntry {
  readonly atTick: number;
  readonly command: SerializedCommand;
}

/** Formát `data/scenarios/*.json`. */
export interface Scenario {
  readonly id: string;
  readonly seed: number;
  /** Cesta k mape relatívna ku koreňu repozitára, napr. `data/maps/harbor_01.json`. */
  readonly map: string;
  readonly commands: readonly ScenarioEntry[];
}

/** Načíta JSON súbor relatívny ku koreňu repozitára. */
export function readRepoJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8')) as unknown;
}

/** Načíta `data/scenarios/<id>.json`. Tvar sa overuje v samotných testoch, nie tu. */
export function loadScenarioFile(id: string): Scenario {
  return readRepoJson(`data/scenarios/${id}.json`) as Scenario;
}

export interface RunHooks {
  /**
   * Volá sa po každom `world.tick()`. `events` = udalosti príkazov aplikovaných tesne pred tickom
   * (`applyPending()`) následované udalosťami samotného ticku; `world.clock.tick` je už posunutý.
   */
  readonly afterTick?: (world: World, events: readonly SimEvent[]) => void;
}

/**
 * Prehrá scenár nad `world`, kým `world.clock.tick < untilTick` (**absolútny** tick, nie počet tickov —
 * vďaka tomu možno beh prerušiť, svet serializovať a pokračovať rovnakým volaním).
 *
 * Príkazy s `atTick < world.clock.tick` sa považujú za už aplikované a preskočia sa; príkazy s
 * `atTick >= untilTick` sa neaplikujú. Príkazy s rovnakým `atTick` idú v poradí zo scenára.
 *
 * @returns všetky udalosti behu v poradí vzniku
 */
export function runScenario(world: World, scenario: Scenario, untilTick: number, hooks: RunHooks = {}): SimEvent[] {
  for (const { atTick } of scenario.commands) {
    if (!Number.isSafeInteger(atTick) || atTick < 0) {
      throw new Error(`scenár '${scenario.id}': atTick musí byť celé číslo >= 0, dostal ${String(atTick)}`);
    }
  }
  // Array.prototype.sort je stabilný → príkazy s rovnakým atTick ostanú v poradí zo scenára.
  const queue = [...scenario.commands].sort((a, b) => a.atTick - b.atTick).filter((e) => e.atTick >= world.clock.tick);
  const events: SimEvent[] = [];
  let next = 0;

  while (world.clock.tick < untilTick) {
    const now = world.clock.tick;
    let applied: readonly SimEvent[] = [];
    if (next < queue.length && queue[next].atTick === now) {
      while (next < queue.length && queue[next].atTick === now) {
        world.enqueue(commandFromJSON(queue[next].command));
        next += 1;
      }
      applied = world.applyPending();
    }
    const ticked = world.tick();
    events.push(...applied, ...ticked);
    hooks.afterTick?.(world, applied.length > 0 ? [...applied, ...ticked] : ticked);
  }
  return events;
}

/** Vyfiltruje udalosti jedného typu so zúženým typom. */
export function eventsOfType<T extends SimEvent['type']>(
  events: readonly SimEvent[],
  type: T,
): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

/** „Hash" stavu sveta podľa ARCHITECTURE §16: `JSON.stringify(world.serialize())` (porovnateľný reťazec). */
export function stateHash(world: World): string {
  return JSON.stringify(world.serialize());
}

/**
 * Ako `runScenario`, ale príkazy `AcceptContract` zo scenára nahradí prijatím prvých `N` platných **importných** ponúk (booking ponuky scenáre neprijímajú) v každom rozhodovacom ticku
 * (`N` = počet prijatí scenára v tom ticku). Id kontraktov závisia od počtu jobov a ďalších entít sveta (spoločný počítadlo id), takže scenár so zapísanými id platí len pre svet,
 * pre ktorý vznikol; takto ten istý záťažový scenár beží aj nad inou sadou defov (napr. režim odovzdávania `apron`).
 */
export function runScenarioAutoAccept(world: World, scenario: Scenario, untilTick: number, hooks: RunHooks = {}): void {
  const accepts = new Map<number, number>();
  for (const { atTick, command } of scenario.commands) if (command.type === 'AcceptContract') accepts.set(atTick, (accepts.get(atTick) ?? 0) + 1);
  const rest: Scenario = { ...scenario, commands: scenario.commands.filter(({ command }) => command.type !== 'AcceptContract') };
  for (const tick of [...accepts.keys()].sort((a, b) => a - b)) {
    if (tick >= untilTick || tick < world.clock.tick) continue;
    runScenario(world, rest, tick, hooks);
    let left = accepts.get(tick) ?? 0;
    const offered = [...world.contractBook.openContracts.values()].filter((contract) => contract.state === 'offered' && contract.kind === 'import').map((contract) => contract.id as number).sort((a, b) => a - b);
    for (const id of offered) {
      if (left === 0) break;
      const command = new AcceptContractCommand(id);
      if (!command.validate(world).ok) continue;
      world.enqueue(command);
      if (!world.applyPending().some((event) => event.type === 'CommandRejected')) left -= 1;
    }
  }
  runScenario(world, rest, untilTick, hooks);
}
