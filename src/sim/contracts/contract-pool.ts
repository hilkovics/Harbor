/**
 * Pool ponúk kontraktov (ARCHITECTURE §9.1; docs/tasks/phase-05.md rozhodnutie 8; ADR-026) — čisté funkcie nad defmi
 * a jediným `Rng` sveta; kedy sa pool dopĺňa, rozhoduje `ContractSystem` (krok 2).
 *
 * - `capacityHint = max(minCapacityHint, min(berthCapacityPerDay, storageCapacity))`: `berthCapacityPerDay` = Σ
 *   `Module.dailyUnloadUnits` (žeriav `⌊ticksPerDay / cycleTicks⌋`), `storageCapacity` = Σ `Module.storageCapacityUnits`
 *   (sklad `capacityUnits`) — háčiky modulov namiesto `instanceof` (pravidlo 7).
 * - Jedna ponuka (`drawOffer`) spotrebuje zo `Rng` v tomto poradí: šablóna (`weighted` medzi šablónami s
 *   `minTier ≤ tier` a váhou > 0), trieda lode (`pick` zo `shipClassIds`), mierka objemu (`range(volumeScaleRange)`),
 *   SLA (`int(slaDaysRange)`). Objem = `clamp(round(mierka × hint), volumeUnitsRange)` a najviac kapacita lode.
 *   Bez vhodnej šablóny ponuka nevznikne a `Rng` sa nespotrebuje.
 */
import type { ContractId } from '../core/entity-id';
import type { Rng } from '../core/rng';
import type { DefRegistry } from '../defs/def-registry';
import type { ContractTemplateDef } from '../defs/types';
import type { Module } from '../modules/module';
import type { StatResolver } from '../tech/stat-resolver';
import { Contract } from './contract';
import { contractRewardCents, contractXpReward, maxSlaDaysOf, urgencyBp } from './contract-terms';

/** Najkratšia platnosť ponuky v tickoch (ponuka musí prežiť aspoň tick svojho vzniku). */
const MIN_OFFER_TICKS = 1;

/** `capacityHint` prístavu (viď hlavička súboru); moduly v ľubovoľnom poradí (súčty sú celé čísla). */
export function capacityHintOf(modules: Iterable<Module>, stats: Pick<StatResolver, 'resolve'>, ticksPerDay: number, minCapacityHint: number): number {
  let berthPerDay = 0;
  let storage = 0;
  for (const module of modules) {
    berthPerDay += module.dailyUnloadUnits(stats, ticksPerDay);
    storage += module.storageCapacityUnits();
  }
  return Math.max(minCapacityHint, Math.min(berthPerDay, storage));
}

/** Vstup pre jednu ponuku. */
export interface OfferContext {
  readonly defs: DefRegistry;
  readonly rng: Rng;
  /** Tick vzniku ponuky. */
  readonly tick: number;
  readonly ticksPerDay: number;
  /** Aktuálny tier hráča (filter `minTier`). */
  readonly tier: number;
  readonly capacityHint: number;
  /** Pridelí id novej ponuke (volá sa až po výbere šablóny). */
  readonly nextId: () => ContractId;
}

/** Šablóny ponúkateľné pri `tier` (poradie defu). */
export function eligibleTemplates(templates: readonly Readonly<ContractTemplateDef>[], tier: number): Readonly<ContractTemplateDef>[] {
  return templates.filter((template) => template.minTier <= tier && template.weight > 0);
}

/** Nová ponuka (`offered`), alebo `null`, keď pri danom tieri nie je žiadna šablóna. Viď hlavička súboru. */
export function drawOffer(context: OfferContext): Contract | null {
  const { defs, rng, tick, ticksPerDay, capacityHint } = context;
  const templates = defs.contractTemplates.items;
  const eligible = eligibleTemplates(templates, context.tier);
  if (eligible.length === 0) return null;
  const template = rng.weighted(eligible, (item) => item.weight);
  const shipClassId = rng.pick(template.shipClassIds);
  const [minScale, maxScale] = defs.economy.volumeScaleRange;
  const scale = rng.range(minScale, maxScale);
  const [minVolume, maxVolume] = template.volumeUnitsRange;
  const capacity = defs.ships.get(shipClassId).capacityUnits;
  const volumeUnits = Math.min(capacity, maxVolume, Math.max(minVolume, Math.round(scale * capacityHint)));
  const slaDays = rng.int(template.slaDaysRange[0], template.slaDaysRange[1]);
  const cargoType = defs.cargoTypes.get(template.cargoTypeId);
  const { economy } = defs;
  const urgency = urgencyBp(slaDays, maxSlaDaysOf(templates), economy.urgencyFactor);
  return new Contract({
    id: context.nextId(),
    templateId: template.id,
    cargoTypeId: template.cargoTypeId,
    volumeUnits,
    slaDays,
    rewardCents: contractRewardCents(volumeUnits, cargoType.basePricePerUnitCents, urgency),
    xpReward: contractXpReward(volumeUnits, cargoType.xpPerUnit, economy.xpMultiplier),
    offeredTick: tick,
    offerExpiresTick: tick + Math.max(MIN_OFFER_TICKS, Math.round(economy.offerExpiryDays * ticksPerDay)),
    shipClassId,
  });
}
