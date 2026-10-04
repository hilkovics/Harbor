/**
 * Vzorce kontraktov (ARCHITECTURE §9.1; docs/tasks/phase-05.md rozhodnutia 1, 6, 7, 8; ADR-026). Peniaze sú celé centy,
 * sadzby z defu sa prevedú na celé bázické body a zaokrúhľuje sa nadol:
 *
 *   urgencyBp = 10 000 + ⌊urgencyFactorBp × (maxSlaDays − slaDays) / maxSlaDays⌋
 *   reward    = ⌊volume × basePricePerUnitCents × urgencyBp / 10 000⌋
 *   demurrage = ⌊reward × demurrageBp / 10 000⌋ za každú celú hodinu státia nad `berthAllowanceTicks`
 *   late      = ⌊reward × lateBp / 10 000⌋ za každý celý deň po `slaDeadlineTick`
 *   xpReward  = volume × xpPerUnit × xpMultiplier; pri dokončení round(xpReward × (včas ? 1 : lateXpFactor))
 *
 * Export booking (ADR-032 bod 13–14): výplata pomerne k naloženým `⌊reward × loaded / booked⌋`, penalizácia za `n` jednotiek
 * (last minute, rolled) `⌊reward × bp × n / (10 000 × booked)⌋` (sadzba je podiel odmeny **za jednotku**, jedno zaokrúhlenie
 * nadol), za nesplnený booking `⌊reward × bp / 10 000⌋` raz; splnený je od `⌈bookingFulfilmentShare × booked⌉` naložených.
 *
 * `maxSlaDays` = najväčšie `slaDaysRange[1]` všetkých šablón (nezávisle od tieru — rovnaké SLA má vždy rovnakú urgency).
 */
import type { ContractTemplateDef, EconomyDef } from '../defs/types';
import { BASIS_POINTS, applyBasisPoints, shareOfCents, toBasisPoints } from '../economy/basis-points';

/** Najväčšie `slaDaysRange[1]` cez šablóny (`maxSlaDays` vzorca urgency); bez šablón 0. */
export function maxSlaDaysOf(templates: readonly Readonly<ContractTemplateDef>[]): number {
  let max = 0;
  for (const template of templates) max = Math.max(max, template.slaDaysRange[1]);
  return max;
}

/** Urgency v bázických bodoch (10 000 = bez prirážky); `slaDays` celé 1 … `maxSlaDays`. */
export function urgencyBp(slaDays: number, maxSlaDays: number, urgencyFactor: number): number {
  if (!Number.isSafeInteger(slaDays) || !Number.isSafeInteger(maxSlaDays) || slaDays < 1 || slaDays > maxSlaDays) {
    throw new RangeError(`urgency: SLA musí byť celé 1 … ${String(maxSlaDays)}, dostal ${String(slaDays)}`);
  }
  return BASIS_POINTS + Math.floor((toBasisPoints(urgencyFactor) * (maxSlaDays - slaDays)) / maxSlaDays);
}

/** Odmena v centoch: `⌊volume × pricePerUnitCents × urgencyBp / 10 000⌋`. */
export function contractRewardCents(volumeUnits: number, pricePerUnitCents: number, urgency: number): number {
  const base = volumeUnits * pricePerUnitCents;
  if (!Number.isSafeInteger(base) || base < 0) throw new RangeError(`odmena: objem ${String(volumeUnits)} × cena ${String(pricePerUnitCents)} nie je celé číslo ≥ 0`);
  return applyBasisPoints(base, urgency);
}

/** XP za včasné dokončenie: `volume × xpPerUnit × xpMultiplier`. */
export function contractXpReward(volumeUnits: number, xpPerUnit: number, xpMultiplier: number): number {
  return volumeUnits * xpPerUnit * xpMultiplier;
}

