/**
 * Náklad na palube kontajnerovej lode podľa počtu jednotiek (F6a, ADR-032 bod 4, 11): import a export sa rozlišujú farbou
 * (`EntityPalette.direction`, tokeny `--cargo-container` / `--ui-accent`).
 *
 * Paluba má `bays × columns` miest (polia z `entities.ship_<classId>.deck` v manifeste, kontajner TEU leží dlhšou stranou pozdĺž
 * lode); kapacita lode (`capacityUnits`, desiatky až stovky jednotiek) je väčšia než počet miest, preto sa paluba kreslí ako
 * **podiel**: obsadí sa `⌈(import + export) / capacity × miest⌉` miest (aspoň jedno, kým je na palube niečo) a rozdelí sa medzi
 * smery pomerom jednotiek (každý smer s jednotkami má aspoň jedno miesto, ak sa zmestia obe). Import zaplňuje palubu od predku,
 * export od zadku, takže pri vykládke importu a nakládke exportu sa oba bloky vidia oddelene a nikdy sa neprekrývajú.
 *
 * Čisté funkcie (`deckSlots`, `deckFill`) bez Pixi a `DeckCargo`, ktorý ich kreslí do lokálneho rámca lode (počiatok = stred lode,
 * predok hore; rodič `ShipView` ju otáča o `heading`).
 */
import { Container, Graphics } from 'pixi.js';
import { MANIFEST_CELL_PX, manifestScale, shipDeck, shipSprite } from './entity-assets';
import type { EntityPalette } from './tokens';
import { TEU_PX } from './world-scale';

/** Hrúbka obrysu kontajnera ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Počet priečnych rebier na kontajneri (ako na sprite `container_teu`: dva pruhy). */
const RIB_COUNT = 2;

/** Miesto pre jeden kontajner na palube: stred (px sveta od stredu lode pri rot 0) a rozmer (naprieč × pozdĺž lode). */
export interface DeckSlot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Smer nákladu na palube. */
export type CargoDirection = 'import' | 'export';

/** Počty obsadených miest paluby podľa smeru. */
export interface DeckFill {
  readonly importSlots: number;
  readonly exportSlots: number;
}

/**
 * Miesta paluby lode triedy `classId` pre bunku `cellPx` v poradí od predku (pole 0, stĺpec 0) po zadok (posledné pole, posledný
 * stĺpec): stred poľa/stĺpca z manifestu, kontajner TEU (`TEU_PX`: dĺžka 64 px pozdĺž lode, šírka 26 px naprieč). `undefined`, ak
 * trieda v manifeste nemá `deck`.
 */
export function deckSlots(classId: string, cellPx: number): readonly DeckSlot[] | undefined {
  const entry = shipSprite(classId);
  const deck = shipDeck(classId);
  if (entry === undefined || deck === undefined) return undefined;
  const unit = manifestScale(cellPx);
  const centerX = (entry.footprint.w * MANIFEST_CELL_PX) / 2;
  const centerY = (entry.footprint.h * MANIFEST_CELL_PX) / 2;
  const slots: DeckSlot[] = [];
  for (const bay of deck.bays) {
    const columnWidth = bay.w / deck.columns;
    for (let column = 0; column < deck.columns; column++) {
      slots.push({
        x: (bay.x + (column + 0.5) * columnWidth - centerX) * unit,
        y: (bay.y + bay.h / 2 - centerY) * unit,
        w: Math.min(columnWidth, TEU_PX.h) * unit,
        h: Math.min(bay.h, TEU_PX.w) * unit,
      });
    }
  }
  return slots;
}

/** `⌊a / b⌉` s polovicou nadol (zhoda ide v prospech importu), celočíselne a presne. */
function roundHalfDown(a: number, b: number): number {
  return Math.floor((2 * a + b - 1) / (2 * b));
}

/**
 * Koľko miest paluby (z `slotCount`) obsadí import a export pri `split` jednotkách na lodi s kapacitou `capacityUnits`: podiel
 * zaplnenia lode zaokrúhlený nahor (aspoň jedno miesto, kým je na palube jednotka), rozdelenie pomerom smerov, každý neprázdny
 * smer aspoň jedno miesto (pri jedinom mieste ho dostane väčší smer, pri zhode a pri polovici import). Súčet je vždy `≤ slotCount`.
 */
