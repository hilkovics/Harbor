import { describe, expect, it } from 'vitest';
import {
  angleOfDirection,
  articulatedPose,
  blendedLaneMagnitude,
  forwardOfAngle,
  pointAlong,
  polylineLength,
  shiftRight,
  trailAt,
} from '@render/articulated-pose';

// R1 / TR1-06: kĺbový nosič po stope — čistá geometria (stred spritu, natočenie podľa tetivy, vlásenka, krátka stopa, interpolácia).

const at = (x: number, y: number) => ({ x, y });

describe('pomocné funkcie', () => {
  it('uhol smeru: sever 0, východ 90, juh 180, západ 270 a opačne dopredu', () => {
    expect(angleOfDirection(0, -1)).toBe(0);
    expect(angleOfDirection(1, 0)).toBe(90);
    expect(angleOfDirection(0, 1)).toBe(180);
    expect(angleOfDirection(-1, 0)).toBe(270);
    for (const angle of [0, 90, 180, 270]) {
      const forward = forwardOfAngle(angle);
      expect(angleOfDirection(forward.x, forward.y)).toBeCloseTo(angle, 9);
    }
  });

  it('dĺžka lomenej čiary a bod vo vzdialenosti; za koncom pokračuje v zadanom smere', () => {
    const line = [at(0, 0), at(2, 0), at(2, 1)];
    expect(polylineLength(line)).toBe(3);
    expect(pointAlong(line, 1, at(0, 0))).toEqual(at(1, 0));
    expect(pointAlong(line, 2.5, at(0, 0))).toEqual(at(2, 0.5));
    expect(pointAlong(line, 0, at(0, 0))).toEqual(at(0, 0));
    expect(pointAlong(line, 4, at(0, 1))).toEqual(at(2, 2)); // 1 bunka za koncom smerom (0; 1)
  });

  it('shiftRight: doprava od smeru jazdy', () => {
    const cases: [number, number, number][] = [
      [0, 5.2, 5],
      [90, 5, 5.2],
      [180, 4.8, 5],
      [270, 5, 4.8],
    ];
    for (const [angle, x, y] of cases) {
      const shifted = shiftRight(at(5, 5), angle, 0.2);
      expect(shifted.x).toBeCloseTo(x, 9);
      expect(shifted.y).toBeCloseTo(y, 9);
    }
    expect(shiftRight(at(5, 5), 90, 0)).toEqual(at(5, 5));
  });
});

