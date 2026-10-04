/**
 * Opravy z review `src/sim` po T6A-05 (T6A-09b, minor 6–8; ADR-032, ADR-033):
 * - 6: limit jobov nakládky pod hákom na žeriav, kým má loď aj import, je pomenovaná konštanta (`PAIRED_HOOK_LOAD_JOBS_PER_CRANE`),
 * - 7: vetvenie podľa režimu odovzdávania je v tabuľke `HANDOVERS` (pravidlo 7), nie v literáloch `handoverMode` mimo nej,
 * - 8: krok 12 overí `loadedUnits` otvoreného export bookingu = jednotky exportu bookingu na lodi.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HANDOVER_MODES } from '@sim/defs';
import { PAIRED_HOOK_LOAD_JOBS_PER_CRANE } from '@sim/logistics/export-load';
import { bothDirections } from '@sim/logistics/apron-usage';
import { CraneModule } from '@sim/modules';
import { HANDOVERS } from '@sim/systems/crane-handover';
import { findWorldViolation } from '@sim/world/world-invariants';
import { apronDefs, hookDefs, startLoading, tickUntil } from '../helpers/f6a';

const EARLY = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const TIMEOUT = 40_000;

describe('limit jobov nakládky pod hákom na žeriav (minor 6)', () => {
  it('kým má loď import aj export, má každý žeriav najviac PAIRED_HOOK_LOAD_JOBS_PER_CRANE jobov nakládky v obehu', () => {
    expect(PAIRED_HOOK_LOAD_JOBS_PER_CRANE).toBe(1);
    const { world, offer } = startLoading({ defs: hookDefs(), kind: 'roundtrip', booked: 12, importUnits: 12, arrivals: EARLY });
    let samples = 0;
    tickUntil(
      world,
      (w) => {
        const ship = [...w.ships.values()].find((candidate) => candidate.state === 'docked');
        if (ship !== undefined && bothDirections(w, ship)) {
          for (const module of w.modules.values()) {
            if (!(module instanceof CraneModule)) continue;
            const loadJobs = [...w.jobs.values()].filter((job) => job.to.kind === 'in_crane' && job.to.craneId === module.id).length;
            expect(loadJobs).toBeLessThanOrEqual(PAIRED_HOOK_LOAD_JOBS_PER_CRANE);
            samples += 1;
          }
        }
        return offer.exportContract.booking.loadedUnits >= 6;
      },
      TIMEOUT,
    );
    expect(samples).toBeGreaterThan(100);
  });
});

describe('vetvenie podľa režimu odovzdávania v tabuľke HANDOVERS (minor 7, pravidlo 7)', () => {
  it('každý režim z defov má stratégiu; vykládka buď rezervuje slot apronu, alebo plánuje cieľ cyklu pod hákom (nie oboje)', () => {
    expect(Object.keys(HANDOVERS).sort()).toEqual([...HANDOVER_MODES].sort());
    expect([HANDOVERS.apron.reservesUnloadSlot, HANDOVERS.apron.plansUnloadTarget]).toEqual([true, false]);
    expect([HANDOVERS.under_hook.reservesUnloadSlot, HANDOVERS.under_hook.plansUnloadTarget]).toEqual([false, true]);
    expect(HANDOVERS.apron.blocksWhenNotReady).toBe(true);
    expect(HANDOVERS.under_hook.blocksWhenNotReady).toBe(false);
  });

  it('v src/sim sa literál režimu porovnáva len v tabuľke (žiadne `handoverMode ===` / `!==` s reťazcom)', () => {
    const root = fileURLToPath(new URL('../../../src/sim/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}${name}`;
        if (statSync(path).isDirectory()) walk(`${path}/`);
        else if (name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => /handoverMode\s*[!=]==\s*['"]/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('krok 12: loadedUnits otvoreného export bookingu (minor 8)', () => {
  it('loadedUnits sedí s jednotkami exportu bookingu na lodi; nezhoda (viac aj menej) je porušenie invariantu', () => {
    const { world, offer } = startLoading({ defs: apronDefs(), kind: 'export', booked: 8, arrivals: EARLY.slice(0, 8) });
    const contract = offer.exportContract;
    tickUntil(world, () => contract.loadedUnits >= 2 && contract.loadedUnits < contract.arrivedUnits, TIMEOUT);
    expect(findWorldViolation(world)).toBeUndefined();
    const loaded = contract.loadedUnits;
    contract.loadedUnits = loaded + 1;
    expect(findWorldViolation(world)).toMatch(new RegExp(`loadedUnits ${String(loaded + 1)}, na .* je ${String(loaded)} jednotiek nákladu bookingu`));
    contract.loadedUnits = loaded - 1;
    expect(findWorldViolation(world)).toMatch(new RegExp(`loadedUnits ${String(loaded - 1)}, na .* je ${String(loaded)} jednotiek nákladu bookingu`));
    contract.loadedUnits = loaded;
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('po odchode lode (jednotky shipped, booking sa uzavrie v ďalšom ticku) invariant neporuší; beh do konca s invariantmi každý tick', () => {
    const { world, offer } = startLoading({ defs: hookDefs(), kind: 'roundtrip', booked: 6, importUnits: 6, arrivals: EARLY.slice(0, 6) });
    tickUntil(world, (w) => w.ships.size === 0 && offer.exportContract.state === 'completed', TIMEOUT);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
