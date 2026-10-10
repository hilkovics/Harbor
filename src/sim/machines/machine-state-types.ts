/** Typy stavu stroja bloku (ADR-040 bod 3) — oddelené od `machine-fsm.ts`, aby tabuľka prechodov a trieda nemali kruhový import. */
/** Stavy stroja v poradí cyklu (FSM: `machine-fsm.ts`). */
export const MACHINE_STATES = ['idle', 'travel', 'shift', 'lift', 'trolley', 'lower'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

/** Poloha stroja: žeriav v bays pozdĺž bloku (spojitá), vozík v radoch naprieč blokom (`−1` = nad pruhom s TP, `0…rows−1` = rad), spúšťač vo vrstvách stohu (`0…maxTier`). */
export interface MachinePose {
  readonly gantry: number;
  readonly trolley: number;
  readonly hoist: number;
}

/** Druh cyklu: `put` = z vozidla na TP do stohu, `take` = zo stohu na vozidlo na TP, `relocate` = rehandling v rámci bloku (zo stohu do stohu). */
export type CycleKind = 'put' | 'take' | 'relocate';

/** Rozpracovaná kontajnerová operácia stroja (najviac jedna; stroj drží najviac 1 kontajner). */
export interface MachineCycle {
  readonly kind: CycleKind;
  readonly unitId: number;
  /** Vozidlo alebo kamión na TP (`put`, `take`; kamión, keď je `truck` pravda — id entít sú jedinečné), pri `relocate` `null`. */
  readonly vehicleId: number | null;
  /** Partner cyklu je kamión (R4, ADR-041 bod 4): job `in_storage ↔ in_truck`, kamión sa po odovzdaní uvoľní sám (zánikom jobu). */
  readonly truck: boolean;
  /** Job vozidla alebo kamióna (`put`, `take`), pri `relocate` `null`. */
  readonly jobId: number | null;
  /** Slot odkiaľ sa zdvíha (`take`, `relocate`); pri `put` `null` (zdvih z vozidla na TP). */
  readonly fromSlot: number | null;
  /** Slot kam sa odkladá (`put`, `relocate`); pri `take` `null` (odklad na vozidlo na TP). Pri `put` sa usadí podľa skutočnej výšky stohu (`settleYardDrop`). */
  readonly toSlot: number | null;
  /** Bay TP, pri ktorom stojí vozidlo (`put`, `take`); pri `relocate` bay zdroja. Pri cykle s vlakom (`trainId`) je to **TEU miesto vo vlaku** (`in_train.slot`), nie bay. */
  readonly tpBay: number;
  /**
   * Partner cyklu je vlak (R6, ADR-043 TR6-02; len RMG): `put` = z vlaka do bufferu (`in_train → in_handler → in_storage`), `take` = z bufferu na vlak (`in_storage → in_handler → in_train`).
   * Cyklus s vlakom nemá vozidlo ani job (`vehicleId`, `jobId` `null`); chýba pri ostatných cykloch.
   */
  readonly trainId?: number;
}

/** Vozidlo čakajúce na TP na stroj (fronta stroja; poradie určuje `(priorita, createdTick, id)` pri výbere, nie poradie vzniku). */
export interface MachineQueueEntry {
  readonly vehicleId: number;
  readonly createdTick: number;
}
