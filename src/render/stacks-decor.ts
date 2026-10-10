/**
 * Ozdoba bloku skladu so stohmi (R2, TERMINAL_2 §3–§4, rozhodnutie 11): pohľad zhora na `YardBlock` (`container_yard_small`, `empty_depot`) —
 * mriežka pozícií `bay × row` a vrchný kontajner každého stohu. Kreslí sa, keď `ModuleVM.stacks` je prítomné; bez neho sa sklad kreslí ako doteraz
 * (sprite `fillNN`, portálový žeriav dvora), preto ozdoba zakrýva telo modulu (`coversBody`) a `yard-crane-decor.ts` sa pri `stacks` neukáže.
 *
 * **Rozloženie** (lokálny rámec modulu pri rot 0, počiatok = stred footprintu): `bays` pozdĺž osi x, `rows` naprieč (os y), plocha je footprint bez okraja
 * `STACK_MARGIN_CELLS`. Rozstup bays/rows je rovnomerný (`innerW / bays`, `innerH / rows`; blok 4 rady vo footprinte 3 buniek = rozstup 42 px s miestom
 * pre nohy straddle carriera). 20′ kontajner sa zmenší tak, aby sa zmestil do svojej pozície (`BAY_FILL`, `ROW_FILL`), 40′ má dvojnásobnú dĺžku a leží
 * na páre bays `(2k, 2k + 1)` — stohy oboch bays nesú ten istý vrchný kontajner a nakreslí sa raz.
 *
 * **Vrchný kontajner** je `CargoSprite` s `look.container` (sprite podľa veľkosti, typu a linky; prázdny sivý, dry tónovaný farbou linky). Prázdne pozície
 * sú len obrys (`--stack-grid`).
 *
 * **Výška — režim „Tieň“:** pod vrchným kontajnerom je jeho tieň (`--stack-shadow`): obdĺžnik kontajnera posunutý dole-vpravo o `výška × --stack-shadow-step`
 * (3 px pri 64 px bunke) a dosiahnutý ťahom od kontajnera (šesťuholník = obrys kontajnera spojený s posunutým), takže je dlhý tieň stohu spojitý aj pri výške
 * 8 (posun 24 px je väčší než šírka kontajnera). Tieň sa orezáva na plochu bloku. Stohy sa kreslia od najnižšieho, takže tieň vyššieho stohu padá na
 * nižšie susedné. Režim „Odznak“ (kruh s číslom) pribudne neskôr (BACKLOG).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { CargoSprite, cargoSizePx } from './cargo-sprite';
import { REEFER_PLUG_FILES, REEFER_PLUG_SIZE, manifestScale } from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM, StackGeometryVM, StackVM } from './view-models';

/** Okraj plochy bloku bez pozícií (zlomok bunky): pri 64 px bunke 12 px, rozstup radov bloku s 3 bunkami a 4 radmi je tak 42 px. */
export const STACK_MARGIN_CELLS = 12 / 64;

/** Odsadenie plochy bloku od okraja footprintu (zlomok bunky; plocha skladu v sprite dvora začína 5 px od okraja 64 px bunky). */
export const STACK_GROUND_INSET_CELLS = 5 / 64;

/** Hrúbka obrysu plochy bloku (2 px z 64 px bunky, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Podiel dĺžky pozície (bay), ktorý zaberá 20′ kontajner, a podiel šírky pozície (row) pre jeho šírku. */
export const BAY_FILL = 0.92;
export const ROW_FILL = 0.8;

/** Id sprite 20′ kontajnera v manifeste: podľa neho sa odvodí prirodzená veľkosť kontajnera (20′ = 64 × 26 px, 40′ dvojnásobná dĺžka). */
const NATURAL_SPRITE_ID = 'container_20_dry';

/** Geometria bloku: z `vm.stackGeometry`, inak odvodená zo stohov (`max(bay) + 1`, `max(row) + 1`, `max(height)`; aspoň 1). */
export function stackGeometryOf(vm: Pick<ModuleVM, 'stacks' | 'stackGeometry'>): StackGeometryVM {
  if (vm.stackGeometry !== undefined) return vm.stackGeometry;
  let bays = 1;
  let rows = 1;
  let maxTier = 1;
  for (const stack of vm.stacks ?? []) {
    bays = Math.max(bays, stack.bay + 1);
    rows = Math.max(rows, stack.row + 1);
    maxTier = Math.max(maxTier, stack.height);
  }
  return { bays, rows, maxTier };
}