describe('articulatedPose', () => {
  it('rovno: kamión (sprite 2 bunky, dĺžka 3) smerom na sever — predok pri hlave, stred o bunku späť, natočenie 0', () => {
    const pose = articulatedPose(at(5.5, 3.5), [at(5.5, 4.5), at(5.5, 5.5)], 3, 2, 0);
    expect(pose.x).toBeCloseTo(5.5, 9);
    expect(pose.y).toBeCloseTo(4.5, 9);
    expect(pose.angle).toBe(0);
    expect(pose.folded).toBe(false);
  });

  it('rovno na východ: stred je západne od hlavy (dozadu po stope)', () => {
    const pose = articulatedPose(at(8.5, 2.5), [at(7.5, 2.5), at(6.5, 2.5)], 3, 2, 90);
    expect(pose.x).toBeCloseTo(7.5, 9);
    expect(pose.y).toBeCloseTo(2.5, 9);
    expect(pose.angle).toBe(90);
  });

  it('jednobunkový sprite (straddle): stred je pol bunky za hlavou', () => {
    const pose = articulatedPose(at(5.5, 3.5), [at(5.5, 4.5)], 2, 1, 0);
    expect(pose.y).toBeCloseTo(4, 9);
  });

  it('zákruta 90°: hlava už v južnom ramene, chvost ešte na východnom — sprite sa láme (tetiva 135°), predok ostáva pri hlave', () => {
    // cesta z východu do rohu (5; 5) a dole na juh: hlava (5,5; 6,5), roh (5,5; 5,5), chvost (4,5; 5,5)
    const pose = articulatedPose(at(5.5, 6.5), [at(5.5, 5.5), at(4.5, 5.5)], 3, 2, 180);
    expect(pose.angle).toBeCloseTo(135, 9); // medzi východom (90°) a juhom (180°)
    expect(pose.folded).toBe(false);
    // predok (stred + dopredu × pol dĺžky) je presne v hlave, stred je o bunku späť v smere natočenia
    const forward = forwardOfAngle(pose.angle);
    expect(pose.x + forward.x).toBeCloseTo(5.5, 9);
    expect(pose.y + forward.y).toBeCloseTo(6.5, 9);
    expect(pose.x).toBeCloseTo(5.5 - Math.SQRT1_2, 9);
    expect(pose.y).toBeCloseTo(6.5 - Math.SQRT1_2, 9);
  });

  it('zákruta 90°: uhol rastie plynulo, keď hlava ide ďalej po výjazde zo zákruty (chvost prechádza rohom)', () => {
    // hlava sa posúva o 0, 0,5, 1, 1,5, 2 za rohom, chvost zatiaľ zostáva na východnom ramene (dĺžka 3)
    const angles = [0, 0.5, 1, 1.5, 2].map((past) => {
      const body = [at(5.5, 5.5), at(4.5, 5.5), at(3.5, 5.5)];
      return articulatedPose(at(5.5, 5.5 + past), body, 4, 2, 180).angle;
    });
    expect(angles[0]).toBeCloseTo(90, 9); // hlava ešte v rohu: rovno na východ
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]); // otáča sa k juhu
    expect(angles[angles.length - 1]).toBeLessThan(180);
    expect(Math.max(...angles.slice(1).map((angle, i) => angle - angles[i]))).toBeLessThan(45); // bez skoku
  });

  it('vlásenka — hlava práve opustila slepú bunku: tetiva ešte ukazuje do slepej bunky (východ), natočenie sa plynule otáča do kurzu hlavy (západ)', () => {
    // slepá cesta po osi x: B (2,5), A (3,5), D (4,5) = slepá bunka; kamión došiel z B do D (východ) a otáča sa naspäť na západ
    const body = [at(4.5, 5.5), at(3.5, 5.5), at(2.5, 5.5)];
    const exact = articulatedPose(at(4.5, 5.5), [at(3.5, 5.5), at(2.5, 5.5)], 4, 2, 270); // hlava presne v slepej bunke, ešte bez zalomenia
    expect(exact.angle).toBeCloseTo(90, 9);
    expect(exact.folded).toBe(false);
    const quarter = articulatedPose(at(4.25, 5.5), body, 4, 2, 270); // 0,25 bunky za zalomením
    const half = articulatedPose(at(4, 5.5), body, 4, 2, 270); //       0,5 bunky: v polovici otáčky
    const full = articulatedPose(at(3.5, 5.5), body, 4, 2, 270); //     bunku za zalomením: v kurze hlavy
    expect(quarter.folded && half.folded && full.folded).toBe(true);
    expect(half.angle).toBeCloseTo(0, 9); // kolmo: sever (východ → sever → západ proti smeru hodinových ručičiek)
    expect(quarter.angle).toBeCloseTo(45, 9);
    expect(full.angle).toBeCloseTo(270, 9);
    expect(quarter.angle).toBeLessThan(exact.angle); // točí sa proti smeru hodinových ručičiek
  });

  it('vlásenka — krátka stopa dvoch buniek: tetiva má nulovú dĺžku, natočenie je z kurzu hlavy a sprite neskáče', () => {
    const pose = articulatedPose(at(3.5, 5.5), [at(4.5, 5.5), at(3.5, 5.5)], 3, 2, 270);
    expect(pose.angle).toBeCloseTo(270, 9);
    expect(pose.x).toBeCloseTo(4.5, 9); // stred na polovici dĺžky po stope: slepá bunka
    expect(pose.y).toBeCloseTo(5.5, 9);
    expect(Number.isFinite(pose.x + pose.y + pose.angle)).toBe(true);
  });

  it('krátka stopa po výjazde z modulu: bez tela je sprite rozvinutý spoza hlavy v smere kurzu', () => {
    const north = articulatedPose(at(5.5, 3.5), [], 3, 2, 0);
    expect(north.x).toBeCloseTo(5.5, 9);
    expect(north.y).toBeCloseTo(4.5, 9);
    expect(north.angle).toBe(0);
    const east = articulatedPose(at(6.5, 3.5), [], 3, 2, 90);
    expect(east.x).toBeCloseTo(5.5, 9);
    expect(east.angle).toBe(90);
  });

  it('krátka stopa po výjazde z modulu: jedna bunka tela — smer z tetivy, zvyšok sprite pokračuje za chvostom', () => {
    // hlava je pol bunky za stredom výjazdovej bunky, ktorá je jediným prvkom tela
    const east = articulatedPose(at(6, 3.5), [at(5.5, 3.5)], 3, 2, 0); // kurz hlavy 0 sa ignoruje: tetiva je spoľahlivá
    expect(east.angle).toBe(90);
    expect(east.x).toBeCloseTo(5, 9); //  1 bunka späť od hlavy: 0,5 po stope a 0,5 za chvostom
    expect(east.y).toBeCloseTo(3.5, 9);
  });

  it('stopa dlhšia než lengthCells nemení smer: tetiva sa berie najďalej po lengthCells', () => {
    // zákruta za chvostom (štvrtá bunka stopy) tetivu neovplyvní: tá končí v (5,5; 6,5), 3 bunky za hlavou
    const pose = articulatedPose(at(5.5, 3.5), [at(5.5, 4.5), at(5.5, 5.5), at(5.5, 6.5), at(4.5, 6.5)], 3, 2, 0);
    expect(pose.angle).toBe(0);
  });
});

