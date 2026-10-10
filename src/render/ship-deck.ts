/**
 * Náklad na palube kontajnerovej lode podľa počtu jednotiek (F6a, ADR-032 bod 4, 11; F6c, ADR-034): import, export a prázdne
 * kontajnery sa rozlišujú farbou (`EntityPalette.direction`, tokeny `--cargo-import` / `--cargo-export` / `--cargo-empty`).
 *
 * Paluba má `bays × columns` miest (polia z `entities.ship_<classId>.deck` v manifeste, kontajner TEU leží dlhšou stranou pozdĺž
 * lode); kapacita lode (`capacityUnits`, desiatky až stovky jednotiek) je väčšia než počet miest, preto sa paluba kreslí ako
 * **podiel**: obsadí sa `⌈(import + export + prázdne) / capacity × miest⌉` miest (aspoň jedno, kým je na palube niečo) a rozdelí sa
 * medzi smery pomerom jednotiek (každý smer s jednotkami má aspoň jedno miesto, ak sa zmestia všetky). Import zaplňuje palubu od
 * predku, export od zadku a prázdne tesne pred exportom (nakladajú sa po plných, stowage ADR-034 bod 10), takže pri vykládke importu
 * a nakládke exportu a prázdnych sa bloky vidia oddelene a nikdy sa neprekrývajú. Prekládka (`tranship`) sa do počtov zarátava
 * ako import (loď A) / export (loď B) — rozhoduje `SimBridge`.
 *
 * Čisté funkcie (`deckSlots`, `deckFill`) bez Pixi a `DeckCargo`, ktorý ich kreslí do lokálneho rámca lode (počiatok = stred lode,
 * predok hore; rodič `ShipView` ju otáča o `heading`).
 */
import { Container, Graphics } from 'pixi.js';
import { drawContainerBox } from './container-box';
import { MANIFEST_CELL_PX, manifestScale, shipDeck, shipSprite } from './entity-assets';
import type { EntityPalette } from './tokens';
import { TEU_PX } from './world-scale';

/** Hrúbka obrysu kontajnera ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Miesto pre jeden kontajner na palube: stred (px sveta od stredu lode pri rot 0) a rozmer (naprieč × pozdĺž lode). */
export interface DeckSlot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Smer nákladu na palube (prekládka sa kreslí ako import / export podľa lode). */
export type CargoDirection = 'import' | 'export' | 'empty';

/** Počty obsadených miest paluby podľa smeru. */
export interface DeckFill {
  readonly importSlots: number;
  readonly exportSlots: number;
  readonly emptySlots: number;
}

/** Náklad lode podľa smeru v jednotkách (`ShipVM.cargoSplit`); `empty` chýba = žiadne prázdne kontajnery. */
export interface DeckSplit {
  readonly import: number;
  readonly export: number;
  readonly empty?: number;
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

/** Žiadne obsadené miesta. */
const NO_FILL: DeckFill = { importSlots: 0, exportSlots: 0, emptySlots: 0 };

/**
 * Koľko miest paluby (z `slotCount`) obsadí import, export a prázdne kontajnery pri `split` jednotkách na lodi s kapacitou
 * `capacityUnits`: podiel zaplnenia lode zaokrúhlený nahor (aspoň jedno miesto, kým je na palube jednotka), rozdelenie pomerom
 * smerov, každý neprázdny smer aspoň jedno miesto. Ak miest nestačí pre všetky smery, dostanú po jednom tie s najväčším počtom
 * (pri zhode import, prázdne, export). Export sa zaokrúhľuje prvý (polovica nadol), zvyšok si delia prázdne a import rovnakým
 * pravidlom; bez prázdnych je výsledok rovnaký ako pri dvoch smeroch (F6a). Súčet je vždy `≤ slotCount`.
 */
export function deckFill(split: DeckSplit, capacityUnits: number, slotCount: number): DeckFill {
  const imports = Math.max(0, Math.floor(split.import));
  const exports = Math.max(0, Math.floor(split.export));
  const empties = Math.max(0, Math.floor(split.empty ?? 0));
  const total = imports + exports + empties;
  if (total === 0 || slotCount <= 0) return NO_FILL;
  const share = capacityUnits > 0 ? Math.ceil((total * slotCount) / capacityUnits) : total; // celočíselne: bez chyby `(a / b) * c`
  const lit = Math.min(slotCount, Math.max(1, share));
  const kinds = (imports > 0 ? 1 : 0) + (exports > 0 ? 1 : 0) + (empties > 0 ? 1 : 0);
  if (lit < kinds) {
    // po jednom miesto pre `lit` najpočetnejších smerov (pri zhode import, prázdne, export)
    const ranked = (
      [
        ['import', imports],
        ['empty', empties],
        ['export', exports],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, lit)
      .map(([direction]) => direction);
    return { importSlots: ranked.includes('import') ? 1 : 0, exportSlots: ranked.includes('export') ? 1 : 0, emptySlots: ranked.includes('empty') ? 1 : 0 };
  }
  const exportSlots = exports === 0 ? 0 : Math.min(lit - (kinds - 1), Math.max(1, roundHalfDown(lit * exports, total)));
  const rest = lit - exportSlots;
  if (empties === 0) return { importSlots: rest, exportSlots, emptySlots: 0 };
  if (imports === 0) return { importSlots: 0, exportSlots, emptySlots: rest };
  const emptySlots = Math.min(rest - 1, Math.max(1, roundHalfDown(rest * empties, imports + empties)));
  return { importSlots: rest - emptySlots, exportSlots, emptySlots };
}

/**
 * Rozmiestnenie obsadených miest: import od predku (indexy `0 … importSlots − 1`), export od zadku (posledných `exportSlots`) a prázdne
 * tesne pred exportom (nakladajú sa po plných). Pri nedostatku miest majú prednosť import a export, prázdne sa neprekryjú.
 */
export function deckDirections(fill: DeckFill, slotCount: number): readonly (CargoDirection | null)[] {
  const result: (CargoDirection | null)[] = Array.from({ length: slotCount }, () => null);
  for (let index = 0; index < Math.min(fill.importSlots, slotCount); index++) result[index] = 'import';
  for (let index = 0; index < Math.min(fill.exportSlots, slotCount); index++) result[slotCount - 1 - index] = 'export';
  for (let index = 0; index < fill.emptySlots; index++) {
    const at = slotCount - 1 - fill.exportSlots - index;
    if (at >= 0 && result[at] === null) result[at] = 'empty';
  }
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
  private fill: DeckFill = NO_FILL;
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
  setCargo(split: DeckSplit, capacityUnits: number): void {
    const fill = deckFill(split, capacityUnits, this.slots.length);
    const key = `${String(fill.importSlots)}/${String(fill.exportSlots)}/${String(fill.emptySlots)}`;
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
      drawContainerBox(this.graphics, { left: slot.x - slot.w / 2, top: slot.y - slot.h / 2, w: slot.w, h: slot.h }, colors, outline, 'y');
    });
  }
}
