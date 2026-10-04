/**
 * Manéver kamióna pri rampe (F5b č. 11, F6a): príjazd po ceste → zastavenie vedľa docku → **cúvanie** do docku (zadok k rampe,
 * kabína von) → nakládka (import) alebo **vykládka** (export, F6a) → výjazd predkom. Sim polohu abstrahuje (kamión stojí na
 * vonkajšej bunke konektora docku, stavy `to_dock` → `loading` / `unloading` → `to_gate_out`; pri dual transaction
 * `unloading` → `loading` v tom istom doku), manéver je čisto prezentačný: riadi ho čas a stav z `TruckVM` (`state`, `prevState`,
 * `approach`), nie nové polia simu. Vykládka exportného kamióna sa kreslí rovnakým manévrom ako nakládka — kamión cúva do docku
 * naložený a z docku odchádza prázdny (alebo s importom).
 *
 * Čisté funkcie a trieda bez Pixi; hodiny sa podávajú zvonka (testy bez skutočného času).
 *
 * **Cúvanie** (`planDockPath`) je kubická Bézierova krivka z póz príjazdu do pózy v doku (px sveta). Kamión cúva, takže
 * smer jeho pohybu je opačný než kurz: na začiatku `−dopredu(kurz príjazdu)`, na konci smerom do modulu (kurz v doku je
 * opačný). Kurz sa plynulo otáča z kurzu príjazdu na kurz v doku (najkratšie, cca 90°) počas celého pohybu — kamión sa nikdy
 * neotáča na mieste:
 *  - príjazd popri dokoch (kurz kolmý na os docku, typicky cesta rovnobežná s rampou): kamión cúva oblúkom do docku;
 *  - príjazd priamo na modul (kurz smeruje k dock, cesta končí na konektore): kamión vycúva do boku a vracia sa do osi docku
 *    — otočka o 180° sa deje počas pohybu po slučke, nie na mieste. Do boku vycúva na tú stranu, kde pri bunke pokračuje cesta
 *    (inak vpravo od smeru príjazdu), aby nezametal cez okolité moduly.
 *
 * **Výjazd** (`DockManeuver` fáza `leaving`): kamión odíde z docku predkom; zobrazená póza sa počas `DOCK_LEAVE_MS` plynule
 * približuje od pózy v doku k pohybujúcej sa póze zo simu (kurz sa pritom otáča najkratšie), takže nevznikne skok ani otočka
 * na mieste.
 *
 * **Sim je rýchlejší než manéver** (ADR-029): kamión má na dock náklad pripravený už pri povele (`waiting → to_dock`), takže
 * `loading` trvá len `loadTicksPerUnit` tickov (pri 1× zlomok `DOCK_STOP_MS + DOCK_REVERSE_MS`) a sim kamión odíde
 * (`loading → to_gate_out`) skôr, než sa dokončí cúvanie. Zobrazený kamión cúvanie **dokončí** (fáza `entering` pokračuje aj po
 * odchode zo `loading`, po odchode zo simu `DOCK_CATCH_UP`-krát rýchlejšie, aby nezdržiaval nasledujúci kamión toho istého
 * docku) a až potom vyjde; `leaving` ho plynule dobehne k pohybujúcej sa póze zo simu.
 */
import type { VehiclePose } from './vehicle-view';
import type { TruckVM } from './view-models';

/** Póza vozidla vo svete: stred (px) a uhol v stupňoch (0 = kabína na sever, v smere hodinových ručičiek). */
export type PosePx = VehiclePose;

/**
 * Stavy `TruckVM.state`, v ktorých kamión stojí v doku rampy a vymieňa náklad: `loading` (import, nakládka) a `unloading` (export,
 * vykládka; F6a). Tabuľka namiesto vetvenia — ďalší stav docku = jeden prvok (pravidlo 7).
 */
export const DOCKED_STATES: ReadonlySet<string> = new Set(['loading', 'unloading']);

/** Zastavenie vedľa docku pred začiatkom cúvania (ms). */
export const DOCK_STOP_MS = 300;

/** Trvanie cúvania do docku (ms). */
export const DOCK_REVERSE_MS = 1300;

/** Trvanie výjazdu z docku do pohybu zo simu (ms). */
export const DOCK_LEAVE_MS = 900;

/** Násobok rýchlosti, ktorým sa cúvanie dokončí, keď sim kamión už pustil z docku (viď hlavička). */
export const DOCK_CATCH_UP = 2;

/** Dĺžka vodiacich úsekov krivky ako podiel vzdialenosti medzi pózami, najmenej `MIN_ARM_CELLS` bunky. */
const ARM_SHARE = 0.9;
const MIN_ARM_CELLS = 0.5;

/** Bočné vybočenie slučky pri otočke o 180° v bunkách (kamión vycúva do boku). */
const SWING_CELLS = 0.9;

