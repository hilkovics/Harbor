/**
 * Modul (ARCHITECTURE §5, §5.3): entita postavená na mriežke podľa `ModuleDef`. Konkrétne druhy sú triedy
 * (`BerthModule`, `CraneModule`, `StorageModule` → `ContainerYard`, `VehicleDepot`, `LandExportModule` → `TruckGate`,
 * `WaitingArea`, `LoadingRamp`…) zaregistrované v `ModuleRegistry`
 * podľa `def.kind` (pravidlo 7 — žiadne switch-e podľa druhu).
 *
 * Geometria je nemenná: `origin` = ľavý horný roh footprintu **po** rotácii, `size` a `cells` po rotácii. Mriežku
 * (`cell.moduleId`) zapisuje až `World.addModule` — samotná inštancia svet nemení.
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import type { CargoHolderKind } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import type { ModuleDef, ModuleKind } from '../defs/types';
import type { CellCoord, Grid } from '../grid/grid';
import { isRotation, type Rotation } from '../grid/rotation';
import { ModuleError } from './module-error';
import { connectorsOf, footprintOf, type PlacedConnector } from './module-geometry';
import { checkRuntimeKeys, type ModuleRuntimeState } from './runtime-state';
import type { CargoSlotsView } from './slot-reservations';

/** Vstup konštruktora modulu (factory v `ModuleRegistry` ho dostane hotový). */
export interface ModuleInit {
  readonly def: Readonly<ModuleDef>;
  readonly id: EntityId;
  /** Ľavý horný roh footprintu po rotácii. */
  readonly origin: CellCoord;
  readonly rotation: Rotation;
  /** Skutočne zaplatená cena (starter moduly 0) — základ refundácie (T02-04). */
  readonly purchaseCostCents: number;
  /** Mriežka sveta, do ktorého modul patrí — len na čítanie (hranice, hĺbka, berth pod žeriavom). */
  readonly grid: Grid;
  /**
   * Ledger sveta len na čítanie (T03-02): moduly so slotmi (apron, sklad) z neho odvodzujú obsadenie a držia len
   * rezervácie — poloha nákladu má jediný zápis (pravidlo 2, review T02-13).
   */
  readonly cargo: CargoReader;
}

