/**
 * Príjem na dockoch rampy (F6d, ADR-035) — staging miesta, ktoré sú **prisľúbené** kamiónom s dovozom (misia `delivery`: export, návrat
 * prázdneho), kým si ich kamión nerezervuje. Kamión dostane z vnútrozemia vjazd len so zaručeným miestom na vyloženie na docku a zaručené miesto
 * mu outbound strana (joby `storage → ramp` importu a výdaja prázdneho) nesmie vziať — inak by import čakajúci na odvoz (outbound job plní staging
 * hneď, ako sa uvoľní miesto, a v kroku 5 predchádza krok 8) zaplnil dock a vykladajúci kamióny by nikdy nedostali miesto, a kamióny na odvoz
 * importu by sa zasa nedostali do stojiska, ktoré držia vykladajúci. Príjem a odvoz majú takto každý vlastnú kapacitu docku a navzájom sa
 * nezablokujú.
 *
 * Prisľúbené miesto = jednotky, ktoré vezie kamión `delivery` ešte pred povelom do docku (`!bonds.holdsIntake`): od povelu do docku ich držia
 * skutočné rezervácie (`LoadingRamp.reserve`). Odvodená hodnota (nie je v save): `refresh` ju prepočíta z kamiónov v O(kamióny) bez alokácie po
 * prvom zväčšení polí; dispatcher ho volá na začiatku kroku 5, vpúšťanie z vnútrozemia pred každým pokusom.
 *
 * Voľné miesto po odpočítaní prisľúbeného (`roomAt`, `roomCount`, `firstRoomDock`) je to, čo smie dostať nový príjem aj outbound job.
 */
import type { LoadingRamp } from '../modules/loading-ramp';
import type { LandsideModules } from '../world/landside-roster';
import type { World } from '../world/world';

export class DockIntake {
  /** Začiatok docku 0 každej rampy (index v `pending`) podľa poradia registra. */
  private offsets = new Int32Array(0);
  /** Prisľúbené jednotky na každý dock. */
  private pending = new Int32Array(0);
  /** Register, pre ktorý `refresh` naposledy naplnil polia. */
  private roster: LandsideModules | undefined;

  /** Prepočíta prisľúbené jednotky dockov všetkých rámp sveta z kamiónov `delivery` pred povelom do docku. */
  refresh(world: World): void {
    const roster = world.landsideModules;
    const { ramps } = roster;
    if (this.offsets.length < ramps.length) this.offsets = new Int32Array(ramps.length);
    let docks = 0;
    for (let ordinal = 0; ordinal < ramps.length; ordinal++) {
      this.offsets[ordinal] = docks;
      docks += ramps[ordinal].docks;
    }
    if (this.pending.length < docks) this.pending = new Int32Array(docks);
    this.pending.fill(0, 0, docks);
    this.roster = roster;
    if (world.trucks.size === 0) return;
    for (const truck of world.trucks.values()) {
      if (truck.mission !== 'delivery' || truck.bonds.holdsIntake) continue;
      const ordinal = roster.rampOrdinal(truck.rampId);
      if (ordinal < 0 || truck.dock >= ramps[ordinal].docks) continue;
      this.pending[this.offsets[ordinal] + truck.dock] += world.cargo.countAt('in_truck', truck.id);
    }
  }

  /** Jednotky prisľúbené kamiónom na dock rampy (po `refresh`); rampa mimo registra → 0. */
  pendingAt(ramp: LoadingRamp, dock: number): number {
    const ordinal = this.roster?.rampOrdinal(ramp.id) ?? -1;
    if (ordinal < 0 || dock < 0 || dock >= ramp.docks) return 0;
    return this.pending[this.offsets[ordinal] + dock];
  }

  /**
   * Voľné miesta docku po odpočítaní prisľúbených (`freeAt − pendingAt`, nie pod 0): koľko ďalších jednotiek smie dostať miesto — nový kamión
   * `delivery` pri vjazde z vnútrozemia aj outbound job (import, výdaj prázdneho). Miesto je jedno a dostane ho ten, kto sa o neho prihlási prvý
   * (kamión s dovozom ho prisľúbením vyhradí, outbound job ho berie len zo zvyšku).
   */
  roomAt(ramp: LoadingRamp, dock: number): number {
    return Math.max(0, ramp.freeAt(dock) - this.pendingAt(ramp, dock));
  }

  /** Voľné miesta rampy po odpočítaní prisľúbených spolu (Σ `roomAt`). */
  roomCount(ramp: LoadingRamp): number {
    let room = 0;
    for (let dock = 0; dock < ramp.docks; dock++) room += this.roomAt(ramp, dock);
    return room;
  }

  /** Najnižší dock s voľným miestom po odpočítaní prisľúbených, alebo −1. */
  firstRoomDock(ramp: LoadingRamp): number {
    for (let dock = 0; dock < ramp.docks; dock++) if (this.roomAt(ramp, dock) > 0) return dock;
    return -1;
  }
}
