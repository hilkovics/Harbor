/**
 * VehicleView (DESIGN_BRIEF §5.6): vozidlo na cestách — sprite `entities.<defId>.states.{empty|loaded}` z manifestu,
 * predok hore pri `heading` 0, otočený okolo stredu vozidla.
 *
 * Poloha je v bunkách × `--cell` (stred vozidla; stred bunky = `x + 0,5`). Sim vedie vozidlo stredom bunky, pruh je
 * prezentačný (`lane.ts`): na dvojpruhovej ceste sa vozidlo posunie kolmo na smer jazdy vpravo o `VEHICLE_OFFSET_CELLS`
 * (stred pruhu, najviac rezerva asfaltu), na jednopruhovej (`one_lane`, `one_way`) jazdí v strede. Sprite má rozmer
 * `footprint` z manifestu × `VEHICLE_SCALE` (jediná mierka vozidiel; kontajner na vozidle je rovnako veľký ako na aprone).
 *
 * **Priama jazda:** `lerp(prev, curr, alpha)` + posun pruhu; posun sa mieša podľa typu cesty pod predchádzajúcou a pod
 * aktuálnou polohou (prechod dvojpruhová → jednopruhová sa nerobí skokom).
 *
 * **Zákruta:** sim mení kurz skokom v strede bunky zákruty (`Vehicle.advance`: kurz podľa úseku `cell → nextCell`), takže
 * `prevHeading ≠ heading` platí len v jedinom ticku a vozidlo pred stredom bunky ešte kurz zákruty nemá. Renderer preto
 * berie zákrutu z tvaru cesty (`RoadMaskAt`: bunka s dvoma kolmými susedmi) a v jej vnútri vedie vozidlo po oblúku
 * (`turn-arc.ts`) podľa POLOHY: parameter oblúka je podiel dráhy v bunke (hrana → stred → hrana), nie `alpha` ticku.
 * V ticku, v ktorom sa kurz zmenil, sa dráha ticku rekonštruuje ako písmeno L cez stred bunky (`prev → stred → curr`),
 * nie ako úsečka `prev → curr`, ktorá by zákrutu rezala. Uhol spritu sa plynulo otáča z kurzu vstupu na kurz výstupu.
 * Zmena kurzu inde než v zákrute (križovatka, obrat) sa rieši ako predtým: pruh sa interpoluje medzi predchádzajúcim
 * a aktuálnym úsekom a uhol sa otáča najkratším oblúkom počas ticku.
 *
 * `loaded` platí, kým vozidlo vezie jednotku nákladu (kontajner medzi nohami je súčasť spritu).
 * Vozidlo bez sprite (def chýba v manifeste / textúra nie je načítaná) sa nakreslí ako telo z tokenov `--vehicle-body`
 * s obrysom `--vehicle-dark` a tmavým pruhom na predku, aby bol vidieť smer jazdy; má rovnakú mierku ako sprite.
 *
 * Rovnaký pohyb (`vehiclePose`: pruhy, oblúky) a sprite používa aj `TruckView` (F4) — líši sa len štýl (`VehicleViewStyle`:
 * prefix `label` a farby fallbacku) a rozmer, ktorý sa berie z `entities.<defId>.footprint` (kamión 1×2, vozidlo 1×1).
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { Point } from './camera';
import { vehicleSprite, type CellSize } from './entity-assets';
import {
  VEHICLE_SCALE,
  defaultRoadKindAt,
  forwardOf,
  laneMagnitude,
  laneOffset,
  noRoadMaskAt,
  rightOf,
  type RoadKindAt,
  type RoadMaskAt,
} from './lane';
import { lerp } from './ship-view';
import type { EntityTextures } from './sprite-atlas';
import type { ColorValue, EntityPalette } from './tokens';
import { cornerAlpha, cornerTurn, isQuarterTurn, lerpHeading, turnArcPose } from './turn-arc';
import type { VehicleVM, ViewRotation } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja bunky (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Rozmer fallbacku vozidla bez záznamu v manifeste (bunky); vozidlo so záznamom berie `footprint` z manifestu. */
const FALLBACK_FOOTPRINT: CellSize = { w: 1, h: 1 };

/** Výška tmavého pruhu na predku fallbacku ako podiel dĺžky vozidla. */
const FALLBACK_FRONT_STRIPE = 0.2;

/** Štýl view: prefix `label` kontajnera a farby fallbacku (telo, obrys, pruh na predku). */
export interface VehicleViewStyle {
  readonly label: string;
  readonly fallback: (palette: EntityPalette) => { readonly body: ColorValue; readonly outline: ColorValue; readonly front: ColorValue };
}