export function deckFill(split: { readonly import: number; readonly export: number }, capacityUnits: number, slotCount: number): DeckFill {
  const imports = Math.max(0, Math.floor(split.import));
  const exports = Math.max(0, Math.floor(split.export));
  const total = imports + exports;
  if (total === 0 || slotCount <= 0) return { importSlots: 0, exportSlots: 0 };
  const share = capacityUnits > 0 ? Math.ceil((total * slotCount) / capacityUnits) : total; // celočíselne: bez chyby `(a / b) * c`
  const lit = Math.min(slotCount, Math.max(1, share));
  if (exports === 0) return { importSlots: lit, exportSlots: 0 };
  if (imports === 0) return { importSlots: 0, exportSlots: lit };
  if (lit === 1) return exports > imports ? { importSlots: 0, exportSlots: 1 } : { importSlots: 1, exportSlots: 0 };
  const exportSlots = Math.min(lit - 1, Math.max(1, roundHalfDown(lit * exports, total)));
  return { importSlots: lit - exportSlots, exportSlots };
}

/** Rozmiestnenie obsadených miest: import od predku (indexy `0 … importSlots − 1`), export od zadku (posledných `exportSlots`). */
export function deckDirections(fill: DeckFill, slotCount: number): readonly (CargoDirection | null)[] {
  const result: (CargoDirection | null)[] = Array.from({ length: slotCount }, () => null);
  for (let index = 0; index < Math.min(fill.importSlots, slotCount); index++) result[index] = 'import';
  for (let index = 0; index < Math.min(fill.exportSlots, slotCount); index++) result[slotCount - 1 - index] = 'export';
  return result;
}

/** Čo `DeckCargo` potrebuje od rendereru. */
export interface DeckCargoDeps {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: EntityPalette;
}

/** Kontajnery na palube lode: jeden `Graphics`, prekreslený len pri zmene obsadenia. */
export class DeckCargo extends Container {
  private readonly slots: readonly DeckSlot[];
  private readonly graphics = new Graphics();
  private fill: DeckFill = { importSlots: 0, exportSlots: 0 };
  private drawn = '';

  constructor(
    classId: string,
    private readonly deps: DeckCargoDeps,
  ) {
    super({ label: 'ship-deck-cargo' });
    this.slots = deckSlots(classId, deps.cellPx) ?? [];
    this.addChild(this.graphics);
  }

  /** Počet miest paluby. */
  get slotCount(): number {
    return this.slots.length;
  }

  /** Aktuálne obsadenie (testy). */
  get currentFill(): DeckFill {
    return this.fill;
  }

  /** Smer nákladu na každom mieste (`null` = prázdne miesto) — pre testy. */
  get directions(): readonly (CargoDirection | null)[] {
    return deckDirections(this.fill, this.slots.length);
  }

  /** Nastaví náklad lode; prekreslí len pri zmene počtu obsadených miest. */
  setCargo(split: { readonly import: number; readonly export: number }, capacityUnits: number): void {
    const fill = deckFill(split, capacityUnits, this.slots.length);
    const key = `${String(fill.importSlots)}/${String(fill.exportSlots)}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.fill = fill;
    this.redraw(deckDirections(fill, this.slots.length));
  }

  private redraw(directions: readonly (CargoDirection | null)[]): void {
    const { cellPx, palette } = this.deps;
    const outline = OUTLINE_CELLS * cellPx;
    this.graphics.clear();
    directions.forEach((direction, index) => {
      if (direction === null) return;
      const slot = this.slots[index];
      const colors = palette.direction[direction];
      const left = slot.x - slot.w / 2;
      const top = slot.y - slot.h / 2;
      this.graphics
        .rect(left, top, slot.w, slot.h)
        .fill({ color: colors.base.color, alpha: colors.base.alpha })
        .stroke({ width: outline, color: colors.dark.color, alpha: colors.dark.alpha, alignment: 1 });
      for (let rib = 1; rib <= RIB_COUNT; rib++) {
        const y = top + (slot.h * rib) / (RIB_COUNT + 1);
        this.graphics.moveTo(left + outline, y).lineTo(left + slot.w - outline, y).stroke({ width: outline / 2, color: colors.dark.color, alpha: colors.dark.alpha });
      }
    });
  }
}