/** Rozloženie pozícií bloku v lokálnom rámci modulu (px sveta). */
export interface StackLayout {
  readonly bays: number;
  readonly rows: number;
  /** Ľavý a horný okraj plochy s pozíciami od stredu footprintu. */
  readonly left: number;
  readonly top: number;
  /** Rozstup stredov bays (os x) a rows (os y). */
  readonly pitchX: number;
  readonly pitchY: number;
  /** Mierka kontajnera voči prirodzenej veľkosti (20′ = 64 × 26 px pri 64 px bunke): zmenšenie, aby sa zmestil do pozície. */
  readonly fit: number;
  /** Prirodzený rozmer 20′ kontajnera (px sveta) bez zmenšenia. */
  readonly natural: { readonly w: number; readonly h: number };
}

/** Rozloženie pre blok `geometry` vo footprinte `baseW × baseH` buniek (pri rot 0) pri veľkosti bunky `cellPx`. */
export function stackLayout(geometry: Pick<StackGeometryVM, 'bays' | 'rows'>, baseW: number, baseH: number, cellPx: number): StackLayout {
  const bays = Math.max(1, geometry.bays);
  const rows = Math.max(1, geometry.rows);
  const margin = STACK_MARGIN_CELLS * cellPx;
  const innerW = baseW * cellPx - 2 * margin;
  const innerH = baseH * cellPx - 2 * margin;
  const pitchX = innerW / bays;
  const pitchY = innerH / rows;
  const natural = cargoSizePx(NATURAL_SPRITE_ID, cellPx);
  const fit = Math.min(1, (pitchX * BAY_FILL) / natural.w, (pitchY * ROW_FILL) / natural.h);
  return { bays, rows, left: -innerW / 2, top: -innerH / 2, pitchX, pitchY, fit, natural };
}

/** Stred pozície (bay; row) v lokálnom rámci modulu. */
export function positionCentre(layout: StackLayout, bay: number, row: number): { readonly x: number; readonly y: number } {
  return { x: layout.left + (bay + 0.5) * layout.pitchX, y: layout.top + (row + 0.5) * layout.pitchY };
}

/** Prvá pozícia páru bays (`2k`), na ktorom leží 40′ kontajner stohu v bay `bay`. */
export function pairStartOf(bay: number): number {
  return bay - (((bay % 2) + 2) % 2);
}

/** Stred kontajnera stohu: 20′ v strede svojej pozície, 40′ uprostred páru `(2k, 2k + 1)`. */
export function stackCentre(layout: StackLayout, stack: Pick<StackVM, 'bay' | 'row'>, sizeFt: 20 | 40): { readonly x: number; readonly y: number } {
  if (sizeFt === 20) return positionCentre(layout, stack.bay, stack.row);
  const start = pairStartOf(stack.bay);
  const first = positionCentre(layout, start, stack.row);
  const second = positionCentre(layout, Math.min(start + 1, layout.bays - 1), stack.row);
  return { x: (first.x + second.x) / 2, y: first.y };
}

/** Stoh s vrchným kontajnerom (výška > 0) pripravený na kreslenie; 40′ má `bay` = prvá pozícia páru. */
export type VisibleStack = StackVM & { readonly top: NonNullable<StackVM['top']> };

/** Kľúč pozície `bay × row`. */
function positionKey(bay: number, row: number): string {
  return `${String(bay)}:${String(row)}`;
}

/** Pozície `bay × row` zakryté kontajnermi 40′ (oba bays páru): ich obrys sa nekreslí. */
export function coveredPositions(stacks: readonly VisibleStack[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const stack of stacks) {
    if (stack.top.sizeFt !== 40) continue;
    covered.add(positionKey(stack.bay, stack.row));
    covered.add(positionKey(stack.bay + 1, stack.row));
  }
  return covered;
}

/**
 * Obrys tieňa obdĺžnika (`left`, `top`, `right`, `bottom`) posunutého dole-vpravo o `shift`: šesťuholník (spojenie obdĺžnika s posunutým), ploché
 * súradnice `x, y, …` od ľavého horného rohu v smere hodinových ručičiek.
 */
export function shadowOutline(left: number, top: number, right: number, bottom: number, shift: number): number[] {
  return [left, top, right, top, right + shift, top + shift, right + shift, bottom + shift, left + shift, bottom + shift, left, bottom];
}

/** Stohy, ktoré sa majú kresliť: s výškou > 0 a vrchným kontajnerom, 40′ raz na pár bays; od najnižšieho (potom po radoch a bays). */
export function visibleStacks(stacks: readonly StackVM[]): readonly VisibleStack[] {
  const seen = new Set<string>();
  const result: VisibleStack[] = [];
  for (const stack of stacks) {
    if (stack.top === null || stack.height <= 0) continue;
    const bay = stack.top.sizeFt === 40 ? pairStartOf(stack.bay) : stack.bay;
    const key = positionKey(bay, stack.row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...stack, bay, top: stack.top });
  }
  return result.sort((a, b) => a.height - b.height || a.row - b.row || a.bay - b.bay);
}