/** Štýl vozidla na cestách: žlté telo s tmavým obrysom a tmavým pruhom na predku. */
export const VEHICLE_STYLE: VehicleViewStyle = {
  label: 'vehicle',
  fallback: (palette) => ({ body: palette.vehicle.body, outline: palette.vehicle.dark, front: palette.vehicle.dark }),
};

export type VehicleLoad = 'empty' | 'loaded';

/** Stav sprite podľa toho, či vozidlo vezie náklad. */
export function vehicleLoad(loaded: boolean): VehicleLoad {
  return loaded ? 'loaded' : 'empty';
}

/** Súbor sprite vozidla (relatívne k `assets/`), alebo `undefined`, ak def nie je vozidlo v manifeste. */
export function vehicleSpriteFile(defId: string, loaded: boolean): string | undefined {
  return vehicleSprite(defId)?.states[vehicleLoad(loaded)];
}

export interface VehiclePose {
  /** Stred vozidla vo svete (px). */
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch v smere hodinových ručičiek (0 = predok na sever). */
  readonly angle: number;
}

/** Tolerancia, s ktorou je bod „v strede bunky“ (sim ho počíta ako `cx + 0,5`, takže je presný; rezerva pre ručné VM). */
const CENTER_TOLERANCE = 1e-6;

/** Bod dráhy vozidla vo svete simu (bunky) a kurz, ktorým tam vozidlo ide. */
interface TravelPoint extends Point {
  readonly heading: ViewRotation;
}

/**
 * Stred bunky zákruty (koleno písmena L), cez ktorý prešlo vozidlo v ticku `prev → curr` so zmenou kurzu o 90°, alebo
 * `null`. Koleno je priesečník osi predchádzajúceho úseku (cez `prev` v smere `prevHeading`) a osi aktuálneho úseku
 * (cez `curr` v smere `heading`); musí byť stredom bunky, ležať pred vozidlom na oboch úsekoch a bunka musí byť podľa
 * `roadMaskAt` zákruta s rovnakým vstupným a výstupným kurzom. Inak (križovatka, obrat, nesúlad s cestou) `null`.
 */
function turnKnee(vm: VehicleVM, prevHeading: ViewRotation, roadMaskAt: RoadMaskAt): Point | null {
  if (!isQuarterTurn(prevHeading, vm.heading)) return null;
  const vertical = prevHeading === 0 || prevHeading === 180;
  const x = vertical ? vm.prevX : vm.x;
  const y = vertical ? vm.y : vm.prevY;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (Math.abs(x - (cellX + 0.5)) > CENTER_TOLERANCE || Math.abs(y - (cellY + 0.5)) > CENTER_TOLERANCE) return null;
  const inbound = forwardOf(prevHeading);
  const outbound = forwardOf(vm.heading);
  if ((x - vm.prevX) * inbound.x + (y - vm.prevY) * inbound.y < -CENTER_TOLERANCE) return null;
  if ((vm.x - x) * outbound.x + (vm.y - y) * outbound.y < -CENTER_TOLERANCE) return null;
  const turn = cornerTurn(roadMaskAt(cellX, cellY), prevHeading);
  if (turn === null || turn.to !== vm.heading) return null;
  return { x, y };
}

/** Bod dráhy v čase `alpha`: úsečka `prev → curr`, alebo pri zákrute lomená čiara `prev → koleno → curr` (rovnomerne). */
function travelPoint(vm: VehicleVM, prevHeading: ViewRotation, knee: Point | null, alpha: number): TravelPoint {
  if (knee === null) {
    return { x: lerp(vm.prevX, vm.x, alpha), y: lerp(vm.prevY, vm.y, alpha), heading: vm.heading };
  }
  const first = Math.abs(knee.x - vm.prevX) + Math.abs(knee.y - vm.prevY);
  const second = Math.abs(vm.x - knee.x) + Math.abs(vm.y - knee.y);
  const distance = alpha * (first + second);
  if (distance < first) {
    const share = distance / first;
    return { x: vm.prevX + (knee.x - vm.prevX) * share, y: vm.prevY + (knee.y - vm.prevY) * share, heading: prevHeading };
  }
  const share = second === 0 ? 0 : (distance - first) / second;
  return { x: knee.x + (vm.x - knee.x) * share, y: knee.y + (vm.y - knee.y) * share, heading: vm.heading };
}

