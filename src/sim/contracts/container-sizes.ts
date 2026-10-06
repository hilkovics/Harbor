/**
 * Zmes veľkostí kontajnerov kontraktu (ADR-039; docs/tasks/phase-r2.md rozhodnutie 2) — čisté funkcie nad jediným `Rng` sveta.
 *
 * Objem šablóny (`volumeUnitsRange`) je v **TEU**. Pri vzniku ponuky `drawContainerCount` losuje kontajnery jeden po druhom (40′ s pravdepodobnosťou
 * `sizeMix`, ak ešte ostávajú aspoň 2 TEU, inak 20′), kým sa nenaplní cieľové TEU: kontrakt má potom `volumeTeu` = cieľ a `volumeUnits` = počet
 * kontajnerov. Poradie veľkostí kontajnerov kontraktu je deterministická funkcia `unitSizeFt(index, volumeUnits, volumeTeu)` — 40′ sú medzi
 * kontajnermi rozložené rovnomerne (Bresenham), takže save nesie len `volumeTeu` a nič ďalšie. `sizeMix` ≤ 0 (chýba v šablóne) nespotrebuje `Rng`.
 */
import { CONTAINER_SIZES, FEET_PER_TEU, type ContainerSize } from '../cargo/cargo-unit';
import type { Rng } from '../core/rng';

/** TEU 20′ kontajnera (1) a 40′ kontajnera (2). */
const TEU_OF_SMALL = CONTAINER_SIZES[0] / FEET_PER_TEU;
const TEU_OF_LARGE = CONTAINER_SIZES[1] / FEET_PER_TEU;

/**
 * Počet kontajnerov, ktoré dajú presne `volumeTeu` TEU pri zmesi `sizeMix` (podiel 40′). Spotreba `Rng`: jeden `chance` na každý kontajner, ktorému
 * ešte ostávajú aspoň 2 TEU; pri `sizeMix ≤ 0` žiadna (všetky 20′, počet = `volumeTeu`).
 */
export function drawContainerCount(rng: Pick<Rng, 'chance'>, volumeTeu: number, sizeMix: number): number {
  if (!(sizeMix > 0)) return volumeTeu;
  let remaining = volumeTeu;
  let count = 0;
  while (remaining > 0) {
    remaining -= remaining >= TEU_OF_LARGE && rng.chance(sizeMix) ? TEU_OF_LARGE : TEU_OF_SMALL;
    count += 1;
  }
  return count;
}

/** Počet 40′ kontajnerov kontraktu: `volumeTeu − volumeUnits` (každý 40′ je o 1 TEU viac ako kontajner). */
export function largeContainerCount(volumeUnits: number, volumeTeu: number): number {
  return Math.max(0, volumeTeu - volumeUnits);
}

/**
 * Veľkosť `index`-teho kontajnera kontraktu (od 0): 40′ práve vtedy, keď sa `⌊(index + 1) × n40 / N⌋` zvýši oproti predchádzajúcemu indexu
 * (`N` = `volumeUnits`, `n40` = počet 40′). Súčet TEU cez `index = 0 … N − 1` je presne `volumeTeu`; `index` mimo `0 … N − 1` je 20′.
 */
export function unitSizeFt(index: number, volumeUnits: number, volumeTeu: number): ContainerSize {
  const large = largeContainerCount(volumeUnits, volumeTeu);
  if (large === 0 || index < 0 || index >= volumeUnits) return CONTAINER_SIZES[0];
  const isLarge = Math.floor(((index + 1) * large) / volumeUnits) > Math.floor((index * large) / volumeUnits);
  return isLarge ? CONTAINER_SIZES[1] : CONTAINER_SIZES[0];
}
