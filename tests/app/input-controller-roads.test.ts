// T03-20: build mód ciest s typmi (dvojpruhová / jednopruhová / jednosmerná): výber typu v BuildBare (`RoadSelection`)
// → správny `PlaceRoad` JSON, `B` spúšťa naposledy použitý typ, smer jednosmerky ťahom a `R`, šípky na ghoste,
// štítok s typom/počtom/cenou a prestavba (cena z `PlaceRoadCommand.quote`).
import { describe, expect, it, vi } from 'vitest';
import { type CellCoord, type Direction4Name, type RoadKind } from '@sim/grid';
import { feedbackText, feedbackIcon, isFundsOnly } from '@app/build-feedback';
import type { BuildFeedback } from '@app/input-controller';
import { DEFAULT_ONE_WAY_DIRECTION } from '@app/config';
import { c, harness, key } from './input-fixtures';
import { setCash } from '../sim/helpers/economy';

/** Riadok 20 v starter parcele (30..57 × 14..33) je pevnina bez ciest → voľné miesto na stavbu. */
const ROW = 20;

type Harness = ReturnType<typeof harness>;

/** Príkazy, ktoré ovládanie odoslalo na most (serializované). */
function spyDispatch(h: Harness): () => unknown[] {
  const spy = vi.spyOn(h.bridge, 'dispatch');
  return () => spy.mock.calls.map(([command]) => command.toJSON());
}

/** Ťah ľavým tlačidlom po zadaných bunkách (pointerdown na prvej, move cez ďalšie, pointerup na poslednej). */
function drag(h: Harness, path: readonly CellCoord[]): void {
  const [first, ...rest] = path;
  h.down(first!);
  for (const cell of rest) h.move(cell);
  h.up(path[path.length - 1]!);
}

const line = (x0: number, x1: number, y = ROW): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => c(x0 + i, y));
const xy = (cells: readonly CellCoord[]) => cells.map(({ x, y }) => ({ x, y }));

/** Bunky sveta s cestou daného typu v riadku (x-ové súradnice). */
function roadsOfKind(h: Harness, kind: RoadKind, y = ROW): number[] {
  const xs: number[] = [];
  for (let x = 0; x < h.world.grid.width; x++) {
    const cell = h.world.grid.at(x, y);
    if (cell.road === 'road' && cell.roadKind === kind) xs.push(x);
  }
  return xs;
}

const costOf = (h: Harness, kind: RoadKind): number => h.world.defs.infrastructure.roadKinds[kind].costPerCellCents;

