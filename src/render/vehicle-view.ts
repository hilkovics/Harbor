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
 * **R1 — kĺbové vozidlá po stope (ADR-037):** keď VM nesie `body` a nie je `offRoad`, sprite sa nekreslí na `x`, `y`, ale po stope
 * (`articulated-pose.ts`): predok je presne pri hlave, stred o polovicu dĺžky spritu späť v smere natočenia, natočenie podľa tetivy stopy a
 * posun do pravého pruhu kolmo na tetivu. Bez `body` (staré VM) a pri `offRoad` platí pohyb ako doteraz. Pri `blocked` (a nie `offRoad`)
 * pribudnú procedurálne brzdové svetlá (`--vehicle-brake`) pri zadnom okraji spritu.
 *
 * Rovnaký pohyb (`vehiclePose`: pruhy, oblúky) a sprite používa aj `TruckView` (F4) — líši sa len štýl (`VehicleViewStyle`:
 * prefix `label` a farby fallbacku) a rozmer, ktorý sa berie z `entities.<defId>.footprint` (kamión 1×2, vozidlo 1×1).
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { articulatedPose, blendedLaneMagnitude, shiftRight, trailAt } from './articulated-pose';
import type { Point } from './camera';
import { CargoSprite } from './cargo-sprite';
import { MANIFEST_CELL_PX, articulatedSprite, brakeLightsSprite, manifestScale, vehicleSprite, type ArticulatedSpriteEntry, type CellSize } from './entity-assets';
import {
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
import { STRADDLE_BODY_PX, VEHICLE_SCALE } from './world-scale';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja bunky (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Rozmer fallbacku vozidla bez záznamu v manifeste (bunky); vozidlo so záznamom berie `footprint` z manifestu. */
const FALLBACK_FOOTPRINT: CellSize = { w: 1, h: 1 };

/** Výška tmavého pruhu na predku fallbacku ako podiel dĺžky vozidla. */
const FALLBACK_FRONT_STRIPE = 0.2;

/** Typ nákladu kontajnera na vozidle (dočasne jediný sprite; typové kontajnery prídu v R2). */
const VEHICLE_CARGO_TYPE = 'container_teu';

/** Uhol, o ktorý sa kontajner otočí, aby ležal dlhšou stranou v smere jazdy (sprite nákladu má dlhšiu stranu pozdĺž x). */
const CARGO_ALONG_DEG = 90;

/**
 * Brzdové svetlo v px zdroja (bunka 64 px): obdĺžnik 4 × 3 px; odsadenie od bočného okraja vozidla a od zadného okraja.
 * `inset` je aj odsadenie svetiel v sprite `vehicle_brake_lights` od spodného okraja plátna.
 */
export const BRAKE_LIGHT_PX = Object.freeze({ w: 4, h: 3, inset: 2 });

/** Štýl view: prefix `label` kontajnera a farby fallbacku (telo, obrys, pruh na predku). */
export interface VehicleViewStyle {
  readonly label: string;
  /** Šírka tela fallbacku v px zdroja (reálna šírka vozidla, `world-scale.ts`); dĺžka je z `footprint`. */
  readonly widthPx: number;
  /** Dĺžka obsahu spritu v px zdroja (reálna dĺžka vozidla, `world-scale.ts`): zadný okraj, pri ktorom svietia brzdové svetlá. */
  readonly lengthPx: number;
  readonly fallback: (palette: EntityPalette) => { readonly body: ColorValue; readonly outline: ColorValue; readonly front: ColorValue };
}

/** Štýl vozidla na cestách: žlté telo s tmavým obrysom a tmavým pruhom na predku. */
export const VEHICLE_STYLE: VehicleViewStyle = {
  label: 'vehicle',
  widthPx: STRADDLE_BODY_PX.w,
  lengthPx: STRADDLE_BODY_PX.h,
  fallback: (palette) => ({ body: palette.vehicle.body, outline: palette.vehicle.dark, front: palette.vehicle.dark }),
};

/** Stav sprite vozidla: `carries_empty` = vezie prázdny (sivý) kontajner (F6c, ADR-034). */
export type VehicleLoad = 'empty' | 'loaded' | 'carries_empty';

/** Stav sprite podľa toho, či vozidlo vezie náklad a či je to prázdny kontajner (`carriesEmpty` sa pri `loaded: false` ignoruje). */
export function vehicleLoad(loaded: boolean, carriesEmpty = false): VehicleLoad {
  if (!loaded) return 'empty';
  return carriesEmpty ? 'carries_empty' : 'loaded';
}

/**
 * Súbor sprite vozidla (relatívne k `assets/`), alebo `undefined`, ak def nie je vozidlo v manifeste. Stav `carries_empty` bez vlastného
 * súboru v manifeste (def ho nemá) použije `loaded` — prázdny kontajner sa vtedy kreslí rovnako ako plný.
 */
export function vehicleSpriteFile(defId: string, loaded: boolean, carriesEmpty = false): string | undefined {
  const states = vehicleSprite(defId)?.states;
  if (states === undefined) return undefined;
  const load = vehicleLoad(loaded, carriesEmpty);
  return load === 'carries_empty' ? (states.carries_empty ?? states.loaded) : states[load];
}

export interface VehiclePose {
  /** Stred vozidla vo svete (px). */
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch v smere hodinových ručičiek (0 = predok na sever). */
  readonly angle: number;
  /** Kĺbové vozidlo: natočenie kabíny (stupne ako `angle`); chýba = kabína rovno s návesom. */
  readonly cabAngle?: number;
}

/** Uhol normalizovaný do (−180, 180]. */
function signedAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
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
  /**
   * Zobrazené naloženie (volá sa po `pose` v tom istom `update`): režisér ho môže odložiť, kým prezentačný manéver neskončí
   * (kamión cúvajúci do docku drží sprite z príchodu). Chýba = `vm.loaded`.
   */
  displayLoaded?(vm: VehicleVM): boolean;
}

/** Kĺbové vozidlo z častí: kabína a náves (kontajnery s počiatkom v točnici / čape), ktoré `syncRig` stavia do pózy. */
interface Rig {
  readonly articulated: ArticulatedSpriteEntry;
  readonly cab: Container;
  readonly trailer: Container;
}

/** Textúry vozidla podľa stavu (`carries_empty` je `loaded`, keď def sivý variant nemá). */
type VehicleTextures = Readonly<Record<VehicleLoad, Texture>>;

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
  private readonly textures: VehicleTextures | null;
  private load: VehicleLoad;
  private readonly roadKindAt: RoadKindAt;
  private readonly roadMaskAt: RoadMaskAt;
  /** Dĺžka spritu v bunkách (`footprint.h` × mierka): predok je pri hlave, stred o polovicu späť v smere natočenia. */
  private readonly spriteLengthCells: number;
  /** Brzdové svetlá pri zadku (vznikne lenivo pri prvom `blocked`); `null`, kým nie sú potrebné. */
  private brakeLights: Container | null = null;
  /** Kĺbové vozidlo z častí (kamión): kabína a náves, kým sú textúry častí k dispozícii (inak fallback). */
  private rig: Rig | null = null;
  /** Vzdialenosť od predku po čap (točnicu) v bunkách (`cab.pivot.y`); 0 pri vozidle bez častí. */
  private hitchCells = 0;
  /** Kontajner na vozidle: plný a prázdny (sivý) variant, viditeľný podľa stavu; `null` pri fallbacku. */
  private cargo: { readonly full: CargoSprite; readonly empty: CargoSprite } | null = null;

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
    this.load = vehicleLoad(vm.loaded, vm.carriesEmpty === true);
    this.textures = this.resolveTextures(vm.defId);
    const entry = vehicleSprite(vm.defId);
    const articulated = articulatedSprite(vm.defId);
    if (articulated !== undefined) {
      const { cab, trailer } = articulated;
      this.hitchCells = (cab.pivot.y / MANIFEST_CELL_PX) * VEHICLE_SCALE;
      this.spriteLengthCells = this.hitchCells + ((trailer.footprint.h * MANIFEST_CELL_PX - trailer.pivot.y) / MANIFEST_CELL_PX) * VEHICLE_SCALE;
    } else {
      this.spriteLengthCells = (entry?.footprint ?? FALLBACK_FOOTPRINT).h * VEHICLE_SCALE;
    }
    const partTextures = articulated === undefined ? null : this.resolvePartTextures(articulated);
    this.sprite = null;
    if (articulated !== undefined && partTextures !== null) {
      this.cargo = this.createCargo();
      this.rig = this.createRig(articulated, partTextures);
    } else if (this.textures !== null && entry !== undefined) {
      this.cargo = this.createCargo();
      // kontajner pod rámom (priehľadný stred straddle carriera): kreslí sa pred rámom
      this.view.addChild(this.cargo.full, this.cargo.empty);
      this.sprite = new Sprite(this.textures[this.load]);
      this.sprite.anchor.set(0.5);
      this.sprite.setSize(entry.footprint.w * deps.cellPx * VEHICLE_SCALE, entry.footprint.h * deps.cellPx * VEHICLE_SCALE);
      this.view.addChild(this.sprite);
    } else {
      this.hitchCells = 0;
      this.view.addChild(this.createFallback(articulated === undefined ? (entry?.footprint ?? FALLBACK_FOOTPRINT) : { w: articulated.footprint.w, h: this.spriteLengthCells }));
    }
    this.update(vm, alpha);
  }

  get vm(): VehicleVM {
    return this.last;
  }


  /** Zobrazený stav sprite (`empty` / `loaded` / `carries_empty`) — pre testy. */
  get loadState(): VehicleLoad {
    return this.load;
  }

  /** Aktuálna textúra sprite (`null` pri fallbacku) — pre testy. */
  get texture(): Texture | null {
    return this.sprite?.texture ?? null;
  }

  /** Vozidlo je nakreslené spritmi z manifestu (rám alebo kabína + náves), nie fallbackom z tokenov — pre testy. */
  get textured(): boolean {
    return this.sprite !== null || this.rig !== null;
  }

  /** Zobrazený kontajner na vozidle (`full` = plný, `empty` = sivý prázdny, `none` = bez kontajnera alebo fallback) — pre testy. */
  get cargoState(): 'none' | 'full' | 'empty' {
    if (this.cargo?.full.visible === true) return 'full';
    return this.cargo?.empty.visible === true ? 'empty' : 'none';
  }

  /** Kabína kĺbového vozidla (`null` pri vozidle bez častí alebo fallbacku) — pre testy. */
  get cabView(): Container | null {
    return this.rig?.cab ?? null;
  }

  /** Náves kĺbového vozidla (`null` pri vozidle bez častí alebo fallbacku) — pre testy. */
  get trailerView(): Container | null {
    return this.rig?.trailer ?? null;
  }

  /** Brzdové svetlá (`null`, kým nebolo vozidlo zablokované) — pre testy. */
  get brakeLightsView(): Container | null {
    return this.brakeLights;
  }

  /** Brzdové svetlá svietia (vozidlo stojí na ceste, `blocked && !offRoad`) — pre testy. */
  get brakeLightsOn(): boolean {
    return this.brakeLights?.visible === true;
  }

  /** Nastaví polohu (interpolovanú), kurz a stav naloženia. Pre nezmenený stav nič nealokuje. */
  update(vm: VehicleVM, alpha: number): void {
    this.last = vm;
    const pose = this.director === null ? this.simPose(vm, alpha) : this.director.pose(vm, alpha, (other, at) => this.simPose(other, at));
    if (this.view.x !== pose.x || this.view.y !== pose.y) this.view.position.set(pose.x, pose.y);
    if (this.view.angle !== pose.angle) this.view.angle = pose.angle;
    const load = vehicleLoad(this.director?.displayLoaded?.(vm) ?? vm.loaded, vm.carriesEmpty === true);
    if (load !== this.load) {
      this.load = load;
      if (this.sprite !== null && this.textures !== null) this.sprite.texture = this.textures[load];
    }
    this.syncCargo(load);
    this.syncRig(pose);
    this.syncBrakeLights(vm);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /**
   * Póza vozidla podľa simu v čase `alpha` (px sveta): kĺbová po stope, keď VM nesie `body` a vozidlo je na ceste, inak pruh a
   * oblúky ako doteraz (`vehiclePose`).
   */
  private simPose(vm: VehicleVM, alpha: number): VehiclePose {
    if (vm.body === undefined || vm.offRoad === true) return vehiclePose(vm, alpha, this.deps.cellPx, this.roadKindAt, this.roadMaskAt);
    return this.trailPose(vm, vm.body, alpha);
  }

  /** Póza vozidla na stope `body` (viď `articulated-pose.ts`): sprite nesený po stope a posunutý do pravého pruhu kolmo na tetivu. */
  private trailPose(vm: VehicleVM, body: readonly Point[], alpha: number): VehiclePose {
    const prevHeading = vm.prevHeading ?? vm.heading;
    const trail = trailAt({ x: vm.prevX, y: vm.prevY }, { x: vm.x, y: vm.y }, body, alpha, prevHeading === 0 || prevHeading === 180);
    const lengthCells = vm.lengthCells ?? body.length + 1;
    const pose = articulatedPose(trail.head, trail.body, lengthCells, this.spriteLengthCells, vm.heading);
    const lane = blendedLaneMagnitude(pose, pose.angle, (cellX, cellY) => laneMagnitude(this.roadKindAt(cellX, cellY)));
    const at = shiftRight(pose, pose.angle, lane);
    const { cellPx } = this.deps;
    if (this.rig === null) return { x: at.x * cellPx, y: at.y * cellPx, angle: pose.angle };
    // kabína sa natáča podľa krátkej tetivy (po čap), náves podľa celej dĺžky: v zákrute kabína ostáva na ceste a náves ju sleduje
    const cab = articulatedPose(trail.head, trail.body, this.hitchCells, this.spriteLengthCells, vm.heading);
    return { x: at.x * cellPx, y: at.y * cellPx, angle: pose.angle, cabAngle: cab.angle };
  }

  /** Kontajner na vozidle: viditeľný plný (`loaded`) alebo prázdny sivý (`carries_empty`) variant, inak žiadny. */
  private syncCargo(load: VehicleLoad): void {
    if (this.cargo === null) return;
    this.cargo.full.visible = load === 'loaded';
    this.cargo.empty.visible = load === 'carries_empty';
  }

  /** Postaví kabínu a náves do pózy: čap je v lokálnom rámci `hitch` za predkom v smere kabíny, náves visí na čape rovno s celkovým kurzom. */
  private syncRig(pose: { readonly angle: number; readonly cabAngle?: number }): void {
    if (this.rig === null) return;
    const front = (-this.spriteLengthCells * this.deps.cellPx) / 2;
    const relative = signedAngle((pose.cabAngle ?? pose.angle) - pose.angle);
    const radians = (relative * Math.PI) / 180;
    const hitch = this.hitchCells * this.deps.cellPx;
    const x = -Math.sin(radians) * hitch;
    const y = front + Math.cos(radians) * hitch;
    this.rig.cab.position.set(x, y);
    this.rig.cab.angle = relative;
    this.rig.trailer.position.set(x, y);
  }

  /** Ukáže / skryje brzdové svetlá: svietia pri `blocked` na ceste; vznikajú lenivo, aby vozidlo bez zablokovania nič navyše nekreslilo. */
  private syncBrakeLights(vm: VehicleVM): void {
    const on = vm.blocked === true && vm.offRoad !== true;
    if (!on) {
      if (this.brakeLights !== null) this.brakeLights.visible = false;
      return;
    }
    this.brakeLights ??= this.createBrakeLights();
    this.brakeLights.visible = true;
  }

  /** Dva červené obdĺžniky (`--vehicle-brake`) pri zadnom okraji spritu, pri bočných okrajoch tela vozidla; mierka ako sprite. */
  private createBrakeLights(): Container {
    const { cellPx, palette } = this.deps;
    const unit = manifestScale(cellPx) * VEHICLE_SCALE;
    const sprite = this.createBrakeLightsSprite(unit);
    if (sprite !== null) return sprite;
    const { w, h, inset } = BRAKE_LIGHT_PX;
    const { brake } = palette.vehicle;
    const x = (this.style.widthPx / 2 - inset - w / 2) * unit;
    const y = (this.style.lengthPx / 2 - h / 2) * unit;
    const lights = new Graphics({ label: 'brake-lights' });
    for (const side of [-1, 1]) lights.rect(side * x - (w * unit) / 2, y - (h * unit) / 2, w * unit, h * unit).fill({ color: brake.color, alpha: brake.alpha });
    this.view.addChild(lights);
    return lights;
  }

  /**
   * Sprite `vehicle_brake_lights` (svetlá pri spodnom okraji plátna) tak, aby svetlá sedeli na zadku vozidla; kamión ho nesie na návese
   * (v zákrute je pri zadku návesu). `null`, keď textúra nie je (fallback: procedurálne obdĺžniky).
   */
  private createBrakeLightsSprite(unit: number): Sprite | null {
    const entry = brakeLightsSprite();
    const texture = entry === undefined ? undefined : this.deps.textures?.file(entry.file);
    if (entry === undefined || texture === undefined) return null;
    const { inset } = BRAKE_LIGHT_PX;
    const sprite = new Sprite(texture);
    sprite.label = 'brake-lights';
    sprite.anchor.set(0.5);
    sprite.setSize(entry.footprint.w * MANIFEST_CELL_PX * unit, entry.footprint.h * MANIFEST_CELL_PX * unit);
    const halfCanvas = (entry.footprint.h * MANIFEST_CELL_PX) / 2;
    if (this.rig !== null) {
      const trailer = this.rig.articulated.trailer;
      const rear = trailer.footprint.h * MANIFEST_CELL_PX - trailer.pivot.y - inset; // zadný okraj návesu od čapu
      sprite.position.set(0, (rear + inset - halfCanvas) * unit);
      this.rig.trailer.addChild(sprite);
    } else {
      sprite.position.set(0, (this.style.lengthPx / 2 + inset - halfCanvas) * unit);
      this.view.addChild(sprite);
    }
    return sprite;
  }

  /** Dvojica kontajnerov (plný / prázdny sivý) položených dlhšou stranou v smere jazdy. */
  private createCargo(): { readonly full: CargoSprite; readonly empty: CargoSprite } {
    const { cellPx, palette, textures } = this.deps;
    const make = (empty: boolean): CargoSprite => {
      const sprite = new CargoSprite(this.id, VEHICLE_CARGO_TYPE, { cellPx, palette, textures }, { empty });
      sprite.angle = CARGO_ALONG_DEG;
      sprite.visible = false;
      return sprite;
    };
    return { full: make(false), empty: make(true) };
  }

  /** Textúry kabíny a návesu, alebo `null` (fallback), keď ktorákoľvek chýba. */
  private resolvePartTextures(articulated: ArticulatedSpriteEntry): { readonly cab: Texture; readonly trailer: Texture } | null {
    const cab = this.deps.textures?.file(articulated.cab.file);
    const trailer = this.deps.textures?.file(articulated.trailer.file);
    return cab === undefined || trailer === undefined ? null : { cab, trailer };
  }

  /** Skladá návesu a kabínu: každá časť je kontajner s počiatkom v čape / točnici, sprite je zakotvený na svojom pivote; kontajner leží na návese. */
  private createRig(articulated: ArticulatedSpriteEntry, textures: { readonly cab: Texture; readonly trailer: Texture }): Rig {
    const { cellPx } = this.deps;
    const part = (entry: ArticulatedSpriteEntry['cab'], texture: Texture): Container => {
      const group = new Container();
      const sprite = new Sprite(texture);
      sprite.anchor.set(entry.pivot.x / (entry.footprint.w * MANIFEST_CELL_PX), entry.pivot.y / (entry.footprint.h * MANIFEST_CELL_PX));
      sprite.setSize(entry.footprint.w * cellPx * VEHICLE_SCALE, entry.footprint.h * cellPx * VEHICLE_SCALE);
      group.addChild(sprite);
      return group;
    };
    const trailer = part(articulated.trailer, textures.trailer);
    const cab = part(articulated.cab, textures.cab);
    trailer.label = 'trailer';
    cab.label = 'cab';
    // kontajner na strede návesu (stred plátna návesu je od čapu o polovicu dĺžky mínus pivot späť)
    const unit = manifestScale(cellPx) * VEHICLE_SCALE;
    if (this.cargo !== null) {
      const centre = ((articulated.trailer.footprint.h * MANIFEST_CELL_PX) / 2 - articulated.trailer.pivot.y) * unit;
      for (const sprite of [this.cargo.full, this.cargo.empty]) {
        sprite.position.set(0, centre);
        trailer.addChild(sprite);
      }
    }
    this.view.addChild(trailer, cab);
    return { articulated, cab, trailer };
  }

  /** Textúry `empty` / `loaded` / `carries_empty` pre vozidlo, alebo `null` (fallback); `carries_empty` bez súboru alebo textúry = `loaded`. */
  private resolveTextures(defId: string): VehicleTextures | null {
    const entry = vehicleSprite(defId);
    if (entry === undefined) return null;
    const empty = this.deps.textures?.file(entry.states.empty);
    const loaded = this.deps.textures?.file(entry.states.loaded);
    if (empty === undefined || loaded === undefined) return null;
    const carriesEmpty = entry.states.carries_empty === undefined ? undefined : this.deps.textures?.file(entry.states.carries_empty);
    return { empty, loaded, carries_empty: carriesEmpty ?? loaded };
  }

  /** Telo z tokenov s pruhom na predku (hore); rozmer `footprint` (vozidlo 1×1, kamión 1×2), v mierke pruhu. */
  private createFallback(footprint: CellSize): Graphics {
    const { cellPx, palette } = this.deps;
    const height = footprint.h * cellPx;
    const inset = FALLBACK_INSET_CELLS * cellPx;
    const { body, outline, front } = this.style.fallback(palette);
    const bodyWidth = this.style.widthPx * manifestScale(cellPx); // reálna šírka vozidla, nie celá bunka
    const left = -bodyWidth / 2;
    const top = -height / 2 + inset;
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
