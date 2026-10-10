/**
 * TrainView (R6, TR6-03): vlak = lokomotíva a vagóny 60′ (`entities.locomotive`, `entities.wagon_container_60`) kreslené kĺbovo — každý voz
 * (`TrainCarVM`) má vlastný stred `x`,`y` (bunky) a `angle`, takže sa vlak v oblúku koľaje láme voz po voze. Sprite sa kladie pivotom (stred vozňa) na stred.
 *
 * Kontajnery na vagóne (`cargo`) idú od predku do slotov z manifestu: 20′ = jedna tretina (`slots20`), 40′ = dve tretiny (`slot40` pri začiatku, inak rozsah
 * tretín), spolu max 3 TEU. Kontajner leží dlhšou stranou pozdĺž vozňa (`CargoSprite` + 90°). Bez textúry: obdĺžniky z tokenov (`--truck-cab`, `--truck-trailer`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { CargoSprite, type CargoSpriteDeps } from './cargo-sprite';
import { containerKey } from './container-sprites';
import { MANIFEST_CELL_PX, locomotiveSprite, manifestScale, wagonSprite, type TrainCarSprite, type WagonSprite } from './entity-assets';
import type { ContainerVM, TrainCarVM, TrainVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px). */
const OUTLINE_CELLS = 2 / 64;

/** Počet tretín (20′ slotov) na vagóne 60′. */
export const WAGON_THIRDS = 3;

/** Uhol kontajnera, aby ležal dlhšou stranou pozdĺž vozňa. */
const CARGO_ALONG_CAR_DEG = 90;

/** Pozícia kontajnera na vagóne: stred v px súboru vagóna po osi vozňa (od predku) a veľkosť. */
export interface WagonSlot {
  readonly centerY: number;
  readonly sizeFt: 20 | 40;
}

/**
 * Rozloženie kontajnerov `cargo` na vagón od predku: 20′ zaberie 1 tretinu, 40′ 2; čo sa nezmestí (viac ako 3 TEU), sa vynechá. 40′ na začiatku stojí
 * na `slot40`, inak na rozsahu zaberaných tretín.
 */
export function wagonSlots(cargo: readonly ContainerVM[], sprite: Pick<WagonSprite, 'slots20' | 'slot40'>): WagonSlot[] {
  const slots: WagonSlot[] = [];
  let third = 0;
  for (const container of cargo) {
    const span = container.sizeFt === 40 ? 2 : 1;
    if (third + span > WAGON_THIRDS) break;
    const from = sprite.slots20[third];
    const to = sprite.slots20[third + span - 1];
    if (from === undefined || to === undefined) break;
    const range: readonly [number, number] = span === 2 && third === 0 ? sprite.slot40 : [from[0], to[1]];
    slots.push({ centerY: (range[0] + range[1]) / 2, sizeFt: container.sizeFt });
    third += span;
  }
  return slots;
}

/** Jeden voz: sprite (alebo fallback) a kontajnery. */
export class TrainCarView {
  readonly view = new Container();
  private readonly cargo = new Container({ label: 'train-cargo' });
  private cargoKey = '';
  private readonly cargoSprites: CargoSprite[] = [];

  constructor(
    readonly kind: TrainCarVM['kind'],
    private readonly id: number,
    private readonly deps: CargoSpriteDeps,
  ) {
    this.view.addChild(this.body());
    this.view.addChild(this.cargo);
  }

  /** Počet kontajnerov na voze (testy). */
  get containerCount(): number {
    return this.cargoSprites.length;
  }

  /** Stredy kontajnerov v px sveta od stredu vozňa po osi vozňa (testy). */
  get containerOffsets(): number[] {
    return this.cargoSprites.map((sprite) => sprite.y);
  }

  /** Voz je nakreslený spritom z manifestu (nie fallbackom) — testy. */
  get textured(): boolean {
    const part = this.kind === 'loco' ? locomotiveSprite() : wagonSprite();
    return part !== undefined && this.deps.textures?.file(part.file) !== undefined;
  }

  update(car: TrainCarVM): void {
    const { cellPx } = this.deps;
    this.view.position.set(car.x * cellPx, car.y * cellPx);
    this.view.angle = car.angle;
    this.syncCargo(car.cargo);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private syncCargo(cargo: readonly ContainerVM[]): void {
    const key = cargo.map((c) => containerKey(c)).join('|');
    if (key === this.cargoKey) return;
    this.cargoKey = key;
    for (const sprite of this.cargoSprites) sprite.destroy({ children: true });
    this.cargoSprites.length = 0;
    const wagon = wagonSprite();
    if (this.kind !== 'wagon' || wagon === undefined) return;
    const scale = manifestScale(this.deps.cellPx);
    const { cellPx, palette, textures } = this.deps;
    wagonSlots(cargo, wagon).forEach((slot, i) => {
      const container = cargo[i];
      if (container === undefined) return;
      const sprite = new CargoSprite(this.id, 'container_teu', { cellPx, palette, textures }, { container });
      sprite.angle = CARGO_ALONG_CAR_DEG;
      sprite.y = (slot.centerY - wagon.pivot.y) * scale;
      this.cargo.addChild(sprite);
      this.cargoSprites.push(sprite);
    });
  }

  private body(): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const part: TrainCarSprite | undefined = this.kind === 'loco' ? locomotiveSprite() : wagonSprite();
    const scale = manifestScale(cellPx);
    const size = part?.footprint ?? { w: 1, h: 3 };
    const width = size.w * cellPx;
    const height = size.h * cellPx;
    const x = -(part?.pivot.x ?? (size.w * MANIFEST_CELL_PX) / 2) * scale;
    const y = -(part?.pivot.y ?? (size.h * MANIFEST_CELL_PX) / 2) * scale;
    const texture = part === undefined ? undefined : textures?.file(part.file);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(x, y);
      sprite.setSize(width, height);
      return sprite;
    }
    const color = this.kind === 'loco' ? palette.truck.cab : palette.truck.trailer;
    const graphics = new Graphics();
    graphics
      .rect(x, y, width, height)
      .fill({ color: color.color, alpha: color.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha, alignment: 1 });
    return graphics;
  }
}

export class TrainView {
  /** Koreň: počiatok = počiatok sveta (vozy majú absolútne polohy). */
  readonly view = new Container();
  readonly id: number;
  private last: TrainVM;
  private cars: TrainCarView[] = [];

  constructor(
    vm: TrainVM,
    private readonly deps: CargoSpriteDeps,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.view.label = `train-${String(vm.id)}`;
    this.update(vm);
  }

  get vm(): TrainVM {
    return this.last;
  }

  /** Počet vozov (testy). */
  get carCount(): number {
    return this.cars.length;
  }

  /** View voza `index` (testy). */
  car(index: number): TrainCarView | undefined {
    return this.cars[index];
  }

  update(vm: TrainVM): void {
    this.last = vm;
    while (this.cars.length > vm.cars.length) this.cars.pop()?.destroy();
    vm.cars.forEach((car, i) => {
      let view: TrainCarView | undefined = this.cars[i];
      if (view !== undefined && view.kind !== car.kind) {
        view.destroy();
        view = undefined;
      }
      if (view === undefined) {
        view = new TrainCarView(car.kind, this.id, this.deps);
        this.cars[i] = view;
        this.view.addChild(view.view);
      }
      view.update(car);
    });
  }

  destroy(): void {
    this.cars = [];
    this.view.destroy({ children: true });
  }
}
