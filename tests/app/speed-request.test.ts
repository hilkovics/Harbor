import { describe, expect, it } from 'vitest';
import { resolveSpeedRequest } from '@app/speed-request';
import { resolveSpeedRequest as fromHud } from '@ui/top-hud';

describe('resolveSpeedRequest (zdieľané HUD ↔ klávesnica)', () => {
  it.each([
    [0, 0, 4, 4], // pauza + požiadavka na pauzu → obnov poslednú nenulovú
    [0, 2, 4, 0], // beží → pauza
    [8, 0, 4, 8], // pauza, hráč vybral 8× → 8×
    [0, 0, undefined, 0], // nie je kam obnoviť
  ] as const)('požiadavka %i, aktuálne %i, obnoviť %s → %i', (requested, current, resume, expected) => {
    expect(resolveSpeedRequest(requested, current, resume)).toBe(expected);
  });

  it('HUD používa tú istú funkciu (žiadna druhá kópia logiky)', () => {
    expect(fromHud).toBe(resolveSpeedRequest);
  });
});
