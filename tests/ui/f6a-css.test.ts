// T6A-07: štýl nových prvkov F6a (booking, spoločná karta voyage, import / export v inšpektore, lashing) — len tokeny,
// bez pevných farieb a rozmerov; farby segmentov a počítadiel idú z design/tokens.css.
import { describe, expect, it } from 'vitest';
import { loadCss } from './css-guard';

const contracts = loadCss('src/ui/contracts-panel.css');
const inspector = loadCss('src/ui/module-inspector.css');

describe('contracts-panel.css: booking exportu a karta voyage', () => {
  it('počítadlá: varovanie --ui-warning, rolled z --ui-danger, ostatné neutrálne (--ui-surface-2)', () => {
    expect(contracts.ruleBody('.contract-card__counter')).toMatch(/background:\s*var\(--ui-surface-2\)/);
    expect(contracts.ruleBody('.contract-card__counter--warn')).toMatch(/var\(--ui-warning\)/);
    expect(contracts.ruleBody('.contract-card__counter--danger')).toMatch(/var\(--ui-danger\)/);
    expect(contracts.ruleBody('.contract-card__counter--warn .contract-card__counter-icon')).toMatch(/color:\s*var\(--ui-warning\)/);
  });

  it('časť voyage: hrana --ui-border, radius --radius-md, odstup z tokenov', () => {
    const part = contracts.ruleBody('.contract-card__part');
    expect(part).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(part).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(part).toMatch(/padding:\s*var\(--space-3\)/);
  });

  it('plánované príchody a súhrn majú sekundárny text a malé písmo', () => {
    const body = contracts.ruleBody('.contract-card__pending,\n.contract-card__summary');
    expect(body).toMatch(/color:\s*var\(--ui-text-2\)/);
    expect(body).toMatch(/font-size:\s*var\(--fs-xs\)/);
  });

  it('karta zdedí tabular-nums od panelu (čísla v počítadlách a pruhoch)', () => {
    expect(contracts.ruleBody('.contracts-panel')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe('module-inspector.css: import / export a lashing', () => {
  it('segment importu = farba kontajnera, exportu = accent', () => {
    expect(inspector.ruleBody('.module-inspector__swatch--import,\n.module-inspector__bar-fill--import')).toMatch(/background:\s*var\(--cargo-container\)/);
    expect(inspector.ruleBody('.module-inspector__swatch--export,\n.module-inspector__bar-fill--export')).toMatch(/background:\s*var\(--ui-accent\)/);
  });

  it('legenda a lashing používajú sekundárny text, hranu --ui-border a accent ikonu', () => {
    expect(inspector.ruleBody('.module-inspector__legend-label')).toMatch(/color:\s*var\(--ui-text-2\)/);
    expect(inspector.ruleBody('.module-inspector__lashing')).toMatch(/border-top:\s*1px solid var\(--ui-border\)/);
    expect(inspector.ruleBody('.module-inspector__lashing-icon')).toMatch(/color:\s*var\(--ui-accent\)/);
  });
});
