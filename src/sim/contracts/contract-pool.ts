/**
 * Pool ponúk kontraktov (ARCHITECTURE §9.1; docs/tasks/phase-05.md rozhodnutie 8; ADR-026, ADR-027 dodatok T05-11) —
 * čisté funkcie nad defmi a jediným `Rng` sveta; kedy sa pool dopĺňa, rozhoduje `ContractSystem` (krok 2).
 *
 * - `capacityHint = max(minCapacityHint, min(berthCapacityPerDay, storageCapacity))`: `berthCapacityPerDay` = Σ
 *   `Module.dailyUnloadUnits` (žeriav `⌊ticksPerDay / cycleTicks⌋`), `storageCapacity` = Σ `Module.storageCapacityUnits`
 *   (sklad `capacityUnits`) — háčiky modulov namiesto `instanceof` (pravidlo 7).
 * - Jedna ponuka (`drawOffer`) spotrebuje zo `Rng` v tomto poradí: šablóna (`weighted` medzi šablónami s
 *   `minTier ≤ tier` a váhou > 0), trieda lode (`pick` zo `shipClassIds`), mierka objemu (`range(volumeScaleRange)`),
 *   SLA (`int(slaDaysRange)`). Objem = `clamp(round(mierka × hint), volumeUnitsRange)`, najviac kapacita lode a pri
 *   `storageCapacity > 0` najviac `max(min rozsahu, storageCapacity)` — poistka, aby partia bežne neprevýšila celú
 *   kapacitu skladov (mierka až 1,2 × hint); dolnú hranicu šablóny poistka neporuší (šablóna je kontrakt s hráčom,
 *   nad kapacitu sa náklad vyvezie počas vykládky — `unloading.outbound = 'sla'`). Poistka nemení spotrebu `Rng`.
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

/** Kapacity prístavu pre pool: vykládka za deň a celková kapacita skladov (jednotky). */
export interface PortCapacity {
  readonly berthCapacityPerDay: number;
  readonly storageCapacity: number;
}

/** Kapacity prístavu (viď hlavička súboru); moduly v ľubovoľnom poradí (súčty sú celé čísla). */
export function portCapacityOf(modules: Iterable<Module>, stats: Pick<StatResolver, 'resolve'>, ticksPerDay: number): PortCapacity {
  let berthCapacityPerDay = 0;
  let storageCapacity = 0;
  for (const module of modules) {
    berthCapacityPerDay += module.dailyUnloadUnits(stats, ticksPerDay);
    storageCapacity += module.storageCapacityUnits();
  }
  return { berthCapacityPerDay, storageCapacity };
}

/** `capacityHint` z kapacít prístavu (viď hlavička súboru). */
export function capacityHintFrom(capacity: PortCapacity, minCapacityHint: number): number {
  return Math.max(minCapacityHint, Math.min(capacity.berthCapacityPerDay, capacity.storageCapacity));
}

/** `capacityHint` prístavu (viď hlavička súboru); moduly v ľubovoľnom poradí. */
export function capacityHintOf(modules: Iterable<Module>, stats: Pick<StatResolver, 'resolve'>, ticksPerDay: number, minCapacityHint: number): number {
  return capacityHintFrom(portCapacityOf(modules, stats, ticksPerDay), minCapacityHint);
}

/**
 * Objem ponuky: `clamp(round(scale × hint), [min, max])`, najviac kapacita lode a pri `storageCapacity > 0` najviac
 * `max(min, storageCapacity)` (viď hlavička súboru).
 */
export function offerVolumeUnits(scale: number, capacityHint: number, volumeUnitsRange: readonly [number, number], shipCapacityUnits: number, storageCapacity: number): number {
  const [minVolume, maxVolume] = volumeUnitsRange;
  let upper = Math.min(shipCapacityUnits, maxVolume);
  if (storageCapacity > 0) upper = Math.min(upper, Math.max(minVolume, storageCapacity));
  return Math.min(upper, Math.max(minVolume, Math.round(scale * capacityHint)));
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
  /** Celková kapacita skladov prístavu (poistka objemu; 0 = bez skladov, poistka neplatí). */
  readonly storageCapacity: number;
  /** Pridelí id novej ponuke (volá sa až po výbere šablóny). */
  readonly nextId: () => ContractId;
}

/** Šablóny ponúkateľné pri `tier` (poradie defu). */
export function eligibleTemplates(templates: readonly Readonly<ContractTemplateDef>[], tier: number): Readonly<ContractTemplateDef>[] {
  return templates.filter((template) => template.minTier <= tier && template.weight > 0);
}

/** Nová ponuka (`offered`), alebo `null`, keď pri danom tieri nie je žiadna šablóna. Viď hlavička súboru. */
export function drawOffer(context: OfferContext): Contract | null {
  const { defs, rng, tick, ticksPerDay, capacityHint, storageCapacity } = context;
  const templates = defs.contractTemplates.items;
  const eligible = eligibleTemplates(templates, context.tier);
  if (eligible.length === 0) return null;
  const template = rng.weighted(eligible, (item) => item.weight);
  const shipClassId = rng.pick(template.shipClassIds);
  const [minScale, maxScale] = defs.economy.volumeScaleRange;
  const scale = rng.range(minScale, maxScale);
  const volumeUnits = offerVolumeUnits(scale, capacityHint, template.volumeUnitsRange, defs.ships.get(shipClassId).capacityUnits, storageCapacity);
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
