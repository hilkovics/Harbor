import { describe, expect, it, vi } from 'vitest';
import { PlaceModuleCommand, PlaceRoadCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { feedbackText } from '@app/build-feedback';
import { CLICK_SLOP_PX } from '@app/config';
import { InputController } from '@app/input-controller';
import { FakeGhost, c, harness, key } from './input-fixtures';
import { setCash } from '../sim/helpers/economy';

// T02-10: build mód modulov (ghost, R, umiestnenie, Esc / pravý klik) a výber modulu klikom (inšpektor).
// Root berth = id 1 (x 40–47, y 14–16), Root žeriav = id 2 (x 43–44, y 14–16). Berth 8×3: bunka pod kurzorom je jeho
// stredom, teda kurzor (52, 15) = ľavý horný roh (48, 14) — voľné nábrežie starter parcely.

const BERTH = 'berth_standard';
const CRANE = 'crane_container_gantry';
const BERTH_COST = 40_000_000;
/** Kurzor, pri ktorom leží ghost kotviska s ľavým horným rohom (48, 14). */
const AT_FREE_QUAY = c(52, 15);
/** Pevnina ďaleko od vody (starter parcela). */
const INLAND = c(35, 25);

const modules = (h: ReturnType<typeof harness>): number => h.world.modules.size;

describe('build mód modulov: vstup a výstup', () => {
  it('výber v BuildBare zapne build_module; ghost sleduje kurzor a je vycentrovaný (bunka pod kurzorom = stred)', () => {
    const h = harness();
    expect(h.controller.state).toBe('idle');
    h.buildSelection.select(BERTH);
    expect(h.controller.state).toBe('build_module');
    expect(h.controller.buildMode).toBe(true);
    expect(h.controller.selectedDefId).toBe(BERTH);
    expect(h.moduleGhost.ghost).toBeNull(); // kurzor ešte nie je nad mapou

    h.move(AT_FREE_QUAY);
    expect(h.moduleGhost.ghost).toMatchObject({ defId: BERTH, x: 48, y: 14, w: 8, h: 3, rotation: 0, valid: true });
    expect(h.moduleGhost.ghost?.connectors).toEqual([
      { x: 49, y: 16, side: 's' },
      { x: 54, y: 16, side: 's' },
    ]);
    expect(h.controller.moduleGhost()).toBe(h.moduleGhost.ghost);

    h.move(c(53, 16));
    expect(h.moduleGhost.ghost).toMatchObject({ x: 49, y: 15 });
  });

  it('feedback ghostu ukáže názov, cenu a stav; text „Kotvisko · $400,000“', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    const feedback = h.controller.feedback();
    expect(feedback).toMatchObject({
      kind: 'module',
      ok: true,
      reasons: [],
      costCents: BERTH_COST,
      cellCount: 24,
      label: 'Kotvisko',
      moduleKind: 'berth',
      fundsShort: false,
      dragging: false,
    });
    expect(feedback && feedbackText(feedback)).toBe('Kotvisko · $400,000');
  });

  it('nad pevninou je ghost neplatný a štítok vypíše slovenské dôvody', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(INLAND);
    expect(h.moduleGhost.ghost?.valid).toBe(false);
    const feedback = h.controller.feedback();
    expect(feedback?.ok).toBe(false);
    expect(feedback?.reasons).toEqual(expect.arrayContaining(['terrain', 'no_water_side']));
    const text = feedback ? feedbackText(feedback) : '';
    expect(text).toContain('Kotvisko · $400,000');
    expect(text).toContain('Nevhodný terén');
    expect(text).toContain('Dlhá hrana musí byť pri vode');
  });

  it('Esc zruší mód modulu: výber sa vynuluje, ghost aj štítok zmiznú; druhý Esc už nič nerobí', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.controller.state).toBe('idle');
    expect(h.buildSelection.get()).toBeNull();
    expect(h.moduleGhost.ghost).toBeNull();
    expect(h.controller.feedback()).toBeNull();
    expect(h.controller.keyDown(key('Escape'))).toBe(false);
  });

  it('pravý klik zruší mód modulu (bez odoslania príkazu); pustenie pravého tlačidla ničomu neprekáža', () => {
    const h = harness();
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.down(AT_FREE_QUAY, 2)).toBe(true);
    expect(h.controller.state).toBe('idle');
    expect(h.buildSelection.get()).toBeNull();
    expect(h.moduleGhost.ghost).toBeNull();
    h.up(AT_FREE_QUAY, 2);
    expect(h.controller.state).toBe('idle');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('zrušenie výberu zvonku (BuildBar: opätovný klik na položku) vypne mód aj ghost', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    h.buildSelection.select(null);
    expect(h.controller.state).toBe('idle');
    expect(h.moduleGhost.ghost).toBeNull();
    expect(h.controller.selectedDefId).toBeNull();
  });

  it('B v móde modulu prepne na stavbu ciest a vynuluje výber v BuildBare', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.controller.keyDown(key('KeyB'))).toBe(true);
    expect(h.controller.state).toBe('build');
    expect(h.buildSelection.get()).toBeNull();
    expect(h.moduleGhost.ghost).toBeNull();
    h.move(c(38, 20));
    expect(h.ghost.cells).toHaveLength(1); // ghost cesty, nie modulu
    expect(h.controller.feedback()?.kind).toBe('place');
  });

  it('výber z BuildBaru počas stavby ciest prepne na mód modulu a ghost cesty zmizne', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.move(c(38, 20));
    expect(h.ghost.cells).toHaveLength(1);
    h.buildSelection.select(BERTH);
    expect(h.controller.state).toBe('build_module');
    expect(h.ghost.cells).toEqual([]);
    expect(h.moduleGhost.ghost).toMatchObject({ defId: BERTH });
  });

  it('výber počas rozpracovaného ťahu cesty ťah zahodí (nič sa nepostaví)', () => {
    const h = harness();
    const cash = h.world.cashCents;
    h.controller.keyDown(key('KeyB'));
    h.down(c(32, 20));
    h.move(c(36, 20));
    h.buildSelection.select(BERTH);
    expect(h.controller.state).toBe('build_module');
    h.up(c(36, 20)); // pustenie po zrušení ťahu sa ignoruje
    h.frame();
    expect(h.world.cashCents).toBe(cash);
  });

  it('výber, ktorý existuje už pri vzniku ovládania, zapne mód hneď', () => {
    const h = harness();
    h.controller.dispose();
    h.buildSelection.select(BERTH);
    const late = new InputController({
      bridge: h.bridge,
      camera: h.camera,
      ghost: new FakeGhost(),
      moduleGhost: h.moduleGhost,
      buildSelection: h.buildSelection,
      moduleSelection: h.moduleSelection,
    });
    expect(late.state).toBe('build_module');
    expect(late.selectedDefId).toBe(BERTH);
    late.dispose();
  });

  it('neznámy def sa nekreslí (bez ghostu, bez chyby)', () => {
    const h = harness();
    h.buildSelection.select('neexistuje');
    expect(h.controller.state).toBe('build_module');
    expect(() => {
      h.move(AT_FREE_QUAY);
    }).not.toThrow();
    expect(h.moduleGhost.ghost).toBeNull();
  });

  it('kurzor mimo mapy alebo opustil mapu → ghost zmizne', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.moduleGhost.ghost).not.toBeNull();
    h.controller.pointerLeave();
    expect(h.moduleGhost.ghost).toBeNull();
    expect(h.controller.feedback()).toBeNull();
    h.move(c(-5, 15));
    expect(h.moduleGhost.ghost).toBeNull();
  });

  it('dispose odhlási odber výberu: ďalšia zmena výberu ovládanie nezmení', () => {
    const h = harness();
    h.controller.dispose();
    h.buildSelection.select(BERTH);
    expect(h.controller.state).toBe('idle');
  });
});

