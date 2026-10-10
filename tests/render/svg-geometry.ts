// Geometria sprite z textu SVG pre testy mierky (F5b č. 10): obdĺžniky s obrysom, vonkajší rozsah obsahu a viewBox.
import { readFileSync } from 'node:fs';

export function readAsset(path: string): string {
  return readFileSync(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
}

/** `<rect>` s výplňou; súradnice v px zdroja, `stroke` = hrúbka obrysu (0 bez obrysu). */
export interface SvgRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
  readonly stroke: number;
}

/** Všetky `<rect x y width height fill [stroke-width]>` z SVG (sprity entít ich majú v tomto poradí atribútov). */
export function svgRects(svg: string): SvgRect[] {
  const pattern = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"([^>]*)>/g;
  return [...svg.matchAll(pattern)].map((match) => {
    const stroke = /stroke-width="([\d.]+)"/.exec(match[6]);
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      fill: match[5].toUpperCase(),
      stroke: stroke === null ? 0 : Number(stroke[1]),
    };
  });
}

/** Vonkajšie hrany obdĺžnika vrátane polovice obrysu na každej strane. */
export function outer(rect: SvgRect): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const half = rect.stroke / 2;
  const left = rect.x - half;
  const top = rect.y - half;
  return { left, right: rect.x + rect.width + half, top, bottom: rect.y + rect.height + half, width: rect.width + rect.stroke, height: rect.height + rect.stroke };
}

/** Vonkajší rozsah obsahu všetkých obdĺžnikov (šírka, dĺžka, stred). */
export function contentExtent(svg: string): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const boxes = svgRects(svg).map(outer);
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.right));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function viewBox(svg: string): { w: number; h: number } {
  const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (match === null) throw new Error('SVG bez viewBox');
  return { w: Number(match[1]), h: Number(match[2]) };
}
