/**
 * Mierka sveta (F5b č. 10, rozhodnutie používateľa: realistická mierka, pruhy ostávajú) — **jediné miesto**, z ktorého sa
 * odvodzujú rozmery kontajnera a vozidiel v rendereri. Tabuľka mierok celej hry je v `docs/DESIGN_BRIEF.md` §4.1.
 *
 * Referencia: 1 bunka (64 px) ≈ `METERS_PER_CELL` = 6 m, teda 1 m ≈ 10,67 px.
 *  - **Kontajner TEU** (20 ft ≈ 6,06 × 2,44 m) = 64 × 26 px (1 bunka × 0,41 bunky); rovnaký na aprone, pod žeriavom, na doku
 *    rampy, v návese kamióna aj v straddle carrieri (`cargoSizePx`, `cargo-sprite.ts`). Sprite `cargo.container_teu` je
 *    nakreslený 64 × 32 px, renderer ho zmenší na šírku 26 px na jednom mieste (`TEU_PX`).
 *  - **Kamión** (ťahač + podvozok 20 ft ≈ 11 m): 28 × 116 px v plátne 64 × 128 (footprint 1 × 2), kontajner v návese 64 × 26.
 *  - **Straddle carrier** obkročí jeden kontajner: 34 px široký (kontajner 26 + nohy), ~62 px dlhý v plátne 64 × 64 (footprint 1 × 1).
 * Sprity vozidiel sú nakreslené v tejto mierke (`VEHICLE_SCALE` = 1 voči súboru), `tests/render/world-scale.test.ts` porovnáva
 * rozmery v SVG s týmito konštantami. Šírka pruhu a posun vozidla v ňom sú v `lane.ts` (z asfaltu sprite `road_*`).
 *
 * Bez importov mimo manifestu, aby ju mohli používať `entity-assets`, `cargo-sprite`, `lane` aj `narrow-road` bez cyklov.
 */
import { cellPx as manifestCellPx } from '../../assets/manifest.json';

/** Koľko metrov zodpovedá jednej bunke (6 m). */
export const METERS_PER_CELL = 6;

/** Pixely zdroja (bunka manifestu = 64 px) na meter: ≈ 10,67. */
export const PX_PER_METER: number = manifestCellPx / METERS_PER_CELL;

/** Meter → px zdroja (zaokrúhlené na celé px, ako sú nakreslené sprity). */
export function metersToPx(meters: number): number {
  return Math.round(meters * PX_PER_METER);
}

/** 20 ft kontajner: dĺžka 6,06 m zaokrúhlená na bunku (6 m) a šírka 2,44 m. */
export const TEU_LENGTH_M = 6;
export const TEU_WIDTH_M = 2.44;

/** Kontajner TEU v px zdroja (dlhšia strana pozdĺž x pri rot 0): 64 × 26. */
export const TEU_PX: { readonly w: number; readonly h: number } = Object.freeze({ w: metersToPx(TEU_LENGTH_M), h: metersToPx(TEU_WIDTH_M) });

/** Kamión s kontajnerovým návesom: šírka ~2,6 m a dĺžka ~10,9 m (ťahač + podvozok 20 ft, footprint 1 × 2). */
export const TRUCK_WIDTH_M = 2.6;
export const TRUCK_LENGTH_M = 10.9;
export const TRUCK_WIDTH_PX = metersToPx(TRUCK_WIDTH_M);
export const TRUCK_LENGTH_PX = metersToPx(TRUCK_LENGTH_M);

/** Straddle carrier: šírka ~3,2 m (kontajner 2,44 m + nohy), dĺžka ~5,8 m (plátno 64 px je dlhšie, kontajner sa kreslí cez rám). */
export const CARRIER_WIDTH_M = 3.2;
export const CARRIER_LENGTH_M = 5.8;
export const CARRIER_WIDTH_PX = metersToPx(CARRIER_WIDTH_M);
export const CARRIER_LENGTH_PX = metersToPx(CARRIER_LENGTH_M);

/**
 * Telo straddle carriera v novom sprite (TR1-06b, Claude Design): 52 × 102 px v plátne 64 × 128 (footprint 1 × 2, priehľadný stred).
 * `CARRIER_*` zostávajú pre šírku pruhu na ceste (`lane.ts`); toto je rozmer pre brzdové svetlá a fallback.
 */
export const STRADDLE_BODY_PX: { readonly w: number; readonly h: number } = Object.freeze({ w: 52, h: 102 });

/**
 * Mierka spritov vozidiel a kamiónov voči súboru (manifest `entities.<def>.footprint` × 64 px × mierka): 1 = sprite v pôvodnej
 * veľkosti. Sprity sú nakreslené v reálnej mierke (kamión 28 px v plátne 64 px), preto sa neškálujú.
 */
export const VEHICLE_SCALE = 1;

/** Šírka najširšieho vozidla (carrier) po mierke, px zdroja. */
export const VEHICLE_WIDTH_PX = Math.max(TRUCK_WIDTH_PX, CARRIER_WIDTH_PX) * VEHICLE_SCALE;