describe('build mód modulov: rotácia (R)', () => {
  it('R otáča 0 → 90 → 180 → 270 → 0; footprint a konektory sa otáčajú, ghost ostáva pod kurzorom', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.controller.rotation).toBe(0);

    expect(h.controller.keyDown(key('KeyR'))).toBe(true);
    expect(h.controller.rotation).toBe(90);
    // 3×8 (po rotácii): stred pod kurzorom (52, 15) → roh (51, 11)
    expect(h.moduleGhost.ghost).toMatchObject({ rotation: 90, w: 3, h: 8, x: 51, y: 11 });
    expect(h.moduleGhost.ghost?.connectors.map((connector) => connector.side)).toEqual(['w', 'w']); // južná strana → západná

    h.controller.keyDown(key('KeyR'));
    expect(h.moduleGhost.ghost).toMatchObject({ rotation: 180, w: 8, h: 3 });
    expect(h.moduleGhost.ghost?.connectors.map((connector) => connector.side)).toEqual(['n', 'n']);

    h.controller.keyDown(key('KeyR'));
    expect(h.moduleGhost.ghost).toMatchObject({ rotation: 270, w: 3, h: 8 });
    expect(h.moduleGhost.ghost?.connectors.map((connector) => connector.side)).toEqual(['e', 'e']);

    h.controller.keyDown(key('KeyR'));
    expect(h.controller.rotation).toBe(0);
    expect(h.moduleGhost.ghost).toMatchObject({ rotation: 0, x: 48, y: 14 });
  });

  it('otočený ghost s inou stranou vody je neplatný (no_water_side) a platí opäť po návrate do 0°', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.moduleGhost.ghost?.valid).toBe(true);
    h.controller.keyDown(key('KeyR'));
    expect(h.moduleGhost.ghost?.valid).toBe(false);
    expect(h.controller.feedback()?.reasons).toContain('no_water_side');
    for (let i = 0; i < 3; i += 1) h.controller.keyDown(key('KeyR'));
    expect(h.moduleGhost.ghost?.valid).toBe(true);
  });

  it('mimo módu modulu R nerobí nič (kláves nie je spotrebovaný), aj auto-repeat', () => {
    const h = harness();
    expect(h.controller.keyDown(key('KeyR'))).toBe(false);
    expect(h.controller.keyDown(key('KeyR', { repeat: true }))).toBe(false);
    h.controller.keyDown(key('KeyB'));
    expect(h.controller.keyDown(key('KeyR'))).toBe(false); // ani v móde ciest
    h.controller.keyDown(key('KeyB'));
    h.buildSelection.select(BERTH);
    expect(h.controller.keyDown(key('KeyR', { repeat: true }))).toBe(true); // spotrebovaný, ale neotáča opakovane
    expect(h.controller.rotation).toBe(0);
  });

  it('nová položka nuluje rotáciu; tá istá ju drží', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.controller.keyDown(key('KeyR'));
    expect(h.controller.rotation).toBe(90);
    h.buildSelection.select(CRANE);
    expect(h.controller.rotation).toBe(0);
  });
});

