/**
 * `DeclineContract { contractId }` — hráč odmietne ponuku (ARCHITECTURE §9.1, §12.2; docs/tasks/phase-05.md
 * rozhodnutie 4; ADR-026). Validácia: `ContractOfferCommand` (`game_over`, `unknown_contract`, `contract_not_offered`).
 *
 * `apply`: `offered → expired` (`ContractStateChanged`, bez nového stavu) a `ContractExpired { reason: 'declined' }`;
 * kniha kontrakt zabudne. Hotovosť, XP ani pool sa nemenia — voľné miesto doplní najbližší `DayClosed`.
 */
import type { Contract } from '../contracts/contract';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ContractOfferCommand, readContractId } from './contract-command';

export class DeclineContractCommand extends ContractOfferCommand {
  static readonly TYPE = 'DeclineContract';

  readonly type = DeclineContractCommand.TYPE;

  constructor(contractId: number) {
    super(DeclineContractCommand.TYPE, contractId);
  }

  /** Príkaz z tvaru `{ type: 'DeclineContract', contractId }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): DeclineContractCommand {
    return new DeclineContractCommand(readContractId(json, DeclineContractCommand.TYPE));
  }

  protected applyTo(world: World, offer: Contract): void {
    world.contractBook.changeState(offer, 'expired');
    world.events.emit({ type: 'ContractExpired', contractId: offer.id, reason: 'declined' });
  }
}
