// TR2-05: karta kontraktu nesie `volumeTeu` z kontraktu (nie počet kontajnerov) a rozdelenie 20′ / 40′ odvodené z `volumeUnits` a `volumeTeu`
// (`largeContainerCount`), takže ho má aj ponuka bez jednotiek.
import { describe, expect, it } from 'vitest';
import type { Contract } from '@sim/contracts';
import { contractCard, contractCards } from '@app/contract-cards';
import { createApp } from './app-fixtures';

function firstOffer() {
  const app = createApp();
  app.loop.frame(app.loop.tickMs);
  const contract = [...app.world.contracts.values()][0];
  if (contract === undefined) throw new Error('ponuka chýba');
  return { world: app.world, contract };
}

/** Kontrakt (trieda s getrami na prototype) s prepísaným objemom — odvodený objekt, pôvodný sa nemení. */
function withVolume(contract: Contract, volumeUnits: number, volumeTeu: number | undefined): Contract {
  return Object.create(contract, { volumeUnits: { value: volumeUnits }, volumeTeu: { value: volumeTeu } }) as Contract;
}

describe('contractCard: TEU a rozdelenie veľkostí', () => {
  it('každá ponuka: volumeTeu z kontraktu, 20′ + 40′ dáva počet kontajnerov a 20′ + 2 × 40′ dáva TEU', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    for (const card of contractCards(app.world)) {
      const contract = app.world.contracts.get(card.id as never) as Contract;
      expect(card.volumeTeu).toBe(contract.volumeTeu ?? contract.volumeUnits);
      expect((card.count20 ?? 0) + (card.count40 ?? 0)).toBe(card.volumeUnits);
      expect((card.count20 ?? 0) + 2 * (card.count40 ?? 0)).toBe(card.volumeTeu);
    }
  });

  it('kontrakt s 40′: 10 kontajnerov a 14 TEU → 6 × 20′ a 4 × 40′; počet kontajnerov ostáva vo `volumeUnits`', () => {
    const { world, contract } = firstOffer();
    const card = contractCard(world, withVolume(contract, 10, 14));
    expect(card).toMatchObject({ volumeUnits: 10, volumeTeu: 14, count20: 6, count40: 4 });
  });

  it('kontrakt bez `volumeTeu` (náklad mimo kontajnerov): TEU = počet jednotiek, všetko 20′', () => {
    const { world, contract } = firstOffer();
    const card = contractCard(world, withVolume(contract, 12, undefined));
    expect(card).toMatchObject({ volumeUnits: 12, volumeTeu: 12, count20: 12, count40: 0 });
  });
});