describe('build mód modulov: umiestnenie klikom', () => {
  it('ľavý klik na platné miesto odošle PlaceModule; svet sa zmení vo frame, hotovosť klesne o cenu, mód ostáva', () => {
    const h = harness();
    const cash = h.world.cashCents;
    const before = modules(h);
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);

    expect(h.down(AT_FREE_QUAY)).toBe(true);
    expect(h.controller.state).toBe('build_module_place');
    expect(dispatch).not.toHaveBeenCalled(); // odošle sa až po pustení
    h.up(AT_FREE_QUAY);
    expect(h.controller.state).toBe('build_module');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatch.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PlaceModuleCommand);
    expect(command?.toJSON()).toEqual({ type: 'PlaceModule', defId: BERTH, x: 48, y: 14, rotation: 0 });

    expect(modules(h)).toBe(before); // ešte nič: príkaz čaká vo fronte
    h.frame();
    expect(modules(h)).toBe(before + 1);
    expect(h.world.cashCents).toBe(cash - BERTH_COST);
    expect(h.controller.state).toBe('build_module');
    expect(h.buildSelection.get()).toBe(BERTH);
    // ghost sa prepočítal: na tom istom mieste už stojí nové kotvisko
    expect(h.moduleGhost.ghost?.valid).toBe(false);
    expect(h.controller.feedback()?.reasons).toContain('occupied');
  });

  it('po umiestnení mód ostáva a stavia sa ďalej (druhé kotvisko na západ od Root berthu)', () => {
    const h = harness();
    const cash = h.world.cashCents;
    const before = modules(h);
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    h.down(AT_FREE_QUAY);
    h.up(AT_FREE_QUAY);
    h.frame();
    const west = c(36, 15); // roh (32, 14): starter parcela začína na x 30, Root berth na x 40
    h.move(west);
    expect(h.moduleGhost.ghost).toMatchObject({ x: 32, y: 14, valid: true });
    h.down(west);
    h.up(west);
    h.frame();
    expect(modules(h)).toBe(before + 2);
    expect(h.world.cashCents).toBe(cash - 2 * BERTH_COST);
    expect(h.controller.state).toBe('build_module');
  });

  it('klik na neplatné miesto (pevnina) nič neodošle', () => {
    const h = harness();
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    const cash = h.world.cashCents;
    h.buildSelection.select(BERTH);
    h.move(INLAND);
    h.down(INLAND);
    h.up(INLAND);
    h.frame();
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.world.cashCents).toBe(cash);
    expect(h.controller.state).toBe('build_module');
  });

  it('nedostatok peňazí: ghost ostáva zelený (ikona $ v štítku), ale klik nič nepostaví (§8 bod 6)', () => {
    const h = harness();
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    setCash(h.world, BERTH_COST - 1);
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.moduleGhost.ghost?.valid).toBe(true);
    const feedback = h.controller.feedback();
    expect(feedback).toMatchObject({ kind: 'module', ok: false, reasons: ['insufficient_funds'], fundsShort: true });
    expect(feedback && feedbackText(feedback)).toBe('Kotvisko · $400,000 · Nedostatok peňazí');
    h.down(AT_FREE_QUAY);
    h.up(AT_FREE_QUAY);
    h.frame();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('nedostatok peňazí spolu s iným dôvodom: ghost je červený', () => {
    const h = harness();
    setCash(h.world, 0);
    h.buildSelection.select(BERTH);
    h.move(INLAND);
    expect(h.moduleGhost.ghost?.valid).toBe(false);
    expect(h.controller.feedback()?.reasons).toEqual(expect.arrayContaining(['insufficient_funds', 'no_water_side']));
  });

  it('po zmene hotovosti (MoneyChanged) sa ghost prepočíta bez pohybu myši', () => {
    const h = harness();
    setCash(h.world, BERTH_COST); // presne na kotvisko
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    expect(h.controller.feedback()?.fundsShort).toBe(false);
    h.bridge.dispatch(new PlaceRoadCommand([c(38, 20)])); // cesta stojí peniaze → hotovosť pod cenou kotviska
    h.frame();
    expect(h.controller.feedback()?.fundsShort).toBe(true);
    expect(h.moduleGhost.ghost?.valid).toBe(true); // stále zelený (§8 bod 6)
  });

  it('Esc počas stlačeného tlačidla zruší len klik; mód ostáva a pustenie nič neodošle', () => {
    const h = harness();
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    h.down(AT_FREE_QUAY);
    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.controller.state).toBe('build_module');
    h.up(AT_FREE_QUAY);
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.buildSelection.get()).toBe(BERTH);
  });

  it('klik sa umiestni na mieste PUSTENIA (ghost sa dá počas stlačenia doladiť)', () => {
    const h = harness();
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    h.buildSelection.select(BERTH);
    h.move(c(51, 15));
    h.down(c(51, 15));
    h.move(AT_FREE_QUAY);
    expect(h.controller.feedback()?.dragging).toBe(true);
    h.up(AT_FREE_QUAY);
    expect(dispatch.mock.calls[0]?.[0].toJSON()).toMatchObject({ x: 48, y: 14 });
  });

  it('otočené kotvisko (dlhá hrana už nie je pri vode) sa neodošle', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    h.controller.keyDown(key('KeyR'));
    const dispatch = vi.spyOn(h.bridge, 'dispatch');
    h.down(AT_FREE_QUAY);
    h.up(AT_FREE_QUAY);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('žeriav sa dá umiestniť len na kotvisko: na Root berthe je platný (obsadené žeriavmi 1/2), inde nie', () => {
    const h = harness();
    h.buildSelection.select(CRANE);
    h.move(c(47, 15)); // 2×3: bunka pod kurzorom je o 1 vpravo od rohu → roh (46, 14), x 46–47 na Root berthe vedľa žeriavu (x 43–44)
    expect(h.moduleGhost.ghost).toMatchObject({ defId: CRANE, x: 46, y: 14, w: 2, h: 3, valid: true });
    expect(h.moduleGhost.ghost?.connectors).toEqual([]);
    h.move(INLAND);
    expect(h.moduleGhost.ghost?.valid).toBe(false);
    expect(h.controller.feedback()?.reasons).toContain('no_berth');
  });

  it('stredný ťah v móde modulu posúva kameru a mód ostáva', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    const top = h.camera.top;
    expect(h.controller.pointerDown({ button: 1, x: 300, y: 300 })).toBe(true);
    expect(h.controller.state).toBe('build_module_pan');
    h.controller.pointerMove(300, 340);
    expect(h.camera.top).toBeCloseTo(top - 40, 6);
    h.controller.pointerUp({ button: 1, x: 300, y: 340 });
    expect(h.controller.state).toBe('build_module');
    expect(h.buildSelection.get()).toBe(BERTH);
  });

  it('koleso počas módu modulu prepočíta ghost (bunka pod kurzorom sa zmenila)', () => {
    const h = harness();
    h.buildSelection.select(BERTH);
    h.move(AT_FREE_QUAY);
    const calls = h.moduleGhost.setCalls;
    h.controller.wheel({ deltaY: -200, deltaMode: 0, x: 100, y: 100 });
    expect(h.moduleGhost.setCalls).toBeGreaterThan(calls);
  });
});