describe('blendedLaneMagnitude', () => {
  const magnitudeAt = (cellX: number): number => (cellX < 10 ? 0.2 : 0);
  const at2 = (cellX: number) => magnitudeAt(cellX);

  it('v strede bunky je posun jej typu cesty', () => {
    expect(blendedLaneMagnitude(at(9.5, 5.5), 90, at2)).toBeCloseTo(0.2, 9);
    expect(blendedLaneMagnitude(at(10.5, 5.5), 90, at2)).toBeCloseTo(0, 9);
  });

  it('na hranici dvoch typov cesty je priemer a posun je spojitý z oboch strán (jazda na východ aj na západ)', () => {
    for (const angle of [90, 270]) {
      expect(blendedLaneMagnitude(at(10 - 1e-9, 5.5), angle, at2)).toBeCloseTo(0.1, 6);
      expect(blendedLaneMagnitude(at(10, 5.5), angle, at2)).toBeCloseTo(0.1, 6);
      let previous = blendedLaneMagnitude(at(9, 5.5), angle, at2);
      for (let x = 9; x <= 11; x += 0.05) {
        const value = blendedLaneMagnitude(at(x, 5.5), angle, at2);
        expect(Math.abs(value - previous)).toBeLessThan(0.02);
        previous = value;
      }
    }
  });

  it('pri zvislom smere sa mieša podľa osi y', () => {
    const byY = (_cellX: number, cellY: number): number => (cellY < 4 ? 0.2 : 0);
    expect(blendedLaneMagnitude(at(5.5, 4), 180, byY)).toBeCloseTo(0.1, 6);
  });
});

describe('trailAt', () => {
  it('rovno: hlava je lerp(prev, curr, alpha), stopa nezmenená, ak ju hlava presahuje', () => {
    const body = [at(5.5, 4.5), at(5.5, 5.5)];
    const trail = trailAt(at(5.5, 4.5), at(5.5, 3.5), body, 0.5);
    expect(trail.head).toEqual(at(5.5, 4));
    expect(trail.body).toBe(body);
  });

  it('hlava ešte nedosiahla stred bunky, ktorý aktuálna stopa už obsahuje: ten sa vynechá (čiara necúva)', () => {
    // prev (5,5; 4,7) → curr (5,5; 4,3): stred (5,5; 4,5) je v ceste ticku 0,2 bunky od začiatku
    const body = [at(5.5, 4.5), at(5.5, 5.5)];
    const early = trailAt(at(5.5, 4.7), at(5.5, 4.3), body, 0.25);
    expect(early.head.y).toBeCloseTo(4.6, 9);
    expect(early.body).toEqual([at(5.5, 5.5)]);
    const late = trailAt(at(5.5, 4.7), at(5.5, 4.3), body, 0.75);
    expect(late.body).toBe(body);
  });

  it('hlava prešla stredom zákruty v jednom ticku: ide cez koleno (stred bunky zo stopy), nie po diagonále', () => {
    const body = [at(5.5, 5.5), at(4.5, 5.5)];
    const prev = at(5.3, 5.5);
    const curr = at(5.5, 5.8);
    const atKnee = trailAt(prev, curr, body, 0.4); // 0,2 z 0,5 dráhy = presne koleno
    expect(atKnee.head.x).toBeCloseTo(5.5, 9);
    expect(atKnee.head.y).toBeCloseTo(5.5, 9);
    const before = trailAt(prev, curr, body, 0.2);
    expect(before.head.x).toBeCloseTo(5.4, 9);
    expect(before.head.y).toBeCloseTo(5.5, 9);
    expect(before.body).toEqual([at(4.5, 5.5)]); // koleno hlava ešte nedosiahla
    const after = trailAt(prev, curr, body, 0.8);
    expect(after.head.x).toBeCloseTo(5.5, 9);
    expect(after.head.y).toBeCloseTo(5.7, 9);
    expect(after.body).toBe(body);
  });

  it('bez stopy sa koleno volí podľa kurzu predchádzajúceho úseku', () => {
    const vertical = trailAt(at(5.3, 5.5), at(5.5, 5.8), [], 0.6, true); // najprv zvislo: koleno (5,3; 5,8)
    expect(vertical.head.x).toBeCloseTo(5.3, 9);
    const horizontal = trailAt(at(5.3, 5.5), at(5.5, 5.8), [], 0.6, false); // najprv vodorovne: koleno (5,5; 5,5)
    expect(horizontal.head.y).toBeCloseTo(5.5 + 0.1, 9);
  });

  it('stojaci nosič: hlava na mieste, stopa nezmenená; alpha mimo 0…1 sa orezáva', () => {
    const body = [at(5.5, 4.5)];
    const trail = trailAt(at(5.5, 3.5), at(5.5, 3.5), body, 0.5);
    expect(trail.head).toEqual(at(5.5, 3.5));
    expect(trail.body).toBe(body);
    expect(trailAt(at(1.5, 1.5), at(2.5, 1.5), [], 7).head).toEqual(at(2.5, 1.5));
    expect(trailAt(at(1.5, 1.5), at(2.5, 1.5), [], -3).head).toEqual(at(1.5, 1.5));
  });
});
