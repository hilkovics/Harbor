/**
 * Pohyb portálového žeriavu nad kontajnerovým dvorom (RTG/RMG, spätná väzba F5b č. 8): čistý model bez Pixi, riadený
 * hodinami zvonka (testuje sa bez skutočného času).
 *
 * Žeriav má dve osi v lokálnom rámci dvora (rot 0, počiatok = stred footprintu, bunky): **portál** jazdí po koľajniciach
 * pozdĺž dvora (os y) a **vozík** po mostíku pozdĺž šírky dvora (os x); ich súčasný pohyb dovedie spreader nad slot.
 * Jedna operácia (`push`) trvá zhruba 0,5 – 1 s:
 *
 *   `travel` (presun nad slot, trvanie podľa vzdialenosti) → `lower` (spustenie) → `hold` (uchopenie / položenie)
 *   → `lift` (zdvihnutie).
 *
 * - **put** (vozidlo kontajner uložilo): kontajner visí na spreaderi od začiatku, pri `hold` ostane na slote a počas `lift`
 *   (spreader ide hore prázdny) sa vytráca — o vzhľad uloženého kontajnera sa potom stará sprite dvora (`fillNN`);
 * - **take** (vozidlo kontajner vzalo): spreader ide prázdny, pri `hold` kontajner uchopí, zdvihne ho a pri vrchole sa vytratí
 *   (odovzdanie vozidlu).
 *
 * Výška zdvihu (`hoist`: 0 = hore, 1 = dole) sa v pohľade zhora prejaví mierkou kontajnera (vyššie = väčší, bližšie ku kamere).
 *
 * Nová operácia počas bežiacej sa zaradí ako jediná čakajúca (ďalšia ju nahradí): pri vysokej rýchlosti simu žeriav nezaostáva
 * za frontou operácií, je to dekorácia, nie stav. S `reducedMotion` žeriav bez animácie hneď stojí nad posledným slotom.
 */

/** Bod v lokálnom rámci dvora (bunky od stredu footprintu; `x` doprava, `y` nadol). */
export interface CraneSpot {
  readonly x: number;
  readonly y: number;
}

/** Druh operácie: vozidlo kontajner uložilo (`put`), alebo vzalo (`take`). */
export type StorageOpKind = 'put' | 'take';

/** Operácia žeriavu: cieľ a druh. */
export interface CraneOp {
  readonly kind: StorageOpKind;
  readonly target: CraneSpot;
}

/** Trvanie fáz v ms: súčet pre typickú vzdialenosť je pod 1 s (zadanie 0,5 – 1 s). */
export const CRANE_PHASE_MS = Object.freeze({
  /** Presun: ms na bunku vzdialenosti (väčšia z osí), v rozsahu `travelMin` … `travelMax`. */
  travelPerCell: 150,
  travelMin: 150,
  travelMax: 450,
  lower: 180,
  hold: 80,
  lift: 180,
});

/** Mierka kontajnera na spreaderi v hornej polohe (bližšie ku kamere); dole je 1. */
export const CRANE_LIFT_SCALE = 1.25;

/** Podiel fázy `lift`, počas ktorého sa odovzdaný kontajner (`take`) vytráca na vrchole. */
export const CRANE_HANDOVER_SHARE = 0.4;

/** Kontajner pod žeriavom: priehľadnosť a mierka. */
export interface CraneCargo {
  readonly alpha: number;
  readonly scale: number;
}

export type CranePhase = 'idle' | 'travel' | 'lower' | 'hold' | 'lift';

/** Póza žeriavu v jednom okamihu. */
export interface YardCranePose {
  /** Poloha portálu (os y) a vozíka (os x) v lokálnom rámci dvora, bunky. */
  readonly gantryY: number;
  readonly trolleyX: number;
  /** Výška spreadera: 0 = hore, 1 = dole na slote. */
  readonly hoist: number;
  /** Kontajner na spreaderi / na slote, alebo `null`. */
  readonly cargo: CraneCargo | null;
  readonly phase: CranePhase;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Plynulý rozbeh a dobeh (smoothstep). */
const ease = (t: number): number => t * t * (3 - 2 * t);

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** Rozpracovaná operácia: časy fáz sú absolútne (ms hodín). */
interface ActiveOp {
  readonly op: CraneOp;
  readonly from: CraneSpot;
  readonly start: number;
  readonly travelEnd: number;
  readonly lowerEnd: number;
  readonly holdEnd: number;
  readonly end: number;
}

function plan(op: CraneOp, from: CraneSpot, start: number): ActiveOp {
  const cells = Math.max(Math.abs(op.target.x - from.x), Math.abs(op.target.y - from.y));
  const travel = Math.min(CRANE_PHASE_MS.travelMax, Math.max(CRANE_PHASE_MS.travelMin, cells * CRANE_PHASE_MS.travelPerCell));
  const travelEnd = start + travel;
  const lowerEnd = travelEnd + CRANE_PHASE_MS.lower;
  const holdEnd = lowerEnd + CRANE_PHASE_MS.hold;
  return { op, from, start, travelEnd, lowerEnd, holdEnd, end: holdEnd + CRANE_PHASE_MS.lift };
}

/** Celkové trvanie operácie z jedného miesta na druhé (ms) — pre testy a ladenie. */
export function craneOpDuration(from: CraneSpot, target: CraneSpot): number {
  const active = plan({ kind: 'put', target }, from, 0);
  return active.end;
}

export class YardCraneMotion {
  private spot: CraneSpot;
  private current: ActiveOp | null = null;
  private pending: CraneOp | null = null;