/** XP pripísané pri dokončení: `round(xpReward)` včas, inak `round(xpReward × lateXpFactor)`. */
export function contractXpGain(xpReward: number, onTime: boolean, lateXpFactor: number): number {
  return Math.round(onTime ? xpReward : xpReward * lateXpFactor);
}

/** Demurrage za jednu celú hodinu nad `berthAllowanceTicks`: `⌊reward × demurrageRateOfRewardPerHour⌋` v bp. */
export function demurrageStepCents(rewardCents: number, economy: Pick<EconomyDef, 'demurrageRateOfRewardPerHour'>): number {
  return shareOfCents(rewardCents, economy.demurrageRateOfRewardPerHour);
}

/** Late penalizácia za jeden celý deň po SLA: `⌊reward × latePenaltyRateOfRewardPerDay⌋` v bp. */
export function lateStepCents(rewardCents: number, economy: Pick<EconomyDef, 'latePenaltyRateOfRewardPerDay'>): number {
  return shareOfCents(rewardCents, economy.latePenaltyRateOfRewardPerDay);
}

/** Počet celých období dĺžky `period` od `since` po `now` (záporný rozdiel = 0). */
export function wholePeriods(now: number, since: number, period: number): number {
  return now <= since ? 0 : Math.floor((now - since) / period);
}

/**
 * Tick, v ktorom ponuka skutočne zanikne, ak ju hráč neprijme: prvá uzávierka dňa (násobok `ticksPerDay`) v čase
 * `offerExpiresTick` alebo po ňom — pool sa obnovuje raz denne (ADR-026). Pre prezentáciu (odpočet na karte ponuky).
 */
export function offerClosingTick(offerExpiresTick: number, ticksPerDay: number): number {
  return Math.ceil(offerExpiresTick / ticksPerDay) * ticksPerDay;
}

/** Výplata exportu pomerne k naloženým: `⌊reward × loaded / booked⌋` (`loaded ≤ booked`, celé čísla). */
export function bookingPayoutCents(rewardCents: number, loadedUnits: number, bookedUnits: number): number {
  const product = rewardCents * loadedUnits;
  if (!Number.isSafeInteger(product) || bookedUnits < 1) throw new RangeError(`výplata exportu: ${String(rewardCents)} × ${String(loadedUnits)} / ${String(bookedUnits)} nie je platné`);
  return Math.floor(product / bookedUnits);
}

/**
 * Penalizácia za `units` jednotiek bookingu so sadzbou `rate` (podiel odmeny za jednotku): `⌊reward × bp × units / (10 000 ×
 * booked)⌋`. Súčin mimo bezpečného celého rozsahu alebo neplatný vstup → `RangeError`.
 */
export function bookingUnitsPenaltyCents(rewardCents: number, bookedUnits: number, units: number, rate: number): number {
  const product = rewardCents * toBasisPoints(rate) * units;
  if (!Number.isSafeInteger(product) || bookedUnits < 1) throw new RangeError(`penalizácia exportu: ${String(rewardCents)} × ${String(rate)} × ${String(units)} / ${String(bookedUnits)} nie je platná`);
  return Math.floor(product / (BASIS_POINTS * bookedUnits));
}

/** Penalizácia za nesplnený booking (raz): `⌊reward × unfulfilledBookingRateOfReward⌋` v bp. */
export function unfulfilledBookingPenaltyCents(rewardCents: number, economy: Pick<EconomyDef, 'unfulfilledBookingRateOfReward'>): number {
  return shareOfCents(rewardCents, economy.unfulfilledBookingRateOfReward);
}

/** Najmenší počet naložených jednotiek, od ktorého je booking splnený: `⌈bookingFulfilmentShare × booked⌉` (celé bázické body). */
export function bookingFulfilmentUnits(bookedUnits: number, economy: Pick<EconomyDef, 'bookingFulfilmentShare'>): number {
  return Math.ceil((toBasisPoints(economy.bookingFulfilmentShare) * bookedUnits) / BASIS_POINTS);
}
