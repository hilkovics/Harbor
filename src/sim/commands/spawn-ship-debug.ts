/**
 * `SpawnShipDebug { shipClassId, cargoTypeId, units }` — ladiaca loď (docs/tasks/phase-02.md rozhodnutie 5 a 8;
 * ADR-016). Registrovaný vždy (scenáre, replay); UI tlačidlo je len v DEV. Kým nie sú kontrakty (F4/F5), je to jediný
 * zdroj lodí a nákladu.
 *
 * `validate` (všetky dôvody naraz, poradie `VALIDATION_REASONS`, `cells = []`, `costCents = 0`):
 * - `unknown_ship_class` — trieda nie je v `ships.json`;
 * - `unknown_cargo` — typ nie je v `cargo_types.json`;
 * - `cargo_incompatible` — kategória nákladu nie je v `cargoCategories` triedy (len keď sú oba defy známe);
 * - `invalid_units` — `units` nie je celé číslo `1 … capacityUnits` (pri neznámej triede len celé ≥ 1).
 *
 * `apply`: loď (`inbound`) so stredom v strede `seaLane[0]` a kurzom prvého úseku dráhy, potom `units` jednotiek
 * `on_ship` (`CargoLedger.create`; id lode predchádza id jednotiek) a `ShipSpawned`. Hotovosť sa nemení.
 */
import type { CellCoord } from '../grid/grid';
import { Ship } from '../ships/ship';
import { cardinalHeading, cellCenter } from '../ships/ship-route';
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import { CommandError } from './command-error';
import { checkFiniteNumber, checkString, readPayload } from './payload';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru v poradí `toJSON`. */
const SPAWN_SHIP_KEYS: readonly string[] = ['type', 'shipClassId', 'cargoTypeId', 'units'];

/** Najmenší počet jednotiek na ladiacej lodi. */
const MIN_UNITS = 1;

/** Kurz lode pri spawne, keď prvý úsek `seaLane` nemá dĺžku (sever). */
const DEFAULT_SPAWN_HEADING = 0;

const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

/** Vstup konštruktora (rovnaké polia ako JSON bez `type`). */
export interface SpawnShipDebugInput {
  readonly shipClassId: string;
  readonly cargoTypeId: string;
  /** Počet jednotiek nákladu; necelé alebo mimo rozsahu odmietne `validate` (`invalid_units`). */
  readonly units: number;
}

export class SpawnShipDebugCommand implements Command {
  static readonly TYPE = 'SpawnShipDebug';

  readonly type = SpawnShipDebugCommand.TYPE;
  readonly shipClassId: string;
  readonly cargoTypeId: string;
  readonly units: number;

  /** @param input reťazce `shipClassId`, `cargoTypeId` a konečné číslo `units`; inak `CommandError`. */
  constructor(input: SpawnShipDebugInput) {
    const type = SpawnShipDebugCommand.TYPE;
    if (typeof input !== 'object' || input === null) throw new CommandError(`${type}: vstup musí byť objekt { shipClassId, cargoTypeId, units }`);
    this.shipClassId = checkString(input.shipClassId, type, '/shipClassId');
    this.cargoTypeId = checkString(input.cargoTypeId, type, '/cargoTypeId');
    this.units = checkFiniteNumber(input.units, type, '/units');
  }

  /** Príkaz z tvaru `{ type: 'SpawnShipDebug', shipClassId, cargoTypeId, units }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): SpawnShipDebugCommand {
    const type = SpawnShipDebugCommand.TYPE;
    const raw = readPayload(json, type, SPAWN_SHIP_KEYS);
    return new SpawnShipDebugCommand({
      shipClassId: checkString(raw['shipClassId'], type, '/shipClassId'),
      cargoTypeId: checkString(raw['cargoTypeId'], type, '/cargoTypeId'),
      units: checkFiniteNumber(raw['units'], type, '/units'),
    });
  }

  /** Viď hlavička súboru. Svet sa nemení, `Rng` sa nepoužije. */
  validate(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    const shipClass = world.defs.ships.has(this.shipClassId) ? world.defs.ships.get(this.shipClassId) : undefined;
    const cargoType = world.defs.cargoTypes.has(this.cargoTypeId) ? world.defs.cargoTypes.get(this.cargoTypeId) : undefined;
    if (shipClass === undefined) found.add('unknown_ship_class');
    if (cargoType === undefined) found.add('unknown_cargo');
    if (shipClass !== undefined && cargoType !== undefined && !shipClass.cargoCategories.includes(cargoType.category)) {
      found.add('cargo_incompatible');
    }
    const maxUnits = shipClass?.capacityUnits ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(this.units) || this.units < MIN_UNITS || this.units > maxUnits) found.add('invalid_units');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents: 0 });
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const result = this.validate(world);
    if (!result.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const [first, second] = world.map.seaLane;
    const spawn = cellCenter(first);
    const next = second === undefined ? spawn : cellCenter(second);
    const ship = new Ship({
      id: world.ids.next(),
      def: world.defs.ships.get(this.shipClassId),
      cargoType: world.defs.cargoTypes.get(this.cargoTypeId),
      state: 'inbound',
      x: spawn.x,
      y: spawn.y,
      heading: cardinalHeading(next.x - spawn.x, next.y - spawn.y) ?? DEFAULT_SPAWN_HEADING,
    });
    world.addShip(ship);
    for (let i = 0; i < this.units; i++) world.cargo.create(this.cargoTypeId, { kind: 'on_ship', shipId: ship.id });
    world.events.emit({ type: 'ShipSpawned', shipId: ship.id, classId: ship.classId, cargoTypeId: ship.cargoTypeId, units: this.units });
  }

  toJSON(): SerializedCommand {
    return { type: this.type, shipClassId: this.shipClassId, cargoTypeId: this.cargoTypeId, units: this.units };
  }
}
