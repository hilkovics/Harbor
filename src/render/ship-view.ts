/**
 * ShipView (DESIGN_BRIEF §5.6): loď na mape — sprite `entities.ship_<classId>.variants.<variant>.{empty|loaded}`
 * z manifestu, predok hore pri `heading` 0, otočený okolo stredu.
 *
 * Variant paluby určuje kategória nákladu lode (`cargoCategory`), `loaded` platí, kým je na palube aspoň jedna jednotka.
 * **F6a:** keď VM nesie `cargoSplit` (import / export na palube) a trieda má v manifeste `deck`, kreslí sa sprite `empty` a náklad
 * sa skladá z kontajnerov podľa počtu jednotiek (`DeckCargo`, import oranžovo, export modro). Stav `lashing` ukáže odznak
 * s prstencom postupu (`LashingBadge`, vzpriamený, v strede lode).
 * Poloha je `lerp(prev, curr, alpha)` v bunkách × `--cell`. Loď bez sprite (trieda / variant chýba v manifeste alebo
 * textúra nie je načítaná) sa nakreslí ako trup z tokenov `--ship-hull` / `--ship-deck` so špicatým predkom.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { shipDeck, shipSprite } from './entity-assets';
import { LashingBadge, lashingProgress } from './lashing-badge';
import { DeckCargo } from './ship-deck';
import type { EntityTextures } from './sprite-atlas';
import type { EntityPalette } from './tokens';
import type { ShipVM } from './view-models';

/**
 * Variant paluby v manifeste podľa kategórie nákladu, v poradí preferencie (prvý, ktorý trieda lodí má):
 * `container → container`, `bulk → bulk`, `liquid → tanker`, `gas → gas` (ak ho trieda má, inak `tanker`), `roro → roro`.
 */
export const SHIP_VARIANT_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  container: ['container'],
  bulk: ['bulk'],
  liquid: ['tanker'],
  gas: ['gas', 'tanker'],
  roro: ['roro'],
};

/** Podiel šírky lode, ktorý zaberá špicatý predok fallbacku (bok trupu sa zužuje k predku). */
const FALLBACK_BOW_TAPER = 1;

/** Podiel šírky lode, o ktorý je paluba fallbacku užšia z každej strany. */
const FALLBACK_DECK_INSET = 0.12;

export type ShipLoad = 'empty' | 'loaded';

/** Variant sprite pre kategóriu nákladu z dostupných variantov triedy, alebo `undefined` (kategória / variant neznámy). */
export function shipVariantKey(cargoCategory: string, available: readonly string[]): string | undefined {
  const candidates = Object.hasOwn(SHIP_VARIANT_CANDIDATES, cargoCategory) ? SHIP_VARIANT_CANDIDATES[cargoCategory] : [];
  return candidates.find((variant) => available.includes(variant));
}

/** Stav paluby: `loaded`, kým je na lodi aspoň jedna jednotka nákladu. */
export function shipLoad(unitsOnBoard: number): ShipLoad {
  return unitsOnBoard > 0 ? 'loaded' : 'empty';
}

/** Súbor sprite lode (relatívne k `assets/`), alebo `undefined`, ak trieda / variant nie je v manifeste. */
export function shipSpriteFile(classId: string, cargoCategory: string, unitsOnBoard: number): string | undefined {
  const entry = shipSprite(classId);
  if (entry === undefined) return undefined;
  const variant = shipVariantKey(cargoCategory, Object.keys(entry.variants));
  if (variant === undefined) return undefined;
  return entry.variants[variant][shipLoad(unitsOnBoard)];
}

/** Lineárna interpolácia `a → b` v čase `t` (0…1). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface ShipPose {
  /** Stred lode vo svete (px). */
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch v smere hodinových ručičiek (0 = predok na sever). */
  readonly angle: number;
}

/** Poloha lode v čase `alpha` medzi predchádzajúcim a aktuálnym tickom, v px sveta. */
export function shipPose(vm: ShipVM, alpha: number, cellPx: number): ShipPose {
  return { x: lerp(vm.prevX, vm.x, alpha) * cellPx, y: lerp(vm.prevY, vm.y, alpha) * cellPx, angle: vm.heading };
}

