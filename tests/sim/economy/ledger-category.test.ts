// Kategórie účtovnej knihy musia zodpovedať typu `LedgerCategory` v ARCHITECTURE §9.2 (vrátane `road_sale`, ADR-012).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEDGER_CATEGORIES } from '@sim/economy';

const ARCHITECTURE = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');

/** Členy únie `type LedgerCategory = '…' | '…';` z §9.2 v poradí dokumentu. */
function categoriesFromArchitecture(): string[] {
  const match = /type LedgerCategory =([^;]*);/.exec(ARCHITECTURE);
  if (match === null) throw new Error('ARCHITECTURE.md neobsahuje type LedgerCategory');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('LEDGER_CATEGORIES', () => {
  it('zhodujú sa s ARCHITECTURE §9.2 vrátane poradia (od R5, ADR-042 na konci `energy` — elektrina reeferov)', () => {
    expect([...LEDGER_CATEGORIES]).toEqual(categoriesFromArchitecture());
    expect(LEDGER_CATEGORIES[LEDGER_CATEGORIES.length - 1]).toBe('energy');
  });

  it('road_sale (ADR-012) nasleduje hneď za road_capex; žiadne duplicity', () => {
    const list: readonly string[] = LEDGER_CATEGORIES;
    expect(list.indexOf('road_sale')).toBe(list.indexOf('road_capex') + 1);
    expect(new Set(list).size).toBe(list.length);
  });
});
