/**
 * Zásoba nákladu dockov rámp pre kamióny (ARCHITECTURE §7.5; ADR-029) — koľko jednotiek je na každom docku pripravených
 * (`LoadingRamp.stagedAt`, ledger) alebo **na ceste s vozidlom** (aktívny outbound job s priradeným vozidlom, cieľ
 * `at_ramp` tohto docku). Job s vozidlom sa nedá zrušiť (ADR-023 bod 7) a jeho jednotka skončí na docku, takže
 * `pripravené + vezené` na docku nikdy neklesne inak než nakládkou kamióna — nakládka zároveň zmenší nárok toho kamióna.
 *
 * Spawner (`spawnTrucks`) pustí nový kamión na dock, len keď `pripravené + vezené − nároky ≥ capacityUnits`, a krok 12
 * overuje `nároky ≤ pripravené + vezené` na každom docku. Otvorený job (bez vozidla) sa nepočíta: dispatcher ho smie
 * zrušiť (rampa stratila prevádzkovosť), kamión by potom čakal na jednotku, ktorá nepríde.
 *
 * Pracovné polia sú znovupoužiteľné (nie sú stav simulácie, do save nepatria): `refresh` je O(rampy + joby) bez alokácie
 * po prvom zväčšení polí.
 */
import { JOB_STATE_TRAITS } from '../logistics/transport-job';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { LandsideModules } from '../world/landside-roster';
import type { World } from '../world/world';

export class DockSupply {
  /** Začiatok docku 0 každej rampy (index v `dispatched`) podľa poradia registra. */
  private offsets = new Int32Array(0);
  /** Jednotky aktívnych outbound jobov s vozidlom na každý dock. */
  private dispatched = new Int32Array(0);
  /** Register, pre ktorý `refresh` naposledy naplnil polia. */
  private roster: LandsideModules | undefined;

  /** Prepočíta vezené jednotky na docky všetkých rámp sveta (rampy z `world.landsideModules`). */
  refresh(world: World): void {
    const roster = world.landsideModules;
    const { ramps } = roster;
    if (this.offsets.length < ramps.length) this.offsets = new Int32Array(ramps.length);
    let docks = 0;
    for (let ordinal = 0; ordinal < ramps.length; ordinal++) {
      this.offsets[ordinal] = docks;
      docks += ramps[ordinal].docks;
    }
    if (this.dispatched.length < docks) this.dispatched = new Int32Array(docks);
    this.dispatched.fill(0, 0, docks);
    this.roster = roster;
    for (const job of world.jobs.values()) {
      const { to } = job;
      if (to.kind !== 'at_ramp' || !JOB_STATE_TRAITS[job.state].hasVehicle) continue;
      const ordinal = roster.rampOrdinal(to.rampId);
      if (ordinal < 0 || to.dock >= ramps[ordinal].docks) continue;
      this.dispatched[this.offsets[ordinal] + to.dock] += job.unitIds.length;
    }
  }

  /** Jednotky na ceste s vozidlom k docku rampy (po `refresh`); rampa mimo registra → 0. */
  dispatchedAt(ramp: LoadingRamp, dock: number): number {
    const ordinal = this.roster?.rampOrdinal(ramp.id) ?? -1;
    if (ordinal < 0 || dock < 0 || dock >= ramp.docks) return 0;
    return this.dispatched[this.offsets[ordinal] + dock];
  }

  /** Pripravené + vezené jednotky docku (po `refresh`). */
  suppliedAt(ramp: LoadingRamp, dock: number): number {
    return ramp.stagedAt(dock) + this.dispatchedAt(ramp, dock);
  }

  /** Jednotky docku, na ktoré ešte nemá nárok žiadny kamión (`pripravené + vezené − nároky`, po `refresh`). */
  unclaimedAt(ramp: LoadingRamp, dock: number): number {
    return this.suppliedAt(ramp, dock) - ramp.claimedAt(dock);
  }
}
