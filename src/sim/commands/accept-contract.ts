/**
 * `AcceptContract { contractId }` — hráč prijme ponuku (ARCHITECTURE §9.1, §12.2; docs/tasks/phase-05.md rozhodnutia
 * 4 a 5; ADR-026). Validácia: `ContractOfferCommand` (`game_over`, `unknown_contract`, `contract_not_offered`) a potom
 * **pripravenosť prístavu** (T06-07, ADR-031; `berthReadiness`): `no_berth_for_ship_class` — žiadny úsek kotvísk nemá
 * pre triedu lode ponuky dosť dĺžky, hĺbky a pásu vody; `berth_unreachable` (T06-08b, ADR-031 dodatok) — taký úsek je,
 * ale loď k žiadnemu nedopláva po prázdnej vode (`ShipTraffic.reachesBerth`: plytká zátoka, úzke hrdlo);
 * `no_crane_for_category` — dosiahnuteľný úsek je, ale bez žeriavu kategórie nákladu kontraktu. Obsadenosť kotvísk
 * a lodná doprava (iné lode) sa neposudzujú (loď by počkala na anchorage). Validácia svet nemení a `Rng` nespotrebuje.
 *
 * `apply` (hotovosť sa nemení): príkaz pôsobí na **skupinu ponuky** (ADR-032 bod 1) — všetky `offered` kontrakty tej istej
 * voyage vzostupne podľa id (roundtrip = import + export booking; import ponuka alebo export-only je skupina o jednom
 * kontrakte). Plán lode je spoločný: `acceptedTick = clock.tick` (v príkazovej fáze ešte predchádzajúci tick),
 * `shipArrivalTick = acceptedTick + max(1, round(rng.range(dni) × ticksPerDay))` (jediný `Rng` sveta, jedno číslo; `dni` =
 * `exportArrivalDaysRange` pri skupine s exportom, inak `arrivalDaysRange`), `slaDeadlineTick = shipArrivalTick + slaDays ×
 * ticksPerDay` každého kontraktu; export booking naplánuje cut-off a príchody kamiónov (`Contract.accept` — ťahy `Rng`
 * po ťahu príchodu, kontrakty vzostupne podľa id). Potom každý kontrakt `offered → accepted` (`ContractStateChanged`) a
 * `ContractAccepted`. Loď spawne `ContractSystem` v ticku príchodu.
 */
import type { Contract } from '../contracts/contract';
import type { ContractId } from '../core/entity-id';
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
    return READINESS_VERDICT[berthReadiness(world, request, (first) => world.shipTraffic.reachesBerth(request.def, first))];
  }

  protected applyTo(world: World, offer: Contract): void {
    const { ticksPerDay, ticksPerHour, tick } = world.clock;
    const group = world.contractBook.offeredOfVoyage(offer.voyageId);
    const withExport = group.some((contract) => contract.booking !== null);
    const [minDays, maxDays] = withExport ? world.defs.economy.exportArrivalDaysRange : world.defs.economy.arrivalDaysRange;
    const arrivalTicks = Math.max(MIN_ARRIVAL_TICKS, Math.round(world.rng.range(minDays, maxDays) * ticksPerDay));
    const context = {
      tick,
      shipArrivalTick: tick + arrivalTicks,
      ticksPerDay,
      ticksPerHour,
      cutoffHours: world.defs.economy.cutoffHours,
      arrivalWindowDays: world.defs.logistics.exportFlow.arrivalWindowDays,
      rng: world.rng,
    };
    for (const contract of group) {
      contract.accept(context);
      world.contractBook.changeState(contract, 'accepted');
      world.events.emit({ type: 'ContractAccepted', contractId: contract.id });
    }
  }
}