describe('InputController: výber typu cesty (RoadSelection z BuildBaru)', () => {
  it('bez výberu B zapne mód s predvoleným two_lane a zrkadlí ho do výberu; druhé B mód vypne a výber vynuluje', () => {
    const h = harness();
    expect(h.controller.roadKind).toBe('two_lane');
    expect(h.roadSelection.get()).toBeNull();
    h.controller.keyDown(key('KeyB'));
    expect(h.controller.state).toBe('build');
    expect(h.roadSelection.get()).toBe('two_lane');
    h.controller.keyDown(key('KeyB'));
    expect(h.controller.state).toBe('idle');
    expect(h.roadSelection.get()).toBeNull();
  });

  it('klik na typ v BuildBare zapne build mód ciest s týmto typom (aj z idle bez B)', () => {
    const h = harness();
    h.roadSelection.select('one_lane');
    expect(h.controller.state).toBe('build');
    expect(h.controller.buildMode).toBe(true);
    expect(h.controller.roadKind).toBe('one_lane');
    expect(h.roadSelection.get()).toBe('one_lane');
  });

  it('opakovaný klik (select(null)) mód ukončí; Esc ho ukončí a výber zhasne', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    h.roadSelection.select(null);
    expect(h.controller.state).toBe('idle');

    h.roadSelection.select('one_way');
    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.controller.state).toBe('idle');
    expect(h.roadSelection.get()).toBeNull();
  });

  it('B spustí naposledy použitý typ (aj po Esc)', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    h.controller.keyDown(key('Escape'));
    expect(h.controller.roadKind).toBe('one_way'); // typ ostáva „naposledy použitý“
    h.controller.keyDown(key('KeyB'));
    expect(h.controller.state).toBe('build');
    expect(h.roadSelection.get()).toBe('one_way');
    expect(h.controller.roadKind).toBe('one_way');
  });

  it('zmena typu v aktívnom móde nechá mód zapnutý a zmení typ; ghost/štítok sa prekreslí s novým typom', () => {
    const h = harness();
    h.roadSelection.select('two_lane');
    h.controller.pointerMove(h.at(30, ROW).x, h.at(30, ROW).y);
    expect(h.controller.feedback()).toMatchObject({ kind: 'place', roadKind: 'two_lane', costCents: costOf(h, 'two_lane') });
    h.roadSelection.select('one_lane');
    expect(h.controller.state).toBe('build');
    expect(h.controller.feedback()).toMatchObject({ roadKind: 'one_lane', costCents: costOf(h, 'one_lane') });
  });

  it('výber typu počas ťahu ťah zahodí (nič sa neodošle), mód ostáva s novým typom', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('two_lane');
    h.down(c(30, ROW));
    h.move(c(33, ROW));
    expect(h.controller.state).toBe('build_place');
    h.roadSelection.select('one_way');
    expect(h.controller.state).toBe('build');
    h.up(c(33, ROW));
    h.frame();
    expect(sent()).toEqual([]);
    expect(roadsOfKind(h, 'two_lane')).toEqual([]);
  });

  it('prepnutie z módu modulu na cestu zruší výber modulu; a naopak výber modulu vypne výber cesty', () => {
    const h = harness();
    h.buildSelection.select('berth_standard');
    expect(h.controller.state).toBe('build_module');
    h.roadSelection.select('one_lane');
    expect(h.controller.state).toBe('build');
    expect(h.buildSelection.get()).toBeNull();
    expect(h.roadSelection.get()).toBe('one_lane');

    h.buildSelection.select('container_yard_small');
    expect(h.controller.state).toBe('build_module');
    expect(h.roadSelection.get()).toBeNull();
    expect(h.controller.roadKind).toBe('one_lane'); // posledne použitý typ ostáva
  });

  it('B z módu modulu prepne na cesty naposledy použitého typu', () => {
    const h = harness();
    h.roadSelection.select('one_lane');
    h.buildSelection.select('berth_standard');
    h.controller.keyDown(key('KeyB'));
    expect(h.controller.state).toBe('build');
    expect(h.roadSelection.get()).toBe('one_lane');
    expect(h.buildSelection.get()).toBeNull();
  });

  it('dispose odhlási odber výberu: ďalšia zmena výberu už mód nezapne', () => {
    const h = harness();
    h.controller.dispose();
    h.roadSelection.select('one_way');
    expect(h.controller.state).toBe('idle');
  });
});

