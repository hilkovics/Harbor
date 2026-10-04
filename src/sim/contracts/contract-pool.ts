/**
 * Pool ponúk kontraktov (ARCHITECTURE §9.1; docs/tasks/phase-05.md rozhodnutie 8; ADR-026, ADR-027 dodatok T05-11) —
 * čisté funkcie nad defmi a jediným `Rng` sveta; kedy sa pool dopĺňa, rozhoduje `ContractSystem` (krok 2).
 *
 * - `capacityHint = max(minCapacityHint, min(berthCapacityPerDay, storageCapacity))`: `berthCapacityPerDay` = Σ
 *   `Module.dailyUnloadUnits` (žeriav `⌊ticksPerDay / cycleTicks⌋`), `storageCapacity` = Σ `Module.storageCapacityUnits`
 *   (sklad `capacityUnits`) — háčiky modulov namiesto `instanceof` (pravidlo 7).
 * - Booking ponuky (`drawBookingOffer`, ADR-032 bod 1) ťahá pool oddelene od import ponúk, po nich a len pri `DayClosed`
 *   (nie pri štarte hry): šablóna zo skupiny `booking` (`export`, `roundtrip`), trieda lode, mierka objemu, SLA a cieľový
 *   prístav; roundtrip vytvorí import (id n) a export (id n + 1) s jednou voyage, obom s rovnakou triedou lode a SLA.
 * - Ponuky F6c (ADR-034) ťahá pool tiež oddelene a po booking ponukách (`drawRepositioningOffer`, `drawTranshipOffer`; `ContractSystem` ich dopĺňa
 *   len pri `DayClosed` a len v prístave s depom prázdnych): **repositioning** (šablóna `empty_repositioning`: vlastná voyage, alebo s exportom
 *   `exportVolumeUnitsRange` — export (id n) a repositioning (id n + 1) na jednej voyage), **prekládka** (šablóna `tranship`: voyage lode A a voyage
 *   lode B — dve postupné voyage knihy, jeden kontrakt). Spotreba `Rng` ako pri booking ponuke: šablóna, loď, mierka, SLA, cieľový prístav.
 * - Jedna ponuka (`drawOffer`) spotrebuje zo `Rng` v tomto poradí: šablóna (`weighted` medzi šablónami s
 *   `minTier ≤ tier` a váhou > 0), trieda lode (`pick` zo `shipClassIds`), mierka objemu (`range(volumeScaleRange)`),
 *   SLA (`int(slaDaysRange)`). Objem = `clamp(round(mierka × hint), volumeUnitsRange)`, najviac kapacita lode a pri
 *   `storageCapacity > 0` najviac `max(min rozsahu, storageCapacity)` — poistka, aby partia bežne neprevýšila celú
 *   kapacitu skladov (mierka až 1,2 × hint); dolnú hranicu šablóny poistka neporuší (šablóna je kontrakt s hráčom,
 *   nad kapacitu sa náklad vyvezie počas vykládky — `unloading.outbound = 'sla'`). Poistka nemení spotrebu `Rng`.
 *   Bez vhodnej šablóny ponuka nevznikne a `Rng` sa nespotrebuje.
 */
import type { ContractId, VoyageId } from '../core/entity-id';
import type { Rng } from '../core/rng';
import type { DefRegistry } from '../defs/def-registry';
import { DEFAULT_TEMPLATE_KIND, type ContractTemplateDef, type ContractTemplateKind } from '../defs/types';
import type { Module } from '../modules/module';
import type { StatResolver } from '../tech/stat-resolver';
import { EmptyRepositioningContract, ExportContract, ImportContract, TranshipContract, type Contract } from './contract';
import { contractRewardCents, contractXpReward, lineForVoyage, maxSlaDaysOf, urgencyBp } from './contract-terms';

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
  /** Pridelí id voyage novej ponuke (ADR-032; volá sa hneď po `nextId`, `Rng` nespotrebuje). */
  readonly nextVoyageId: () => VoyageId;
}

/**
 * Skupiny šablón, z ktorých pool losuje oddelene (ADR-032 bod 1, ADR-034): `import` ponuky (šablóny `import`, F5), `booking` ponuky (šablóny
 * `export` a `roundtrip`, počet `economy.bookingOffersPerDay`), `repositioning` (šablóny `empty_repositioning`, `economy.repositioningOffersPerDay`)
 * a `tranship` (šablóny `tranship`, `economy.transhipOffersPerDay`). Tabuľka (nie switch) — nový druh šablóny = nový prvok skupiny. Ponuky F6c
 * pool ťahá len v prístave s depom prázdnych (`ContractSystem`), takže svet bez depa ostáva bitovo rovnaký ako vo F6a.
 */
