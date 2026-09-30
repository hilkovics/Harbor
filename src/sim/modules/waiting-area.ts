/**
 * Stojisko / čakacia plocha kamiónov (ARCHITECTURE §5.3 `truck_waiting_area`, §7.5, §7.8 bod 3; rozhodnutie
 * orchestrátora F4 č. 3; ADR-022) — **priechod** s `params.bays` stojiskami medzi bránou a rampou.
 *
 * Bay má tri stavy: voľný → **rezervovaný** kamiónom pri spawne (kamión sa bez voľného bay nespawnuje, §7.8 bod 3) →
 * **obsadený**, keď kamión po bráne dorazí do stojiska a čaká na povel do docku → voľný, keď odíde k rampe. Modul drží
 * len držiteľa každého bay a príznak obsadenia (`reserveBay` / `occupyBay` / `releaseBay`); poradie a pohyb kamiónov
 * riadi systém (T04-04). Rezervovaný bay nepoužije iný kamión, preto sa „voľné miesto" pýta cez `freeBays`.
 *
 * `runtime` v save je `{}`: bays patria kamiónom — kamión v save nesie index svojho bay (`SerializedTruck.bay`) a obnova
 * ho rezervuje (`reserveBayAt`, pri `waiting` aj `occupyBay`, T04-04, ADR-024), tak ako rezervácie skladu z jobov
 * (ADR-018). Priechod (vstupný a výstupný konektor voči bráne a rampe) určuje svet (`LandsideNetwork`).
 */
import type { EntityId } from '../core/entity-id';
import { waitingAreaParams } from '../defs/module-def';
import type { WaitingAreaParams } from '../defs/types';
import { LandExportModule } from './land-export-module';
import type { ModuleInit } from './module';
import { ModuleError } from './module-error';

export class WaitingArea extends LandExportModule {
  /** Typované `params` defu (`waitingAreaParams`). */
  readonly params: WaitingAreaParams;
  /** Bay → kamión, ktorý ho drží (rezervácia alebo obsadenie); `null` = voľný. */
  private readonly holders: (EntityId | null)[];
  /** Bay → kamión v ňom stojí (inak len rezervácia). */
  private readonly occupiedFlags: boolean[];
  private held = 0;
  private occupied = 0;

  /** Def iného druhu než `waiting_area` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = waitingAreaParams(init.def);
    this.holders = new Array<EntityId | null>(this.params.bays).fill(null);
    this.occupiedFlags = new Array<boolean>(this.params.bays).fill(false);
  }

  override get internalTicks(): number | undefined {
    return this.params.internalTicks;
  }

  /** Počet stojísk (`params.bays`). */
  get bays(): number {
    return this.params.bays;
  }

  /** Bays, v ktorých kamión stojí. */
  get occupiedBays(): number {
    return this.occupied;
  }

  /** Bays rezervované kamiónmi na ceste (ešte neobsadené). */
  get reservedBays(): number {
    return this.held - this.occupied;
  }

  /** Voľné bays (`bays − reserved − occupied`) — koľko ďalších `reserveBay` uspeje. */
  get freeBays(): number {
    return this.params.bays - this.held;
  }

  /** Kamión, ktorý bay drží; `null` = voľný. Bay mimo rozsahu → `ModuleError('invalid_slot')`. */
  bayHolder(bay: number): EntityId | null {
    this.assertBay(bay, 'bayHolder');
    return this.holders[bay];
  }

  /** Stojí v bayi kamión? Bay mimo rozsahu → `ModuleError('invalid_slot')`. */
  isBayOccupied(bay: number): boolean {
    this.assertBay(bay, 'isBayOccupied');
    return this.occupiedFlags[bay];
  }

  /** Najnižší voľný bay (ten, ktorý by dal `reserveBay`), alebo −1. Bez alokácie. */
  firstFreeBay(): number {
    return this.holders.indexOf(null);
  }

  /** Bay, ktorý kamión drží; `undefined`, ak žiadny. */
  bayOf(truckId: EntityId): number | undefined {
    const bay = this.holders.indexOf(truckId);
    return bay < 0 ? undefined : bay;
  }

