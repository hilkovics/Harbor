/**
 * BerthAllocator (ARCHITECTURE §5.4; karta T02-05; rozhodnutie orchestrátora 1 v ADR-016) — čistá funkcia, ktorá
 * pre loď nájde súvislý úsek voľných kotvísk. Svet nemení; rezerváciu (`dockedShipId`, `berthIds`) zapíše `ShipSystem`.
 *
 * Pravidlá (v poradí vyhodnotenia):
 * 1. skupiny `world.berthGroups` v poradí id; skupina prichádza do úvahy, keď `totalLength ≥ lengthCells`, má aspoň
 *    jedno kotvisko s `depthClass ≥ draftClass` a aspoň jeden žeriav kategórie nákladu lode (len rýchle vyradenie —
 *    `minDepth ≥ draftClass` je skratka „celá skupina je dosť hlboká", nie podmienka, T02-14);
 * 2. v skupine súvislé úseky kotvísk (poradie po pobreží) od najmenšieho počtu kotvísk, pri rovnakom počte od
 *    najmenšieho indexu po pobreží; úsek musí byť celý voľný (`dockedShipId === null` — bez lode aj rezervácie),
 *    každé jeho kotvisko musí mať efektívnu hĺbku `depthClass ≥ draftClass` lode (ARCHITECTURE §4.3; hlboký úsek
 *    vyhovuje aj vedľa plytkého suseda v tej istej skupine), súčet `lengthCells ≥ lengthCells` lode, pás vody hlboký
 *    aspoň `widthCells` lode (loď sa zmestí na vodu) a aspoň jeden kompatibilný žeriav (inak by loď na kotvisku nikdy
 *    nevyložila);
 * 3. prvý vyhovujúci úsek vyhráva (ak ho prijme voliteľná podmienka `accept` — ADR-029: voľná trasa k nemu a cesta
 *    von); žiadny → `null` (loď čaká na anchorage).
 *
 * Poradie čakajúcich lodí (FIFO podľa spawnu) zabezpečuje `ShipSystem`, ktorý lode spracúva vzostupne podľa id.
 *
 * `berthReadiness` (T06-07, `AcceptContract`) posúdi tie isté úseky podľa bodu 2 bez obsadenosti a bez `accept` — či
 * prístav loď danej triedy a nákladu vôbec obslúži; od T06-08b aj so statickou dosiahnuteľnosťou úseku (predikát podľa
 * prvého kotviska úseku — `ShipTraffic.reachesBerth`, ADR-031 dodatok).
 */
import type { EntityId } from '../core/entity-id';
import type { CargoCategory, ShipClassDef } from '../defs/types';
import type { BerthGroup } from '../modules/berth-group';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';

/** Čo alokátor zo sveta číta (`World` to spĺňa). */
export interface BerthAllocationWorld {
  readonly berthGroups: readonly BerthGroup[];
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Čo alokátor potrebuje o lodi. */
export interface BerthRequest {
  readonly def: Pick<ShipClassDef, 'lengthCells' | 'widthCells' | 'draftClass'>;
  readonly cargoCategory: CargoCategory;
}

/** Stojí na kotvisku žeriav danej kategórie? */
export function hasCompatibleCrane(world: BerthAllocationWorld, berth: BerthModule, category: CargoCategory): boolean {
  return berth.craneIds.some((craneId) => {
    const crane = world.modules.get(craneId);
    return crane instanceof CraneModule && crane.category === category;
  });
}

function berthsOf(world: BerthAllocationWorld, group: BerthGroup): readonly BerthModule[] {
  return group.berthIds.map((berthId) => {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) throw new Error(`BerthAllocator: skupina ${String(group.id)} odkazuje na #${String(berthId)}, ktorý nie je berth`);
    return berth;
  });
}

/** Kotvisko unesie ponor lode (efektívna hĺbka, ADR-014 bod 2)? */
function isDeepEnough(berth: BerthModule, request: BerthRequest): boolean {
  return berth.depthClass >= request.def.draftClass;
}

/**
 * Môže mať skupina úsek s dosť hlbokými kotviskami? `minDepth ≥ draftClass` je rýchla cesta (hlboká je celá skupina),
 * inak rozhodne aspoň jedno dosť hlboké kotvisko. Presnú podmienku pre úsek overí `fitsRun`.
 */
function mayFitDepth(group: BerthGroup, berths: readonly BerthModule[], request: BerthRequest): boolean {
  return group.minDepth >= request.def.draftClass || berths.some((berth) => isDeepEnough(berth, request));
}

/**
 * Posúdenie úseku kotvísk: `unfit` (obsadený pri `requireFree`, plytký, úzky pás vody alebo krátky), `no_crane` (tvarom
 * lodi vyhovuje, žeriav kategórie nákladu chýba) alebo `fits`.
 */
type RunFit = 'unfit' | 'no_crane' | 'fits';

/**
 * Úsek `berths[start … start + count)` pre loď (bod 2 hlavičky); `requireFree` = každé kotvisko bez lode a rezervácie
 * (alokácia), inak sa obsadenosť neposudzuje (pripravenosť prístavu, `berthReadiness`).
 */