describe('InputController: PlaceRoad podľa vybraného typu', () => {
  it('two_lane: JSON s kind two_lane bez dirs, cena z defu', () => {
    const h = harness();
    const sent = spyDispatch(h);
    const cash = h.world.cashCents;
    h.roadSelection.select('two_lane');
    drag(h, line(30, 33));
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy(line(30, 33)), kind: 'two_lane' }]);
    h.frame();
    expect(roadsOfKind(h, 'two_lane')).toEqual([30, 31, 32, 33]);
    expect(h.world.cashCents).toBe(cash - 4 * costOf(h, 'two_lane'));
  });

  it('one_lane: JSON s kind one_lane bez dirs, lacnejšia cena', () => {
    const h = harness();
    const sent = spyDispatch(h);
    const cash = h.world.cashCents;
    h.roadSelection.select('one_lane');
    drag(h, line(30, 32));
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy(line(30, 32)), kind: 'one_lane' }]);
    h.frame();
    expect(roadsOfKind(h, 'one_lane')).toEqual([30, 31, 32]);
    expect(h.world.cashCents).toBe(cash - 3 * costOf(h, 'one_lane'));
    expect(costOf(h, 'one_lane')).toBeLessThan(costOf(h, 'two_lane'));
  });

  it('one_way rovno: dirs = smer ťahu pre každú bunku; svet má roadKind one_way a roadDir', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    drag(h, line(30, 33));
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy(line(30, 33)), kind: 'one_way', dirs: ['E', 'E', 'E', 'E'] }]);
    h.frame();
    expect(roadsOfKind(h, 'one_way')).toEqual([30, 31, 32, 33]);
    for (let x = 30; x <= 33; x++) expect(h.world.grid.at(x, ROW).roadDir).toBe('E');
  });

  it('one_way v protismere (na západ): smery W', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    drag(h, [c(33, ROW), c(32, ROW), c(31, ROW)]);
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy([c(33, ROW), c(32, ROW), c(31, ROW)]), kind: 'one_way', dirs: ['W', 'W', 'W'] }]);
  });

  it('one_way v rohu: bunka v rohu smeruje do ďalšej, posledná zdedí smer', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    const path = [c(30, ROW), c(31, ROW), c(32, ROW), c(32, ROW + 1), c(32, ROW + 2)];
    drag(h, path);
    h.frame();
    expect([30, 31, 32].map((x) => h.world.grid.at(x, ROW).roadDir)).toEqual(['E', 'E', 'S']);
    expect([ROW + 1, ROW + 2].map((y) => h.world.grid.at(32, y).roadDir)).toEqual(['S', 'S']);
  });

  it('one_way U-otočka: smery E, S, W a posledná W', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    const path = [c(30, ROW), c(31, ROW), c(31, ROW + 1), c(30, ROW + 1)];
    drag(h, path);
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy(path), kind: 'one_way', dirs: ['E', 'S', 'W', 'W'] }]);
  });

  it('ťah, ktorý sa vrátil cez zbrané bunky, jednosmerku neodmietne (smer sa zdedí, príkaz je platný)', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    drag(h, [c(30, ROW), c(31, ROW), c(32, ROW), c(31, ROW), c(31, ROW + 1)]);
    const [command] = sent() as Array<{ cells: unknown[]; dirs: string[] }>;
    expect(command?.cells).toHaveLength(4);
    expect(command?.dirs).toHaveLength(4);
    h.frame();
    expect(h.world.grid.at(31, ROW + 1).roadKind).toBe('one_way');
  });

  it('nikdy sa neodošle nič bez validácie: neplatná bunka (voda) odmietne celý ťah jednosmerky', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    drag(h, [c(44, 12), c(44, 13), c(44, 14)]); // voda, potom nábrežie
    expect(sent()).toEqual([]);
  });
});

