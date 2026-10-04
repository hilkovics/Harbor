/**
 * `AcceptContract { contractId }` — hráč prijme ponuku (ARCHITECTURE §9.1, §12.2; docs/tasks/phase-05.md rozhodnutia
 * 4 a 5; ADR-026). Validácia: `ContractOfferCommand` (`game_over`, `unknown_contract`, `contract_not_offered`) a potom
 * **pripravenosť prístavu** (T06-07, ADR-031; `berthReadiness`): `no_berth_for_ship_class` — žiadny úsek kotvísk nemá
 * pre triedu lode ponuky dosť dĺžky, hĺbky a pásu vody; `berth_unreachable` (T06-08b, ADR-031 dodatok) — taký úsek je,
 * ale loď k žiadnemu nedopláva po prázdnej vode (`ShipTraffic.reachesBerth`: plytká zátoka, úzke hrdlo);
 * `no_crane_for_category` — dosiahnuteľný úsek je, ale bez žeriavu kategórie nákladu kontraktu. Obsadenosť kotvísk
 * a lodná doprava (iné lode) sa neposudzujú (loď by počkala na anchorage). Pri skupine s export bookingom (export,
 * roundtrip) sa po pripravenosti kotvísk posúdi aj **pozemná strana** (`exportLandsideReadiness`, ADR-032): `no_ramp_for_category`
 * — žiadna rampa kategórie, `ramp_inoperative` — žiadna nie je prevádzková (brána, stojisko, cesta od portálu),
 * `no_storage_for_category` — z prevádzkovej rampy nie je dosiahnuteľný sklad kategórie; bez nej by kamióny s exportom nevznikli
 * a booking by skončil penalizáciou. Nové druhy F6c (ADR-034) majú vlastnú pripravenosť (`READINESS_BY_KIND`) a bránu ani rampu nepotrebujú:
 * **repositioning prázdnych** vyžaduje depo prázdnych a **prekládka** sklad kategórie nákladu — inak `no_storage_for_category` (nový dôvod sa nezavádza).
 * Validácia svet nemení a `Rng` nespotrebuje.
 *
 * `apply` (hotovosť sa nemení): príkaz pôsobí na **skupinu ponuky** (ADR-032 bod 1) — všetky `offered` kontrakty tej istej
 * voyage vzostupne podľa id (roundtrip = import + export booking; import ponuka alebo export-only je skupina o jednom
 * kontrakte). Plán lode je spoločný: `acceptedTick = clock.tick` (v príkazovej fáze ešte predchádzajúci tick),
 * `shipArrivalTick = acceptedTick + max(1, round(rng.range(dni) × ticksPerDay))` (jediný `Rng` sveta, jedno číslo; `dni` =
 * `exportArrivalDaysRange` pri skupine s cut-off exportom (`Contract.hasCutoff`), inak `arrivalDaysRange`; prekládka a repositioning
 * bez exportu cut-off nemajú), `slaDeadlineTick = shipArrivalTick + slaDays ×
 * ticksPerDay` každého kontraktu; export booking naplánuje cut-off a príchody kamiónov (`Contract.accept` — ťahy `Rng`
 * po ťahu príchodu, kontrakty vzostupne podľa id; v prístave s depom prázdnych potom ťahy výdaja prázdnych, F6c). Potom každý kontrakt `offered → accepted` (`ContractStateChanged`) a
 * `ContractAccepted`. Loď spawne `ContractSystem` v ticku príchodu.
 */
import type { Contract } from '../contracts/contract';
import type { ContractId } from '../core/entity-id';
import type { ContractKind } from '../contracts/contract-fsm';
import type { CargoCategory } from '../defs/types';
import { exportLandsideReadiness, repositioningReadiness, transhipReadiness, type ExportReadiness } from '../logistics/export-readiness';
import { planEmptyPickups } from '../trucks/empty-plan';
import { berthReadiness, type BerthReadiness } from '../ships/berth-allocator';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ContractOfferCommand, offerVerdict, readContractId } from './contract-command';
import type { ValidationResult } from './validation';

/** Najskorší príchod lode po prijatí — v ďalšom ticku (krok 2 ho spawne, keď `tick ≥ shipArrivalTick`). */
const MIN_ARRIVAL_TICKS = 1;