/** Stav lode, v ktorom sa kreslí odznak lashingu (`ShipState` `lashing`, ADR-032 bod 12). */
export const LASHING_STATE = 'lashing';

/**
 * Kreslí sa náklad na palube po kontajneroch? Keď VM nesie `cargoSplit` a ide o kontajnerovú loď, ktorej trieda má v manifeste
 * `deck`; inak platí F2–F6 správanie (sprite `loaded` / `empty` podľa `unitsOnBoard`).
 */
export function hasDeckCargo(vm: ShipVM): boolean {
  return vm.cargoSplit !== undefined && vm.cargoCategory === 'container' && shipDeck(vm.classId) !== undefined;
}

/** Zobrazený stav paluby: pri kontajneroch na palube vždy `empty` (náklad sa kreslí navrch), inak podľa `unitsOnBoard`. */
export function shipDisplayLoad(vm: ShipVM): ShipLoad {
  return hasDeckCargo(vm) ? 'empty' : shipLoad(vm.unitsOnBoard);
}

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo). */
export function sameShipShape(a: ShipVM, b: ShipVM): boolean {
  return a.classId === b.classId && a.cargoCategory === b.cargoCategory && a.widthCells === b.widthCells && a.lengthCells === b.lengthCells;
}

export interface ShipViewDeps {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: EntityPalette;
  /** Textúry entít; `null` = vždy fallback `Graphics`. */
  readonly textures: EntityTextures | null;
  /** Násobok odznaku lashingu pre aktuálny zoom (`badgeScaleForZoom`); predvolene 1. */
  readonly badgeScale?: number;
}

export class ShipView {
  /** Koreň view: počiatok = stred lode vo svete (px), otočený o `heading`. */
  readonly view: Container;
  readonly id: number;
  private last: ShipVM;
  /** Sprite lode (`null` pri fallbacku). */
  private readonly sprite: Sprite | null;
  private readonly textures: { readonly empty: Texture; readonly loaded: Texture } | null;
  private load: ShipLoad;
  /** Kontajnery na palube (vznikne lenivo, keď VM nesie `cargoSplit`); `null` = bez nich. */
  private deck: DeckCargo | null = null;
  /** Odznak lashingu (vznikne lenivo pri prvom stave `lashing`). */
  private lashingBadge: LashingBadge | null = null;
  private badgeScale: number;

  constructor(
    vm: ShipVM,
    private readonly deps: ShipViewDeps,
    alpha = 1,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.badgeScale = deps.badgeScale ?? 1;
    this.view = new Container({ label: `ship-${String(vm.id)}` });
    this.load = shipDisplayLoad(vm);
    this.textures = this.resolveTextures(vm);
    if (this.textures !== null) {
      this.sprite = new Sprite(this.textures[this.load]);
      this.sprite.anchor.set(0.5);
      this.sprite.setSize(vm.widthCells * deps.cellPx, vm.lengthCells * deps.cellPx);
      this.view.addChild(this.sprite);
    } else {
      this.sprite = null;
      this.view.addChild(this.createFallback(vm));
    }
    this.update(vm, alpha);
  }

  get vm(): ShipVM {
    return this.last;
  }

  /** Aktuálna textúra sprite (`null` pri fallbacku) — pre testy. */
  get texture(): Texture | null {
    return this.sprite?.texture ?? null;
  }

  /** Kontajnery na palube (`null`, kým VM nenesie `cargoSplit`) — pre testy. */
  get deckCargo(): DeckCargo | null {
    return this.deck;
  }

  /** Odznak lashingu (`null`, kým loď nebola v `lashing`) — pre testy. */
  get lashing(): LashingBadge | null {
    return this.lashingBadge;
  }

  /** Odznak lashingu je viditeľný — pre testy. */
  get lashingVisible(): boolean {
    return this.lashingBadge?.visible === true;
  }