describe('InputController: smer jednosmerky pre 1-bunkový ťah a R', () => {
  it('predvolený smer je východ a 1-bunkový ťah pošle dirs [E]', () => {
    const h = harness();
    const sent = spyDispatch(h);
    expect(h.controller.oneWayDirection).toBe(DEFAULT_ONE_WAY_DIRECTION);
    expect(DEFAULT_ONE_WAY_DIRECTION).toBe('E');
    h.roadSelection.select('one_way');
    drag(h, [c(30, ROW)]);
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: [{ x: 30, y: ROW }], kind: 'one_way', dirs: ['E'] }]);
  });

  it('R otáča smer v poradí E → S → W → N → E a vracia true (spracované)', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    const seen: Direction4Name[] = [];
    for (let i = 0; i < 4; i++) {
      expect(h.controller.keyDown(key('KeyR'))).toBe(true);
      seen.push(h.controller.oneWayDirection);
    }
    expect(seen).toEqual(['S', 'W', 'N', 'E']);
  });

  it('R pred 1-bunkovým ťahom nastaví jeho smer (dirs a svet); ghost ukazuje šípku aktuálneho smeru', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    h.controller.keyDown(key('KeyR')); // E → S
    const p = h.at(30, ROW);
    h.controller.pointerMove(p.x, p.y);
    expect(h.arrows.arrows).toEqual([{ x: 30, y: ROW, dir: 'S' }]);
    expect(h.controller.feedback()).toMatchObject({ roadKind: 'one_way', direction: 'S', rotatable: true });
    h.controller.keyDown(key('KeyR')); // S → W
    expect(h.arrows.arrows).toEqual([{ x: 30, y: ROW, dir: 'W' }]);
    drag(h, [c(30, ROW)]);
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: [{ x: 30, y: ROW }], kind: 'one_way', dirs: ['W'] }]);
    h.frame();
    expect(h.world.grid.at(30, ROW).roadDir).toBe('W');
  });

  it('po ťahu jednosmerky je smer pre 1-bunkový ťah posledný smer ťahu (N)', () => {
    const h = harness();
    const sent = spyDispatch(h);
    h.roadSelection.select('one_way');
    drag(h, [c(40, ROW + 4), c(40, ROW + 3), c(40, ROW + 2)]); // na sever
    expect(h.controller.oneWayDirection).toBe('N');
    drag(h, [c(35, ROW)]);
    expect(sent()[1]).toEqual({ type: 'PlaceRoad', cells: [{ x: 35, y: ROW }], kind: 'one_way', dirs: ['N'] });
  });

  it('zrušený ťah (Esc) smer nezmení', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    h.down(c(30, ROW));
    h.move(c(30, ROW + 2)); // ťah na juh by po pustení nastavil smer S
    h.controller.keyDown(key('Escape'));
    h.up(c(30, ROW + 2)); // pustenie po Esc sa ignoruje
    expect(h.controller.oneWayDirection).toBe('E');
  });

  it('R mimo jednosmerky nič nerobí: dvojpruhová/jednopruhová cesta a idle (nespracované), smer ostáva', () => {
    const h = harness();
    expect(h.controller.keyDown(key('KeyR'))).toBe(false); // idle
    h.roadSelection.select('two_lane');
    expect(h.controller.keyDown(key('KeyR'))).toBe(false);
    h.roadSelection.select('one_lane');
    expect(h.controller.keyDown(key('KeyR'))).toBe(false);
    expect(h.controller.oneWayDirection).toBe('E');
  });

  it('R v móde modulu stále otáča modul, smer jednosmerky sa nemení', () => {
    const h = harness();
    h.buildSelection.select('berth_standard');
    expect(h.controller.keyDown(key('KeyR'))).toBe(true);
    expect(h.controller.rotation).toBe(90);
    expect(h.controller.oneWayDirection).toBe('E');
  });

  it('opakovaný R (auto-repeat) sa spracuje ako príkaz len v móde jednosmerky', () => {
    const h = harness();
    expect(h.controller.keyDown(key('KeyR', { repeat: true }))).toBe(false);
    h.roadSelection.select('one_way');
    expect(h.controller.keyDown(key('KeyR', { repeat: true }))).toBe(true);
    expect(h.controller.oneWayDirection).toBe('E'); // repeat nerotuje, len sa pohltí
  });
});

