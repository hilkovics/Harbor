/**
 * Príkazy `AcceptContract` a `DeclineContract` (T05-05, TDD; „Rozhodnutia orchestrátora" 4, 5; „Spoločné rozhrania"):
 * validácia (`unknown_contract`, `contract_not_offered`), účinok, udalosti a serializácia (replay).
 *
 * Predpoklady o API:
 *  C1 príkazy sa registrujú v `commandRegistry` pod typmi `AcceptContract` a `DeclineContract` s payloadom
 *     `{ contractId: number }` (`commandFromJSON`, `toJSON` sa zhoduje so vstupom);
 *  C2 `validate` vracia dôvody `unknown_contract` (id nie je v `world.contracts`) a `contract_not_offered` (kontrakt nie
 *     je v stave `offered`); odmietnutý príkaz nemení stav sveta (`CommandRejected` pri aplikácii);
 *  C3 `DeclineContract` = `offered → expired` s `ContractExpired { reason: 'declined' }` a `ContractStateChanged`;
 *     expirovaný kontrakt ostáva vo `world.contracts` v stave `expired` alebo z mapy zmizne (test pripúšťa oboje);
 *  C4 `AcceptContract` = `offered → accepted` + `ContractAccepted` + `ContractStateChanged`, bez zmeny hotovosti.
 */
import { describe, expect, it } from 'vitest';
import { CommandError, commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import type { World } from '@sim/world';
import { must } from '../helpers/harbor';
import {
  DEFS,
  TICKS_PER_DAY,
  acceptContract,
  cashOf,
  commandReasons,
  completedOf,
  contractById,
  declineContract,
  offeredContracts,
  stateOfContract,
  tickWorld,
  worldWithPool,
} from '../helpers/f5';

const UNKNOWN_ID = 987_654;

/** Zaradí príkaz, aplikuje ho (bez tiku) a vráti udalosti. */
function applyNow(world: World, command: ReturnType<typeof acceptContract>): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

const typesOf = (events: readonly SimEvent[]): string[] => events.map((event) => event.type);
const rejections = (events: readonly SimEvent[]): (readonly string[])[] =>
  events.flatMap((event) => (event.type === 'CommandRejected' ? [event.reasons as readonly string[]] : []));
const asRecords = (events: readonly SimEvent[]): Record<string, unknown>[] => events as unknown as Record<string, unknown>[];

describe('AcceptContract', () => {
  it('validate: ponuka je platná; neznáme id → unknown_contract', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    expect(commandReasons(world, acceptContract(offer.id))).toEqual([]);
    expect(commandReasons(world, acceptContract(UNKNOWN_ID))).toEqual(['unknown_contract']);
  });

  it('účinok: offered → accepted, ContractAccepted + ContractStateChanged, acceptedTick, plán lode; hotovosť sa nemení', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    const cashBefore = cashOf(world);
    const events = applyNow(world, acceptContract(offer.id));

    expect(rejections(events)).toEqual([]);
    expect(typesOf(events)).toContain('ContractAccepted');
    const accepted = asRecords(events).filter((event) => event['type'] === 'ContractAccepted');
    expect(accepted.map((event) => event['contractId'])).toEqual([offer.id]);
    const changes = asRecords(events).filter((event) => event['type'] === 'ContractStateChanged');
    expect(changes.map((event) => [event['contractId'], event['from'], event['to']])).toEqual([[offer.id, 'offered', 'accepted']]);
    expect(events.filter((event) => event.type === 'MoneyChanged')).toEqual([]);

    const contract = contractById(world, offer.id);
    expect(contract.state).toBe('accepted');
    expect(contract.acceptedTick).toBe(world.clock.tick);
    expect(must(contract.shipArrivalTick, 'shipArrivalTick')).toBeGreaterThan(world.clock.tick);
    expect(must(contract.slaDeadlineTick, 'slaDeadlineTick')).toBeGreaterThan(must(contract.shipArrivalTick, 'shipArrivalTick'));
    expect(contract.shipId).toBeUndefined();
    expect(cashOf(world)).toBe(cashBefore);
    expect(offeredContracts(world).map((c) => c.id)).not.toContain(offer.id);
    expect(offeredContracts(world)).toHaveLength(DEFS.economy.offersPerDay - 1);
  });

  it('druhé prijatie toho istého kontraktu: contract_not_offered, CommandRejected a stav sa nemení', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    applyNow(world, acceptContract(offer.id));
    const snapshot = JSON.stringify(contractById(world, offer.id));
    expect(commandReasons(world, acceptContract(offer.id))).toEqual(['contract_not_offered']);
    const events = applyNow(world, acceptContract(offer.id));
    expect(rejections(events)).toEqual([['contract_not_offered']]);
    expect(JSON.stringify(contractById(world, offer.id))).toBe(snapshot);
  });

  it('neznáme id pri aplikácii: CommandRejected(unknown_contract), svet sa nezmení', () => {
    const world = worldWithPool();
    const before = JSON.stringify(world.serialize());
    expect(rejections(applyNow(world, acceptContract(UNKNOWN_ID)))).toEqual([['unknown_contract']]);
    expect(JSON.stringify(world.serialize())).toBe(before);
  });

  it('expirovanú ponuku (timeout) prijať nejde: unknown_contract alebo contract_not_offered', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    tickWorld(world, DEFS.economy.offerExpiryDays * TICKS_PER_DAY + TICKS_PER_DAY + 1);
    expect(['expired', 'removed']).toContain(stateOfContract(world, offer.id));
    const reasons = commandReasons(world, acceptContract(offer.id));
    expect(reasons).toHaveLength(1);
    expect(['unknown_contract', 'contract_not_offered']).toContain(reasons[0]);
  });
});