/**
 * Poloha vozidla v čase `alpha` medzi predchádzajúcim a aktuálnym tickom, v px sveta (podrobnosti v hlavičke súboru):
 *  - priama jazda: `lerp(prev, curr, alpha)` + posun pruhu (`lane.ts`), typ cesty z bunky pod predchádzajúcou a pod
 *    aktuálnou polohou (`roadKindAt`), `prevHeading` chýbajúci vo VM = `heading`;
 *  - bunka so zákrutou (`roadMaskAt`: dvaja kolmí susedia): oblúk `turnArcPose` s parametrom podľa polohy v bunke;
 *  - zmena kurzu mimo zákruty: `lerp(prev + pruh(prevHeading), curr + pruh(heading), alpha)`, uhol najkratším oblúkom.
 * Bez `roadMaskAt` (predvolene) sa oblúky nekreslia.
 */
export function vehiclePose(
  vm: VehicleVM,
  alpha: number,
  cellPx: number,
  roadKindAt: RoadKindAt = defaultRoadKindAt,
  roadMaskAt: RoadMaskAt = noRoadMaskAt,
): VehiclePose {
  const prevHeading = vm.prevHeading ?? vm.heading;
  const kindFrom = roadKindAt(Math.floor(vm.prevX), Math.floor(vm.prevY));
  const kindTo = roadKindAt(Math.floor(vm.x), Math.floor(vm.y));
  const turned = prevHeading !== vm.heading;
  const knee = turned ? turnKnee(vm, prevHeading, roadMaskAt) : null;
  if (turned && knee === null) {
    // zmena kurzu mimo zákruty: pruh sa interpoluje medzi predchádzajúcim a aktuálnym úsekom
    const from = laneOffset(kindFrom, prevHeading);
    const to = laneOffset(kindTo, vm.heading);
    return {
      x: lerp(vm.prevX + from.x, vm.x + to.x, alpha) * cellPx,
      y: lerp(vm.prevY + from.y, vm.y + to.y, alpha) * cellPx,
      angle: lerpHeading(prevHeading, vm.heading, alpha),
    };
  }
  const at = travelPoint(vm, prevHeading, knee, alpha);
  const right = rightOf(at.heading);
  const lane = lerp(laneMagnitude(kindFrom), laneMagnitude(kindTo), alpha);
  let x = at.x + right.x * lane;
  let y = at.y + right.y * lane;
  let angle: number = at.heading;
  const cellX = Math.floor(at.x);
  const cellY = Math.floor(at.y);
  const turn = cornerTurn(roadMaskAt(cellX, cellY), at.heading);
  if (turn !== null) {
    // Oblúk začína a končí na hrane bunky v strede pruhu tejto bunky; zvyšok miešania typov (`lane` − vlastný posun)
    // sa pripočíta, takže pri rôznych typoch susedných ciest nevzniká skok.
    const center: Point = { x: cellX + 0.5, y: cellY + 0.5 };
    const kind = roadKindAt(cellX, cellY);
    const arc = turnArcPose(kind, turn.from, turn.to, cornerAlpha(at, center, at.heading));
    const rest = lane - laneMagnitude(kind);
    x = center.x + arc.x + rest * right.x;
    y = center.y + arc.y + rest * right.y;
    angle = arc.angle;
  }
  return { x: x * cellPx, y: y * cellPx, angle };
}

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo): poloha a kurz sa menia každý tick, def nie. */
export function sameVehicleShape(a: VehicleVM, b: VehicleVM): boolean {
  return a.defId === b.defId;
}

/**
 * „Režisér“ pózy: nadstavba nad bežnou pózou zo simu, ktorá môže zobrazenú pózu nahradiť prezentačným manévrom (kamión pri
 * rampe, `dock-maneuver.ts`). Dostane VM, `alpha` a funkciu `poseOf` (bežná póza ľubovoľného VM, napr. východiskovej polohy).
 */
export interface PoseDirector {
  pose(vm: VehicleVM, alpha: number, poseOf: (vm: VehicleVM, alpha: number) => VehiclePose): VehiclePose;
}

export interface VehicleViewDeps {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: EntityPalette;
  /** Textúry entít; `null` = vždy fallback `Graphics`. */
  readonly textures: EntityTextures | null;
  /** Typ cesty v bunke (pruh vozidla, `lane.ts`); `WorldRenderer` ho čerpá z gridu, predvolene všade `two_lane`. */
  readonly roadKindAt?: RoadKindAt;
  /** Maska susedov cestnej bunky (zákruty, `lane.ts`); `WorldRenderer` ju čerpá z gridu, predvolene bez oblúkov. */
  readonly roadMaskAt?: RoadMaskAt;
  /** Hodiny v ms pre manéver kamióna pri rampe (`dock-maneuver.ts`); predvolene `performance.now`, v testoch riadené. */
  readonly now?: () => number;
}