describe('InputController: ghost jednosmerky — šípky a štítok', () => {
  it('počas ťahu dostane každá bunka šípku podľa dirs; po pustení šípky zmiznú', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    h.down(c(30, ROW));
    h.move(c(31, ROW));
    h.move(c(31, ROW + 1));
    expect(h.arrows.arrows).toEqual([
      { x: 30, y: ROW, dir: 'E' },
      { x: 31, y: ROW, dir: 'S' },
      { x: 31, y: ROW + 1, dir: 'S' },
    ]);
    expect(h.ghost.cells).toHaveLength(3);
    h.controller.keyDown(key('Escape'));
    h.controller.pointerLeave();
    expect(h.arrows.arrows).toBeNull();
  });

  it('dvojpruhová ani jednopruhová cesta šípky nemá; prepnutie z jednosmerky ich skryje', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    const p = h.at(30, ROW);
    h.controller.pointerMove(p.x, p.y);
    expect(h.arrows.arrows).toHaveLength(1);
    h.roadSelection.select('one_lane');
    expect(h.arrows.arrows).toBeNull();
    h.roadSelection.select('two_lane');
    expect(h.arrows.arrows).toBeNull();
  });

  it('šípky zmiznú aj pri odchode z módu ciest (Esc)', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    const p = h.at(30, ROW);
    h.controller.pointerMove(p.x, p.y);
    expect(h.arrows.arrows).not.toBeNull();
    h.controller.keyDown(key('Escape'));
    expect(h.arrows.arrows).toBeNull();
  });

  it('odstraňovanie (pravé tlačidlo) šípky nemá', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    h.down(c(30, ROW), 2);
    expect(h.controller.feedback()?.kind).toBe('remove');
    expect(h.arrows.arrows).toBeNull();
  });

  it('štítok: typ, počet buniek, cena a smer; 1 bunka navyše s nápovedou R', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    const p = h.at(30, ROW);
    h.controller.pointerMove(p.x, p.y);
    const hover = h.controller.feedback();
    expect(hover && feedbackText(hover)).toBe('Jednosmerná cesta · 1 bunka · $1,500 · → východ (R otočí)');
    h.down(c(30, ROW));
    h.move(c(33, ROW));
    const stroke = h.controller.feedback();
    expect(stroke && feedbackText(stroke)).toBe('Jednosmerná cesta · 4 bunky · $6,000 · → východ');
    expect(stroke?.rotatable).toBe(false);
    expect(stroke && feedbackIcon(stroke)).toBe('ic_road');
  });

  it('štítok dvojpruhovej a jednopruhovej cesty: názov typu, počet buniek, cena', () => {
    const h = harness();
    h.roadSelection.select('two_lane');
    h.down(c(30, ROW));
    h.move(c(34, ROW));
    expect(feedbackText(h.controller.feedback()!)).toBe('Cesta dvojpruhová · 5 buniek · $10,000');
    h.controller.keyDown(key('Escape'));
    h.roadSelection.select('one_lane');
    h.down(c(30, ROW));
    h.move(c(34, ROW));
    expect(feedbackText(h.controller.feedback()!)).toBe('Cesta jednopruhová · 5 buniek · $6,000');
  });
});

describe('InputController: prestavba typu cesty (cena z quote)', () => {
  /** Postaví dvojpruhovú cestu 30..32 a vráti hotovosť po stavbe. */
  function withTwoLane(): Harness {
    const h = harness();
    h.roadSelection.select('two_lane');
    drag(h, line(30, 32));
    h.frame();
    h.controller.keyDown(key('Escape'));
    return h;
  }

  it('dvojpruhová → jednopruhová: štítok „Prestavba: stavba, vrátené refundácia“; cena a svet podľa quote', () => {
    const h = withTwoLane();
    const sent = spyDispatch(h);
    const cash = h.world.cashCents;
    h.roadSelection.select('one_lane');
    h.down(c(30, ROW));
    h.move(c(32, ROW));
    const build = 3 * costOf(h, 'one_lane');
    const refund = Math.floor((3 * costOf(h, 'two_lane') * h.world.defs.economy.removalRefundRate * 10_000) / 10_000);
    expect(refund).toBeGreaterThan(0);
    const feedback = h.controller.feedback();
    expect(feedback).toMatchObject({ ok: true, cellCount: 3, buildCents: build, refundCents: refund, costCents: build - refund });
    expect(feedback && feedbackText(feedback)).toBe('Cesta jednopruhová · 3 bunky · Prestavba: $3,600, vrátené $3,000 (čisto $600)');
    expect(h.ghost.cells.every((cell) => cell.valid)).toBe(true);

    h.up(c(32, ROW));
    expect(sent()).toEqual([{ type: 'PlaceRoad', cells: xy(line(30, 32)), kind: 'one_lane' }]);
    h.frame();
    expect(roadsOfKind(h, 'one_lane')).toEqual([30, 31, 32]);
    expect(h.world.cashCents).toBe(cash - (build - refund));
  });

  it('dvojpruhová → jednosmerná: dirs z ťahu, čistá cena = stavba − refundácia', () => {
    const h = withTwoLane();
    const cash = h.world.cashCents;
    h.roadSelection.select('one_way');
    drag(h, line(30, 32));
    h.frame();
    expect([30, 31, 32].map((x) => [h.world.grid.at(x, ROW).roadKind, h.world.grid.at(x, ROW).roadDir])).toEqual([
      ['one_way', 'E'],
      ['one_way', 'E'],
      ['one_way', 'E'],
    ]);
    expect(h.world.cashCents).toBe(cash - (3 * costOf(h, 'one_way') - 3 * costOf(h, 'two_lane') * 0.5));
  });

  it('ten istý typ na existujúcu cestu je „nič na zmenu“: hover ghost aj štítok zmiznú, ťah sa neodošle', () => {
    const h = withTwoLane();
    const sent = spyDispatch(h);
    h.roadSelection.select('two_lane');
    const p = h.at(31, ROW);
    h.controller.pointerMove(p.x, p.y);
    expect(h.controller.feedback()).toBeNull();
    drag(h, line(30, 32));
    expect(sent()).toEqual([]);
  });

  it('jednosmerka s iným smerom je prestavba (R zobrazí cenu); rovnaký smer je „nič na zmenu“', () => {
    const h = harness();
    h.roadSelection.select('one_way');
    drag(h, [c(30, ROW)]); // smer E
    h.frame();
    const p = h.at(30, ROW);
    h.controller.pointerMove(p.x, p.y);
    expect(h.controller.feedback()).toBeNull(); // rovnaký typ aj smer
    h.controller.keyDown(key('KeyR')); // E → S
    expect(h.controller.feedback()).toMatchObject({ ok: true, refundCents: 75_000, buildCents: 150_000, costCents: 75_000, cellCount: 1 });
  });

  it('prestavba bez peňazí: zelený ghost, ikona $, ťah sa neodošle', () => {
    const h = withTwoLane();
    const sent = spyDispatch(h);
    setCash(h.world, 0); // stavba 3 × $1,500 − refund $3,000 = $1,500 > 0
    h.roadSelection.select('one_way');
    h.down(c(30, ROW));
    h.move(c(32, ROW));
    const feedback = h.controller.feedback()!;
    expect(feedback).toMatchObject({ ok: false, reasons: ['insufficient_funds'], fundsShort: true });
    expect(isFundsOnly(feedback)).toBe(true);
    expect(feedbackIcon(feedback)).toBe('ic_cash');
    expect(feedbackText(feedback)).toContain('Nedostatok peňazí');
    expect(h.ghost.cells.every((cell) => cell.valid)).toBe(true);
    h.up(c(32, ROW));
    expect(sent()).toEqual([]);
  });
});

