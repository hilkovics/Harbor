// T6C-05: projekcia repositioningu prázdnych a prekládky do kariet `ContractsPanel` (druh, linka, booking bez cut-off, trasa
// A → B, dostupné prázdne, dôvody odmietnutia) nad kontraktmi vloženými do knihy sveta (ADR-034).
import { describe, expect, it } from 'vitest';
import { AcceptContractCommand, type ValidationReason } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { KIND_REASON_TEXT, acceptDisabledReason, contractCards, contractLine, reasonText } from '@app/contract-cards';
import { REASON_TEXT } from '@app/build-feedback';
import { createApp } from './app-fixtures';
import { acceptRoundtrip, addRoundtripOffer } from './f6a-fixtures';
import { acceptContract, addRepositioningOffer, addTranshipOffer, storeEmptyUnit } from './f6c-fixtures';

const YARD = 4 as EntityId;

describe('contractLine: linka z lines.json', () => {
  it('názov a token farby z defu; neznáme id ostane pod svojím id bez farby', () => {
    const { world } = createApp();
    expect(contractLine(world, 'blue_anchor')).toEqual({ id: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue' });
    expect(contractLine(world, 'northern_star')).toMatchObject({ label: 'Northern Star Shipping', colorToken: 'line-amber' });
    expect(contractLine(world, 'golden_wave')).toMatchObject({ label: 'Golden Wave Container', colorToken: 'line-teal' });
    expect(contractLine(world, 'unknown_line')).toEqual({ id: 'unknown_line', label: 'unknown_line', colorToken: '' });
  });

  it('každá karta (aj import) nesie linku svojho kontraktu', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    const cards = contractCards(world);
    expect(cards.map((card) => card.line?.id)).toEqual([roundtrip.importContract.lineId, roundtrip.exportContract.lineId]);
    expect(cards[0]?.line).toEqual({ id: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue' });
  });
});

describe('contractCards: repositioning prázdnych', () => {
  it('karta má vlastný druh `empty_repositioning`, linku a booking bez cut-off (ani odstupu, ani ticku)', () => {
    const { world } = createApp();
    const offer = addRepositioningOffer(world, { volumeUnits: 24, lineId: 'northern_star', destinationPort: 'Gdańsk' });
    const [card] = contractCards(world);
    expect(card).toMatchObject({
      id: offer.id,
      kind: 'empty_repositioning',
      voyageId: offer.voyageId,
      state: 'offered',
      volumeUnits: 24,
      cargoLabel: 'Kontajnery',
      unit: 'TEU',
      line: { id: 'northern_star', label: 'Northern Star Shipping' },
      booking: { destinationPort: 'Gdańsk', bookedUnits: 24, arrivedUnits: 0, loadedUnits: 0, pendingArrivals: 0 },
    });
    expect(card?.booking).not.toHaveProperty('cutoffTick');
    expect(card?.booking).not.toHaveProperty('cutoffLeadTicks');
    expect(card).not.toHaveProperty('tranship');
  });

  it('availableEmpties = prázdne linky v stave `available` v prístave; poškodené, opravované a prázdne inej linky sa nerátajú', () => {
    const { world } = createApp();
    addRepositioningOffer(world, { lineId: 'blue_anchor' });
    for (let slot = 0; slot < 5; slot += 1) storeEmptyUnit(world, 'blue_anchor', YARD, slot);
    const damaged = storeEmptyUnit(world, 'blue_anchor', YARD, 5);
    world.cargo.setStatus(damaged.id, 'damaged', null);
    const repairing = storeEmptyUnit(world, 'blue_anchor', YARD, 6);
    world.cargo.setStatus(repairing.id, 'in_repair', world.clock.tick + 100);
    storeEmptyUnit(world, 'golden_wave', YARD, 7);
    expect(contractCards(world)[0]?.availableEmpties).toBe(5);
  });

  it('bez prázdnych v prístave 0; karta nepripojí `availableEmpties` k importu ani prekládke', () => {
    const { world } = createApp();
    addRepositioningOffer(world);
    addTranshipOffer(world);
    const roundtrip = addRoundtripOffer(world);
    const cards = contractCards(world);
    expect(cards.find((card) => card.kind === 'empty_repositioning')?.availableEmpties).toBe(0);
    for (const card of cards.filter((candidate) => candidate.kind !== 'empty_repositioning')) expect(card).not.toHaveProperty('availableEmpties');
    expect(cards.map((card) => card.id)).toContain(roundtrip.exportContract.id);
  });

  it('uzavretý repositioning už `availableEmpties` nenesie (história)', () => {
    const { world } = createApp();
    const offer = addRepositioningOffer(world);
    expect(contractCards(world)[0]).toHaveProperty('availableEmpties');
    acceptContract(world, offer);
    world.contractBook.changeState(offer, 'ship_en_route');
    expect(contractCards(world)[0]).toHaveProperty('availableEmpties');
    world.contractBook.changeState(offer, 'failed');
    expect(contractCards(world)[0]).toMatchObject({ state: 'failed' });
    expect(contractCards(world)[0]).not.toHaveProperty('availableEmpties');
  });
});

describe('contractCards: prekládka', () => {
  it('ponuka: kind `tranship`, voyage A ako voyageId, plavba B a rozstup príchodu B z economy.transhipGapDaysRange', () => {
    const { world } = createApp();
    const offer = addTranshipOffer(world, { volumeUnits: 36, destinationPort: 'Hamburg' });
    const [card] = contractCards(world);
    const { ticksPerDay } = world.clock;
    expect(card).toMatchObject({
      id: offer.id,
      kind: 'tranship',
      voyageId: offer.voyageId,
      line: { id: 'golden_wave' },
      booking: { destinationPort: 'Hamburg', bookedUnits: 36 },
      tranship: { outVoyageId: offer.outVoyageId },
    });
    const [minDays, maxDays] = world.defs.economy.transhipGapDaysRange;
    expect(card?.tranship?.outGapTicks).toEqual([Math.round(minDays * ticksPerDay), Math.round(maxDays * ticksPerDay)]);
    expect(card?.tranship).not.toHaveProperty('outArrivalTick');
    expect(card?.tranship).not.toHaveProperty('rescueDeadlineTick');
    expect(card?.booking).not.toHaveProperty('cutoffLeadTicks');
    expect(offer.outVoyageId).not.toBe(offer.voyageId);
  });

  it('prijatá prekládka nesie príchod lode B (po lodi A) namiesto rozstupu', () => {
    const { world } = createApp();
    const offer = addTranshipOffer(world);
    acceptContract(world, offer, { arrivalIn: 2 * world.clock.ticksPerDay, gapDays: 1.5 });
    const card = contractCards(world)[0];
    const arrival = world.clock.tick + 2 * world.clock.ticksPerDay;
    expect(card?.shipArrivalTick).toBe(arrival);
    expect(card?.tranship?.outArrivalTick).toBe(arrival + Math.round(1.5 * world.clock.ticksPerDay));
    expect(card?.tranship).not.toHaveProperty('outGapTicks');
  });

  it('počítadlá bookingu: vyložené (arrived), naložené, vrátené; zmeškaná prekládka nesie lehotu záchrany', () => {
    const { world } = createApp();
    const offer = addTranshipOffer(world, { volumeUnits: 10 });
    acceptContract(world, offer);
    offer.arrivedUnits = 10;
    offer.unitsUnloaded = 10;
    offer.loadedUnits = 3;
    offer.unitsExported = 2;
    offer.rescueDeadlineTick = world.clock.tick + 3 * world.clock.ticksPerDay;
    const card = contractCards(world)[0];
    expect(card?.booking).toMatchObject({ bookedUnits: 10, arrivedUnits: 10, loadedUnits: 3, returnedUnits: 2 });
    expect(card?.unitsUnloaded).toBe(10);
    expect(card?.tranship?.rescueDeadlineTick).toBe(offer.rescueDeadlineTick);
  });
});

describe('contractCards: skupiny a poradie', () => {
  it('export + repositioning jednej voyage dostanú rovnaké voyageId (panel ich zloží do jednej karty)', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    const cards = contractCards(world);
    expect(new Set(cards.map((card) => card.voyageId)).size).toBe(1);
    acceptRoundtrip(world, roundtrip);
    expect(contractCards(world).map((card) => card.kind)).toEqual(['import', 'export']);
  });

  it('nové druhy sú v zozname podľa id spolu s ostatnými ponukami', () => {
    const { world } = createApp();
    const repo = addRepositioningOffer(world);
    const tranship = addTranshipOffer(world);
    expect(contractCards(world).map((card) => card.id)).toEqual([repo.id, tranship.id]);
  });
});

describe('dôvody odmietnutia pre nové druhy', () => {
  const landside: readonly ValidationReason[] = ['no_ramp_for_category', 'ramp_inoperative', 'no_storage_for_category'];

  it('tabuľka KIND_REASON_TEXT má pre repositioning aj prekládku texty bez slova „export“ (ide o prázdne a prekládku)', () => {
    for (const kind of ['empty_repositioning', 'tranship'] as const) {
      const texts = KIND_REASON_TEXT[kind];
      expect(texts, kind).toBeDefined();
      for (const reason of landside) {
        const text = texts?.[reason];
        expect(text, `${kind}/${reason}`).toBeTypeOf('string');
        expect(text?.toLowerCase(), `${kind}/${reason}`).not.toContain('export');
      }
    }
  });

  it('reasonText: špecifický text pre druh, inak všeobecný z REASON_TEXT (import a export ho nemajú v tabuľke)', () => {
    expect(reasonText('empty_repositioning', 'no_storage_for_category')).toBe('Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)');
    expect(reasonText('empty_repositioning', 'game_over')).toBe(REASON_TEXT.game_over);
    expect(reasonText('tranship', 'no_storage_for_category')).toBe('Pre prekládku nie je dosiahnuteľný sklad na tento náklad');
    expect(reasonText('export', 'no_storage_for_category')).toBe(REASON_TEXT.no_storage_for_category);
    expect(reasonText('import', 'no_crane_for_category')).toBe(REASON_TEXT.no_crane_for_category);
  });

  it('karta repositioningu bez prístavu: disabledReason = prvý dôvod validácie AcceptContract v texte druhu', () => {
    const { world } = createApp();
    const offer = addRepositioningOffer(world);
    const verdict = new AcceptContractCommand(offer.id).validate(world);
    expect(verdict.ok).toBe(false);
    const reason = verdict.reasons[0];
    if (reason === undefined) throw new Error('validácia nevrátila dôvod');
    const text = acceptDisabledReason(world, offer);
    expect(text).toBe(reasonText('empty_repositioning', reason));
    expect(contractCards(world)[0]?.disabledReason).toBe(text);
  });

  it('prijatý kontrakt dôvod nemá', () => {
    const { world } = createApp();
    const offer = addTranshipOffer(world);
    acceptContract(world, offer);
    expect(acceptDisabledReason(world, offer)).toBeUndefined();
    expect(contractCards(world)[0]).not.toHaveProperty('disabledReason');
  });
});