  /** Nastaví polohu (interpolovanú), rotáciu, stav paluby, kontajnery na palube a odznak lashingu. */
  update(vm: ShipVM, alpha: number): void {
    this.last = vm;
    const pose = shipPose(vm, alpha, this.deps.cellPx);
    if (this.view.x !== pose.x || this.view.y !== pose.y) this.view.position.set(pose.x, pose.y);
    if (this.view.angle !== pose.angle) this.view.angle = pose.angle;
    const load = shipDisplayLoad(vm);
    if (load !== this.load) {
      this.load = load;
      if (this.sprite !== null && this.textures !== null) this.sprite.texture = this.textures[load];
    }
    this.syncDeck(vm);
    this.syncLashing(vm, pose.angle);
  }

  /** Nastaví veľkosť odznaku lashingu podľa zoomu kamery (`badgeScaleForZoom`); platí aj pre odznak, ktorý ešte nevznikol. */
  setBadgeScale(scale: number): void {
    this.badgeScale = scale;
    this.lashingBadge?.scale.set(scale);
  }

  destroy(): void {
    this.deck = null;
    this.lashingBadge = null;
    this.view.destroy({ children: true });
  }

  /** Kontajnery na palube podľa `vm.cargoSplit` (vytvorí / zruší lenivo, prekreslí len pri zmene). */
  private syncDeck(vm: ShipVM): void {
    if (!hasDeckCargo(vm) || vm.cargoSplit === undefined) {
      if (this.deck !== null) {
        this.deck.destroy({ children: true });
        this.deck = null;
      }
      return;
    }
    if (this.deck === null) {
      this.deck = new DeckCargo(vm.classId, this.deps);
      this.view.addChildAt(this.deck, 1); // nad spritom / fallbackom, pod odznakom
    }
    this.deck.setCargo(vm.cargoSplit, vm.capacityUnits);
  }

  /** Odznak lashingu v stave `lashing`: vzpriamený (proti rotácii lode), prstenec podľa `vm.lashing`. */
  private syncLashing(vm: ShipVM, angle: number): void {
    if (vm.state !== LASHING_STATE) {
      if (this.lashingBadge !== null) this.lashingBadge.visible = false;
      return;
    }
    if (this.lashingBadge === null) {
      this.lashingBadge = new LashingBadge(this.deps);
      this.lashingBadge.scale.set(this.badgeScale);
      this.view.addChild(this.lashingBadge); // navrchu
    }
    this.lashingBadge.visible = true;
    if (this.lashingBadge.angle !== -angle) this.lashingBadge.angle = -angle;
    this.lashingBadge.setProgress(vm.lashing === undefined ? 0 : lashingProgress(vm.lashing.ticksLeft, vm.lashing.ticksTotal));
  }

  /** Textúry `empty` / `loaded` pre triedu a kategóriu lode, alebo `null` (fallback). */
  private resolveTextures(vm: ShipVM): { readonly empty: Texture; readonly loaded: Texture } | null {
    const empty = shipSpriteFile(vm.classId, vm.cargoCategory, 0);
    const loaded = shipSpriteFile(vm.classId, vm.cargoCategory, 1);
    if (empty === undefined || loaded === undefined) return null;
    const emptyTexture = this.deps.textures?.file(empty);
    const loadedTexture = this.deps.textures?.file(loaded);
    if (emptyTexture === undefined || loadedTexture === undefined) return null;
    return { empty: emptyTexture, loaded: loadedTexture };
  }

  /** Trup so špicatým predkom (hore) a paluba; rozmery z VM (`widthCells × lengthCells`). */
  private createFallback(vm: ShipVM): Graphics {
    const { cellPx, palette } = this.deps;
    const halfW = (vm.widthCells * cellPx) / 2;
    const halfL = (vm.lengthCells * cellPx) / 2;
    const taper = Math.min(halfL * 2, vm.widthCells * cellPx * FALLBACK_BOW_TAPER);
    const { hull, deck } = palette.ship;
    const graphics = new Graphics();
    graphics
      .poly([0, -halfL, halfW, -halfL + taper, halfW, halfL, -halfW, halfL, -halfW, -halfL + taper])
      .fill({ color: hull.color, alpha: hull.alpha });
    const inset = halfW * 2 * FALLBACK_DECK_INSET;
    graphics
      .rect(-halfW + inset, -halfL + taper, halfW * 2 - inset * 2, Math.max(0, halfL * 2 - taper - inset))
      .fill({ color: deck.color, alpha: deck.alpha });
    return graphics;
  }
}