export class VehicleView {
  /** Koreň view: počiatok = stred vozidla vo svete (px), otočený o `heading`. */
  readonly view: Container;
  readonly id: number;
  private last: VehicleVM;
  /** Sprite vozidla (`null` pri fallbacku). */
  private readonly sprite: Sprite | null;
  private readonly textures: { readonly empty: Texture; readonly loaded: Texture } | null;
  private load: VehicleLoad;
  private readonly roadKindAt: RoadKindAt;
  private readonly roadMaskAt: RoadMaskAt;

  constructor(
    vm: VehicleVM,
    private readonly deps: VehicleViewDeps,
    alpha = 1,
    private readonly style: VehicleViewStyle = VEHICLE_STYLE,
    private readonly director: PoseDirector | null = null,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.roadKindAt = deps.roadKindAt ?? defaultRoadKindAt;
    this.roadMaskAt = deps.roadMaskAt ?? noRoadMaskAt;
    this.view = new Container({ label: `${style.label}-${String(vm.id)}` });
    this.load = vehicleLoad(vm.loaded);
    this.textures = this.resolveTextures(vm.defId);
    const entry = vehicleSprite(vm.defId);
    if (this.textures !== null && entry !== undefined) {
      this.sprite = new Sprite(this.textures[this.load]);
      this.sprite.anchor.set(0.5);
      this.sprite.setSize(entry.footprint.w * deps.cellPx * VEHICLE_SCALE, entry.footprint.h * deps.cellPx * VEHICLE_SCALE);
      this.view.addChild(this.sprite);
    } else {
      this.sprite = null;
      this.view.addChild(this.createFallback(entry?.footprint ?? FALLBACK_FOOTPRINT));
    }
    this.update(vm, alpha);
  }

  get vm(): VehicleVM {
    return this.last;
  }


  /** Aktuálna textúra sprite (`null` pri fallbacku) — pre testy. */
  get texture(): Texture | null {
    return this.sprite?.texture ?? null;
  }

  /** Nastaví polohu (interpolovanú), kurz a stav naloženia. Pre nezmenený stav nič nealokuje. */
  update(vm: VehicleVM, alpha: number): void {
    this.last = vm;
    const pose = this.director === null ? this.simPose(vm, alpha) : this.director.pose(vm, alpha, (other, at) => this.simPose(other, at));
    if (this.view.x !== pose.x || this.view.y !== pose.y) this.view.position.set(pose.x, pose.y);
    if (this.view.angle !== pose.angle) this.view.angle = pose.angle;
    const load = vehicleLoad(vm.loaded);
    if (load !== this.load) {
      this.load = load;
      if (this.sprite !== null && this.textures !== null) this.sprite.texture = this.textures[load];
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** Póza vozidla podľa simu (pruh, oblúky) v čase `alpha` (px sveta). */
  private simPose(vm: VehicleVM, alpha: number): VehiclePose {
    return vehiclePose(vm, alpha, this.deps.cellPx, this.roadKindAt, this.roadMaskAt);
  }

  /** Textúry `empty` / `loaded` pre vozidlo, alebo `null` (fallback). */
  private resolveTextures(defId: string): { readonly empty: Texture; readonly loaded: Texture } | null {
    const entry = vehicleSprite(defId);
    if (entry === undefined) return null;
    const empty = this.deps.textures?.file(entry.states.empty);
    const loaded = this.deps.textures?.file(entry.states.loaded);
    if (empty === undefined || loaded === undefined) return null;
    return { empty, loaded };
  }

  /** Telo z tokenov s pruhom na predku (hore); rozmer `footprint` (vozidlo 1×1, kamión 1×2), v mierke pruhu. */
  private createFallback(footprint: CellSize): Graphics {
    const { cellPx, palette } = this.deps;
    const width = footprint.w * cellPx;
    const height = footprint.h * cellPx;
    const inset = FALLBACK_INSET_CELLS * cellPx;
    const { body, outline, front } = this.style.fallback(palette);
    const left = -width / 2 + inset;
    const top = -height / 2 + inset;
    const bodyWidth = width - inset * 2;
    const bodyHeight = height - inset * 2;
    const graphics = new Graphics();
    graphics
      .rect(left, top, bodyWidth, bodyHeight)
      .fill({ color: body.color, alpha: body.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: outline.color, alpha: outline.alpha, alignment: 1 });
    graphics.rect(left, top, bodyWidth, bodyHeight * FALLBACK_FRONT_STRIPE).fill({ color: front.color, alpha: front.alpha });
    graphics.scale.set(VEHICLE_SCALE); // rovnaká mierka ako sprite
    return graphics;
  }
}
