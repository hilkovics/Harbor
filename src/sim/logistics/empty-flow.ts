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
 * - **`errands`** (dodatok T6C-02) — poverenie kamióna misie `collect`, ktorý po vzniku z `pickupPlan` čaká na prázdny kontajner linky:
 *   `{ truckId, lineId, contractId, unitId, giveUpTick }`; `unitId` je prázdny, ktorý dispatcher kamiónu pridelil (job zo skladu na jeho
 *   dock, potom jednotka na docku a v kamióne), `null` kým žiadny nie je; po `giveUpTick` bez neho kamión odíde prázdny. Položka zanikne,
 *   keď kamión opustí mapu (`EmptyPickedUp`) alebo sa vzdá (`EmptyPickupMissed`).
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

/** Poverenie kamióna misie `collect`: výdaj jedného prázdneho kontajnera linky exportérovi bookingu (dodatok T6C-02, ADR-034). */
export interface ErrandEntry {
  /** Kamión misie `collect` (celé ≥ 1). */
  readonly truckId: number;
  readonly lineId: string;
  /** Export booking, ktorého exportér prázdny berie (celé ≥ 1). */
  readonly contractId: number;
  /** Prázdny kontajner pridelený kamiónu, alebo `null`, kým žiadny nie je. */
  readonly unitId: number | null;
  /** Od tohto ticku kamión bez prideleného prázdneho odíde prázdny (`vznik + emptyPickupMaxWaitHours`, celé ≥ 0). */
  readonly giveUpTick: number;
}

/** Stav plánu v save (`WorldState.emptyFlow`, v8). */
export interface EmptyFlowState {
  readonly returnPlan: readonly ReturnPlanEntry[];
  readonly pickupPlan: readonly PickupPlanEntry[];
  /** Poverenia kamiónov misie `collect` vzostupne podľa `truckId` (dodatok T6C-02). */
  readonly errands: readonly ErrandEntry[];
}

/** Kľúče `EmptyFlowState` v poradí `getState()`. */
export const EMPTY_FLOW_STATE_KEYS: readonly (keyof EmptyFlowState)[] = ['returnPlan', 'pickupPlan', 'errands'];
/** Kľúče položky `errands` v poradí `getState()`. */
export const ERRAND_ENTRY_KEYS: readonly (keyof ErrandEntry)[] = ['truckId', 'lineId', 'contractId', 'unitId', 'giveUpTick'];
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

/** Meniteľné poverenie (jediné meniteľné pole je `unitId`, mení ho len `EmptyFlow.assignErrandUnit`). */
interface MutableErrand {
  readonly truckId: number;
  readonly lineId: string;
  readonly contractId: number;
  unitId: number | null;
  readonly giveUpTick: number;
}

export class EmptyFlow {
  private readonly returns: ReturnPlanEntry[];
  private readonly pickups: PickupPlanEntry[];
  private readonly errandList: MutableErrand[];

  /** Prázdny plán (nová hra); obnovu zo save robí `EmptyFlow.fromState`. */
  constructor(state: EmptyFlowState = { returnPlan: [], pickupPlan: [], errands: [] }) {
    this.returns = state.returnPlan.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId }));
    this.pickups = state.pickupPlan.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId, contractId: entry.contractId }));
    this.errandList = state.errands.map((entry) => ({ ...entry }));
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

  /** Poverenia kamiónov misie `collect` vzostupne podľa `truckId` (živé pole len na čítanie). */
  get errands(): readonly ErrandEntry[] {
    return this.errandList;
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

  /** Zaeviduje poverenie nového kamióna `collect` (kamióny vznikajú vzostupne podľa id; kamión už s poverením → `Error`). */
  addErrand(truckId: number, lineId: string, contractId: number, giveUpTick: number): void {
    if (this.errandList.some((errand) => errand.truckId === truckId)) throw new Error(`EmptyFlow.addErrand: kamión #${String(truckId)} už má poverenie`);
    this.errandList.push({ truckId, lineId, contractId, unitId: null, giveUpTick });
  }

  /** Poverenie kamióna, alebo `undefined` (kamión nie je misie `collect`). */
  errandOfTruck(truckId: number): ErrandEntry | undefined {
    return this.errandList.find((errand) => errand.truckId === truckId);
  }

  /** Poverenie, ktorému je pridelený prázdny kontajner `unitId`; jednotka nikomu nepridelená → `undefined`. */
  errandOfUnit(unitId: number): ErrandEntry | undefined {
    return this.errandList.find((errand) => errand.unitId === unitId);
  }

  /** Pridelí kamiónu prázdny kontajner (`unitId`), alebo pridelenie zruší (`null` — job zo skladu sa zrušil). Neznámy kamión → `Error`. */
  assignErrandUnit(truckId: number, unitId: number | null): void {
    const errand = this.errandList.find((entry) => entry.truckId === truckId);
    if (errand === undefined) throw new Error(`EmptyFlow.assignErrandUnit: kamión #${String(truckId)} nemá poverenie`);
    errand.unitId = unitId;
  }

  /** Odstráni poverenie kamióna (opustil mapu alebo odišiel prázdny); kamión bez poverenia sa ignoruje. */
  removeErrand(truckId: number): void {
    const at = this.errandList.findIndex((errand) => errand.truckId === truckId);
    if (at >= 0) this.errandList.splice(at, 1);
  }

  /** Čistý JSON stav pre save (nová kópia). */
  getState(): EmptyFlowState {
    return {
      returnPlan: this.returns.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId })),
      pickupPlan: this.pickups.map((entry) => ({ dueTick: entry.dueTick, lineId: entry.lineId, contractId: entry.contractId })),
      errands: this.errandList.map((entry) => ({ truckId: entry.truckId, lineId: entry.lineId, contractId: entry.contractId, unitId: entry.unitId, giveUpTick: entry.giveUpTick })),
    };
  }
}