describe('výber modulu klikom (inšpektor)', () => {
  const ROOT_BERTH = 1 as EntityId;
  const ROOT_CRANE = 2 as EntityId;

  it('Root modul: id 1 = kotvisko, id 2 = žeriav (predpoklad testov)', () => {
    const { world } = harness();
    expect(world.modules.get(ROOT_BERTH)?.kind).toBe('berth');
    expect(world.modules.get(ROOT_CRANE)?.kind).toBe('crane');
  });

  it('klik na bunku kotviska vyberie kotvisko', () => {
    const h = harness();
    h.down(c(41, 15));
    h.up(c(41, 15));
    expect(h.moduleSelection.get()).toBe(ROOT_BERTH);
    expect(h.controller.state).toBe('idle');
  });

  it('žeriav má prednosť pred kotviskom pod ním (bunka ležiaca v jeho footprinte)', () => {
    const h = harness();
    h.down(c(43, 15));
    h.up(c(43, 15));
    expect(h.moduleSelection.get()).toBe(ROOT_CRANE);
    h.down(c(44, 16));
    h.up(c(44, 16));
    expect(h.moduleSelection.get()).toBe(ROOT_CRANE);
    h.down(c(45, 15)); // vedľa žeriavu (x 43–44), ešte na kotvisku
    h.up(c(45, 15));
    expect(h.moduleSelection.get()).toBe(ROOT_BERTH);
  });

  it('klik do prázdna (pevnina, more) výber zruší', () => {
    const h = harness();
    h.down(c(41, 15));
    h.up(c(41, 15));
    expect(h.moduleSelection.get()).not.toBeNull();
    h.down(INLAND);
    h.up(INLAND);
    expect(h.moduleSelection.get()).toBeNull();
    h.down(c(41, 15));
    h.up(c(41, 15));
    h.down(c(41, 10)); // voda
    h.up(c(41, 10));
    expect(h.moduleSelection.get()).toBeNull();
  });

  it('ťah mapy (posun väčší než CLICK_SLOP_PX) nevyberá ani neruší výber a posúva kameru', () => {
    const h = harness();
    h.down(c(41, 15));
    h.up(c(41, 15));
    const left = h.camera.left;
    const start = h.at(41, 15);
    h.controller.pointerDown({ button: 0, ...start });
    h.controller.pointerMove(start.x + CLICK_SLOP_PX + 5, start.y);
    h.controller.pointerUp({ button: 0, x: start.x + CLICK_SLOP_PX + 5, y: start.y });
    expect(h.camera.left).not.toBe(left);
    expect(h.moduleSelection.get()).toBe(ROOT_BERTH); // nezmenený
  });

  it('drobné chvenie kurzora (≤ CLICK_SLOP_PX) je stále klik', () => {
    const h = harness();
    const start = h.at(41, 15);
    h.controller.pointerDown({ button: 0, ...start });
    h.controller.pointerMove(start.x + CLICK_SLOP_PX - 1, start.y);
    h.controller.pointerUp({ button: 0, x: start.x + CLICK_SLOP_PX - 1, y: start.y });
    expect(h.moduleSelection.get()).toBe(ROOT_BERTH);
  });

  it('stredné tlačidlo (posun kamery) modul nevyberá', () => {
    const h = harness();
    h.down(c(41, 15), 1);
    h.up(c(41, 15), 1);
    expect(h.moduleSelection.get()).toBeNull();
  });

  it('Esc v pokoji zruší výber (a spotrebuje kláves); bez výberu Esc nerobí nič', () => {
    const h = harness();
    expect(h.controller.keyDown(key('Escape'))).toBe(false);
    h.down(c(41, 15));
    h.up(c(41, 15));
    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.moduleSelection.get()).toBeNull();
    expect(h.controller.keyDown(key('Escape'))).toBe(false);
  });

  it('v stavbe ciest a v móde modulu klik modul nevyberá', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(41, 15));
    h.up(c(41, 15));
    expect(h.moduleSelection.get()).toBeNull();
    h.controller.keyDown(key('KeyB'));
    h.buildSelection.select(BERTH);
    h.move(c(41, 15));
    h.down(c(41, 15));
    h.up(c(41, 15));
    expect(h.moduleSelection.get()).toBeNull();
  });

  it('výber modulu prežije vstup do módu modulu a Esc v ňom ho neruší (Esc ruší najprv mód)', () => {
    const h = harness();
    h.down(c(41, 15));
    h.up(c(41, 15));
    h.buildSelection.select(BERTH);
    h.controller.keyDown(key('Escape'));
    expect(h.controller.state).toBe('idle');
    expect(h.moduleSelection.get()).toBe(ROOT_BERTH);
    h.controller.keyDown(key('Escape'));
    expect(h.moduleSelection.get()).toBeNull();
  });
});