describe('DeclineContract', () => {
  it('validate: ponuka je platná; neznáme id → unknown_contract; prijatý kontrakt → contract_not_offered', () => {
    const world = worldWithPool();
    const [first, second] = offeredContracts(world);
    expect(commandReasons(world, declineContract(must(first, 'ponuka').id))).toEqual([]);
    expect(commandReasons(world, declineContract(UNKNOWN_ID))).toEqual(['unknown_contract']);
    applyNow(world, acceptContract(must(second, 'ponuka').id));
    expect(commandReasons(world, declineContract(second.id))).toEqual(['contract_not_offered']);
  });

  it('účinok: offered → expired s ContractExpired(declined); bez zmeny hotovosti, XP a počtu dokončených', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    const cashBefore = cashOf(world);
    const events = applyNow(world, declineContract(offer.id));

    expect(rejections(events)).toEqual([]);
    const expired = asRecords(events).filter((event) => event['type'] === 'ContractExpired');
    expect(expired.map((event) => [event['contractId'], event['reason']])).toEqual([[offer.id, 'declined']]);
    const changes = asRecords(events).filter((event) => event['type'] === 'ContractStateChanged');
    expect(changes.map((event) => [event['contractId'], event['from'], event['to']])).toEqual([[offer.id, 'offered', 'expired']]);
    expect(['expired', 'removed']).toContain(stateOfContract(world, offer.id));
    expect(cashOf(world)).toBe(cashBefore);
    expect(completedOf(world)).toBe(0);
    expect(offeredContracts(world)).toHaveLength(DEFS.economy.offersPerDay - 1);
  });

  it('odmietnutú ponuku už nejde prijať ani odmietnuť; ostatné ponuky ostávajú', () => {
    const world = worldWithPool();
    const [first, second] = offeredContracts(world);
    applyNow(world, declineContract(must(first, 'ponuka').id));
    for (const command of [acceptContract(first.id), declineContract(first.id)]) {
      const reasons = commandReasons(world, command);
      expect(reasons).toHaveLength(1);
      expect(['unknown_contract', 'contract_not_offered']).toContain(reasons[0]);
    }
    expect(contractById(world, must(second, 'ponuka').id).state).toBe('offered');
  });

  it('odmietnutie prijatého kontraktu pri aplikácii: CommandRejected(contract_not_offered), kontrakt ostáva accepted', () => {
    const world = worldWithPool();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    applyNow(world, acceptContract(offer.id));
    expect(rejections(applyNow(world, declineContract(offer.id)))).toEqual([['contract_not_offered']]);
    expect(contractById(world, offer.id).state).toBe('accepted');
  });
});

describe('serializácia príkazov (replay)', () => {
  it.each([acceptContract(7), declineContract(7)])('%j prežije commandFromJSON → toJSON bez zmeny', (command) => {
    expect(commandFromJSON(command).toJSON()).toEqual(command);
  });

  it.each([
    { type: 'AcceptContract' },
    { type: 'AcceptContract', contractId: 'jedenásť' },
    { type: 'DeclineContract' },
    { type: 'DeclineContract', contractId: 1, navyše: true },
  ])('chybný payload %j → CommandError', (payload) => {
    expect(() => commandFromJSON(payload)).toThrow(CommandError);
  });
});

describe('determinizmus prijatia', () => {
  it('rovnaký seed a rovnaký tick prijatia dajú rovnaký príchod lode a SLA', () => {
    const a = worldWithPool();
    const b = worldWithPool();
    const id = must(offeredContracts(a)[0], 'ponuka').id;
    applyNow(a, acceptContract(id));
    applyNow(b, acceptContract(id));
    expect(JSON.stringify(contractById(a, id))).toBe(JSON.stringify(contractById(b, id)));
  });
});