/** Jeden nakreslený stoh (pre testy): pozícia, výška, sprite vrchného kontajnera a jeho tieň (`null` pri výške 0). */
export interface DrawnStack {
  readonly bay: number;
  readonly row: number;
  readonly height: number;
  readonly sizeFt: 20 | 40;
  readonly sprite: CargoSprite;
  readonly shadow: Graphics;
}

/** Podpis obsahu VM bloku: pri nezmenenom podpise sa ozdoba neprekresľuje. */
function signatureOf(vm: ModuleVM, geometry: StackGeometryVM): string {
  const parts = [`${String(geometry.bays)}x${String(geometry.rows)}x${String(geometry.maxTier)}`, vm.depot === undefined ? 'y' : 'd'];
  for (const stack of vm.stacks ?? []) {
    const top = stack.top;
    parts.push(
      `${String(stack.bay)},${String(stack.row)},${String(stack.height)}` +
        (top === null ? '' : `,${String(top.sizeFt)},${top.containerType},${top.lineId ?? ''},${top.direction},${top.oog === true ? 'o' : ''},${top.reefer ?? ''}`),
    );
  }
  return parts.join(';');
}

export class StacksDecor implements ModuleDecor {
  readonly view = new Container({ label: 'stacks' });
  private readonly ground = new Graphics({ label: 'stacks-ground' });
  private readonly grid = new Graphics({ label: 'stacks-grid' });
  private readonly tops = new Container({ label: 'stacks-tops' });
  private signature = '';
  /** Posledné VM polia, pre ktoré je ozdoba nakreslená: rovnaké referencie (snapshot bez zmeny) preskočia aj výpočet podpisu. */
  private lastStacks: readonly StackVM[] | null = null;
  private lastGeometry: StackGeometryVM | undefined;
  private lastDepot: ModuleVM['depot'];
  private shown = true;
  private currentLayout: StackLayout = stackLayout({ bays: 1, rows: 1 }, 1, 1, 1);
  private stackList: DrawnStack[] = [];

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.view.addChild(this.ground, this.grid, this.tops);
    this.update(vm);
  }

  /** Ozdoba kreslí telo bloku (ModuleView skryje sprite `fillNN`). */
  get coversBody(): boolean {
    return this.shown;
  }

  /** Nakreslené stohy od najnižšieho — pre testy. */
  get stacks(): readonly DrawnStack[] {
    return this.stackList;
  }

  /** Rozloženie bloku (lokálny rámec modulu) pre posledný VM — pre testy. */
  get layout(): StackLayout {
    return this.currentLayout;
  }

  update(vm: ModuleVM): void {
    this.shown = vm.stacks !== undefined;
    this.view.visible = this.shown;
    if (vm.stacks === undefined) return;
    if (vm.stacks === this.lastStacks && vm.stackGeometry === this.lastGeometry && (vm.depot === undefined) === (this.lastDepot === undefined)) return;
    this.lastStacks = vm.stacks;
    this.lastGeometry = vm.stackGeometry;
    this.lastDepot = vm.depot;
    const geometry = stackGeometryOf(vm);
    const signature = signatureOf(vm, geometry);
    if (signature === this.signature) return;
    this.signature = signature;
    const { deps, pose } = this.context;
    const layout = stackLayout(geometry, pose.baseW, pose.baseH, deps.cellPx);
    this.currentLayout = layout;
    const visible = visibleStacks(vm.stacks);
    this.drawGround(vm, pose.baseW, pose.baseH);
    this.drawGrid(layout, coveredPositions(visible));
    this.drawStacks(visible, layout);
  }

  destroy(): void {
    this.stackList = [];
    this.view.destroy({ children: true });
  }

  /** Plocha bloku: výplň `--module-base` (depo prázdnych `--module-roof`) s obrysom `--module-outline`, odsadená ako sprite dvora. */
  private drawGround(vm: ModuleVM, baseW: number, baseH: number): void {
    const { cellPx, palette } = this.context.deps;
    const inset = STACK_GROUND_INSET_CELLS * cellPx;
    const fill = vm.depot === undefined ? palette.module.base : palette.module.roof;
    const { outline } = palette.module;
    this.ground
      .clear()
      .rect(-(baseW * cellPx) / 2 + inset, -(baseH * cellPx) / 2 + inset, baseW * cellPx - 2 * inset, baseH * cellPx - 2 * inset)
      .fill({ color: fill.color, alpha: fill.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: outline.color, alpha: outline.alpha, alignment: 1 });
  }

  /** Obrys každej pozície `bay × row` (veľkosť 20′ kontajnera po zmenšení); pozície pod 40′ kontajnerom (`covered`) sa nekreslia. */
  private drawGrid(layout: StackLayout, covered: ReadonlySet<string>): void {
    const { cellPx, palette } = this.context.deps;
    const { grid } = palette.stack;
    const w = layout.natural.w * layout.fit;
    const h = layout.natural.h * layout.fit;
    this.grid.clear();
    for (let row = 0; row < layout.rows; row++) {
      for (let bay = 0; bay < layout.bays; bay++) {
        if (covered.has(positionKey(bay, row))) continue;
        const at = positionCentre(layout, bay, row);
        this.grid.rect(at.x - w / 2, at.y - h / 2, w, h);
      }
    }
    this.grid.stroke({ width: (OUTLINE_CELLS * cellPx) / 2, color: grid.color, alpha: grid.alpha });
  }

  /** Odznak zásuvky reefera (`overlay.reefer_plug_<stav>`) na pravom konci vrchného kontajnera; bez textúry malý kruh z tokenov (`on` accent, `off` neutrál, `alarm` varovanie). */
  private plugBadge(state: 'on' | 'off' | 'alarm', x: number, y: number, fit: number): Container {
    const { cellPx, palette, textures } = this.context.deps;
    const size = REEFER_PLUG_SIZE.w * manifestScale(cellPx) * fit;
    const holder = new Container({ label: `reefer-plug-${state}` });
    holder.position.set(x, y);
    const texture = textures?.file(REEFER_PLUG_FILES[state]);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(size, size);
      holder.addChild(sprite);
    } else {
      const color = state === 'on' ? palette.accent : state === 'alarm' ? palette.emptyState.repair : palette.container.neutral;
      holder.addChild(new Graphics().circle(0, 0, size / 2).fill({ color: color.color, alpha: color.alpha }));
    }
    return holder;
  }

  /** Vrchné kontajnery od najnižšieho stohu; pred každým jeho tieň (výška × krok dole-vpravo), orezaný na plochu bloku. */
  private drawStacks(stacks: readonly VisibleStack[], layout: StackLayout): void {
    const { deps } = this.context;
    const { cellPx, palette } = deps;
    const unitStep = palette.stack.shadowStepPx * manifestScale(cellPx);
    const { baseW, baseH } = this.context.pose;
    const edge = (STACK_GROUND_INSET_CELLS + OUTLINE_CELLS) * cellPx; // plocha bloku končí pri obryse, tieň ju neopúšťa
    const limit = { left: -(baseW * cellPx) / 2 + edge, top: -(baseH * cellPx) / 2 + edge, right: (baseW * cellPx) / 2 - edge, bottom: (baseH * cellPx) / 2 - edge };
    for (const child of this.tops.removeChildren()) child.destroy({ children: true });
    this.stackList = [];
    for (const stack of stacks) {
      const sprite = new CargoSprite(0, 'container_teu', deps, { container: stack.top });
      const at = stackCentre(layout, stack, stack.top.sizeFt);
      sprite.position.set(at.x, at.y);
      sprite.scale.set(layout.fit);
      const w = layout.natural.w * (stack.top.sizeFt / 20) * layout.fit;
      const h = layout.natural.h * layout.fit;
      const shift = stack.height * unitStep;
      const shadow = new Graphics({ label: 'stack-shadow' });
      const outline = shadowOutline(at.x - w / 2, at.y - h / 2, at.x + w / 2, at.y + h / 2, shift);
      const clamped = outline.map((value, index) => (index % 2 === 0 ? Math.min(Math.max(value, limit.left), limit.right) : Math.min(Math.max(value, limit.top), limit.bottom)));
      shadow.poly(clamped).fill({ color: palette.stack.shadow.color, alpha: palette.stack.shadow.alpha });
      this.tops.addChild(shadow, sprite);
      const plug = stack.top.reefer === undefined ? undefined : this.plugBadge(stack.top.reefer, at.x + w / 2 - (REEFER_PLUG_SIZE.w * manifestScale(cellPx) * layout.fit) / 2, at.y, layout.fit);
      if (plug !== undefined) this.tops.addChild(plug);
      this.stackList.push({ bay: stack.bay, row: stack.row, height: stack.height, sizeFt: stack.top.sizeFt, sprite, shadow });
    }
  }
}

export const stacksDecorFactory: ModuleDecorFactory = {
  id: 'stacks',
  applies: (vm) => vm.stacks !== undefined,
  create: (vm, context) => new StacksDecor(vm, context),
};