export const TEMPLATE_GROUP_KINDS = Object.freeze({
  import: Object.freeze(['import'] as const),
  booking: Object.freeze(['export', 'roundtrip'] as const),
  repositioning: Object.freeze(['empty_repositioning'] as const),
  tranship: Object.freeze(['tranship'] as const),
} satisfies Record<string, readonly ContractTemplateKind[]>);
export type TemplateGroup = keyof typeof TEMPLATE_GROUP_KINDS;

/**
 * Šablóny skupiny `group` (predvolene `import` — import-only svet sa správa ako vo F5) ponúkateľné pri `tier`
 * (poradie defu): `minTier ≤ tier` a váha > 0.
 */
export function eligibleTemplates(
  templates: readonly Readonly<ContractTemplateDef>[],
  tier: number,
  group: TemplateGroup = 'import',
): Readonly<ContractTemplateDef>[] {
  const kinds: readonly ContractTemplateKind[] = TEMPLATE_GROUP_KINDS[group];
  return templates.filter((template) => kinds.includes(template.kind ?? DEFAULT_TEMPLATE_KIND) && template.minTier <= tier && template.weight > 0);
}

/** Spoločné podmienky ponuky šablóny (z jedného ťahu `Rng`) pre `buildImport` / `buildExport`. */
interface DrawnTerms {
  readonly template: Readonly<ContractTemplateDef>;
  readonly shipClassId: string;
  readonly scale: number;
  readonly slaDays: number;
  readonly urgency: number;
  readonly offeredTick: number;
  readonly offerExpiresTick: number;
}

/** Objem ponuky z mierky: rozsah šablóny, kapacita lode a poistka skladov (`offerVolumeUnits`). */
function volumeOf(context: OfferContext, terms: DrawnTerms, range: readonly [number, number]): number {
  const shipCapacity = context.defs.ships.get(terms.shipClassId).capacityUnits;
  return offerVolumeUnits(terms.scale, context.capacityHint, range, shipCapacity, context.storageCapacity);
}

/** Podmienky ponuky po ťahoch `Rng` (šablóna, loď, mierka a SLA už sú vyžrebované). */
function drawnTerms(context: OfferContext, template: Readonly<ContractTemplateDef>, shipClassId: string, scale: number, slaDays: number): DrawnTerms {
  const { defs, tick, ticksPerDay } = context;
  return {
    template,
    shipClassId,
    scale,
    slaDays,
    urgency: urgencyBp(slaDays, maxSlaDaysOf(defs.contractTemplates.items), defs.economy.urgencyFactor),
    offeredTick: tick,
    offerExpiresTick: tick + Math.max(MIN_OFFER_TICKS, Math.round(defs.economy.offerExpiryDays * ticksPerDay)),
  };
}

/** Import kontrakt ponuky (F5) s objemom `volumeUnits`; voyage dodáva volajúci (id n a n + 1 podľa poradia vzniku). */
function buildImport(context: OfferContext, terms: DrawnTerms, id: ContractId, voyageId: VoyageId, volumeUnits: number): ImportContract {
  const { defs } = context;
  const cargoType = defs.cargoTypes.get(terms.template.cargoTypeId);
  return new ImportContract({
    id,
    voyageId,
    templateId: terms.template.id,
    cargoTypeId: terms.template.cargoTypeId,
    volumeUnits,
    slaDays: terms.slaDays,
    rewardCents: contractRewardCents(volumeUnits, cargoType.basePricePerUnitCents, terms.urgency),
    xpReward: contractXpReward(volumeUnits, cargoType.xpPerUnit, defs.economy.xpMultiplier),
    offeredTick: terms.offeredTick,
    offerExpiresTick: terms.offerExpiresTick,
    shipClassId: terms.shipClassId,
    lineId: lineForVoyage(defs.lines.items, voyageId),
  });
}

/** Export booking ponuky (ADR-032 bod 14): odmena za celý booking `⌊booked × exportPricePerUnitCents × urgency⌋`. */
function buildExport(context: OfferContext, terms: DrawnTerms, id: ContractId, voyageId: VoyageId, bookedUnits: number, destinationPort: string): ExportContract {
  const { defs } = context;
  const cargoType = defs.cargoTypes.get(terms.template.cargoTypeId);
  return new ExportContract({
    id,
    voyageId,
    templateId: terms.template.id,
    cargoTypeId: terms.template.cargoTypeId,
    volumeUnits: bookedUnits,
    slaDays: terms.slaDays,
    rewardCents: contractRewardCents(bookedUnits, cargoType.exportPricePerUnitCents, terms.urgency),
    xpReward: contractXpReward(bookedUnits, cargoType.xpPerUnit, defs.economy.xpMultiplier),
    offeredTick: terms.offeredTick,
    offerExpiresTick: terms.offerExpiresTick,
    shipClassId: terms.shipClassId,
    lineId: lineForVoyage(defs.lines.items, voyageId),
    destinationPort,
  });
}

