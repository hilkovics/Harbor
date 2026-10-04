/**
 * Register tried modulov: `kind` defu → factory (CLAUDE.md pravidlo 7, ARCHITECTURE §17 — žiadny switch podľa
 * druhu ani `.constructor`). Nový druh modulu = nová trieda + `register(kind, factory)`; neregistrovaný druh je
 * chyba pri vytváraní, nie tichý fallback.
 *
 * Predvolený `moduleRegistry` má vstavané druhy (`berth`, `crane`, od F3 `storage`, `depot`, od F4 pozemné `gate`,
 * `waiting_area`, `ramp` — `LandExportModule`, ADR-022) zaregistrované pri
 * načítaní modulu (staticky, rovnako ako `commandRegistry`), `World` ho používa pri stavbe aj pri obnove zo save.
 * Druh `storage` má viac tried podľa kategórie nákladu — vyberá ich tabuľka `STORAGE_MODULES` (§17: `kind`, potom
 * def → trieda), nie switch.
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { storageParams } from '../defs/module-def';
import type { CargoCategory, ModuleDef, ModuleKind } from '../defs/types';
import type { Grid } from '../grid/grid';
import type { PlacedModuleSpec } from '../grid/map-def';
import { BerthModule } from './berth-module';
import { ContainerYard } from './container-yard';
import { CraneModule } from './crane-module';
import { LoadingRamp } from './loading-ramp';
import type { Module, ModuleInit } from './module';
import { ModuleError } from './module-error';
import { TruckGate } from './truck-gate';
import { VehicleDepot } from './vehicle-depot';
import { WaitingArea } from './waiting-area';

/** Vytvorí inštanciu modulu z hotového vstupu (validáciu id, ceny, rotácie a hraníc robí `Module`). */
export type ModuleFactory = (init: ModuleInit) => Module;

/** Prostredie sveta, v ktorom modul vzniká (mriežka na čítanie hraníc, hĺbky a berthu pod žeriavom; ledger na čítanie obsadenia slotov). */
export interface ModuleEnv {
  readonly grid: Grid;
  readonly cargo: CargoReader;
  /** Test „jednotka na docku čaká na kamión" pre rampy (`ModuleInit.pickupCargo`); chýba = každá jednotka. */
  readonly pickupCargo?: (unit: CargoUnit) => boolean;
}

export class ModuleRegistry {
  private readonly factories = new Map<ModuleKind, ModuleFactory>();

  /** Zaregistruje triedu pre `kind`; už registrovaný druh → `ModuleError('duplicate_kind')`. */
  register(kind: ModuleKind, factory: ModuleFactory): void {
    if (this.factories.has(kind)) throw new ModuleError('duplicate_kind', `ModuleRegistry.register: druh '${kind}' je už registrovaný`);
    this.factories.set(kind, factory);
  }

  has(kind: ModuleKind): boolean {
    return this.factories.has(kind);
  }

  /** Registrované druhy v poradí registrácie. */
  get kinds(): readonly ModuleKind[] {
    return [...this.factories.keys()];
  }

  /**
   * Nová inštancia modulu `def` na mieste `spec` (ľavý horný roh po rotácii) s daným id a zaplatenou cenou.
   * Svet nemení — do sveta ju pridá `World.addModule`. Chyby (`ModuleError`): `spec.defId ≠ def.id` →
   * `invalid_input`, neregistrovaný `def.kind` → `unknown_kind`; ďalšie hlási konštruktor triedy (`Module`).
   */
  create(def: Readonly<ModuleDef>, spec: PlacedModuleSpec, id: EntityId, purchaseCostCents: number, env: ModuleEnv): Module {
    if (spec.defId !== def.id) {
      throw new ModuleError('invalid_input', `ModuleRegistry.create: spec.defId '${spec.defId}' ≠ def.id '${def.id}'`);
    }
    const factory = this.factories.get(def.kind);
    if (factory === undefined) {
      const known = this.kinds.length > 0 ? this.kinds.join(', ') : '–';
      throw new ModuleError('unknown_kind', `ModuleRegistry.create: pre druh '${def.kind}' (modul '${def.id}') nie je registrovaná trieda (registrované: ${known})`);
    }
    return factory({ def, id, origin: { x: spec.x, y: spec.y }, rotation: spec.rotation, purchaseCostCents, grid: env.grid, cargo: env.cargo, pickupCargo: env.pickupCargo });
  }
}

/**
 * Triedy skladov podľa kategórie nákladu (§5, §17; ADR-017): nový sklad = trieda `extends StorageModule` + riadok.
 * Kategória bez riadku (bulk, liquid, gas, roro — F7+) je chyba pri vytváraní, nie tichý fallback.
 */
export const STORAGE_MODULES: { readonly [C in CargoCategory]?: ModuleFactory } = Object.freeze({
  container: (init: ModuleInit) => new ContainerYard(init),
});

/** Factory druhu `storage`: trieda podľa `params.category`; kategória bez triedy → `ModuleError('unknown_kind')`. */
function createStorage(init: ModuleInit): Module {
  const { category } = storageParams(init.def);
  const factory = STORAGE_MODULES[category];
  if (factory === undefined) {
    const known = Object.keys(STORAGE_MODULES).join(', ');
    throw new ModuleError('unknown_kind', `ModuleRegistry: sklad '${init.def.id}' kategórie '${category}' nemá triedu (registrované kategórie: ${known})`);
  }
  return factory(init);
}

/** Vstavané druhy modulov — tabuľka `kind → trieda` (ARCHITECTURE §17). */
export const BUILTIN_MODULES: readonly (readonly [ModuleKind, ModuleFactory])[] = Object.freeze([
  ['berth', (init) => new BerthModule(init)],
  ['crane', (init) => new CraneModule(init)],
  ['storage', createStorage],
  ['depot', (init) => new VehicleDepot(init)],
  ['gate', (init) => new TruckGate(init)],
  ['waiting_area', (init) => new WaitingArea(init)],
  ['ramp', (init) => new LoadingRamp(init)],
]);

/** Zaregistruje vstavané druhy do `registry`. */
export function registerBuiltinModules(registry: ModuleRegistry): void {
  for (const [kind, factory] of BUILTIN_MODULES) registry.register(kind, factory);
}

/** Predvolený register simulácie so vstavanými druhmi. */
export const moduleRegistry = new ModuleRegistry();
registerBuiltinModules(moduleRegistry);
