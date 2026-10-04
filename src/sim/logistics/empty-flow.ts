/**
 * Plán toku prázdnych kontajnerov (F6c, ADR-034) — **jediný stav**, ktorý prázdne kontajnery potrebujú mimo ledgera, kontraktov
 * a vozidiel: fronty naplánovaných udalostí zoradené podľa ticku (zdroj `Rng` je jediný `Rng` sveta, plán sa losuje pri vzniku
 * udalosti, takže save po obnove pokračuje bitovo rovnako).
 *
 * - **`returnPlan`** — návrat prázdneho kontajnera linky z vnútrozemia: keď importná jednotka odíde kamiónom (`→ exported`) a
 *   `rng.chance(emptyReturnRate)` vyjde, do plánu pribudne `{ dueTick = tick + round(rng.range(hinterlandDaysRange) × ticksPerDay),
 *   lineId }`. V `dueTick` spawne krok 8 kamión misie `delivery` s novou jednotkou `direction: 'empty'` (`in_truck`).
 * - **`pickupPlan`** — výdaj prázdneho exportérovi: pri prijatí export bookingu sa pre každú jednotku plánu príchodov
 *   `rng.chance(emptyPickupRate)` rozhodne, či ju predchádza prázdny kamión; položka `{ dueTick = príchod − rng.range(emptyPickupLeadHoursRange)
 *   × ticksPerHour (najskôr acceptedTick + 1), lineId bookingu, contractId }`. V `dueTick` spawne krok 8 kamión misie `pickup` po
 *   prázdny kontajner linky (z depa cez rampu); bez dostupného prázdneho čaká `emptyPickupMaxWaitHours`.
 *
 * Plány sú v poradí `dueTick` neklesajúco, pri rovnakom ticku v poradí vzniku (stabilné). Táto trieda nepozná `Rng`, defy ani svet —
 * len drží a serializuje plán; losovanie a spotrebu robia systémy (T6C-02). Spotrebuje sa **až po vzniku kamióna** (ako plán
 * príchodov exportu): bez bayu, rampy alebo portálu položka počká a žiadna udalosť nezanikne.
 */

/** Plánovaný návrat jedného prázdneho kontajnera linky. */
export interface ReturnPlanEntry {
  /** Tick, od ktorého krok 8 spawne kamión s prázdnym (celé ≥ 0). */
  readonly dueTick: number;
  /** Linka z `lines.json`, ktorej kontajner sa vráti. */
  readonly lineId: string;
}

/** Plánovaný výdaj jedného prázdneho kontajnera linky exportérovi. */
export interface PickupPlanEntry {
  readonly dueTick: number;
  readonly lineId: string;
  /** Export booking, pre ktorého jednotku exportér prázdny berie (`ContractId`, celé ≥ 1). */
  readonly contractId: number;
}

/** Stav plánu v save (`WorldState.emptyFlow`, v8). */
export interface EmptyFlowState {
  readonly returnPlan: readonly ReturnPlanEntry[];
  readonly pickupPlan: readonly PickupPlanEntry[];
}

/** Kľúče `EmptyFlowState` v poradí `getState()`. */
export const EMPTY_FLOW_STATE_KEYS: readonly (keyof EmptyFlowState)[] = ['returnPlan', 'pickupPlan'];
/** Kľúče položky `returnPlan` v poradí `getState()`. */
export const RETURN_PLAN_ENTRY_KEYS: readonly (keyof ReturnPlanEntry)[] = ['dueTick', 'lineId'];
/** Kľúče položky `pickupPlan` v poradí `getState()`. */
export const PICKUP_PLAN_ENTRY_KEYS: readonly (keyof PickupPlanEntry)[] = ['dueTick', 'lineId', 'contractId'];

/** Vloží položku za posledný prvok s `dueTick ≤ entry.dueTick` (stabilné poradie vzniku). */
function insertByDue<T extends { readonly dueTick: number }>(plan: T[], entry: T): void {
  let at = plan.length;
  while (at > 0 && plan[at - 1].dueTick > entry.dueTick) at -= 1;
  plan.splice(at, 0, entry);
}

export class EmptyFlow {
  private readonly returns: ReturnPlanEntry[];
  private readonly pickups: PickupPlanEntry[];

  /** Prázdny plán (nová hra); obnovu zo save robí `EmptyFlow.fromState`. */
  constructor(state: EmptyFlowState = { returnPlan: [], pickupPlan: [] }) {
    this.returns = state.returnPlan.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId }));
    this.pickups = state.pickupPlan.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId, contractId: entry.contractId }));
  }

  /** Obnova zo save (tvar a hodnoty overil `parseEmptyFlowState`). */
  static fromState(state: EmptyFlowState): EmptyFlow {
    return new EmptyFlow(state);
  }

  /** Plánované návraty prázdnych v poradí `dueTick` (živé pole len na čítanie). */
  get returnPlan(): readonly ReturnPlanEntry[] {
    return this.returns;
  }

  /** Plánované výdaje prázdnych exportérom v poradí `dueTick` (živé pole len na čítanie). */
  get pickupPlan(): readonly PickupPlanEntry[] {
    return this.pickups;
  }

  /** Naplánuje návrat prázdneho kontajnera linky `lineId` v `dueTick`. */
  scheduleReturn(dueTick: number, lineId: string): void {
    insertByDue(this.returns, { dueTick, lineId });
  }

  /** Naplánuje výdaj prázdneho kontajnera linky `lineId` exportérovi bookingu `contractId` v `dueTick`. */
  schedulePickup(dueTick: number, lineId: string, contractId: number): void {
    insertByDue(this.pickups, { dueTick, lineId, contractId });
  }

  /** Najbližší návrat, ktorý je splatný v `tick` (`dueTick ≤ tick`), inak `undefined`. */
  dueReturn(tick: number): ReturnPlanEntry | undefined {
    const [first] = this.returns;
    return first !== undefined && first.dueTick <= tick ? first : undefined;
  }

  /** Najbližší výdaj splatný v `tick`, inak `undefined`. */
  duePickup(tick: number): PickupPlanEntry | undefined {
    const [first] = this.pickups;
    return first !== undefined && first.dueTick <= tick ? first : undefined;
  }

  /** Odstráni najbližší návrat (kamión s prázdnym vznikol). */
  consumeReturn(): void {
    this.returns.shift();
  }

  /** Odstráni najbližší výdaj (kamión po prázdny vznikol). */
  consumePickup(): void {
    this.pickups.shift();
  }

  /** Odstráni všetky nesplatené výdaje bookingu `contractId` (booking sa uzavrel skôr než kamión vznikol); vráti ich počet. */
  dropPickupsOf(contractId: number): number {
    const before = this.pickups.length;
    for (let i = this.pickups.length - 1; i >= 0; i--) if (this.pickups[i].contractId === contractId) this.pickups.splice(i, 1);
    return before - this.pickups.length;
  }

  /** Čistý JSON stav pre save (nová kópia). */
  getState(): EmptyFlowState {
    return {
      returnPlan: this.returns.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId })),
      pickupPlan: this.pickups.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId, contractId: entry.contractId })),
    };
  }
}