function isEntityId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export abstract class Module {
  readonly id: EntityId;
  readonly def: Readonly<ModuleDef>;
  readonly kind: ModuleKind;
  readonly origin: CellCoord;
  readonly rotation: Rotation;
  /** Rozmery footprintu po rotácii. */
  readonly size: { readonly w: number; readonly h: number };
  /** Bunky footprintu row-major. */
  readonly cells: readonly CellCoord[];
  /** Konektory vo svete po rotácii (`connectorsOf`) v poradí defu; vonkajšiu bunku dáva `connectorOutside`. */
  readonly connectors: readonly PlacedConnector[];
  readonly purchaseCostCents: number;

  /**
   * Chyby (`ModuleError`): id nie je celé ≥ 1 alebo cena nie je celé ≥ 0 alebo neplatná rotácia →
   * `invalid_input`; footprint presahuje mapu → `out_of_bounds`.
   */
  protected constructor(init: ModuleInit) {
    const { def, id, origin, rotation, purchaseCostCents, grid } = init;
    if (!isEntityId(id)) throw new ModuleError('invalid_input', `modul '${def.id}': id musí byť celé číslo ≥ 1, dostal ${String(id)}`);
    if (!Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0) {
      throw new ModuleError('invalid_input', `modul '${def.id}': purchaseCostCents musí byť celé číslo ≥ 0, dostal ${String(purchaseCostCents)}`);
    }
    if (!isRotation(rotation)) {
      throw new ModuleError('invalid_input', `modul '${def.id}': rotácia musí byť 0, 90, 180 alebo 270, dostal ${String(rotation)}`);
    }
    const { size, cells } = footprintOf(def, origin.x, origin.y, rotation);
    if (!grid.rectInBounds({ x: origin.x, y: origin.y, w: size.w, h: size.h })) {
      throw new ModuleError(
        'out_of_bounds',
        `modul '${def.id}' #${String(id)}: footprint ${String(size.w)}×${String(size.h)} na (${String(origin.x)}, ${String(origin.y)}) presahuje mapu ${String(grid.width)}×${String(grid.height)}`,
      );
    }
    this.id = id;
    this.def = def;
    this.kind = def.kind;
    this.origin = Object.freeze({ x: origin.x, y: origin.y });
    this.rotation = rotation;
    this.size = size;
    this.cells = cells;
    this.connectors = connectorsOf(def, origin.x, origin.y, rotation);
    this.purchaseCostCents = purchaseCostCents;
  }

  /** Leží bunka vo footprinte modulu? */
  containsCell(x: number, y: number): boolean {
    return x >= this.origin.x && y >= this.origin.y && x < this.origin.x + this.size.w && y < this.origin.y + this.size.h;
  }

  /** Popis do chybových správ: `berth_standard #3`. */
  get label(): string {
    return `${this.def.id} #${String(this.id)}`;
  }

  /**
   * Sloty nákladu modulu len na čítanie (apron kotviska, sklad), alebo `undefined` pre modul bez slotov. Generický kód
   * (invarianty kroku 12, obnova save, pravidlo `has_cargo`) sa pýta tu, nie `instanceof` (pravidlo 7, ADR-017).
   */
  cargoSlots(): CargoSlotsView | undefined {
    return undefined;
  }

  /**
   * Rezervované (zatiaľ prázdne) miesta pre prichádzajúci náklad a druh lokácie, do ktorej náklad príde; `undefined` =
   * modul také miesta nemá. Základ: sloty z `cargoSlots()` (apron, sklad); rampa (T04-02) hlási staging rezervácie
   * dockov (`at_ramp`), ktoré nie sú jedinečné sloty. Pravidlo `has_cargo` (§8 bod 8) sa pýta tu, nie `instanceof`.
   */
  cargoReservations(): { readonly kind: CargoHolderKind; readonly count: number } | undefined {
    const slots = this.cargoSlots();
    return slots === undefined ? undefined : { kind: slots.kind, count: slots.reservedCount };
  }

  /**
   * Prvé porušenie vnútornej konzistencie dynamického stavu modulu (krok 12, §6), alebo `undefined`. Základ: nič
   * na kontrolu. Pozemné moduly (T04-02) kontrolujú frontu brány, bays stojiska a staging dockov rampy; väzby na iné
   * entity (kamióny, joby) kontroluje svet. V platnom stave nesmie alokovať (ADR-021).
   */
  findRuntimeProblem(): string | undefined {
    return undefined;
  }

  /**
   * Vnútorný čas vozidla pri vstupe do modulu (§7.3 bod 4, ADR-011) z `params.internalTicks` modulu; `undefined` =
   * modul ho neurčuje a platí `logistics.defaultInternalTicks`. Prepíšu ho triedy, ktorých params pole majú (sklad,
   * depo) — generický kód sa pýta tu, nie `instanceof` (pravidlo 7).
   */
  vehicleInternalTicks(): number | undefined {
    return undefined;
  }

  /**
   * Dynamický stav pre save (čistý JSON, nová kópia pri každom volaní). Základ: modul bez vlastného stavu → `{}`.
   * Podtrieda so stavom prepíše `getRuntimeState` aj `restoreRuntimeState`.
   */
  getRuntimeState(): ModuleRuntimeState {
    return {};
  }

  /**
   * Obnoví dynamický stav zo `getRuntimeState()` (aj po `JSON.parse`); volá sa na novej inštancii pred
   * `World.addModule`. Neplatný stav → `ModuleStateError` s cestou relatívnou k `runtime`. Základ: len `{}`.
   */
  restoreRuntimeState(raw: unknown): void {
    checkRuntimeKeys(raw, []);
  }
}
