/**
 * Loď (ARCHITECTURE §5, §7.4) — **zatiaľ len tvar** zo „Spoločných rozhraní“ (docs/tasks/phase-02.md), aby
 * `world.ships` mala typ. Triedu s FSM, pohybom a serializáciou (`WorldState.ships`) doplní T02-05; dovtedy je
 * `world.ships` vždy prázdna.
 */
import type { EntityId } from '../core/entity-id';
import type { ShipClassDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';

/** Stavy lode v poradí životného cyklu (FSM prechody určí T02-05). */
export const SHIP_STATES = ['inbound', 'waiting_anchorage', 'berthing', 'docked', 'undocking', 'outbound', 'despawned'] as const;
export type ShipState = (typeof SHIP_STATES)[number];

export interface Ship {
  readonly id: EntityId;
  readonly classId: string;
  readonly def: Readonly<ShipClassDef>;
  readonly cargoTypeId: string;
  readonly state: ShipState;
  /** Stred lode v bunkách (float); stred bunky (cx, cy) = (cx + 0.5, cy + 0.5). */
  readonly x: number;
  readonly y: number;
  /** 0 = predok na sever, v smere hodinových ručičiek. */
  readonly heading: Rotation;
  /** Obsadené kotviská (prázdne mimo `berthing`/`docked`/`undocking`). */
  readonly berthIds: readonly EntityId[];
}
