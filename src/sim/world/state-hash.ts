/**
 * Odtlačok (hash) stavu sveta (ARCHITECTURE §14, §16; ADR-030 bod 5): FNV-1a 32-bit nad UTF-8 bajtmi
 * `JSON.stringify(world.serialize())`, výsledok 8 malých hex znakov.
 *
 * Slúži na porovnanie dvoch behov (determinizmus, roundtrip save/load uprostred toku): rovnaký stav → rovnaký hash;
 * zmena ľubovoľnej hodnoty v `WorldState` (aj poradia kľúčov či prvkov) → s pravdepodobnosťou 1 − 2⁻³² iný hash.
 * Nie je kryptografický a nepoužíva sa na integritu súboru ani v UI — volajú ho testy a `simrun --hash` /
 * `simrun --roundtrip-at N`.
 *
 * Čistý TS bez `TextEncoder` (hranica `src/sim`, ADR-007): UTF-8 kódovanie po kódových bodoch je tu ručne; `WorldState`
 * je dnes len ASCII, ale hash je definovaný aj pre iné znaky, takže sa zhoduje s FNV-1a nad UTF-8 súborom savu.
 */
import type { World } from './world';
import type { AnyWorldState } from './world-state';

/** FNV-1a 32-bit: počiatočná hodnota (offset basis) a prvočíslo — konštanty algoritmu, nie balans. */
const FNV1A_32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

/** Šírka výstupu: 32 bitov = 8 hex znakov (s nulami na začiatku). */
const HASH_HEX_DIGITS = 8;
const HEX_RADIX = 16;

/** Hranice UTF-8 (počet bajtov kódového bodu) a bitové masky kódovania — štrukturálne konštanty formátu. */
const UTF8_ONE_BYTE_MAX = 0x7f;
const UTF8_TWO_BYTE_MAX = 0x7ff;
const UTF8_THREE_BYTE_MAX = 0xffff;
const UTF8_CONTINUATION = 0x80;
const UTF8_LEAD_TWO = 0xc0;
const UTF8_LEAD_THREE = 0xe0;
const UTF8_LEAD_FOUR = 0xf0;
const UTF8_PAYLOAD_MASK = 0x3f;
const UTF8_PAYLOAD_BITS = 6;
/** Kódový bod nad BMP zaberá v UTF-16 dve jednotky (surrogate pair). */
const SURROGATE_PAIR_UNITS = 2;

/** Jeden krok FNV-1a: `hash ^= byte; hash *= prime` (mod 2³²). */
function mix(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV1A_32_PRIME) >>> 0;
}

/**
 * FNV-1a 32-bit nad UTF-8 bajtmi reťazca → 8 hex znakov. Osamotený surrogate (neplatné UTF-16) sa zakóduje ako
 * trojbajtová sekvencia jeho hodnoty (ako WTF-8); `JSON.stringify` taký znak nevyrobí.
 */
export function fnv1a32Hex(text: string): string {
  let hash = FNV1A_32_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0;
    if (code <= UTF8_ONE_BYTE_MAX) {
      hash = mix(hash, code);
    } else if (code <= UTF8_TWO_BYTE_MAX) {
      hash = mix(hash, UTF8_LEAD_TWO | (code >> UTF8_PAYLOAD_BITS));
      hash = mix(hash, UTF8_CONTINUATION | (code & UTF8_PAYLOAD_MASK));
    } else if (code <= UTF8_THREE_BYTE_MAX) {
      hash = mix(hash, UTF8_LEAD_THREE | (code >> (2 * UTF8_PAYLOAD_BITS)));
      hash = mix(hash, UTF8_CONTINUATION | ((code >> UTF8_PAYLOAD_BITS) & UTF8_PAYLOAD_MASK));
      hash = mix(hash, UTF8_CONTINUATION | (code & UTF8_PAYLOAD_MASK));
    } else {
      hash = mix(hash, UTF8_LEAD_FOUR | (code >> (3 * UTF8_PAYLOAD_BITS)));
      hash = mix(hash, UTF8_CONTINUATION | ((code >> (2 * UTF8_PAYLOAD_BITS)) & UTF8_PAYLOAD_MASK));
      hash = mix(hash, UTF8_CONTINUATION | ((code >> UTF8_PAYLOAD_BITS) & UTF8_PAYLOAD_MASK));
      hash = mix(hash, UTF8_CONTINUATION | (code & UTF8_PAYLOAD_MASK));
      i += SURROGATE_PAIR_UNITS - 1;
    }
  }
  return hash.toString(HEX_RADIX).padStart(HASH_HEX_DIGITS, '0');
}

/**
 * Hash hotového stavu: FNV-1a 32 nad `JSON.stringify(state)` (8 hex znakov). Pre `world.serialize()` aj stav po
 * `JSON.parse` uloženého súboru — poradie kľúčov sa pri `JSON.parse` zachová, takže hash savu = hash sveta, z ktorého
 * vznikol. Stav sa neoveruje ani nemigruje (staršia verzia dá iný hash než jej migrácia).
 */
export function hashWorldState(state: AnyWorldState): string {
  return fnv1a32Hex(JSON.stringify(state));
}

/**
 * Hash aktuálneho stavu sveta = `hashWorldState(world.serialize())`. Svet nemení; neprázdna fronta príkazov → `Error`
 * zo `serialize()` (najprv `applyPending()` alebo `tick()`).
 */
export function stateHash(world: World): string {
  return hashWorldState(world.serialize());
}
