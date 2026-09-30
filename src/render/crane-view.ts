/**
 * CraneView (ARCHITECTURE §15.1, DESIGN_BRIEF §5.3): žeriav zložený z oddelených spritov s vlastným pivotom
 * (`sprites.<defId>.parts` v manifeste): statická základňa (`base`), výložník (`boom`) a vozík (`trolley` / `bucket` —
 * časť s `travel`), ktorý jazdí po výložníku.
 *
 * Skladanie (rot 0, počiatok = stred footprintu, potom sa celé otočí o `rotation`):
 *  - `base` vyplní footprint modulu,
 *  - `boom` sa kladie pivotom (`pivot`) na `mountOnBase`; v skupine výložníka sa mierne natáča podľa fázy
 *    (`CRANE_BOOM_TILT_DEG`),
 *  - vozík je dieťa skupiny výložníka (natáča sa s ním) a jeho stred leží na osi výložníka v rozsahu `travel.yMin..yMax`
 *    (súradnice súboru výložníka; `yMin` = morský koniec, `yMax` = pevninský koniec),
 *  - držaný náklad (`holding`) je pod vozíkom.
 * Odznak `overlay.blocked_badge` (pri `blocked`) sa neotáča so žeriavom — ostáva čitateľný.
 *
 * Chýbajúci sprite časti → obdĺžnik z tokenov (`--crane-frame` / `--crane-boom`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { rotateFootprint } from '@sim/grid';
import { CargoSprite, type CargoSpriteDeps } from './cargo-sprite';
import {
  BLOCKED_BADGE_FILE,
  BLOCKED_BADGE_SIZE,
  manifestScale,
  moduleSprite,
  type CellSize,
  type ManifestPart,
  type ManifestPoint,
  type ModuleSpriteEntry,
} from './entity-assets';
import { footprintPose, type FootprintPose } from './footprint-pose';
import type { CraneVM } from './view-models';

export type CraneState = CraneVM['state'];

/**
 * Sklon výložníka v stupňoch (v smere hodinových ručičiek) podľa fázy: pri `grabbing` sa mierne vychýli doprava,
 * pri `placing` doľava, inak je rovno (nad vodou). Malé konštanty — len jemné vizuálne naznačenie fázy cyklu.
 */
export const CRANE_BOOM_TILT_DEG: Readonly<Record<CraneState, number>> = {
  idle: 0,
  grabbing: 3,
  swinging: 0,
  placing: -3,
  blocked: 0,
};

/** Najväčší násobok odznaku pri malom zoome (odznak ostáva čitateľný, ale nezaberá celý žeriav). */
export const BADGE_MAX_SCALE = 2;

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Rozmer fallbacku žeriava bez záznamu v manifeste (bunky). */
const FALLBACK_FOOTPRINT: CellSize = { w: 1, h: 1 };

/**
 * Poloha vozíka pozdĺž výložníka ako podiel dráhy: 0 = pevninský koniec, 1 = morský koniec.
 * `idle` a `blocked` stoja na pevnine; `grabbing` ide k lodi (`progress`); `swinging` je pri lodi (práve chytil náklad);
 * `placing` sa vracia k apronu (`1 − progress`).
 */
export function trolleyTravelFraction(state: CraneState, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  switch (state) {
    case 'idle':
    case 'blocked':
      return 0;
    case 'grabbing':
      return p;
    case 'swinging':
      return 1;
    case 'placing':
      return 1 - p;
  }
}

/** Súradnica `y` stredu vozíka v súbore výložníka (px zdroja) pre podiel dráhy `fraction` (0 = `yMax`, 1 = `yMin`). */
export function trolleyBoomY(fraction: number, travel: { readonly yMin: number; readonly yMax: number }): number {
  return travel.yMax - fraction * (travel.yMax - travel.yMin);
}

/** Násobok odznaku pre zoom kamery: `1 / zoom` v rozsahu 1…`BADGE_MAX_SCALE` (odznak ostáva čitateľný pri malom zoome). */
export function badgeScaleForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError(`badgeScaleForZoom: zoom musí byť kladný, dostal ${String(zoom)}`);
  return Math.min(BADGE_MAX_SCALE, Math.max(1, 1 / zoom));
}

/** Rozloženie žeriava z manifestu: základňa, výložník a pojazdná časť (s `travel`). */
export interface CraneParts {
  readonly baseFile: string | undefined;
  readonly boom: ManifestPart | undefined;
  readonly mover: ManifestPart | undefined;
}

