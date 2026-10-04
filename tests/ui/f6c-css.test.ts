// T6C-05: štýl nových prvkov F6c (odznak linky, trasa prekládky, farby segmentov tranship / prázdne, depo prázdnych) — len tokeny,
// bez pevných farieb a rozmerov; farby liniek idú cez `--line-color` (inline z tokenu linky), farby segmentov cez lokálne `--mi-*`.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const contracts = loadCss('src/ui/contracts-panel.css');
const inspector = loadCss('src/ui/module-inspector.css');

describe('contracts-panel.css: linka a trasa prekládky', () => {
  it('odznak linky: bodka berie farbu z `--line-color`, ktorá má na karte predvolenú hodnotu zo sekundárneho textu', () => {
    expect(contracts.ruleBody('.contract-card__line-dot')).toMatch(/background:\s*var\(--line-color\)/);
    expect(contracts.ruleBody('.contract-card__line-dot')).toMatch(/border-radius:\s*50%/);
    expect(contracts.ruleBody('.contract-card')).toMatch(/--line-color:\s*var\(--ui-text-2\)/);
  });

  it('trasa: odznaky lodí s hranou --ui-border a plochou --ui-surface-2, odpočet výrazne (--ui-text, semibold), zmeškaná červená', () => {
    const badge = contracts.ruleBody('.contract-card__leg-badge');
    expect(badge).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(badge).toMatch(/background:\s*var\(--ui-surface-2\)/);
    const time = contracts.ruleBody('.contract-card__leg-time');
    expect(time).toMatch(/color:\s*var\(--ui-text\)/);
    expect(time).toMatch(/font-weight:\s*var\(--fw-semibold\)/);
    expect(contracts.ruleBody('.contract-card__leg--danger .contract-card__leg-badge')).toMatch(/border-color:\s*var\(--ui-danger\)/);
    expect(contracts.ruleBody('.contract-card__leg--danger .contract-card__leg-time')).toMatch(/var\(--ui-danger\)/);
  });

  it('riadok lode sa zalomí (dlhý odpočet) a spojnica A → B je 2 px čiara z --ui-border', () => {
    expect(contracts.ruleBody('.contract-card__leg')).toMatch(/flex-wrap:\s*wrap/);
    const connector = contracts.ruleBody('.contract-card__leg:not(:last-child)::after');
    expect(connector).toMatch(/width:\s*2px/);
    expect(connector).toMatch(/background:\s*var\(--ui-border\)/);
  });
});

describe('module-inspector.css: tranship, prázdne a depo', () => {
  it('lokálne farby segmentov sú odvodené od existujúcich tokenov (každý zdroj je v design/tokens.css)', () => {
    const root = inspector.ruleBody('.module-inspector');
    for (const [name, token] of [['--mi-empty', '--module-base'], ['--mi-tranship', '--ui-xp'], ['--mi-damaged', '--ui-warning'], ['--mi-repair', '--ui-accent']] as const) {
      expect(root, name).toMatch(new RegExp(`${name}:\\s*var\\(${token}\\)`));
      expect(TOKENS_CSS, token).toContain(`${token}:`);
    }
    expect(root).toMatch(/--line-color:\s*var\(--ui-text-2\)/);
  });

  it('segmenty pruhu a značky legendy: tranship / prázdne / poškodené / oprava čítajú `--mi-*`', () => {
    expect(inspector.ruleBody('.module-inspector__swatch--tranship,\n.module-inspector__bar-fill--tranship')).toMatch(/background:\s*var\(--mi-tranship\)/);
    expect(inspector.ruleBody('.module-inspector__swatch--empty,\n.module-inspector__bar-fill--empty')).toMatch(/background:\s*var\(--mi-empty\)/);
    expect(inspector.ruleBody('.module-inspector__swatch--damaged,\n.module-inspector__bar-fill--damaged')).toMatch(/background:\s*var\(--mi-damaged\)/);
    expect(inspector.ruleBody('.module-inspector__swatch--repair,\n.module-inspector__bar-fill--repair')).toMatch(/background:\s*var\(--mi-repair\)/);
  });

  it('zoznam liniek depa: rámovaný zoznam ako vozidlá, bodka z `--line-color`, nenulové poškodené varovanie a oprava accent', () => {
    const list = inspector.ruleBody('.module-inspector__lines');
    expect(list).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(list).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(inspector.ruleBody('.module-inspector__line-dot')).toMatch(/background:\s*var\(--line-color\)/);
    expect(inspector.ruleBody('.module-inspector__line-value--warn')).toMatch(/color:\s*var\(--ui-warning\)/);
    expect(inspector.ruleBody('.module-inspector__line-value--busy')).toMatch(/color:\s*var\(--ui-accent\)/);
    expect(inspector.ruleBody('.module-inspector__line-total')).toMatch(/color:\s*var\(--ui-text-2\)/);
  });

  it('opravárenské miesta: obsadené miesto je accent, upozornenie na čakajúce poškodené je varovanie', () => {
    expect(inspector.ruleBody(".module-inspector__meter[data-section='repair-bays'] .module-inspector__bay--occupied")).toMatch(/background:\s*var\(--mi-repair\)/);
    expect(inspector.ruleBody('.module-inspector__meter-note')).toMatch(/color:\s*var\(--ui-warning\)/);
  });

  it('čísla v depe majú tabular-nums z panelu inšpektora', () => {
    expect(inspector.ruleBody('.module-inspector')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
