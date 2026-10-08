/**
 * Reťaze nôh (TOS, ADR-040 bod 4; docs/TERMINAL_2.md §5.4): každý presun kontajnera medzi nábrežím a blokom je reťaz nôh, ktoré robia rôzne stroje a stretávajú sa
 * na odovzdávacích miestach (TP). Reťaz určuje **systém obsluhy cieľového bloku** (`YardBlock.handlingSystem`) cez tabuľku `HANDLING_CHAINS` — nie switch (pravidlo 7):
 *
 * - `straddle`: vykládka STS → (pod hákom) straddle → stoh, nakládka stoh → straddle → STS; vozidlo kontajner zdvihne a uloží samo (`canLift`).
 * - `rtg`: vykládka STS → ťahač (TT) pod hákom → RTG (TP v pruhu bloku) → stoh, nakládka RTG → TT → STS; ťahač nezdvihne nič, odovzdáva stroj bloku.
 *
 * Kto príde na TP skôr, čaká: vozidlo stojí na TP (`loading` / `unloading` s pripnutým odpočtom ako pod hákom), kým stroj nedokončí odovzdanie
 * (`systems/yard-machine-system.ts`); žeriav čaká pod hákom na vozidlo ako doteraz (ADR-033).
 *
 * `vehicleMayServe` je jediné miesto, kde sa overuje, či vozidlo smie job (dispatcher): job s reťazou, ktorej leg bloku robí stroj, smie len vozidlo bez zdvihu
 * (`canLift: false`); ostatné joby (reťaz bez stroja alebo job bez reťaze — rampa, apron, depo) len vozidlo, ktoré zdvihne samo.
 */
import type { CargoLocationKind } from '../cargo/cargo-location';
import type { YardMachine } from '../machines/yard-machine';
import { YardBlock, type HandlingSystem } from '../modules/yard-block';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';
import type { TransportJob } from './transport-job';

/** Druh reťaze: vykládka lode do bloku, alebo nakládka z bloku na loď. */
export type ChainKind = 'discharge' | 'load';

/** Úloha nohy: `quay` (žeriav pod hákom), `carrier` (jazda vozidla), `yard` (odovzdanie v bloku). */
export type LegRole = 'quay' | 'carrier' | 'yard';

/** Kto nohu robí: `crane` (STS), `vehicle` (jazda, alebo zdvih samotného vozidla), `machine` (stroj bloku — RTG). */
export type LegActor = 'crane' | 'vehicle' | 'machine';

/** Jedna noha reťaze: kto ju robí a medzi akými polohami v ledgeri (`CargoLedger.move`; pri `machine` ide ešte cez `in_handler`). */
export interface HandlingLeg {
  readonly role: LegRole;
  readonly actor: LegActor;
  readonly from: CargoLocationKind;
  readonly to: CargoLocationKind;
}

const leg = (role: LegRole, actor: LegActor, from: CargoLocationKind, to: CargoLocationKind): HandlingLeg => Object.freeze({ role, actor, from, to });

/** Reťaze nôh podľa systému obsluhy bloku a druhu presunu (viď hlavička). */
export const HANDLING_CHAINS: { readonly [S in HandlingSystem]: { readonly [K in ChainKind]: readonly HandlingLeg[] } } = Object.freeze({
  straddle: Object.freeze({
    discharge: Object.freeze([leg('quay', 'crane', 'in_crane', 'in_vehicle'), leg('yard', 'vehicle', 'in_vehicle', 'in_storage')]),
    load: Object.freeze([leg('yard', 'vehicle', 'in_storage', 'in_vehicle'), leg('quay', 'crane', 'in_vehicle', 'in_crane')]),
  }),
  rtg: Object.freeze({
    discharge: Object.freeze([leg('quay', 'crane', 'in_crane', 'in_vehicle'), leg('carrier', 'vehicle', 'in_vehicle', 'in_vehicle'), leg('yard', 'machine', 'in_vehicle', 'in_storage')]),
    load: Object.freeze([leg('yard', 'machine', 'in_storage', 'in_vehicle'), leg('carrier', 'vehicle', 'in_vehicle', 'in_vehicle'), leg('quay', 'crane', 'in_vehicle', 'in_crane')]),
  }),
});

