/**
 * Jazda po oblúku v zákrute (docs/tasks/phase-03.md T03-19, požiadavka 4): čistá geometria bez Pixi.
 *
 * Sim vedie vozidlo po lomenej čiare cez stredy buniek (ADR-019). Zákruta v bunke `K` je teda písmeno L: od stredu hrany,
 * cez stred `K`, k stredu ďalšej hrany. Renderer ju nahrádza oblúkom, ktorý vychádza zo sprite `road_corner.svg`
 * (`M32 0A32 32 0 0 0 64 32`): oblúky majú stred vo vnútornom rohu bunky — v rohu, ktorý ležia obe pripojené strany —
 * a polomery
 *  - 32 px (stred cesty) pre `one_lane` a `one_way` (vozidlo jazdí v strede),
 *  - 19 px pre pravú zákrutu dvojpruhovej cesty (vnútorný pruh: 32 − 13),
 *  - 45 px pre ľavú zákrutu dvojpruhovej cesty (vonkajší pruh: 32 + 13).
 * Oblúk začína aj končí na hrane bunky presne v bode, kde končí priamy pruh susednej bunky (os ± 13 px), takže na hrane
 * nie je skok. Vozidlo tak neprekročí stredovú čiaru (polomer 32): jeho telo (± 13 px od stredu pruhu) leží v pruhu
 * 6…32 px (vpravo) resp. 32…58 px (vľavo).
 *
 * **Parameter oblúka `alpha`** ∈ [0, 1] je podiel dráhy vo vnútri bunky: 0 = hrana, cez ktorú vozidlo vošlo, 0,5 = stred
 * bunky (tam sim mení kurz), 1 = hrana, cez ktorú vyšlo. Uhol spritu sa otáča lineárne z kurzu vstupu na kurz výstupu
 * najkratším oblúkom (±90°). Sim zmenu kurzu robí skokom v strede bunky (`Vehicle.advance`: kurz podľa úseku), preto
 * `alpha` odvádza z polohy vozidla, nie z `prevHeading → heading` (`vehicle-view.ts`, `cornerAlpha`).
 */
import type { Point } from './camera';
import { forwardOf, laneMagnitude, rightOf } from './lane';
import type { RoadKind } from '@sim/grid';
import type { ViewRotation } from './view-models';

/** Bity masky susedov (autotile: N = 1, E = 2, S = 4, W = 8) v poradí kurzov 0°, 90°, 180°, 270° = smer von z bunky. */
const SIDE_BITS: readonly (readonly [ViewRotation, number])[] = [
  [0, 1],
  [90, 2],
  [180, 4],
  [270, 8],
];

/** Kurz normalizovaný do [0, 360). */
export function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Otočenie kurzu `from` → `to` najkratším oblúkom v stupňoch: +90 (pravá zákruta), −90 (ľavá zákruta), 0 (rovnaký
 * kurz) alebo 180 (obrat, oba smery rovnako dlhé). Iná hodnota nemôže nastať (kurzy sú násobky 90°).
 */