function runFit(world: BerthAllocationWorld, berths: readonly BerthModule[], start: number, count: number, request: BerthRequest, requireFree: boolean): RunFit {
  let length = 0;
  let crane = false;
  for (let i = start; i < start + count; i++) {
    const berth = berths[i];
    if ((requireFree && berth.dockedShipId !== null) || !isDeepEnough(berth, request) || berth.params.frontWaterCells < request.def.widthCells) return 'unfit';
    length += berth.lengthCells;
    crane ||= hasCompatibleCrane(world, berth, request.cargoCategory);
  }
  if (length < request.def.lengthCells) return 'unfit';
  return crane ? 'fits' : 'no_crane';
}

/** Úsek `berths[start … start + count)` vyhovuje lodi (bod 2 hlavičky)? */
function fitsRun(world: BerthAllocationWorld, berths: readonly BerthModule[], start: number, count: number, request: BerthRequest): boolean {
  return runFit(world, berths, start, count, request, true) === 'fits';
}

/**
 * Pripravenosť prístavu pre loď (T06-07, `AcceptContract`; dosiahnuteľnosť T06-08b, ADR-031 dodatok) — úseky podľa
 * bodu 2 hlavičky **bez ohľadu na obsadenosť** (loď pri kotvisku, rezervácia) a lodnú dopravu (`accept`; loď by
 * nanajvýš počkala na anchorage), každý tvarom vyhovujúci úsek aj so statickou dosiahnuteľnosťou (`reachable` podľa
 * prvého kotviska úseku — loď k nemu dopláva a odpláva po prázdnej vode). Verdikt je najlepší spomedzi úsekov:
 * `ready` = dosiahnuteľný úsek so žeriavom kategórie nákladu; `no_crane` = dosiahnuteľný úsek s dĺžkou, hĺbkou a pásom
 * vody, ale bez žeriavu; `unreachable` = taký úsek je, ale loď k žiadnemu nedopláva (kotvisko v plytkej zátoke,
 * lagúna za úzkym hrdlom); `no_berth` = žiadny úsek nemá dosť dĺžky, hĺbky alebo vody. Svet nemení (validácia
 * príkazu, nie hot path).
 */
export type BerthReadiness = 'ready' | 'no_crane' | 'unreachable' | 'no_berth';

/** Poradie verdiktov (vyšší = bližšie k obslúženiu lode); `berthReadiness` vráti najvyšší. */
const READINESS_RANK: { readonly [R in BerthReadiness]: number } = Object.freeze({ no_berth: 0, unreachable: 1, no_crane: 2, ready: 3 });

/** Verdikt tvarom vyhovujúceho úseku podľa posúdenia `runFit` (dosiahnuteľnosť zvlášť). */
const SHAPED_VERDICT: { readonly [F in Exclude<RunFit, 'unfit'>]: BerthReadiness } = Object.freeze({ fits: 'ready', no_crane: 'no_crane' });

/**
 * Pripravenosť prístavu pre loď (viď `BerthReadiness`). `reachable` (predvolene všetko) = statická dosiahnuteľnosť
 * úseku podľa jeho prvého kotviska; volá sa len pre tvarom vyhovujúce úseky.
 */
export function berthReadiness(world: BerthAllocationWorld, request: BerthRequest, reachable: (first: BerthModule) => boolean = () => true): BerthReadiness {
  let best: BerthReadiness = 'no_berth';
  for (const group of world.berthGroups) {
    if (group.totalLength < request.def.lengthCells) continue;
    const berths = berthsOf(world, group);
    for (let count = 1; count <= berths.length; count++) {
      for (let start = 0; start + count <= berths.length; start++) {
        const fit = runFit(world, berths, start, count, request, false);
        if (fit === 'unfit') continue;
        const verdict = reachable(berths[start]) ? SHAPED_VERDICT[fit] : 'unreachable';
        if (verdict === 'ready') return verdict;
        if (READINESS_RANK[verdict] > READINESS_RANK[best]) best = verdict;
      }
    }
  }
  return best;
}

/**
 * Kotviská pre loď v poradí po pobreží (podľa pravidiel v hlavičke súboru), alebo `null`, keď žiadny úsek nevyhovuje.
 * `accept` (predvolene prijme všetko) dostane každý vyhovujúci úsek v poradí a rozhodne, či ho použiť. Svet nemení.
 */
export function allocateBerths(world: BerthAllocationWorld, request: BerthRequest, accept: (run: readonly BerthModule[]) => boolean = () => true): readonly BerthModule[] | null {
  for (const group of world.berthGroups) {
    if (group.totalLength < request.def.lengthCells) continue;
    const berths = berthsOf(world, group);
    if (!mayFitDepth(group, berths, request)) continue;
    if (!berths.some((berth) => hasCompatibleCrane(world, berth, request.cargoCategory))) continue;
    for (let count = 1; count <= berths.length; count++) {
      for (let start = 0; start + count <= berths.length; start++) {
        if (!fitsRun(world, berths, start, count, request)) continue;
        const run = Object.freeze(berths.slice(start, start + count));
        if (accept(run)) return run;
      }
    }
  }
  return null;
}