/** Druh reťaze jobu pod hákom: `in_crane → in_storage` je vykládka, `in_storage → in_crane` nakládka; iný job (rampa, apron, depo) reťaz nemá. */
export function chainKindOf(job: TransportJob): ChainKind | undefined {
  if (job.from.kind === 'in_crane' && job.to.kind === 'in_storage') return 'discharge';
  if (job.from.kind === 'in_storage' && job.to.kind === 'in_crane') return 'load';
  return undefined;
}

/** Blok jobu pod hákom (cieľ vykládky, zdroj nakládky), ak je to blok so stohmi. */
export function chainBlockOf(world: Pick<World, 'modules'>, job: TransportJob): YardBlock | undefined {
  const kind = chainKindOf(job);
  if (kind === undefined) return undefined;
  const block = world.modules.get(kind === 'discharge' ? job.toModuleId : job.fromModuleId);
  return block instanceof YardBlock ? block : undefined;
}

/** Reťaz nôh jobu podľa systému jeho bloku (`HANDLING_CHAINS`); job bez reťaze → `undefined`. */
export function chainOfJob(world: Pick<World, 'modules'>, job: TransportJob): readonly HandlingLeg[] | undefined {
  const kind = chainKindOf(job);
  const block = chainBlockOf(world, job);
  return kind === undefined || block === undefined ? undefined : HANDLING_CHAINS[block.handlingSystem][kind];
}

/** Stroj, ktorý robí leg bloku jobu (`yard` s `actor: 'machine'`); `undefined`, ak job takú nohu nemá alebo blok stroj nemá. */
export function yardMachineOfJob(world: Pick<World, 'modules' | 'machineOfBlock'>, job: TransportJob): YardMachine | undefined {
  const chain = chainOfJob(world, job);
  const block = chainBlockOf(world, job);
  if (chain === undefined || block === undefined || chain.find((candidate) => candidate.role === 'yard')?.actor !== 'machine') return undefined;
  return world.machineOfBlock(block.id);
}

/** Robí leg bloku jobu stroj (vozidlo teda len privezie a čaká na TP)? Bez ohľadu na to, či blok stroj už má. */
export function jobNeedsMachine(world: Pick<World, 'modules'>, job: TransportJob): boolean {
  return chainOfJob(world, job)?.find((candidate) => candidate.role === 'yard')?.actor === 'machine';
}

/** Zdvihne vozidlo kontajner samo? Chýbajúci `canLift` v defe = áno (straddle carrier, empty handler); ťahač má `false`. */
export function vehicleCanLift(vehicle: Pick<Vehicle, 'def'>): boolean {
  return vehicle.def.canLift !== false;
}

/** Smie vozidlo vykonať job (viď hlavička súboru)? */
export function vehicleMayServe(world: Pick<World, 'modules'>, vehicle: Pick<Vehicle, 'def'>, job: TransportJob): boolean {
  return jobNeedsMachine(world, job) !== vehicleCanLift(vehicle);
}

/**
 * Je koncový bod jobu, pri ktorom vozidlo stojí v stave `vehicleState`, odovzdanie strojom bloku (RTG)? `loading` = zdroj jobu je blok (nakládka z bloku), `unloading` = cieľ
 * jobu je blok (vykládka do bloku); vozidlo vtedy nič nezdvíha, čaká na TP na stroj (`systems/yard-machine-system.ts`).
 */
export function isMachineEndpoint(world: Pick<World, 'modules'>, job: TransportJob, vehicleState: 'loading' | 'unloading'): boolean {
  const endpoint = vehicleState === 'loading' ? job.from : job.to;
  return endpoint.kind === 'in_storage' && jobNeedsMachine(world, job);
}