/** Repositioning prázdnych kontajnerov (ADR-034): odmena za celý booking `⌊booked × repositioningPricePerUnitCents × urgency⌋`, bez cut-off. */
function buildRepositioning(context: OfferContext, terms: DrawnTerms, id: ContractId, voyageId: VoyageId, bookedUnits: number, destinationPort: string): EmptyRepositioningContract {
  const { defs } = context;
  const cargoType = defs.cargoTypes.get(terms.template.cargoTypeId);
  return new EmptyRepositioningContract({
    id,
    voyageId,
    templateId: terms.template.id,
    cargoTypeId: terms.template.cargoTypeId,
    volumeUnits: bookedUnits,
    slaDays: terms.slaDays,
    rewardCents: contractRewardCents(bookedUnits, cargoType.repositioningPricePerUnitCents, terms.urgency),
    xpReward: contractXpReward(bookedUnits, cargoType.xpPerUnit, defs.economy.xpMultiplier),
    offeredTick: terms.offeredTick,
    offerExpiresTick: terms.offerExpiresTick,
    shipClassId: terms.shipClassId,
    lineId: lineForVoyage(defs.lines.items, voyageId),
    destinationPort,
  });
}

/** Prekládka loď → loď (ADR-034): odmena `⌊N × transhipPricePerUnitCents × urgency⌋`; voyage lode A (`voyageId`) a lode B (`outVoyageId`). */
function buildTranship(
  context: OfferContext,
  terms: DrawnTerms,
  id: ContractId,
  voyageId: VoyageId,
  outVoyageId: VoyageId,
  volumeUnits: number,
  destinationPort: string,
): TranshipContract {
  const { defs } = context;
  const cargoType = defs.cargoTypes.get(terms.template.cargoTypeId);
  return new TranshipContract({
    id,
    voyageId,
    outVoyageId,
    templateId: terms.template.id,
    cargoTypeId: terms.template.cargoTypeId,
    volumeUnits,
    slaDays: terms.slaDays,
    rewardCents: contractRewardCents(volumeUnits, cargoType.transhipPricePerUnitCents, terms.urgency),
    xpReward: contractXpReward(volumeUnits, cargoType.xpPerUnit, defs.economy.xpMultiplier),
    offeredTick: terms.offeredTick,
    offerExpiresTick: terms.offerExpiresTick,
    shipClassId: terms.shipClassId,
    lineId: lineForVoyage(defs.lines.items, voyageId),
    destinationPort,
  });
}

/**
 * Kontrakty booking ponuky podľa druhu šablóny (tabuľka, nie switch — pravidlo 7): `export` = jeden booking s vlastnou
 * voyage (bookované TEU z `volumeUnitsRange`), `roundtrip` = import z `volumeUnitsRange` (id n) a export z
 * `exportVolumeUnitsRange` (id n + 1) na jednej voyage. Ids prideľuje `context.nextId` v poradí vzniku.
 */
const BOOKING_BUILDERS: { readonly [K in 'export' | 'roundtrip']: (context: OfferContext, terms: DrawnTerms, destinationPort: string) => Contract[] } = {
  export: (context, terms, destinationPort) => {
    const voyageId = context.nextVoyageId();
    return [buildExport(context, terms, context.nextId(), voyageId, volumeOf(context, terms, terms.template.volumeUnitsRange), destinationPort)];
  },
  roundtrip: (context, terms, destinationPort) => {
    const exportRange = terms.template.exportVolumeUnitsRange as readonly [number, number];
    const voyageId = context.nextVoyageId();
    const importContract = buildImport(context, terms, context.nextId(), voyageId, volumeOf(context, terms, terms.template.volumeUnitsRange));
    return [importContract, buildExport(context, terms, context.nextId(), voyageId, volumeOf(context, terms, exportRange), destinationPort)];
  },
};

/**
 * Nová import ponuka (`offered`) s vlastnou voyage, alebo `null`, keď pri danom tieri nie je žiadna šablóna druhu `import`.
 * Viď hlavička súboru; booking ponuky (`export`, `roundtrip`) ťahá `drawBookingOffer`.
 */
