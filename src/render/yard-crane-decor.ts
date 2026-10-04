/**
 * Ozdoba kontajnerového dvora: portálový žeriav (RTG/RMG, `ModuleVM.storage` + `lastStorageOp`, spätná väzba F5b č. 8).
 *
 * Kreslí sa procedurálne (`Graphics` z tokenov `--crane-frame`, `--crane-boom`, `--cargo-container`; manifest pre dvor nemá
 * časti žeriavu; kontajner na spreaderi je sivý `--cargo-empty`, keď ide o depo prázdnych alebo operáciu s prázdnym kontajnerom, F6c): dve koľajnice po dlhých stranách dvora, mostík s nohami (portál) naprieč dvorom, vozík na mostíku
 * a pod ním spreader s kontajnerom. Keď vozidlo kontajner uloží alebo vezme (nová `lastStorageOp`), portál s vozíkom
 * sa presunie nad slot, spreader sa spustí a zdvihne (`yard-crane-motion.ts`, ~0,5 – 1 s). Medzi operáciami žeriav stojí
 * nad posledným slotom. Pri `prefers-reduced-motion` (`ModuleViewDeps.reducedMotion`) sa animácia vynechá a žeriav len stojí
 * nad posledným slotom.
 *
 * Poloha slotu: sloty jednej vrstvy (`sprites.<defId>.slots`) sú rozložené v mriežke `footprint.w` stĺpcov po riadkoch
 * (slot `n` → pozícia `n mod slots`, vrstva `⌊n / slots⌋`); mriežka zaberá footprint bez okraja `YARD_INSET_CELLS`, čo
 * zodpovedá rozloženiu políčok v sprite dvora (`container_yard_*_fill*.svg`: stĺpce 44/100/156/212 px zo 4 × 64 px).
 *
 * Ozdoba žije v lokálnom rámci modulu (rot 0, počiatok = stred footprintu); celý modul sa otáča, žeriav s ním.
 */
import { Container, Graphics } from 'pixi.js';
import { moduleSprite, type ModuleSpriteEntry } from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory, ModuleViewDeps } from './module-decor';
import type { EntityPalette } from './tokens';
import type { ModuleVM } from './view-models';
import { CRANE_LIFT_SCALE, YardCraneMotion, type CraneSpot, type YardCranePose } from './yard-crane-motion';

/** Okraj dvora bez políčok (zlomok bunky): políčka v sprite dvora začínajú 20,5 px od okraja 64 px bunky. */
export const YARD_INSET_CELLS = 0.3;

/** Rozmer kontajnera v dvore (bunky): políčko v sprite `container_yard_*_fill*.svg` je 47 × 17 px z 64 px bunky. */
export const YARD_BOX_CELLS = Object.freeze({ w: 47 / 64, h: 17 / 64 });

/** Hrúbka obrysu (2 px z 64 px bunky, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Geometria žeriavu (zlomky bunky, ako `OUTLINE_CELLS`): koľajnica, mostík, noha portálu a vozík. */
const RAIL_CELLS = 3 / 64;
const BRIDGE_CELLS = 9 / 64;
const LEG_CELLS = Object.freeze({ w: 13 / 64, h: 19 / 64 });
const TROLLEY_CELLS = 15 / 64;
/** Vzdialenosť koľajnice od okraja footprintu. */
const RAIL_INSET_CELLS = 0.1;

/** Dvor má stohové pozície (`slots`, `layers` v manifeste) → je to sklad kontajnerov s portálovým žeriavom. */
export function isYardEntry(entry: ModuleSpriteEntry | undefined): entry is ModuleSpriteEntry & { slots: number } {
  return entry?.slots !== undefined && entry.layers !== undefined;
}

/**
 * Stred slotu `slot` dvora v lokálnom rámci (bunky od stredu footprintu, rot 0): mriežka `footprint.w` stĺpcov × riadkov
 * podľa počtu pozícií na vrstve, vrstvy sa na pozíciu skladajú. Neplatný (záporný / necelý) slot sa zaokrúhli nadol a orezá na 0.
 */
export function yardSlotSpot(entry: Pick<ModuleSpriteEntry, 'footprint' | 'slots'>, slot: number): CraneSpot {
  const { w, h } = entry.footprint;
  const positions = Math.max(1, entry.slots ?? w * h);
  const cols = Math.max(1, w);
  const rows = Math.ceil(positions / cols);
  const position = Math.max(0, Math.floor(slot)) % positions;
  const col = position % cols;
  const row = Math.floor(position / cols);
  const innerW = w - 2 * YARD_INSET_CELLS;
  const innerH = h - 2 * YARD_INSET_CELLS;
  return {
    x: -w / 2 + YARD_INSET_CELLS + ((col + 0.5) * innerW) / cols,
    y: -h / 2 + YARD_INSET_CELLS + ((row + 0.5) * innerH) / rows,
  };
}