  /**
   * @param home pokojová poloha žeriavu, kým nemal žiadnu operáciu
   * @param now hodiny v ms (predvolene sa podávajú z `ModuleViewDeps.now`)
   * @param reducedMotion `true` = bez animácie (`prefers-reduced-motion`); čítané pri každej operácii
   */
  constructor(
    home: CraneSpot,
    private readonly now: () => number,
    private readonly reducedMotion: () => boolean = () => false,
  ) {
    this.spot = home;
  }

  /** Žeriav práve vykonáva operáciu alebo nejakú čaká. */
  get busy(): boolean {
    return this.current !== null || this.pending !== null;
  }

  /** Nová operácia: hneď (ak je žeriav voľný), inak ako jediná čakajúca. S `reducedMotion` žeriav len preskočí nad cieľ. */
  push(op: CraneOp): void {
    if (this.reducedMotion()) {
      this.current = null;
      this.pending = null;
      this.spot = op.target;
      return;
    }
    this.settle();
    if (this.current === null) this.current = plan(op, this.spot, this.now());
    else this.pending = op;
  }

  /** Póza v aktuálnom čase (posunie frontu hotových operácií). */
  pose(): YardCranePose {
    this.settle();
    const active = this.current;
    if (active === null) return { gantryY: this.spot.y, trolleyX: this.spot.x, hoist: 0, cargo: null, phase: 'idle' };
    const t = this.now();
    const travel = ease(clamp01((t - active.start) / (active.travelEnd - active.start)));
    const trolleyX = lerp(active.from.x, active.op.target.x, travel);
    const gantryY = lerp(active.from.y, active.op.target.y, travel);
    const put = active.op.kind === 'put';
    if (t < active.travelEnd) {
      return { gantryY, trolleyX, hoist: 0, phase: 'travel', cargo: put ? { alpha: 1, scale: CRANE_LIFT_SCALE } : null };
    }
    if (t < active.lowerEnd) {
      const hoist = ease(clamp01((t - active.travelEnd) / (active.lowerEnd - active.travelEnd)));
      return { gantryY, trolleyX, hoist, phase: 'lower', cargo: put ? { alpha: 1, scale: lerp(CRANE_LIFT_SCALE, 1, hoist) } : null };
    }
    if (t < active.holdEnd) {
      const grab = clamp01((t - active.lowerEnd) / (active.holdEnd - active.lowerEnd));
      return { gantryY, trolleyX, hoist: 1, phase: 'hold', cargo: put ? { alpha: 1, scale: 1 } : { alpha: grab, scale: 1 } };
    }
    const lift = clamp01((t - active.holdEnd) / (active.end - active.holdEnd));
    const hoist = 1 - ease(lift);
    if (put) {
      // kontajner ostáva na slote a vytráca sa (sprite dvora ho prevezme)
      return { gantryY, trolleyX, hoist, phase: 'lift', cargo: { alpha: 1 - lift, scale: 1 } };
    }
    const fade = clamp01((lift - (1 - CRANE_HANDOVER_SHARE)) / CRANE_HANDOVER_SHARE);
    return { gantryY, trolleyX, hoist, phase: 'lift', cargo: { alpha: 1 - fade, scale: lerp(1, CRANE_LIFT_SCALE, ease(lift)) } };
  }

  /** Ukončí operácie, ktorých čas uplynul, a spustí čakajúcu (nadväzuje na koniec predchádzajúcej). */
  private settle(): void {
    const t = this.now();
    while (this.current !== null && t >= this.current.end) {
      const finished = this.current;
      this.spot = finished.op.target;
      const next = this.pending;
      this.pending = null;
      this.current = next === null ? null : plan(next, this.spot, finished.end);
    }
  }
}
