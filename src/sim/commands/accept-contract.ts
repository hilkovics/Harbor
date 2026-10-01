/**
 * `AcceptContract { contractId }` — hráč prijme ponuku (ARCHITECTURE §9.1, §12.2; docs/tasks/phase-05.md rozhodnutia
 * 4 a 5; ADR-026). Validácia: `ContractOfferCommand` (`game_over`, `unknown_contract`, `contract_not_offered`) a potom
 * **pripravenosť prístavu** (T06-07, ADR-031; `berthReadiness`): `no_berth_for_ship_class` — žiadny úsek kotvísk nemá
 * pre triedu lode ponuky dosť dĺžky, hĺbky a pásu vody; `no_crane_for_category` — taký úsek je, ale bez žeriavu
 * kategórie nákladu kontraktu. Obsadenosť kotvísk a lodná doprava sa neposudzujú (loď by počkala na anchorage).
 * Validácia svet nemení a `Rng` nespotrebuje.
 *
 * `apply` (hotovosť sa nemení): plán lode — `acceptedTick = clock.tick` (v príkazovej fáze ešte predchádzajúci tick),
 * `shipArrivalTick = acceptedTick + max(1, round(rng.range(arrivalDaysRange) × ticksPerDay))` (jediný `Rng` sveta, jedno
 * číslo), `slaDeadlineTick = shipArrivalTick + slaDays × ticksPerDay` — potom `offered → accepted`
 * (`ContractStateChanged`) a `ContractAccepted`. Loď spawne `ContractSystem` v ticku príchodu.
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
    return READINESS_VERDICT[berthReadiness(world, request)];
  }

  protected applyTo(world: World, offer: Contract): void {
    const { ticksPerDay, tick } = world.clock;
    const [minDays, maxDays] = world.defs.economy.arrivalDaysRange;
    const arrivalTicks = Math.max(MIN_ARRIVAL_TICKS, Math.round(world.rng.range(minDays, maxDays) * ticksPerDay));
    offer.acceptedTick = tick;
    offer.shipArrivalTick = tick + arrivalTicks;
    offer.slaDeadlineTick = offer.shipArrivalTick + offer.slaDays * ticksPerDay;
    world.contractBook.changeState(offer, 'accepted');
    world.events.emit({ type: 'ContractAccepted', contractId: offer.id });
  }
}
