/**
 * Zvýraznenie zápchy (R1, ADR-037 bod 8, TERMINAL_2 §7.8, §11): pre každého nosiča s `jammed` (`blockedTicks ≥ stuckTicks`)
 *  - **poloprehľadné červené štvorce** (`--traffic-jam`) pod bunkami hlavy a stopy (`body`) — vrstva `cells` leží nad cestami
 *    a modulmi a pod vozidlami, takže vozidlá ostanú čitateľné;
 *  - **odznak** `overlay.warning_badge` nad hlavou — vrstva `badges` leží nad vozidlami a drží čitateľnú veľkosť aj pri malom
 *    zoome (`badgeScaleForZoom`, rovnako ako odznaky modulov).
 *
 * Bunky sa prekresľujú len pri zmene množiny buniek; odznaky vznikajú a zanikajú podľa nosiča (kľúč `v<id>` / `t<id>`).
 * Vrstva nič nekreslí, kým nie je žiadny nosič v zápche.
 */
import { Container, Graphics } from 'pixi.js';
import { createWarningBadge } from './badges';
import type { CargoSpriteDeps } from './cargo-sprite';
import { badgeScaleForZoom } from './crane-view';
import { lerp } from './ship-view';
import type { TruckVM, VehicleVM } from './view-models';

/** Nosič, ktorý vrstva číta: `VehicleVM` aj `TruckVM` (spoločné polia stopy). */
type Carrier = VehicleVM | TruckVM;

/** Posun odznaku nad hlavu: o koľko bunky vyššie než stred bunky hlavy (okraj bunky). */
const BADGE_RISE_CELLS = 0.5;

export class TrafficJamLayer {
  /** Červené bunky zápchy: pridaj ich do sveta nad cesty a moduly a pod vozidlá. */
  readonly cells = new Container({ label: 'traffic-jam-cells' });
  /** Odznaky nad hlavami: pridaj ich do sveta nad vozidlá. */
  readonly badges = new Container({ label: 'traffic-jam-badges' });
  private readonly graphics = new Graphics();
  private readonly badgeViews = new Map<string, Container>();
  private readonly seen = new Set<string>();
  /** Pracovná množina buniek (znovupoužitá, aby sa za frame nealokovalo). */
  private readonly cellSet = new Map<string, { x: number; y: number }>();
  private drawnKey = '';
  private badgeScale = 1;

  constructor(private readonly deps: CargoSpriteDeps) {
    this.cells.addChild(this.graphics);
  }

  /** Počet červených buniek — pre testy. */
  get cellCount(): number {
    return this.drawnKey === '' ? 0 : this.drawnKey.split(';').length;
  }

  /** Počet odznakov nad hlavami — pre testy. */
  get badgeCount(): number {
    return this.badgeViews.size;
  }

  /** Odznak nosiča (`v<id>` vozidlo, `t<id>` kamión), alebo `undefined` — pre testy. */
  badge(key: string): Container | undefined {
    return this.badgeViews.get(key);
  }

  /** Zosúladí bunky a odznaky s nosičmi v zápche pre `alpha` (0…1 medzi predchádzajúcim a aktuálnym tickom). */
  sync(vehicles: readonly VehicleVM[], trucks: readonly TruckVM[], alpha: number): void {
    const cells = this.cellSet;
    cells.clear();
    this.seen.clear();
    const visit = (prefix: string, carrier: Carrier): void => {
      if (carrier.jammed !== true) return;
      const key = `${prefix}${String(carrier.id)}`;
      this.seen.add(key);
      const add = (point: { x: number; y: number }): void => {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        cells.set(`${String(x)},${String(y)}`, { x, y });
      };
      add(carrier);
      for (const point of carrier.body ?? []) add(point);
      this.placeBadge(key, carrier, alpha);
    };
    for (const vehicle of vehicles) visit('v', vehicle);
    for (const truck of trucks) visit('t', truck);
    this.drawCells(cells);
    this.badgeViews.forEach((badge, key) => {
      if (this.seen.has(key)) return;
      badge.destroy({ children: true });
      this.badgeViews.delete(key);
    });
  }

  /** Prispôsobí veľkosť odznakov zoomu kamery (volá `WorldRenderer.syncCamera`). */
  setZoom(zoom: number): void {
    const next = badgeScaleForZoom(zoom);
    if (next === this.badgeScale) return;
    this.badgeScale = next;
    this.badgeViews.forEach((badge) => {
      badge.scale.set(next);
    });
  }

  destroy(): void {
    this.badgeViews.clear();
    this.cells.destroy({ children: true });
    this.badges.destroy({ children: true });
  }

  /** Odznak nad hlavou nosiča (interpolovaná poloha hlavy, vzpriamený); vznikne lenivo. */
  private placeBadge(key: string, carrier: Carrier, alpha: number): void {
    let badge = this.badgeViews.get(key);
    if (badge === undefined) {
      badge = createWarningBadge(this.deps, 0, this.badgeScale);
      this.badgeViews.set(key, badge);
      this.badges.addChild(badge);
    }
    const { cellPx } = this.deps;
    badge.position.set(lerp(carrier.prevX, carrier.x, alpha) * cellPx, (lerp(carrier.prevY, carrier.y, alpha) - BADGE_RISE_CELLS) * cellPx);
  }

  /** Prekreslí červené štvorce, ak sa zmenila množina buniek. */
  private drawCells(cells: ReadonlyMap<string, { x: number; y: number }>): void {
    if (cells.size === 0 && this.drawnKey === '') return;
    const key = [...cells.keys()].sort().join(';');
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.graphics.clear();
    const { cellPx, palette } = this.deps;
    const { jam } = palette;
    cells.forEach(({ x, y }) => {
      this.graphics.rect(x * cellPx, y * cellPx, cellPx, cellPx);
    });
    if (cells.size > 0) this.graphics.fill({ color: jam.color, alpha: jam.alpha });
  }
}
