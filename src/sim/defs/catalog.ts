/**
 * Katalóg (ADR-009): zmrazený zoznam položiek defu s vyhľadávaním podľa `id`, plus generická validácia súboru
 * `{ schemaVersion, items: [...] }` (`validateCatalog`). Rozhranie `Catalog` je to, čo vidí zvyšok simu.
 */
import { DefError } from './def-error';
import {
  checkFields,
  describeValue,
  failWith,
  findUnknownKey,
  freezeCopy,
  isPlainObject,
  pointerSegment,
  type FieldRecord,
  type Problem,
} from './def-spec';
import { SUPPORTED_SCHEMA_VERSION } from './types';

/** Položka katalógu: má `id` (snake_case, jedinečné v rámci katalógu). */
export interface CatalogItem {
  readonly id: string;
}

export interface Catalog<T extends CatalogItem> {
  /** Položky v poradí zo súboru. */
  readonly items: readonly T[];
  /** Položka podľa `id`; neznáme `id` → `DefError`. */
  get(id: string): T;
  has(id: string): boolean;
}

class ItemCatalog<T extends CatalogItem> implements Catalog<T> {
  readonly items: readonly T[];
  private readonly byId: ReadonlyMap<string, T>;

  constructor(
    private readonly defName: string,
    items: readonly T[],
  ) {
    const byId = new Map<string, T>();
    items.forEach((item, index) => {
      const first = byId.get(item.id);
      if (first !== undefined) {
        throw new DefError(defName, `/items${pointerSegment(index)}/id`, `duplicitné id '${item.id}' (/items/${String(items.indexOf(first))}/id)`);
      }
      byId.set(item.id, item);
    });
    this.items = Object.freeze([...items]);
    this.byId = byId;
  }

  get(id: string): T {
    const item = this.byId.get(id);
    if (item === undefined) {
      throw new DefError(this.defName, '/items', `neznáme id '${id}' (známe: ${[...this.byId.keys()].join(', ')})`);
    }
    return item;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}

/** Katalóg z hotových položiek; duplicitné `id` → `DefError` na `/items/<index>/id`. */
export function createCatalog<T extends CatalogItem>(defName: string, items: readonly T[]): Catalog<T> {
  return new ItemCatalog(defName, items);
}

/** Kontrola položky nad rámec tabuľky polí (vzťahy medzi poľami, polia mimo tabuľky); `path` = `/items/<index>`. */
export type ItemCheck = (item: Readonly<Record<string, unknown>>, path: string) => Problem | undefined;

export interface CatalogSpec {
  /** Tabuľka polí položky (bez polí z `extraKeys`). */
  readonly fields: FieldRecord;
  /** Kľúče položky mimo `fields`, ktoré overuje `check` (napr. `params` podľa `kind`); inak by boli „neznáme“. */
  readonly extraKeys?: readonly string[];
  readonly check?: ItemCheck;
}

/**
 * Overí surový katalóg `{ schemaVersion, items }` a vráti zmrazený `Catalog`. Hlási prvý nájdený problém (`DefError`):
 * koreň → neznáme kľúče → `schemaVersion` → `items` (pole, ≥ 1) → každá položka v poradí (objekt, neznáme kľúče,
 * polia tabuľky v jej poradí, `check`) → duplicitné `id`. Vstup sa nemení ani nezmrazuje.
 *
 * Návratový typ `T` zaručuje volajúci: tabuľka `spec.fields` (+ `check` pre `extraKeys`) musí pokrývať každé pole `T`
 * — pri jej deklarácii to vynucuje `SpecTable<T>`. Po úspešnej validácii tvar zodpovedá `T`.
 */
export function validateCatalog<T extends CatalogItem>(defName: string, raw: unknown, spec: CatalogSpec): Catalog<Readonly<T>> {
  const fail = (problem: Problem): never => failWith(defName, problem);

  if (raw === undefined) return fail({ path: '', message: 'def chýba' });
  if (!isPlainObject(raw)) return fail({ path: '', message: `očakávaný objekt, dostal ${describeValue(raw)}` });

  const unknownKey = findUnknownKey(raw, new Set(['schemaVersion', 'items']), '');
  if (unknownKey) fail(unknownKey);

  const versionPath = pointerSegment('schemaVersion');
  if (!Object.hasOwn(raw, 'schemaVersion')) fail({ path: versionPath, message: 'chýba povinné pole' });
  if (raw['schemaVersion'] !== SUPPORTED_SCHEMA_VERSION) {
    fail({
      path: versionPath,
      message: `nepodporovaná verzia schémy, očakávaná ${String(SUPPORTED_SCHEMA_VERSION)}, dostal ${describeValue(raw['schemaVersion'])}`,
    });
  }

  const itemsPath = pointerSegment('items');
  if (!Object.hasOwn(raw, 'items')) fail({ path: itemsPath, message: 'chýba povinné pole' });
  const rawItems = raw['items'];
  if (!Array.isArray(rawItems)) return fail({ path: itemsPath, message: `očakávané pole, dostal ${describeValue(rawItems)}` });
  if (rawItems.length < 1) return fail({ path: itemsPath, message: 'pole musí mať aspoň 1 položku, má 0' });

  const known = new Set([...Object.keys(spec.fields), ...(spec.extraKeys ?? [])]);
  const items = rawItems.map((rawItem: unknown, index): T => {
    const path = `${itemsPath}${pointerSegment(index)}`;
    if (!isPlainObject(rawItem)) return fail({ path, message: `očakávaný objekt, dostal ${describeValue(rawItem)}` });
    const problem = findUnknownKey(rawItem, known, path) ?? checkFields(rawItem, spec.fields, path) ?? spec.check?.(rawItem, path);
    if (problem) return fail(problem);
    // Všetky polia prešli kontrolou a neznáme kľúče sú vylúčené, takže tvar zodpovedá `T` (viď dokumentáciu funkcie).
    return freezeCopy(rawItem) as T;
  });

  return createCatalog(defName, items);
}
