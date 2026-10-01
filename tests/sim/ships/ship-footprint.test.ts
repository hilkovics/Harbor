// Zabraté bunky lodí (T5B-02, ADR-029): prekryv obdĺžnikov, oblasti a výpočet buniek, ktoré loď zaberie cestou po
// trase (`sweepRoute`) — presný pri osových úsekoch, konzervatívny pri šikmých, s natočením kurzu na začiatku úseku.
import { describe, expect, it } from 'vitest';
import type { Rotation } from '@sim/grid';
import { SWEEP_STEP_CELLS, TrafficArea, areasOverlap, boxHitsArea, boxesOverlap, shipBox, sweepRoute, type CellBox, type ShipPoint } from '@sim/ships';

const FEEDER = { lengthCells: 6, widthCells: 2 };

/** Bunky oblasti ako množina "x,y". */
function cellsOf(area: TrafficArea): Set<string> {
  const cells = new Set<string>();
  for (const box of area.boxes) {
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) cells.add(`${String(x)},${String(y)}`);
  }
  return cells;
}

function cellsOfBox(box: CellBox): string[] {
  const cells: string[] = [];
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) cells.push(`${String(x)},${String(y)}`);
  return cells;
}

describe('prekryv obdĺžnikov a oblastí', () => {
  it('boxesOverlap: spoločná bunka; dotyk hranou nie je prekryv', () => {
    const a: CellBox = { x0: 0, y0: 0, x1: 4, y1: 2 };
    expect(boxesOverlap(a, { x0: 3, y0: 1, x1: 5, y1: 3 })).toBe(true);
    expect(boxesOverlap(a, { x0: 4, y0: 0, x1: 6, y1: 2 })).toBe(false);
    expect(boxesOverlap(a, { x0: 0, y0: 2, x1: 4, y1: 4 })).toBe(false);
  });

  it('TrafficArea: add/clear/size; boxHitsArea a areasOverlap', () => {
    const area = new TrafficArea();
    area.add({ x0: 0, y0: 0, x1: 2, y1: 2 });
    area.add({ x0: 10, y0: 10, x1: 12, y1: 12 });
    expect(area.size).toBe(2);
    expect(boxHitsArea({ x0: 11, y0: 11, x1: 13, y1: 13 }, area)).toBe(true);
    expect(boxHitsArea({ x0: 5, y0: 5, x1: 6, y1: 6 }, area)).toBe(false);
    const other = new TrafficArea();
    other.add({ x0: 1, y0: 1, x1: 3, y1: 3 });
    expect(areasOverlap(area, other)).toBe(true);
    other.clear();
    expect(other.size).toBe(0);
    other.add({ x0: 2, y0: 2, x1: 10, y1: 10 });
    expect(areasOverlap(area, other)).toBe(false);
  });
});

describe('sweepRoute', () => {
  it('prázdna trasa = obdĺžnik v štarte; vráti štartovú pózu', () => {
    const area = new TrafficArea();
    expect(sweepRoute(area, FEEDER, { x: 5.5, y: 5.5, heading: 90 }, [])).toEqual({ x: 5.5, y: 5.5, heading: 90 });
    expect(area.boxes).toEqual([shipBox(FEEDER, 5.5, 5.5, 90)]);
  });

  it('osový úsek: presne obal obdĺžnikov v koncoch; natočenie na začiatku úseku pridá obdĺžnik s novým kurzom', () => {
    const area = new TrafficArea();
    const end = sweepRoute(area, FEEDER, { x: 5.5, y: 5.5, heading: 90 }, [{ x: 5.5, y: 15.5 }]);
    expect(end).toEqual({ x: 5.5, y: 15.5, heading: 180 });
    const turned = shipBox(FEEDER, 5.5, 5.5, 180);
    const arrived = shipBox(FEEDER, 5.5, 15.5, 180);
    expect(area.boxes).toEqual([shipBox(FEEDER, 5.5, 5.5, 90), turned, { x0: turned.x0, y0: turned.y0, x1: arrived.x1, y1: arrived.y1 }]);
  });

  it('pevný kurz bodu (posun bokom): kurz sa nemení podľa smeru úseku', () => {
    const area = new TrafficArea();
    const end = sweepRoute(area, FEEDER, { x: 43, y: 10, heading: 90 }, [{ x: 43, y: 13, heading: 90 }]);
    expect(end.heading).toBe(90);
    // Obal obdĺžnikov v bode priblíženia (y 9–10) a pri kotvisku (y 12–13) = pás x 40–45, y 9–13.
    expect(cellsOf(area)).toEqual(new Set(cellsOfBox({ x0: 40, y0: 9, x1: 46, y1: 14 })));
  });

  it('šikmý úsek: konzervatívny — obsahuje obdĺžnik lode v každej polohe na úseku (hustá kontrola)', () => {
    const area = new TrafficArea();
    const start = { x: 3.25, y: 4.5, heading: 90 as Rotation };
    const target: ShipPoint = { x: 14.75, y: 9.25 };
    sweepRoute(area, FEEDER, start, [target]);
    const cells = cellsOf(area);
    const heading = 90; // |dx| ≥ |dy| → východ
    const samples = 997;
    for (let k = 0; k <= samples; k++) {
      const x = start.x + ((target.x - start.x) * k) / samples;
      const y = start.y + ((target.y - start.y) * k) / samples;
      for (const cell of cellsOfBox(shipBox(FEEDER, x, y, heading))) expect(cells.has(cell), `bunka ${cell} v polohe (${String(x)}, ${String(y)})`).toBe(true);
    }
    expect(SWEEP_STEP_CELLS).toBeGreaterThan(0);
  });
});