describe('feedbackText: cena ťahu cesty', () => {
  const base: BuildFeedback = { kind: 'place', ok: true, reasons: [], costCents: 0, cellCount: 3, x: 0, y: 0, dragging: true };

  it('záporná čistá cena prestavby sa zobrazí ako príjem so znamienkom', () => {
    const feedback: BuildFeedback = { ...base, roadKind: 'one_lane', costCents: -50_000, buildCents: 100_000, refundCents: 150_000 };
    expect(feedbackText(feedback)).toBe('Cesta jednopruhová · 3 bunky · Prestavba: $1,000, vrátené $1,500 (príjem +$500)');
  });

  it('bez refundácie je to obyčajná cena; bez typu ostáva pôvodné „Cesta“', () => {
    expect(feedbackText({ ...base, costCents: 600_000 })).toBe('Cesta · 3 bunky · $6,000');
    expect(feedbackText({ ...base, roadKind: 'two_lane', costCents: 600_000, buildCents: 600_000, refundCents: 0 })).toBe('Cesta dvojpruhová · 3 bunky · $6,000');
  });

  it('odmietnutý ťah ukáže len dôvody', () => {
    expect(feedbackText({ ...base, ok: false, reasons: ['terrain', 'occupied'], roadKind: 'one_way' })).toBe('Nevhodný terén · Obsadené');
  });

  it('nedostatok peňazí: štítok má typ, počet, cenu aj dôvod', () => {
    const feedback: BuildFeedback = { ...base, ok: false, reasons: ['insufficient_funds'], fundsShort: true, roadKind: 'two_lane', costCents: 600_000, buildCents: 600_000, refundCents: 0 };
    expect(feedbackText(feedback)).toBe('Cesta dvojpruhová · 3 bunky · $6,000 · Nedostatok peňazí');
  });
});