/** Roztriedi `parts` záznamu žeriava; pojazdná časť je tá s `travel` (`trolley` alebo `bucket`). */
export function craneParts(entry: ModuleSpriteEntry): CraneParts {
  const parts = entry.parts ?? {};
  return {
    baseFile: parts['base']?.file ?? entry.file,
    boom: parts['boom'],
    mover: Object.values(parts).find((part) => part.travel !== undefined),
  };
}

/** Footprint žeriava vo svete (po rotácii): rozmery z manifestu, ľavý horný roh z `CraneVM`. */
export function craneBox(vm: CraneVM, footprint: CellSize): { x: number; y: number; w: number; h: number; rotation: CraneVM['rotation'] } {
  const rotated = rotateFootprint(footprint.w, footprint.h, vm.rotation);
  return { x: vm.x, y: vm.y, w: rotated.w, h: rotated.h, rotation: vm.rotation };
}

export interface CraneViewDeps extends CargoSpriteDeps {
  /** Násobok odznaku pre aktuálny zoom (`badgeScaleForZoom`); predvolene 1. */
  readonly badgeScale?: number;
}

export class CraneView {
  /** Koreň view: počiatok = stred footprintu vo svete (px), NEotočený (odznak ostáva vzpriamený). */
  readonly view: Container;
  readonly id: number;
  private last: CraneVM;
  private readonly pose: FootprintPose;
  private readonly entry: ModuleSpriteEntry | undefined;
  private readonly parts: CraneParts | undefined;
  private readonly scale: number;
  /** Otočená časť (základňa + výložník + vozík). */
  private readonly body = new Container({ label: 'crane-body' });
  private readonly boomGroup = new Container({ label: 'crane-boom' });
  private readonly moverGroup = new Container({ label: 'crane-mover' });
  private readonly badge: Container;
  private held: CargoSprite | null = null;

  constructor(
    vm: CraneVM,
    private readonly deps: CraneViewDeps,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.entry = moduleSprite(vm.defId);
    this.parts = this.entry !== undefined ? craneParts(this.entry) : undefined;
    this.scale = manifestScale(deps.cellPx);
    this.pose = footprintPose(craneBox(vm, this.entry?.footprint ?? FALLBACK_FOOTPRINT), deps.cellPx);
    this.view = new Container({ label: `crane-${String(vm.id)}` });
    this.view.position.set(this.pose.cx, this.pose.cy);
    this.body.angle = this.pose.angle;
    this.view.addChild(this.body);
    this.build();
    this.badge = this.createBadge();
    this.badge.scale.set(deps.badgeScale ?? 1);
    this.view.addChild(this.badge);
    this.apply(vm);
  }

  get vm(): CraneVM {
    return this.last;
  }

  /** Odznak zablokovania je viditeľný (testy). */
  get badgeVisible(): boolean {
    return this.badge.visible;
  }

  /** Sklon výložníka v stupňoch (testy). */
  get boomAngle(): number {
    return this.boomGroup.angle;
  }

  /** Poloha vozíka pozdĺž výložníka v px sveta od pivotu výložníka (záporné = k moru; testy). */
  get trolleyOffsetY(): number {
    return this.moverGroup.y;
  }

  /** Držaný náklad (testy). */
  get heldCargo(): CargoSprite | null {
    return this.held;
  }

  /** Nastaví fázu cyklu: vozík, sklon výložníka, držaný náklad, odznak. Nič nerobí (ani nealokuje) pri nezmenenom VM. */
  update(vm: CraneVM): void {
    const before = this.last;
    if (
      before.state === vm.state &&
      before.progress === vm.progress &&
      before.holding?.unitId === vm.holding?.unitId &&
      before.holding?.typeId === vm.holding?.typeId
    ) {
      this.last = vm;
      return;
    }
    this.apply(vm);
  }

  private apply(vm: CraneVM): void {
    this.last = vm;
    const travel = this.parts?.mover?.travel;
    const boomPivot = this.parts?.boom?.pivot;
    if (travel !== undefined && boomPivot !== undefined) {
      const y = trolleyBoomY(trolleyTravelFraction(vm.state, vm.progress), travel);
      this.moverGroup.y = (y - boomPivot.y) * this.scale;
    }
    this.boomGroup.angle = CRANE_BOOM_TILT_DEG[vm.state];
    this.syncHeld(vm);
    this.badge.visible = vm.state === 'blocked';
  }

