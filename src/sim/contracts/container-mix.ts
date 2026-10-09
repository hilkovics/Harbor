/**
 * Zmes typov kontajnerov kontraktu (R5, ADR-042; docs/TERMINAL_2.md §3.2) — čisté funkcie nad jediným `Rng` sveta, vedľa zmesi veľkostí (`container-sizes.ts`).
 *
 * Pri vzniku ponuky `drawUnitTypes` losuje typ každého kontajnera (jedno číslo `Rng` na kontajner, keď má šablóna `typeMix`; bez neho žiadna spotreba): podiely
 * typov podľa `typeMix`, zvyšok je `dry`; typ, ktorý veľkosť kontajnera nepozná (tank len 20′), sa pre kontajner preskočí (jeho podiel pripadne `dry`). Výsledok je pole
 * typov podľa poradia kontajnerov kontraktu (`Contract.unitContainerType(index)`), ukladá sa do save; samé `dry` = prázdne pole. Typy s napájaním (reefer) sa losujú
 * len v svete s blokom so zásuvkami (`poweredSupply`) — inak by loď s reeferom nemala kde vykladať — a bez nich sa `Rng` nespotrebuje.
 * Odmena: `rateTeu` = Σ TEU × `rateMultiplier` typu; pri samých `dry` presne `volumeTeu` (odmena ostáva bitovo rovnaká).
 */
import { DEFAULT_CONTAINER_TYPE, FEET_PER_TEU } from '../cargo/cargo-unit';
import type { Rng } from '../core/rng';
import type { Catalog } from '../defs/catalog';
import type { ContainerTypeDef, ContractTypeShare } from '../defs/types';
import { unitSizeFt } from './container-sizes';

/** Typ `index`-tého kontajnera z poľa typov kontraktu (chýbajúce / prázdne pole = `dry`). */
export function unitTypeAt(unitTypes: readonly string[], index: number): string {
  return unitTypes[index] ?? DEFAULT_CONTAINER_TYPE;
}

/**
 * Typy kontajnerov kontraktu (viď hlavička súboru): `volumeUnits` kontajnerov s veľkosťami `unitSizeFt`; `mix` bez prvkov → `[]` bez spotreby `Rng`.
 * `poweredSupply = false` vyradí typy s `needsPower` (ich podiel pripadne `dry`); ak z zmesi nič nezostane, `Rng` sa nespotrebuje.
 */
export function drawUnitTypes(
  rng: Pick<Rng, 'next'>,
  volumeUnits: number,
  volumeTeu: number,
  mix: readonly ContractTypeShare[] | undefined,
  types: Catalog<Readonly<ContainerTypeDef>>,
  poweredSupply: boolean,
): readonly string[] {
  // Typy s napájaním bez bloku so zásuvkami sa vyradia pred losovaním; zmes, z ktorej nezostane nič, nespotrebuje `Rng` (svet bez reeferov ostáva bitovo rovnaký).
  const active = mix?.filter((entry) => poweredSupply || !types.get(entry.type).needsPower) ?? [];
  if (active.length === 0) return [];
  const result: string[] = [];
  let anySpecial = false;
  for (let index = 0; index < volumeUnits; index++) {
    const size = unitSizeFt(index, volumeUnits, volumeTeu);
    const roll = rng.next();
    let cumulative = 0;
    let picked = DEFAULT_CONTAINER_TYPE;
    for (const entry of active) {
      cumulative += entry.share;
      if (roll >= cumulative) continue;
      const def = types.get(entry.type);
      if (def.sizes.includes(size) && (poweredSupply || !def.needsPower)) picked = entry.type;
      break;
    }
    anySpecial ||= picked !== DEFAULT_CONTAINER_TYPE;
    result.push(picked);
  }
  return anySpecial ? result : [];
}

/**
 * OOG jednotky kontraktu (R5, ADR-042 TR5-02): indexy kontajnerov (vzostupne), ktorým `Rng` pridelí nadrozmer. Každá jednotka typu s `oogChance > 0` dostane jedno číslo `Rng`
 * (`< oogChance` = OOG); len keď má prístav OOG plochu (`oogSupply`) — inak sa `Rng` nespotrebuje a svet bez OOG plochy ostáva bitovo rovnaký. Prázdne pole = žiadne OOG.
 */
export function drawOogUnits(rng: Pick<Rng, 'next'>, unitTypes: readonly string[], types: Catalog<Readonly<ContainerTypeDef>>, oogSupply: boolean): readonly number[] {
  if (!oogSupply) return [];
  const result: number[] = [];
  unitTypes.forEach((type, index) => {
    const chance = types.get(type).oogChance;
    if (chance > 0 && rng.next() < chance) result.push(index);
  });
  return result;
}

/** Efektívne TEU kontraktu pre odmenu: Σ TEU kontajnera × `rateMultiplier` jeho typu (pole typov prázdne = `volumeTeu`). Zaokrúhlené na celé číslo. */
export function rateTeuOf(unitTypes: readonly string[], volumeUnits: number, volumeTeu: number, types: Catalog<Readonly<ContainerTypeDef>>): number {
  if (unitTypes.length === 0) return volumeTeu;
  let total = 0;
  for (let index = 0; index < volumeUnits; index++) {
    total += (unitSizeFt(index, volumeUnits, volumeTeu) / FEET_PER_TEU) * types.get(unitTypeAt(unitTypes, index)).rateMultiplier;
  }
  return Math.round(total);
}
