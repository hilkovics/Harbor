/**
 * Konektory modulov vo svete pre kreslenie ciest (spätná väzba F5b č. 3): cesta končiaca pred bránou, stojiskom, rampou
 * či dvorom sa pripája na konektor modulu, nie zaobleným koncom s medzerou.
 *
 * Sim konektor modulu pozná (`Module.connectors`, `connectorsOf`), ale snapshot ich nenesie; renderer ich skladá z manifestu
 * (`sprites.<defId>.connectors`: bunka pri rot 0 + strana vjazdu, rovnaká tabuľka, z ktorej ich berie aj sim) a z polohy
 * a rotácie `ModuleVM` (`rotateLocalCell`, strana sa otáča o rotáciu modulu). Čisté funkcie a trieda bez Pixi.
 *
 * Bunka cesty pred konektorom (`connectorOutside`) dostane v smere k modulu ďalší bit autotile masky
 * (`autotileMask(…, extraMask)`): z `end` sa tak stane `straight`, z `straight` s odbočkou `t` atď., rameno siaha až po
 * okraj bunky modulu. Berie sa len vrstva `road` (koľajové a potrubné konektory pribudnú s ich vrstvami).
 */
import { DIRECTIONS_4, rotateLocalCell, type CellCoord, type Grid, type Rotation } from '@sim/grid';
import { moduleSprite } from './entity-assets';
import { footprintPose, SIDE_STEP } from './footprint-pose';
import type { ModuleVM, ViewSide } from './view-models';

/** Strany v poradí otáčania v smere hodinových ručičiek (`n` → `e` → `s` → `w`). */
const SIDES: readonly ViewSide[] = ['n', 'e', 's', 'w'];

/** Strana po otočení modulu o `rotation` (90° = jeden krok v smere hodinových ručičiek). */
function rotatedSide(side: ViewSide, rotation: Rotation): ViewSide {
  return SIDES[(SIDES.indexOf(side) + rotation / 90) % SIDES.length];
}

/** Bit v maske susedov (N = 1, E = 2, S = 4, W = 8) pre krok `(dx, dy)`; iný krok je chyba. */
function bitOfStep(dx: number, dy: number): number {
  const direction = DIRECTIONS_4.find((candidate) => candidate.dx === dx && candidate.dy === dy);
  if (direction === undefined) throw new RangeError(`bitOfStep: (${String(dx)}, ${String(dy)}) nie je krok o jednu bunku`);
  return direction.bit;
}

/** Konektor modulu vo svete: bunka footprintu, strana vjazdu (po rotácii) a typ prepojenia. */
export interface WorldConnector {
  readonly x: number;
  readonly y: number;
  readonly side: ViewSide;
  readonly type: 'road' | 'rail' | 'pipe';
}

/** Časť `ModuleVM`, z ktorej sa konektory skladajú: def a footprint po rotácii. */
export type ConnectorHost = Pick<ModuleVM, 'defId' | 'x' | 'y' | 'w' | 'h' | 'rotation'>;

/**
 * Konektory modulu vo svete v poradí manifestu (= poradie v defe): bunka `(x, y)` footprintu a strana vjazdu po rotácii.
 * Modul bez záznamu v manifeste alebo bez konektorov → prázdne pole.
 */
export function worldConnectors(host: ConnectorHost): readonly WorldConnector[] {
  const entry = moduleSprite(host.defId);
  if (entry === undefined) return [];
  const { baseW, baseH } = footprintPose(host, 1);
  return entry.connectors.map((connector) => {
    const cell = rotateLocalCell(connector.x, connector.y, baseW, baseH, host.rotation);
    return { x: host.x + cell.x, y: host.y + cell.y, side: rotatedSide(connector.side, host.rotation), type: connector.type };
  });
}

/** Bunka cesty pred konektorom (vonkajšia bunka, môže ležať mimo mapy) a bit smeru k modulu v jej maske. */
export interface ConnectorArm {
  readonly x: number;
  readonly y: number;
  readonly bit: number;
}

/** Rameno cesty pred konektorom `connector`: vonkajšia bunka a bit smeru späť k bunke konektora. */
export function connectorArm(connector: Pick<WorldConnector, 'x' | 'y' | 'side'>): ConnectorArm {
  const step = SIDE_STEP[connector.side];
  return { x: connector.x + step.x, y: connector.y + step.y, bit: bitOfStep(-step.x, -step.y) };
}

/** Rovnakosť statickej časti modulov (def, poloha, rozmer, rotácia) — mení konektory, ostatné polia VM nie. */
function sameHost(a: ConnectorHost, b: ConnectorHost): boolean {
  return a.defId === b.defId && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
}

/**
 * Index ramien ciest k konektorom modulov: pre každú bunku cesty (index v mriežke) maska smerov k modulom, ktoré sa na ňu
 * pripájajú. `update(modules)` ho prepočíta z aktuálnych modulov (nič nerobí, ak sa moduly nezmenili) a vráti bunky, ktorým
 * sa maska zmenila — tie treba prekresliť (`RoadLayer.updateRoads`).
 */
export class ConnectorArmIndex {
  private bits = new Map<number, number>();
  private hosts: readonly ConnectorHost[] = [];

  constructor(
    private readonly grid: Grid,
    private readonly type: WorldConnector['type'] = 'road',
  ) {}

  /** Maska smerov k modulom pre bunku (x, y); 0 pre bunku bez ramena aj mimo mapy. Vhodné ako `ConnectorMaskAt`. */
  readonly maskAt = (x: number, y: number): number => (this.grid.inBounds(x, y) ? (this.bits.get(this.grid.index(x, y)) ?? 0) : 0);

  /** Prepočíta ramená z modulov; @returns bunky (mimo mapy vynechané), ktorým sa maska zmenila */
  update(modules: readonly ConnectorHost[]): CellCoord[] {
    if (this.hosts.length === modules.length && modules.every((module, i) => sameHost(module, this.hosts[i]))) return [];
    const next = new Map<number, number>();
    for (const module of modules) {
      for (const connector of worldConnectors(module)) {
        if (connector.type !== this.type) continue;
        const arm = connectorArm(connector);
        if (!this.grid.inBounds(arm.x, arm.y)) continue;
        const index = this.grid.index(arm.x, arm.y);
        next.set(index, (next.get(index) ?? 0) | arm.bit);
      }
    }
    const changed: CellCoord[] = [];
    const indices = new Set<number>([...this.bits.keys(), ...next.keys()]);
    for (const index of [...indices].sort((a, b) => a - b)) {
      if ((this.bits.get(index) ?? 0) !== (next.get(index) ?? 0)) {
        changed.push({ x: index % this.grid.width, y: Math.floor(index / this.grid.width) });
      }
    }
    this.bits = next;
    this.hosts = modules.map(({ defId, x, y, w, h, rotation }) => ({ defId, x, y, w, h, rotation }));
    return changed;
  }
}

/** Maska smerov k modulom pre bunku (x, y); viď `ConnectorArmIndex.maskAt`. */
export type ConnectorMaskAt = (x: number, y: number) => number;

/** `ConnectorMaskAt` bez modulov: žiadne ramená. */
export const noConnectorMask: ConnectorMaskAt = () => 0;