/** Výsledok validácie podľa pripravenosti prístavu (tabuľka, nie switch). */
const READINESS_VERDICT: { readonly [R in BerthReadiness]: ValidationResult } = Object.freeze({
  ready: offerVerdict(null),
  no_berth: offerVerdict('no_berth_for_ship_class'),
  no_crane: offerVerdict('no_crane_for_category'),
  unreachable: offerVerdict('berth_unreachable'),
});

/** Výsledok validácie podľa pripravenosti pozemnej strany exportu (tabuľka, nie switch). */
const EXPORT_READINESS_VERDICT: { readonly [R in ExportReadiness]: ValidationResult } = Object.freeze({
  ready: offerVerdict(null),
  no_ramp: offerVerdict('no_ramp_for_category'),
  ramp_inoperative: offerVerdict('ramp_inoperative'),
  no_storage: offerVerdict('no_storage_for_category'),
});

/**
 * Pripravenosť pozemnej strany / skladov podľa druhu kontraktu ponuky (tabuľka, nie switch — pravidlo 7): import nič navyše, export brána + rampa +
 * sklad (ADR-032), repositioning depo prázdnych, prekládka sklad (ADR-034).
 */
const READINESS_BY_KIND: { readonly [K in ContractKind]: (world: World, category: CargoCategory) => ExportReadiness } = Object.freeze({
  import: () => 'ready',
  export: exportLandsideReadiness,
  empty_repositioning: repositioningReadiness,
  tranship: transhipReadiness,
});

export class AcceptContractCommand extends ContractOfferCommand {
  static readonly TYPE = 'AcceptContract';

  readonly type = AcceptContractCommand.TYPE;

  constructor(contractId: number) {
    super(AcceptContractCommand.TYPE, contractId);
  }

  /** Príkaz z tvaru `{ type: 'AcceptContract', contractId }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): AcceptContractCommand {
    return new AcceptContractCommand(readContractId(json, AcceptContractCommand.TYPE));
  }

  /** Ponuka (`ContractOfferCommand`) a pripravenosť prístavu pre loď a náklad ponuky (viď hlavička súboru). */
  protected override check(world: World): ValidationResult {
    const offer = super.check(world);
    if (!offer.ok) return offer;
    const contract = world.contracts.get(this.contractId as ContractId) as Contract;
    const request = { def: world.defs.ships.get(contract.shipClassId), cargoCategory: world.defs.cargoTypes.get(contract.cargoTypeId).category };
    const berths = READINESS_VERDICT[berthReadiness(world, request, (first) => world.shipTraffic.reachesBerth(request.def, first))];
    if (!berths.ok) return berths;
    // Skupina ponuky (voyage): každý jej kontrakt musí mať svoju pripravenosť (export aj repositioning jednej voyage), prvý chýbajúci článok vyhráva.
    for (const offered of world.contractBook.offeredOfVoyage(contract.voyageId)) {
      const verdict = EXPORT_READINESS_VERDICT[READINESS_BY_KIND[offered.kind](world, request.cargoCategory)];
      if (!verdict.ok) return verdict;
    }
    return berths;
  }

  protected applyTo(world: World, offer: Contract): void {
    const { ticksPerDay, ticksPerHour, tick } = world.clock;
    const group = world.contractBook.offeredOfVoyage(offer.voyageId);
    const withCutoff = group.some((contract) => contract.hasCutoff);
    const [minDays, maxDays] = withCutoff ? world.defs.economy.exportArrivalDaysRange : world.defs.economy.arrivalDaysRange;
    const arrivalTicks = Math.max(MIN_ARRIVAL_TICKS, Math.round(world.rng.range(minDays, maxDays) * ticksPerDay));
    const context = {
      tick,
      shipArrivalTick: tick + arrivalTicks,
      ticksPerDay,
      ticksPerHour,
      cutoffHours: world.defs.economy.cutoffHours,
      arrivalWindowDays: world.defs.logistics.exportFlow.arrivalWindowDays,
      transhipGapDaysRange: world.defs.economy.transhipGapDaysRange,
      rng: world.rng,
    };
    for (const contract of group) {
      contract.accept(context);
      // Prístav s depom prázdnych: pre časť jednotiek exportu naplánuje výdaj prázdneho kontajnera linky (ADR-034, ťahy `Rng`).
      planEmptyPickups(world, contract);
      world.contractBook.changeState(contract, 'accepted');
      world.events.emit({ type: 'ContractAccepted', contractId: contract.id });
    }
  }
}