  /** Nastaví veľkosť odznaku podľa zoomu kamery (`badgeScaleForZoom`). */
  setBadgeScale(scale: number): void {
    this.badge.scale.set(scale);
  }

  destroy(): void {
    this.held = null;
    this.view.destroy({ children: true });
  }

  /** Náklad pod vozíkom: vytvorí / vymení / zruší podľa `vm.holding`. */
  private syncHeld(vm: CraneVM): void {
    const holding = vm.holding;
    if (holding === null) {
      if (this.held !== null) {
        this.held.destroy();
        this.held = null;
      }
      return;
    }
    if (this.held?.unitId === holding.unitId && this.held.typeId === holding.typeId) return;
    this.held?.destroy();
    this.held = new CargoSprite(holding.unitId, holding.typeId, this.deps);
    this.moverGroup.addChildAt(this.held, 0); // pod sprite vozíka: vozík (spreader) je nad kontajnerom
  }

  /** Poskladá základňu, výložník a vozík podľa manifestu (chýbajúca časť → obdĺžnik z tokenov). */
  private build(): void {
    const { cellPx } = this.deps;
    const { baseW, baseH } = this.pose;
    const { parts } = this;
    const topLeft: ManifestPoint = { x: (-baseW * cellPx) / 2, y: (-baseH * cellPx) / 2 };
    this.body.addChild(this.partDisplay(parts?.baseFile, { w: baseW, h: baseH }, { x: 0, y: 0 }, 'frame', topLeft));
    const boom = parts?.boom;
    if (boom === undefined) return;
    const mount = boom.mountOnBase ?? { x: 0, y: 0 };
    this.boomGroup.position.set(topLeft.x + mount.x * this.scale, topLeft.y + mount.y * this.scale);
    this.body.addChild(this.boomGroup);
    this.boomGroup.addChild(this.partDisplay(boom.file, boom.footprint ?? FALLBACK_FOOTPRINT, boom.pivot ?? { x: 0, y: 0 }, 'boom'));
    const mover = parts?.mover;
    if (mover === undefined || boom.pivot === undefined) return;
    // Vozík: stred na osi výložníka (x pivotu výložníka), y nastaví `update`.
    this.moverGroup.x = 0;
    this.moverGroup.addChild(this.partDisplay(mover.file, mover.footprint ?? FALLBACK_FOOTPRINT, mover.pivot ?? { x: 0, y: 0 }, 'frame'));
    this.boomGroup.addChild(this.moverGroup);
  }

  /**
   * Sprite alebo fallback časti: ľavý horný roh je `origin − pivot × scale` (pivot v px zdroja), veľkosť je
   * `footprint × cellPx` (bunky).
   */
  private partDisplay(
    file: string | undefined,
    footprint: CellSize,
    pivot: ManifestPoint,
    fallback: 'frame' | 'boom',
    origin: ManifestPoint = { x: 0, y: 0 },
  ): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const width = footprint.w * cellPx;
    const height = footprint.h * cellPx;
    const x = origin.x - pivot.x * this.scale;
    const y = origin.y - pivot.y * this.scale;
    const texture = file !== undefined ? textures?.file(file) : undefined;
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(x, y);
      sprite.setSize(width, height);
      return sprite;
    }
    const color = fallback === 'boom' ? palette.crane.boom : palette.crane.frame;
    const graphics = new Graphics();
    graphics
      .rect(x, y, width, height)
      .fill({ color: color.color, alpha: color.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha, alignment: 1 });
    return graphics;
  }

  /**
   * Odznak zablokovania na strede žeriava: kontajner (jeho `scale` nesie zoom) so spritom `overlay.blocked_badge`
   * alebo kruhom z `--ui-danger`.
   */
  private createBadge(): Container {
    const { textures, palette, cellPx } = this.deps;
    const width = BLOCKED_BADGE_SIZE.w * this.scale;
    const height = BLOCKED_BADGE_SIZE.h * this.scale;
    const badge = new Container({ label: 'crane-blocked-badge' });
    const texture = textures?.file(BLOCKED_BADGE_FILE);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(width, height);
      badge.addChild(sprite);
    } else {
      const graphics = new Graphics();
      graphics
        .circle(0, 0, Math.min(width, height) / 2)
        .fill({ color: palette.danger.color, alpha: palette.danger.alpha })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha });
      badge.addChild(graphics);
    }
    return badge;
  }
}
