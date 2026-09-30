/**
 * Register tried modulov: `kind` defu → factory (CLAUDE.md pravidlo 7, ARCHITECTURE §17 — žiadny switch podľa
 * druhu ani `.constructor`). Nový druh modulu = nová trieda + `register(kind, factory)`; neregistrovaný druh je
 * chyba pri vytváraní, nie tichý fallback.
 *
 * Predvolený `moduleRegistry` má vstavané druhy F2 (`berth`, `crane`) zaregistrované pri načítaní modulu (staticky,
 * rovnako ako `commandRegistry`), `World` ho používa pri stavbe aj pri obnove zo save.
 */
import type { EntityId } from '../core/entity-id';
import type { ModuleDef, ModuleKind } from '../defs/types';
import type { Grid } from '../grid/grid';
import type { PlacedModuleSpec } from '../grid/map-def';
import { BerthModule } from './berth-module';
import { CraneModule } from './crane-module';
import type { Module, ModuleInit } from './module';
import { ModuleError } from './module-error';

/** Vytvorí inštanciu modulu z hotového vstupu (validáciu id, ceny, rotácie a hraníc robí `Module`). */
export type ModuleFactory = (init: ModuleInit) => Module;

/** Prostredie sveta, v ktorom modul vzniká (mriežka na čítanie hraníc, hĺbky a berthu pod žeriavom). */
export interface ModuleEnv {
  readonly grid: Grid;
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
    return factory({ def, id, origin: { x: spec.x, y: spec.y }, rotation: spec.rotation, purchaseCostCents, grid: env.grid });
  }
}

/** Vstavané druhy modulov F2 — tabuľka `kind → trieda` (ARCHITECTURE §17). */
export const BUILTIN_MODULES: readonly (readonly [ModuleKind, ModuleFactory])[] = Object.freeze([
  ['berth', (init) => new BerthModule(init)],
  ['crane', (init) => new CraneModule(init)],
]);

/** Zaregistruje vstavané druhy do `registry`. */
export function registerBuiltinModules(registry: ModuleRegistry): void {
  for (const [kind, factory] of BUILTIN_MODULES) registry.register(kind, factory);
}

/** Predvolený register simulácie so vstavanými druhmi. */
export const moduleRegistry = new ModuleRegistry();
registerBuiltinModules(moduleRegistry);
