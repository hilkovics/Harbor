// TR3-04: inšpektor strojov a blokov (MachineInspector, BlockInspector, CraneInspector) nad fixture dátami;
// callbacky onSetPriority / onSetGang a strážca štýlu machine-inspector.css (len tokeny).
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BlockInspector,
  CraneInspector,
  MachineInspector,
  clampTractorsPerSts,
  machineCargoText,
  machineIcon,
  machineSubtitle,
  type MachineInspectorData,
} from '@ui/machine-inspector';
import { TOKENS_CSS, loadCss } from './css-guard';
import { fieldText, findAll, propsOf } from './react-tree';

const FIXTURE: MachineInspectorData = {
  id: 17,
  defId: 'rtg_block',
  displayName: 'RTG',
  blockId: 2,
  state: 'working',
  cargo: { sizeFt: 40, containerType: 'dry' },
  queueLength: 5,
  movesPerHour: 19,
};

describe('MachineInspector — prezentácia z props', () => {
  it('ukáže názov, podtitul s id a blokom, stav a číselné riadky', () => {
    const html = renderToStaticMarkup(createElement(MachineInspector, { data: FIXTURE }));
    expect(fieldText(html, 'title')).toBe('RTG');
    expect(fieldText(html, 'sub')).toBe('#17 · blok #2');
    expect(fieldText(html, 'badge')).toBe('Pracuje');
    expect(fieldText(html, 'cargo')).toBe('40′ dry');
    expect(fieldText(html, 'queue')).toBe('5');
    expect(fieldText(html, 'moves')).toBe('19');
    expect(html).toContain('data-state="working"');
    expect(html).toContain('data-def-id="rtg_block"');
  });

  it('bez displayName ukáže defId, bez bloku „bez bloku", prázdny kontajner „Prázdny"', () => {
    const html = renderToStaticMarkup(
      createElement(MachineInspector, { data: { ...FIXTURE, displayName: undefined, blockId: null, cargo: null, state: 'blocked' } }),
    );
    expect(fieldText(html, 'title')).toBe('rtg_block');
    expect(fieldText(html, 'sub')).toBe('#17 · bez bloku');
    expect(fieldText(html, 'cargo')).toBe('Prázdny');
    expect(fieldText(html, 'badge')).toBe('Blokovaný');
    expect(html).toContain('machine-inspector__badge--bad');
  });

  it('počty s tisícovým oddeľovačom (formatCount), nie holé čísla', () => {
    const html = renderToStaticMarkup(createElement(MachineInspector, { data: { ...FIXTURE, queueLength: 1240, movesPerHour: 0 } }));
    expect(fieldText(html, 'queue')).toBe('1,240');
    expect(fieldText(html, 'moves')).toBe('0');
  });

  it('bez dát vykreslí prázdny stav bez pádu', () => {
    const html = renderToStaticMarkup(createElement(MachineInspector));
    expect(html).toContain('data-section="machine-empty"');
    expect(html).toContain('Stroj nie je vybraný.');
  });

  it('pomocné funkcie: text kontajnera, podtitul, ikona podľa defId', () => {
    expect(machineCargoText({ sizeFt: 20, containerType: 'tank' })).toBe('20′ tank');
    expect(machineCargoText(null)).toBe('Prázdny');
    expect(machineSubtitle(FIXTURE)).toBe('#17 · blok #2');
    expect(machineIcon('rtg_block')).toBe('ic_rtg');
    expect(machineIcon('terminal_tractor')).toBe('ic_tractor');
    expect(machineIcon('unknown_thing')).toBe('ic_crane');
  });
});

describe('BlockInspector — priorita RTG', () => {
  it('označí zvolenú prioritu (aria-checked) a predvolená je loď', () => {
    const html = renderToStaticMarkup(createElement(BlockInspector, { priority: 'truck' }));
    expect(html).toMatch(/data-priority="truck"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-priority="truck"/);
    const dflt = renderToStaticMarkup(createElement(BlockInspector));
    expect(dflt).toMatch(/data-priority="ship"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-priority="ship"/);
    expect(html).toContain('Housekeeping');
  });

  it('klik na prioritu volá onSetPriority(order)', () => {
    const onSetPriority = vi.fn();
    const tree = BlockInspector({ priority: 'ship', onSetPriority });
    const buttons = findAll(tree, (el) => typeof propsOf(el)['data-priority'] === 'string');
    expect(buttons.map((el) => propsOf(el)['data-priority'])).toEqual(['ship', 'truck', 'housekeeping']);
    const housekeeping = buttons.find((el) => propsOf(el)['data-priority'] === 'housekeeping');
    expect(housekeeping).toBeDefined();
    (propsOf(housekeeping as ReactElement).onClick as () => void)();
    expect(onSetPriority).toHaveBeenCalledWith('housekeeping');
  });

  it('bez onSetPriority klik nespadne', () => {
    const tree = BlockInspector({});
    const button = findAll(tree, (el) => propsOf(el)['data-priority'] === 'ship')[0];
    expect(() => (propsOf(button as ReactElement).onClick as () => void)()).not.toThrow();
  });
});

describe('CraneInspector — gang / pool a ťahače na STS', () => {
  it('zobrazí počet ťahačov a označí režim', () => {
    const html = renderToStaticMarkup(createElement(CraneInspector, { gang: 'pool', tractorsPerSts: 3 }));
    expect(html).toMatch(/data-gang="pool"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-gang="pool"/);
    expect(html).toContain('value="3"');
  });

  it('klik na režim volá onSetGang(mode, n) s aktuálnym počtom', () => {
    const onSetGang = vi.fn();
    const tree = CraneInspector({ gang: 'gang', tractorsPerSts: 4, onSetGang });
    const pool = findAll(tree, (el) => propsOf(el)['data-gang'] === 'pool')[0];
    (propsOf(pool as ReactElement).onClick as () => void)();
    expect(onSetGang).toHaveBeenLastCalledWith('pool', 4);
  });

  it('zmena počtu volá onSetGang(mode, n) a ohraničí hodnotu', () => {
    const onSetGang = vi.fn();
    const tree = CraneInspector({ gang: 'gang', tractorsPerSts: 2, onSetGang });
    const input = findAll(tree, (el) => propsOf(el)['data-field'] === 'tractors-per-sts')[0];
    const onChange = propsOf(input as ReactElement).onChange as (event: unknown) => void;
    onChange({ currentTarget: { value: '99' } });
    expect(onSetGang).toHaveBeenLastCalledWith('gang', 8);
    onChange({ currentTarget: { value: '3' } });
    expect(onSetGang).toHaveBeenLastCalledWith('gang', 3);
  });

  it('clampTractorsPerSts: zaokrúhli, ohraničí, NaN → minimum', () => {
    expect(clampTractorsPerSts(0)).toBe(1);
    expect(clampTractorsPerSts(2.6)).toBe(3);
    expect(clampTractorsPerSts(42)).toBe(8);
    expect(clampTractorsPerSts(Number.NaN)).toBe(1);
  });
});

describe('machine-inspector.css — len tokeny', () => {
  const css = loadCss('src/ui/machine-inspector.css');

  it('bez pevných farieb; každý var(--x) je v tokens.css alebo lokálne', () => {
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    const local = css.localProperties();
    for (const name of css.usedProperties()) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('pevné px len 1px a 2px (čiary, focus ring)', () => {
    const pixels = new Set([...css.source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('čísla v tabular-nums (hodnoty, číselné pole)', () => {
    expect(css.ruleBody('.machine-inspector__value')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.machine-inspector__number')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
