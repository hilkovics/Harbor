/**
 * StatResolver (ARCHITECTURE §7.2, §10; ADR-014): jediné miesto, kde sa číta laditeľná štatistika entity
 * (napr. `cycleTicks` žeriavu). `resolve(target, id, stat)` = základ z typovaných parametrov defu → všetky `add`
 * modifikátory → všetky `mul` modifikátory (poradie je záväzné, nezávisí od poradia zoznamu).
 *
 * Vo F2 nie sú žiadne modifikátory (tech tree príde neskôr) — výsledok je základ z defu. Základ sa hľadá cez
 * tabuľku cieľov (`STAT_BASES`), nie switch; nový cieľ (vozidlo, loď…) = nový riadok.
 */
import { DefError, type DefRegistry } from '../defs/def-registry';
import { MODULE_PARAM_SPECS } from '../defs/module-def';
import type { FieldRecord } from '../defs/def-spec';
import type { ModuleKind, ModuleParamsByKind } from '../defs/types';

/** Kľúče typu `T` s číselnou hodnotou. */
type NumericKeys<T> = { [P in keyof T]-?: T[P] extends number ? P : never }[keyof T];

/** Číselné parametre modulov všetkých druhov (`depthClass`, `apronSlots`, `maxCranes`, `frontWaterCells`, `cycleTicks`). */
export type ModuleStat = { [K in ModuleKind]: NumericKeys<ModuleParamsByKind[K]> }[ModuleKind];

/** Druh entity, ktorej štatistiku resolver pozná. */
export interface StatTargets {
  readonly module: ModuleStat;
}
export type StatTarget = keyof StatTargets;

/** Poradie aplikácie operácií (§10): najprv všetky `add`, potom všetky `mul`. */
export const STAT_OPS = ['add', 'mul'] as const;
export type StatOp = (typeof STAT_OPS)[number];

/** Modifikátor štatistiky (efekt tech uzla, §10): `op` + `value` pre (`target`, `id` defu, `stat`). */
export interface StatModifier {
  readonly target: StatTarget;
  /** Id defu (napr. `crane_container_gantry`). */
  readonly id: string;
  readonly stat: string;
  readonly op: StatOp;
  readonly value: number;
}

/** Tabuľka, ako operácia mení hodnotu. */
const STAT_OP_APPLY: { readonly [O in StatOp]: (value: number, operand: number) => number } = {
  add: (value, operand) => value + operand,
  mul: (value, operand) => value * operand,
};

/** `base` → všetky `add` → všetky `mul` (poradie `STAT_OPS`, v rámci operácie poradie zoznamu). */
export function applyStatModifiers(base: number, modifiers: readonly Pick<StatModifier, 'op' | 'value'>[]): number {
  let value = base;
  for (const op of STAT_OPS) {
    for (const modifier of modifiers) {
      if (modifier.op === op) value = STAT_OP_APPLY[op](value, modifier.value);
    }
  }
  return value;
}

/** Číselné polia tabuľky `MODULE_PARAM_SPECS[kind]` (`integer`/`number`). */
function isNumericParam(kind: ModuleKind, stat: string): boolean {
  const table: FieldRecord = MODULE_PARAM_SPECS[kind];
  const spec = Object.hasOwn(table, stat) ? table[stat] : undefined;
  return spec?.kind === 'integer' || spec?.kind === 'number';
}

type StatBase = (defs: DefRegistry, id: string, stat: string) => number;

/** Základ štatistiky podľa cieľa. Neznáme id → `DefError` katalógu; štatistika, ktorú druh nemá → `DefError`. */
const STAT_BASES: { readonly [T in StatTarget]: StatBase } = {
  module: (defs, id, stat) => {
    const def = defs.modules.get(id);
    const value = def.params[stat];
    if (!isNumericParam(def.kind, stat) || typeof value !== 'number') {
      throw new DefError('modules', '/items', `modul '${id}' (druh '${def.kind}') nemá číselný parameter '${stat}'`);
    }
    return value;
  },
};

export class StatResolver {
  private readonly defs: DefRegistry;
  private readonly modifiers: readonly StatModifier[];

  /** `modifiers` = aktívne efekty (vo F2 prázdne; tech tree ich dodá neskôr). */
  constructor(defs: DefRegistry, modifiers: readonly StatModifier[] = []) {
    this.defs = defs;
    this.modifiers = Object.freeze([...modifiers]);
  }

  /**
   * Hodnota štatistiky `stat` defu `id` cieľa `target` po modifikátoroch (§10: base → add → mul). Výsledok nie je
   * zaokrúhlený — celočíselné štatistiky (ticky) zaokrúhľuje ich spotrebiteľ. Chyby: neznáme id alebo štatistika →
   * `DefError`.
   */
  resolve<T extends StatTarget>(target: T, id: string, stat: StatTargets[T]): number {
    const base = STAT_BASES[target](this.defs, id, stat);
    const applicable = this.modifiers.filter((m) => m.target === target && m.id === id && m.stat === stat);
    return applyStatModifiers(base, applicable);
  }
}