/** Strana (vzhľadom na kurz príjazdu), na ktorú kamión pri otočke o 180° vycúva do boku. */
export type SwingSide = 'left' | 'right';

/** Plynulý rozbeh a dobeh. */
export const smooth = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** Uhol do rozsahu [0, 360). */
function normalizeDeg(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** Najkratšia orientovaná zmena uhla `from → to` v stupňoch, (−180, 180]. */
export function shortestDelta(from: number, to: number): number {
  const delta = normalizeDeg(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/** Jednotkový vektor smeru jazdy pre uhol kurzu (0 = sever = −y, 90 = východ = +x). */
function directionOf(angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/** Uhol v rozsahu, v ktorom sa krivka „otočí o 180°“ (hranica pre slučku). */
const U_TURN_DEG = 179;

/** Krivka manévru: póza v čase `progress` ∈ [0, 1] (plynulý rozbeh a dobeh v cene). */
export interface DockPath {
  at(progress: number): PosePx;
}

/**
 * Cúvanie z pózy príjazdu `from` do pózy v doku `to` (px sveta, `cellPx` = `--cell`). Smer pohybu na začiatku je opačný než
 * kurz príjazdu, na konci opačný než kurz v doku; kurz sa otáča z `from.angle` na `to.angle` najkratšie, pri otočke o 180°
 * so slučkou na strane `swing` (vpravo: proti smeru hodinových ručičiek, vľavo: v smere).
 */
export function planDockPath(from: PosePx, to: PosePx, cellPx: number, swing: SwingSide = 'right'): DockPath {
  const startDir = directionOf(from.angle + 180); // cúvanie: proti kurzu
  const endDir = directionOf(to.angle + 180);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const arm = Math.max(MIN_ARM_CELLS * cellPx, ARM_SHARE * distance);
  let turn = shortestDelta(from.angle, to.angle);
  let bulge = { x: 0, y: 0 };
  if (Math.abs(turn) > U_TURN_DEG) {
    // kamión smeruje na modul: vycúva do boku a vráti sa do osi; vpravo sa kurz otáča o −180°, vľavo o +180°
    const sign = swing === 'right' ? 1 : -1;
    turn = -180 * sign;
    const side = directionOf(from.angle + 90 * sign);
    bulge = { x: side.x * SWING_CELLS * cellPx, y: side.y * SWING_CELLS * cellPx };
  }
  const p0 = { x: from.x, y: from.y };
  const p1 = { x: from.x + startDir.x * arm + bulge.x, y: from.y + startDir.y * arm + bulge.y };
  const p2 = { x: to.x - endDir.x * arm + bulge.x, y: to.y - endDir.y * arm + bulge.y };
  const p3 = { x: to.x, y: to.y };
  return {
    at(progress) {
      const k = smooth(progress);
      const u = 1 - k;
      const b0 = u * u * u;
      const b1 = 3 * u * u * k;
      const b2 = 3 * u * k * k;
      const b3 = k * k * k;
      return {
        x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
        y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
        angle: normalizeDeg(from.angle + turn * k),
      };
    },
  };
}

/** Plynulé prelínanie póz: poloha lineárne, uhol najkratším smerom. */
export function blendPose(from: PosePx, to: PosePx, share: number): PosePx {
  const k = Math.min(1, Math.max(0, share));
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    angle: normalizeDeg(from.angle + shortestDelta(from.angle, to.angle) * k),
  };
}

export type DockPhase = 'free' | 'entering' | 'docked' | 'leaving';

/** Zdroje póz pre `DockManeuver.update`: pózy sa počítajú lenivo (len keď ich fáza potrebuje). */
export interface DockPoses {
  /** Bežná póza kamióna zo simu (pruh, oblúky): mimo docku a cieľ výjazdu. */
  readonly sim: () => PosePx;
  /** Póza na vonkajšej bunke konektora docku (východisko cúvania), alebo `null` bez `vm.approach`. */
  readonly approach: () => PosePx | null;
  /** Strana, na ktorú má kamión pri príjazde priamo na modul vycúvať do boku (kde pokračuje cesta); predvolene vpravo. */
  readonly swing?: () => SwingSide;
}

/**
 * Stav manévru jedného kamióna: `free` (jazda podľa simu) → `entering` (zastavenie + cúvanie) → `docked` (nakládka) →
 * `leaving` (výjazd) → `free`. Prechody riadi `TruckVM.state`/`prevState`; čas hodiny z konštruktora.
 */
export class DockManeuver {
  private phase: DockPhase = 'free';
  private path: DockPath | null = null;
  private startedAt = 0;
  private leaveFrom: PosePx | null = null;
  /** Póza v doku (cieľ cúvania), zapamätaná počas `loading` / `unloading` — po odchode sim kamióna ju `TruckVM` už nenesie. */
  private dockTarget: PosePx | null = null;
  /** Čas, kedy sim kamión pustil z docku počas cúvania (od neho cúva `DOCK_CATCH_UP`-krát rýchlejšie); `null` = ešte nepustil. */
  private releasedAt: number | null = null;
  private lastState: string | null = null;
  /** `TruckVM.loaded` v okamihu, keď kamión prišiel k dokom (začiatok cúvania); pri `entering` sa zobrazuje namiesto aktuálneho. */
  private loadedOnEntry = false;

  constructor(
    private readonly now: () => number,
    private readonly cellPx: number,
  ) {}

  get currentPhase(): DockPhase {
    return this.phase;
  }

  /**
   * Či má kamión zobraziť naložený sprite: kým cúva do docku (`entering`), drží stav z príchodu — export prichádza naložený a
   * prázdny je až po vykládke v doku, import naopak (sim je rýchlejší než manéver, jednotka sa v ňom presunie skôr, než kamión
   * dôjde do docku). Inak (mimo docku, v doku, pri výjazde) platí `vm.loaded`.
   */
  displayLoaded(vm: Pick<TruckVM, 'loaded'>): boolean {
    return this.phase === 'entering' ? this.loadedOnEntry : vm.loaded;
  }

  /** Zobrazená póza kamióna pre `vm` (mimo manévru je to `poses.sim()`). */
  update(vm: TruckVM, poses: DockPoses): PosePx {
    const t = this.now();
    const docking = DOCKED_STATES.has(vm.state) && vm.approach !== undefined;
    let result: PosePx;
    if (docking) {
      if (this.phase === 'free') this.enter(vm, poses, t);
      else if (this.phase === 'leaving') this.phase = 'docked';
      this.releasedAt = null;
      this.dockTarget = dockPose(vm, this.cellPx);
      result = this.dockedPose(this.dockTarget, t);
    } else {
      result = this.outsideDock(poses, t);
    }
    this.lastState = vm.state;
    return result;
  }

  /**
   * Sim kamión už nie je v `loading` (odišiel z docku alebo ešte nepríšiel): rozpracované cúvanie sa najprv dokončí
   * (sim je rýchlejší než manéver, viď hlavička), potom nasleduje výjazd, inak jazda podľa simu.
   */
  private outsideDock(poses: DockPoses, t: number): PosePx {
    if (this.phase === 'entering' && this.dockTarget !== null) {
      if (this.releasedAt === null) this.releasedAt = t;
      const reversing = this.dockedPose(this.dockTarget, t);
      if (this.phase === 'entering') return reversing;
    }
    if (this.phase === 'docked') {
      this.phase = 'leaving';
      this.leaveFrom = this.dockTarget;
      this.startedAt = t;
    }
    return this.phase === 'leaving' ? this.leavingPose(poses, t) : poses.sim();
  }

  /** Kamión prišiel do `loading` / `unloading`: po práve dokončenej jazde k dokom (`to_dock`) cúva, inak (napr. nový view) stojí v doku. */
  private enter(vm: TruckVM, poses: DockPoses, t: number): void {
    this.loadedOnEntry = vm.loaded;
    const approach = poses.approach();
    const arrived = this.lastState === 'to_dock' || vm.prevState === 'to_dock';
    if (approach === null || !arrived) {
      this.phase = 'docked';
      return;
    }
    this.phase = 'entering';
    this.startedAt = t;
    this.path = planDockPath(approach, dockPose(vm, this.cellPx), this.cellPx, poses.swing?.() ?? 'right');
  }

  /** Póza počas `entering` (stojí, potom cúva po krivke); po dokončení fáza `docked` a póza `target`. */
  private dockedPose(target: PosePx, t: number): PosePx {
    if (this.phase === 'entering' && this.path !== null) {
      const caughtUp = this.releasedAt === null ? 0 : (t - this.releasedAt) * (DOCK_CATCH_UP - 1);
      const progress = (t - this.startedAt + caughtUp - DOCK_STOP_MS) / DOCK_REVERSE_MS;
      if (progress < 1) return this.path.at(Math.max(0, progress));
      this.phase = 'docked';
    }
    return target;
  }

  private leavingPose(poses: DockPoses, t: number): PosePx {
    const progress = (t - this.startedAt) / DOCK_LEAVE_MS;
    const sim = poses.sim();
    if (progress >= 1 || this.leaveFrom === null) {
      this.phase = 'free';
      this.leaveFrom = null;
      return sim;
    }
    return blendPose(this.leaveFrom, sim, smooth(progress));
  }
}

/** Cieľová póza v doku: `x`, `y`, `heading` z VM v bunkách → px, bez posunu pruhu. */
export function dockPose(vm: Pick<TruckVM, 'x' | 'y' | 'heading'>, cellPx: number): PosePx {
  return { x: vm.x * cellPx, y: vm.y * cellPx, angle: vm.heading };
}