export function headingDelta(from: ViewRotation, to: ViewRotation): number {
  const delta = normalizeAngle(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/** Je zmena kurzu `from` → `to` zákruta o 90° (pravá alebo ľavá)? */
export function isQuarterTurn(from: ViewRotation, to: ViewRotation): boolean {
  return Math.abs(headingDelta(from, to)) === 90;
}

/**
 * Kurz medzi `from` a `to` v čase `alpha` najkratším oblúkom (`normalizeAngle`); pri obrate o 180° sa neinterpoluje
 * (smer otáčania je nejednoznačný) a platí `to`. Pre zmenu kurzu v križovatke, kde oblúk nepoznáme.
 */
export function lerpHeading(from: ViewRotation, to: ViewRotation, alpha: number): number {
  const delta = headingDelta(from, to);
  return delta === 180 ? to : normalizeAngle(from + delta * alpha);
}

/** Poloha a uhol vozidla na oblúku; poloha je posun od stredu bunky v bunkách (`x` doprava, `y` nadol). */
export interface ArcPose {
  readonly x: number;
  readonly y: number;
  /** Uhol spritu v stupňoch v smere hodinových ručičiek (0 = predok na sever), [0, 360). */
  readonly angle: number;
}

/**
 * Polomer oblúka v bunkách okolo vnútorného rohu: stred pruhu je od osi cesty o `laneMagnitude(kind)`, os je od rohu
 * o 0,5 bunky — pravá zákruta 0,5 − posun (19/64), ľavá 0,5 + posun (45/64), jednopruhové cesty 0,5 (32/64).
 * Zákruta, ktorá nie je o 90°, je `RangeError`.
 */
export function turnArcRadius(kind: RoadKind, from: ViewRotation, to: ViewRotation): number {
  const delta = headingDelta(from, to);
  if (Math.abs(delta) !== 90) {
    throw new RangeError(`turnArcRadius: zmena kurzu ${String(from)}° → ${String(to)}° nie je zákruta o 90°`);
  }
  return delta > 0 ? 0.5 - laneMagnitude(kind) : 0.5 + laneMagnitude(kind);
}

/**
 * Poloha a uhol vozidla na oblúku zákruty `from` → `to` (kurzy vstupu a výstupu) v čase `alpha` ∈ [0, 1] (viď hlavička).
 * Oblúk má stred vo vnútornom rohu bunky a začína na hrane vstupu v strede pruhu (posun `laneMagnitude(kind)` vpravo od
 * osi), končí na hrane výstupu v strede pruhu. `alpha` mimo [0, 1] sa orezáva. Nealokuje nič okrem výsledku.
 * Zákruta, ktorá nie je o 90° (rovno, obrat), je `RangeError`.
 */
export function turnArcPose(kind: RoadKind, from: ViewRotation, to: ViewRotation, alpha: number): ArcPose {
  const delta = headingDelta(from, to);
  if (Math.abs(delta) !== 90) {
    throw new RangeError(`turnArcPose: zmena kurzu ${String(from)}° → ${String(to)}° nie je zákruta o 90°`);
  }
  const t = Math.min(1, Math.max(0, alpha));
  const dIn = forwardOf(from);
  const dOut = forwardOf(to);
  const rIn = rightOf(from);
  const lane = laneMagnitude(kind);
  // stred oblúka = roh bunky, ktorý ležia hrany vstupu a výstupu (počiatok = stred bunky)
  const centerX = -0.5 * dIn.x + 0.5 * dOut.x;
  const centerY = -0.5 * dIn.y + 0.5 * dOut.y;
  // vektor stredu pruhu na hrane vstupu voči stredu oblúka; ním sa otáča o `delta · t`
  const startX = lane * rIn.x - 0.5 * dOut.x;
  const startY = lane * rIn.y - 0.5 * dOut.y;
  const phi = (delta * t * Math.PI) / 180; // y smeruje nadol: kladný uhol = v smere hodinových ručičiek, ako kurz
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  return {
    x: centerX + startX * cos - startY * sin,
    y: centerY + startX * sin + startY * cos,
    angle: normalizeAngle(from + delta * t),
  };
}

/** Strany, ktorými sa vozidlo pohybuje v zákrute: kurz pri vstupe a pri výstupe. */
export interface CornerTurn {
  readonly from: ViewRotation;
  readonly to: ViewRotation;
}

/**
 * Zákruta bunky s maskou susedov `mask` pre vozidlo idúce kurzom `heading`, alebo `null`, ak bunka nie je zákruta
 * (nemá práve dvoch kolmých susedov). Vozidlo v zákrute je buď na vstupnom úseku (kurz mieri od pripojenej strany
 * dovnútra, výstup je druhá strana), alebo na výstupnom (kurz mieri von cez pripojenú stranu, vstup bol z druhej
 * strany) — z kurzu sa teda vždy určí obe strany.
 */
export function cornerTurn(mask: number, heading: ViewRotation): CornerTurn | null {
  const sides: ViewRotation[] = [];
  for (const [side, bit] of SIDE_BITS) if ((mask & bit) !== 0) sides.push(side);
  if (sides.length !== 2 || !isQuarterTurn(sides[0], sides[1])) return null;
  const opposite = normalizeAngle(heading + 180) as ViewRotation;
  const outIndex = sides.indexOf(heading);
  if (outIndex >= 0) {
    // kurz mieri von cez pripojenú stranu: vozidlo vychádza, prišlo z druhej strany
    const entrySide = sides[1 - outIndex];
    return { from: normalizeAngle(entrySide + 180) as ViewRotation, to: heading };
  }
  const inIndex = sides.indexOf(opposite);
  if (inIndex >= 0) return { from: heading, to: sides[1 - inIndex] };
  return null;
}

/**
 * Parameter oblúka `alpha` pre vozidlo v bunke so stredom `center`, idúce kurzom `heading` do polohy `position`
 * (bunky): 0,5 + priemet posunu od stredu bunky na smer jazdy, orezané na [0, 1]. Sim vedie vozidlo po ose úseku, takže
 * vo vstupnej polovici bunky je hodnota v [0; 0,5] (hrana → stred) a vo výstupnej v [0,5; 1] (stred → hrana).
 */
export function cornerAlpha(position: Point, center: Point, heading: ViewRotation): number {
  const forward = forwardOf(heading);
  const along = (position.x - center.x) * forward.x + (position.y - center.y) * forward.y;
  return Math.min(1, Math.max(0, 0.5 + along));
}