/** Pokojová poloha žeriavu, kým dvor nemal operáciu: prvý riadok stredného stĺpca. */
export function yardCraneHome(entry: Pick<ModuleSpriteEntry, 'footprint' | 'slots'>): CraneSpot {
  const { w, h } = entry.footprint;
  const positions = Math.max(1, entry.slots ?? w * h);
  const rows = Math.ceil(positions / Math.max(1, w));
  return { x: 0, y: -h / 2 + YARD_INSET_CELLS + (0.5 * (h - 2 * YARD_INSET_CELLS)) / rows };
}

const defaultNow = (): number => performance.now();

/** `prefers-reduced-motion: reduce` z prehliadača; bez DOM (`matchMedia` chýba) `false`. */
export function browserReducedMotion(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class YardCraneDecor implements ModuleDecor {
  readonly view = new Container({ label: 'yard-crane' });
  private readonly entry: ModuleSpriteEntry & { slots: number };
  private readonly motion: YardCraneMotion;
  private readonly cellPx: number;
  private readonly palette: EntityPalette;
  /** Mostík (nohy + nosník) v polohe portálu: `y` = poloha portálu. */
  private readonly gantry = new Container({ label: 'yard-crane-gantry' });
  /** Vozík, spreader a kontajner v polohe vozíka (`x`, `y` = poloha spreadera). */
  private readonly trolley = new Container({ label: 'yard-crane-trolley' });
  private readonly spreader: Graphics;
  private readonly cargo: Graphics;
  /** Kontajner na spreaderi je prázdny (sivý): depo prázdnych vždy, inak podľa poslednej operácie (`lastStorageOp.empty`). */
  private emptyCargo: boolean;
  private readonly depot: boolean;
  /** Kľúč poslednej spracovanej operácie (`tick:slot:druh`); `null` = dvor ešte nemal operáciu. */
  private seenOp: string | null = null;
  /** Naposledy nakreslená póza (zmena sa prenesie do scény, nezmenená nealokuje). */
  private drawn: YardCranePose | null = null;

  constructor(vm: ModuleVM, context: ModuleDecorContext) {
    const entry = context.entry;
    if (!isYardEntry(entry)) throw new Error(`YardCraneDecor: ${vm.defId} nie je dvor so stohovými pozíciami (chýba slots/layers v manifeste)`);
    this.entry = entry;
    const deps = context.deps;
    this.cellPx = deps.cellPx;
    const op = vm.lastStorageOp;
    // dvor, ktorý už operáciu mal (nový view po načítaní), sa nerozbehne: žeriav stojí nad posledným slotom
    const home = op === undefined ? yardCraneHome(entry) : yardSlotSpot(entry, op.slot);
    this.seenOp = op === undefined ? null : opKey(op);
    this.motion = new YardCraneMotion(home, deps.now ?? defaultNow, deps.reducedMotion ?? browserReducedMotion);
    this.depot = vm.depot !== undefined;
    this.emptyCargo = this.depot || op?.empty === true;
    this.spreader = this.createSpreader(deps);
    this.palette = deps.palette;
    this.cargo = new Graphics();
    this.cargo.visible = false;
    this.drawCargo(this.emptyCargo);
    this.view.addChild(this.createRails(deps, entry), this.gantry, this.trolley);
    this.gantry.addChild(this.createBridge(deps, entry));
    this.trolley.addChild(this.cargo, this.spreader, this.createTrolley(deps));
    this.render(this.motion.pose());
  }

  /** Póza žeriavu práve teraz — pre testy. */
  get pose(): YardCranePose {
    return this.motion.pose();
  }

  /** Žeriav vykonáva alebo čaká operáciu — pre testy. */
  get busy(): boolean {
    return this.motion.busy;
  }

  /** Mostík žeriavu (kontajner s polohou portálu) — pre testy. */
  get gantryView(): Container {
    return this.gantry;
  }

  /** Vozík so spreaderom (kontajner s polohou vozíka) — pre testy. */
  get trolleyView(): Container {
    return this.trolley;
  }

  /** Kontajner na spreaderi — pre testy. */
  get cargoView(): Graphics {
    return this.cargo;
  }

  /** Kontajner na spreaderi je sivý (prázdny kontajner) — pre testy. */
  get carriesEmpty(): boolean {
    return this.emptyCargo;
  }

  update(vm: ModuleVM): void {
    const op = vm.lastStorageOp;
    if (op !== undefined) {
      const key = opKey(op);
      if (key !== this.seenOp) {
        this.seenOp = key;
        this.setEmptyCargo(this.depot || op.empty === true);
        this.motion.push({ kind: op.kind, target: yardSlotSpot(this.entry, op.slot) });
      }
    }
    this.render(this.motion.pose());
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** Prenesie pózu do scény (len pri zmene). */
  private render(pose: YardCranePose): void {
    const last = this.drawn;
    if (last !== null && last.gantryY === pose.gantryY && last.trolleyX === pose.trolleyX && last.hoist === pose.hoist && last.cargo?.alpha === pose.cargo?.alpha && last.cargo?.scale === pose.cargo?.scale) {
      return;
    }
    this.drawn = pose;
    const { cellPx } = this;
    this.gantry.y = pose.gantryY * cellPx;
    this.trolley.position.set(pose.trolleyX * cellPx, pose.gantryY * cellPx);
    // spreader ide hore = bližšie ku kamere = väčší; dole na slote má mierku 1
    const scale = pose.cargo === null ? 1 + (1 - pose.hoist) * (CRANE_LIFT_SCALE - 1) : pose.cargo.scale;
    this.spreader.scale.set(scale);
    this.spreader.visible = pose.phase !== 'idle';
    this.cargo.visible = pose.cargo !== null;
    if (pose.cargo !== null) {
      this.cargo.alpha = pose.cargo.alpha;
      this.cargo.scale.set(pose.cargo.scale);
    }
  }

  /** Dve koľajnice po dlhých stranách dvora. */
  private createRails(deps: ModuleViewDeps, entry: ModuleSpriteEntry): Graphics {
    const { cellPx, palette } = deps;
    const { w, h } = entry.footprint;
    const x = (w / 2 - RAIL_INSET_CELLS) * cellPx;
    const top = (-h / 2 + RAIL_INSET_CELLS) * cellPx;
    const height = (h - 2 * RAIL_INSET_CELLS) * cellPx;
    const thickness = RAIL_CELLS * cellPx;
    const { boom } = palette.crane;
    const graphics = new Graphics();
    for (const side of [-1, 1]) graphics.rect(side * x - thickness / 2, top, thickness, height).fill({ color: boom.color, alpha: boom.alpha });
    return graphics;
  }

  /** Mostík naprieč dvorom: nosník medzi koľajnicami a noha portálu na každej koľajnici; počiatok = stred nosníka. */
  private createBridge(deps: ModuleViewDeps, entry: ModuleSpriteEntry): Graphics {
    const { cellPx, palette } = deps;
    const { frame } = palette.crane;
    const { outline } = palette.module;
    const half = (entry.footprint.w / 2 - RAIL_INSET_CELLS) * cellPx;
    const beamHeight = BRIDGE_CELLS * cellPx;
    const legW = LEG_CELLS.w * cellPx;
    const legH = LEG_CELLS.h * cellPx;
    const line = { width: OUTLINE_CELLS * cellPx, color: outline.color, alpha: outline.alpha, alignment: 1 };
    const graphics = new Graphics();
    graphics.rect(-half, -beamHeight / 2, half * 2, beamHeight).fill({ color: frame.color, alpha: frame.alpha }).stroke(line);
    for (const side of [-1, 1]) {
      graphics.rect(side * half - legW / 2, -legH / 2, legW, legH).fill({ color: frame.color, alpha: frame.alpha }).stroke(line);
    }
    return graphics;
  }

  /** Vozík na mostíku (štvorec pod stredom spreadera). */
  private createTrolley(deps: ModuleViewDeps): Graphics {
    const { cellPx, palette } = deps;
    const { boom } = palette.crane;
    const { outline } = palette.module;
    const size = TROLLEY_CELLS * cellPx;
    const graphics = new Graphics();
    graphics
      .rect(-size / 2, -size / 2, size, size)
      .fill({ color: boom.color, alpha: boom.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: outline.color, alpha: outline.alpha, alignment: 1 });
    return graphics;
  }

  /** Rám spreadera: obrys veľkosti kontajnera (`vehicle.dark`), bez výplne — kontajner je pod ním. */
  private createSpreader(deps: ModuleViewDeps): Graphics {
    const { cellPx, palette } = deps;
    const { dark } = palette.vehicle;
    const w = YARD_BOX_CELLS.w * cellPx;
    const h = YARD_BOX_CELLS.h * cellPx;
    const graphics = new Graphics();
    graphics.rect(-w / 2, -h / 2, w, h).stroke({ width: OUTLINE_CELLS * cellPx, color: dark.color, alpha: dark.alpha, alignment: 0 });
    return graphics;
  }

  /** Prefarbí kontajner na spreaderi pri zmene druhu (oranžový ↔ sivý prázdny). */
  private setEmptyCargo(empty: boolean): void {
    if (empty === this.emptyCargo) return;
    this.emptyCargo = empty;
    this.drawCargo(empty);
  }

  /** Nakreslí kontajner na spreaderi: farba kategórie (`--cargo-container`) alebo prázdneho kontajnera (`--cargo-empty`) s obrysom a rebrami. */
  private drawCargo(empty: boolean): void {
    const { cellPx, palette } = this;
    const colors = empty ? palette.direction.empty : palette.cargo;
    const w = YARD_BOX_CELLS.w * cellPx;
    const h = YARD_BOX_CELLS.h * cellPx;
    this.cargo.clear();
    this.cargo
      .rect(-w / 2, -h / 2, w, h)
      .fill({ color: colors.base.color, alpha: colors.base.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: colors.dark.color, alpha: colors.dark.alpha, alignment: 1 });
  }
}

function opKey(op: NonNullable<ModuleVM['lastStorageOp']>): string {
  return `${String(op.tick)}:${String(op.slot)}:${op.kind}`;
}

export const yardCraneDecorFactory: ModuleDecorFactory = {
  id: 'yard_crane',
  applies: (vm) => vm.storage !== undefined && isYardEntry(moduleSprite(vm.defId)),
  create: (vm, context) => new YardCraneDecor(vm, context),
};
