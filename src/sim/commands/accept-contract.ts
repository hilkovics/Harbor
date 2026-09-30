/**
 * `AcceptContract { contractId }` — hráč prijme ponuku (ARCHITECTURE §9.1, §12.2; docs/tasks/phase-05.md rozhodnutia
 * 4 a 5; ADR-026). Validácia: `ContractOfferCommand` (`game_over`, `unknown_contract`, `contract_not_offered`).
 *
 * `apply` (hotovosť sa nemení): plán lode — `acceptedTick = clock.tick` (v príkazovej fáze ešte predchádzajúci tick),
 * `shipArrivalTick = acceptedTick + max(1, round(rng.range(arrivalDaysRange) × ticksPerDay))` (jediný `Rng` sveta, jedno
 * číslo), `slaDeadlineTick = shipArrivalTick + slaDays × ticksPerDay` — potom `offered → accepted`
 * (`ContractStateChanged`) a `ContractAccepted`. Loď spawne `ContractSystem` v ticku príchodu.
 */
import type { Contract } from '../contracts/contract';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ContractOfferCommand, readContractId } from './contract-command';

/** Najskorší príchod lode po prijatí — v ďalšom ticku (krok 2 ho spawne, keď `tick ≥ shipArrivalTick`). */
const MIN_ARRIVAL_TICKS = 1;

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