export function drawOffer(context: OfferContext): Contract | null {
  const { defs, rng } = context;
  const eligible = eligibleTemplates(defs.contractTemplates.items, context.tier);
  if (eligible.length === 0) return null;
  const template = rng.weighted(eligible, (item) => item.weight);
  const shipClassId = rng.pick(template.shipClassIds);
  const [minScale, maxScale] = defs.economy.volumeScaleRange;
  const scale = rng.range(minScale, maxScale);
  const slaDays = rng.int(template.slaDaysRange[0], template.slaDaysRange[1]);
  const terms = drawnTerms(context, template, shipClassId, scale, slaDays);
  return buildImport(context, terms, context.nextId(), context.nextVoyageId(), volumeOf(context, terms, template.volumeUnitsRange));
}

/**
 * Nová booking ponuka (skupina kontraktov jednej voyage vzostupne podľa id: export booking, alebo import + export
 * roundtripu), alebo prázdne pole, keď pri danom tieri nie je žiadna šablóna druhu `export` / `roundtrip` (`Rng` sa vtedy
 * nespotrebuje). Spotreba `Rng`: šablóna (`weighted`), trieda lode (`pick`), mierka objemu (`range`), SLA (`int`),
 * cieľový prístav (`pick`).
 */
export function drawBookingOffer(context: OfferContext): Contract[] {
  const { defs, rng } = context;
  const eligible = eligibleTemplates(defs.contractTemplates.items, context.tier, 'booking');
  if (eligible.length === 0) return [];
  const template = rng.weighted(eligible, (item) => item.weight);
  const shipClassId = rng.pick(template.shipClassIds);
  const [minScale, maxScale] = defs.economy.volumeScaleRange;
  const scale = rng.range(minScale, maxScale);
  const slaDays = rng.int(template.slaDaysRange[0], template.slaDaysRange[1]);
  const destinationPort = rng.pick(template.destinationPorts as readonly string[]);
  const build = BOOKING_BUILDERS[template.kind as 'export' | 'roundtrip'];
  return build(context, drawnTerms(context, template, shipClassId, scale, slaDays), destinationPort);
}

/**
 * Spoločné ťahy `Rng` ponuky F6c (viď hlavička súboru) a výber šablóny skupiny `group`; bez vhodnej šablóny `undefined` (a `Rng` sa nespotrebuje).
 * Poradie: šablóna (`weighted`), trieda lode (`pick`), mierka objemu (`range`), SLA (`int`), cieľový prístav (`pick`).
 */
function drawF6cTerms(context: OfferContext, group: 'repositioning' | 'tranship'): { readonly terms: DrawnTerms; readonly destinationPort: string } | undefined {
  const { defs, rng } = context;
  const eligible = eligibleTemplates(defs.contractTemplates.items, context.tier, group);
  if (eligible.length === 0) return undefined;
  const template = rng.weighted(eligible, (item) => item.weight);
  const shipClassId = rng.pick(template.shipClassIds);
  const [minScale, maxScale] = defs.economy.volumeScaleRange;
  const scale = rng.range(minScale, maxScale);
  const slaDays = rng.int(template.slaDaysRange[0], template.slaDaysRange[1]);
  const destinationPort = rng.pick(template.destinationPorts as readonly string[]);
  return { terms: drawnTerms(context, template, shipClassId, scale, slaDays), destinationPort };
}

/**
 * Nová ponuka repositioningu prázdnych (skupina kontraktov jednej voyage vzostupne podľa id), alebo prázdne pole, keď pri danom tieri nie je
 * šablóna `empty_repositioning`. Šablóna s `exportVolumeUnitsRange` = export (id n) a repositioning (id n + 1) na jednej voyage, inak vlastná voyage.
 */
export function drawRepositioningOffer(context: OfferContext): Contract[] {
  const drawn = drawF6cTerms(context, 'repositioning');
  if (drawn === undefined) return [];
  const { terms, destinationPort } = drawn;
  const voyageId = context.nextVoyageId();
  const exportRange = terms.template.exportVolumeUnitsRange;
  const contracts: Contract[] = [];
  if (exportRange !== undefined) contracts.push(buildExport(context, terms, context.nextId(), voyageId, volumeOf(context, terms, exportRange), destinationPort));
  contracts.push(buildRepositioning(context, terms, context.nextId(), voyageId, volumeOf(context, terms, terms.template.volumeUnitsRange), destinationPort));
  return contracts;
}

/** Nová ponuka prekládky (jeden kontrakt: voyage lode A, potom voyage lode B), alebo prázdne pole, keď pri danom tieri nie je šablóna `tranship`. */
export function drawTranshipOffer(context: OfferContext): Contract[] {
  const drawn = drawF6cTerms(context, 'tranship');
  if (drawn === undefined) return [];
  const { terms, destinationPort } = drawn;
  const voyageId = context.nextVoyageId();
  const outVoyageId = context.nextVoyageId();
  return [buildTranship(context, terms, context.nextId(), voyageId, outVoyageId, volumeOf(context, terms, terms.template.volumeUnitsRange), destinationPort)];
}
