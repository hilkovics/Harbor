/**
 * Akcie „Prijať“ / „Odmietnuť“ nad ponukou kontraktu (T05-07, F6a): `validate` → `dispatch` len pri `ok` (pravidlo 5).
 *
 * Karta v paneli nesie `id` prvého kontraktu skupiny voyage (vzostupne podľa id); `AcceptContract` / `DeclineContract`
 * pôsobia v sime na celú skupinu ponuky — všetky `offered` kontrakty tej istej voyage (ADR-032 bod 1) —, takže UI posiela
 * jediný príkaz s týmto `id` aj pri roundtripe (import + export booking).
 */
import { AcceptContractCommand, DeclineContractCommand, type Command } from '@sim/commands';
import type { SimBridge } from './sim-bridge';

/** Časť `SimBridge`, ktorú akcie používajú. */
export type OfferActionBridge = Pick<SimBridge, 'validate' | 'dispatch'>;

function dispatchValid(bridge: OfferActionBridge, command: Command): boolean {
  if (!bridge.validate(command).ok) return false;
  bridge.dispatch(command);
  return true;
}

/** Prijme ponuku (skupinu voyage kontraktu `id`); `false` = validácia ju odmietla a nič sa neposlalo. */
export function acceptOffer(bridge: OfferActionBridge, id: number): boolean {
  return dispatchValid(bridge, new AcceptContractCommand(id));
}

/** Odmietne ponuku (skupinu voyage kontraktu `id`); `false` = validácia ju odmietla a nič sa neposlalo. */
export function declineOffer(bridge: OfferActionBridge, id: number): boolean {
  return dispatchValid(bridge, new DeclineContractCommand(id));
}