  /**
   * Rezervuje najnižší voľný bay pre kamión a vráti ho. Kamión už drží bay → `duplicate_id`; žiadny voľný →
   * `no_free_bay` (volajúci sa pýta `freeBays` vopred). Pri chybe sa nič nezmení.
   */
  reserveBay(truckId: EntityId): number {
    this.assertTruckFree(truckId, 'reserveBay');
    const bay = this.holders.indexOf(null);
    if (bay < 0) throw new ModuleError('no_free_bay', `${this.label}.reserveBay: žiadny voľný bay (${String(this.params.bays)})`);
    this.holders[bay] = truckId;
    this.held += 1;
    return bay;
  }

  /**
   * Rezervuje konkrétny bay (obnova zo save podľa kamióna, T04-04). Chyby: mimo rozsahu → `invalid_slot`, kamión už
   * drží bay → `duplicate_id`, bay drží iný kamión → `slot_reserved`.
   */
  reserveBayAt(bay: number, truckId: EntityId): void {
    this.assertBay(bay, 'reserveBayAt');
    this.assertTruckFree(truckId, 'reserveBayAt');
    const holder = this.holders[bay];
    if (holder !== null) throw new ModuleError('slot_reserved', `${this.label}.reserveBayAt: bay ${String(bay)} drží kamión #${String(holder)}`);
    this.holders[bay] = truckId;
    this.held += 1;
  }

  /**
   * Kamión dorazil do svojho rezervovaného bay a stojí v ňom; vráti bay. Chyby: kamión bay nedrží →
   * `slot_not_reserved`, bay je už obsadený → `slot_occupied`.
   */
  occupyBay(truckId: EntityId): number {
    const bay = this.holders.indexOf(truckId);
    if (bay < 0) throw new ModuleError('slot_not_reserved', `${this.label}.occupyBay: kamión #${String(truckId)} nedrží žiadny bay`);
    if (this.occupiedFlags[bay]) throw new ModuleError('slot_occupied', `${this.label}.occupyBay: bay ${String(bay)} kamióna #${String(truckId)} je už obsadený`);
    this.occupiedFlags[bay] = true;
    this.occupied += 1;
    return bay;
  }

  /** Uvoľní bay kamióna (odchod k rampe alebo zrušenie); vráti ho. Kamión bay nedrží → `slot_not_reserved`. */
  releaseBay(truckId: EntityId): number {
    const bay = this.holders.indexOf(truckId);
    if (bay < 0) throw new ModuleError('slot_not_reserved', `${this.label}.releaseBay: kamión #${String(truckId)} nedrží žiadny bay`);
    if (this.occupiedFlags[bay]) {
      this.occupiedFlags[bay] = false;
      this.occupied -= 1;
    }
    this.holders[bay] = null;
    this.held -= 1;
    return bay;
  }

  /** Počítadlá sedia s bays, obsadený bay má držiteľa, kamión drží najviac jeden bay (krok 12, bez alokácie). */
  override findRuntimeProblem(): string | undefined {
    let held = 0;
    let occupied = 0;
    for (let bay = 0; bay < this.holders.length; bay++) {
      const holder = this.holders[bay];
      if (this.occupiedFlags[bay]) {
        occupied += 1;
        if (holder === null) return `${this.label}: bay ${String(bay)} je obsadený bez kamióna`;
      }
      if (holder === null) continue;
      held += 1;
      for (let other = 0; other < bay; other++) {
        if (this.holders[other] === holder) return `${this.label}: kamión #${String(holder)} drží bays ${String(other)} aj ${String(bay)}`;
      }
    }
    if (held !== this.held || occupied !== this.occupied) {
      return `${this.label}: počítadlá bays (držané ${String(this.held)}, obsadené ${String(this.occupied)}) ≠ bays (${String(held)}, ${String(occupied)})`;
    }
    return undefined;
  }

  private assertBay(bay: number, method: string): void {
    if (!Number.isInteger(bay) || bay < 0 || bay >= this.params.bays) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: bay musí byť celé číslo 0…${String(this.params.bays - 1)}, dostal ${String(bay)}`);
    }
  }

  private assertTruckFree(truckId: EntityId, method: string): void {
    if (!Number.isSafeInteger(truckId) || truckId < 1) {
      throw new ModuleError('invalid_input', `${this.label}.${method}: id kamióna musí byť celé číslo ≥ 1, dostal ${String(truckId)}`);
    }
    const bay = this.holders.indexOf(truckId);
    if (bay >= 0) throw new ModuleError('duplicate_id', `${this.label}.${method}: kamión #${String(truckId)} už drží bay ${String(bay)}`);
  }
}
