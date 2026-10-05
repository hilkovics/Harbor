// T6D-04: dáta inšpektora brány — kamióny čakajúce vo vnútrozemí (`hinterlandQueue`, ADR-035). Čakajúci kamión je splatná položka plánu,
// bez rampy a road portálu sa nič nevpúšťa (`admitFromHinterland`), takže plán návratov prázdnych sa dá nechať čakať bez simulovania celého reťazca.
import { describe, expect, it } from 'vitest';
import { hinterlandQueue } from '@sim/world';
import { hinterlandData, inspectorData } from '@app/inspector-data';
import { hinterlandRows } from '@ui/module-inspector';
import { GATE_ID, buildLandside, createApp, type App } from './app-fixtures';

const LINE = 'blue_anchor';

/** Svet s bránou, ale bez ciest a rámp: plán návratov prázdnych čaká vo vnútrozemí, kým neuplynie čas. */
function gateOnlyApp(): App {
  const app = createApp();
  buildLandside(app, { roads: false, parts: ['gate'] });
  return app;
}

describe('inspectorData: brána — vnútrozemie (F6d)', () => {
  it('prázdny prístav: nikto nečaká — samé nuly a mierka herného času z hodín sveta', () => {
    const app = createApp();
    buildLandside(app);
    const { ticksPerHour, ticksPerDay } = app.world.clock;
    expect(inspectorData(app.bridge, GATE_ID)?.gate?.hinterland).toEqual({
      pickup: 0,
      delivery: 0,
      collect: 0,
      total: 0,
      oldestWaitTicks: 0,
      scale: { ticksPerHour, ticksPerDay },
    });
  });

  it('čakajúce návraty prázdnych sa započítajú do dovozu a najdlhšie čakanie rastie s tickmi od dueTick', () => {
    const app = gateOnlyApp();
    const { world } = app;
    world.emptyFlow.scheduleReturn(0, LINE);
    world.emptyFlow.scheduleReturn(5, LINE);
    for (let i = 0; i < 40; i += 1) world.tick();
    const waiting = inspectorData(app.bridge, GATE_ID)?.gate?.hinterland;
    expect(waiting).toMatchObject({ pickup: 0, delivery: 2, collect: 0, total: 2, oldestWaitTicks: world.clock.tick });
    expect(world.clock.tick).toBe(40);
    expect(waiting?.oldestWaitTicks).toBe(40);
    // zhoda s dotazom sveta, z ktorého sa dáta berú
    const queue = hinterlandQueue(world);
    expect(waiting).toMatchObject({ pickup: queue.pickup, delivery: queue.delivery, collect: queue.collect, total: queue.total, oldestWaitTicks: queue.oldestWaitTicks });
  });

  it('položka plánu s dueTick v budúcnosti ešte nečaká', () => {
    const app = gateOnlyApp();
    app.world.emptyFlow.scheduleReturn(500, LINE);
    for (let i = 0; i < 10; i += 1) app.world.tick();
    expect(inspectorData(app.bridge, GATE_ID)?.gate?.hinterland).toMatchObject({ delivery: 0, total: 0, oldestWaitTicks: 0 });
  });

  it('riadky inšpektora: počet, rozpis „dovoz 2“ a najdlhšie čakanie v hodinách a minútach herného času', () => {
    const app = gateOnlyApp();
    app.world.emptyFlow.scheduleReturn(0, LINE);
    app.world.emptyFlow.scheduleReturn(0, LINE);
    const { ticksPerHour } = app.world.clock;
    // pol hodiny a štvrť hodiny herného času
    const ticks = Math.round(ticksPerHour * 0.75);
    for (let i = 0; i < ticks; i += 1) app.world.tick();
    const rows = hinterlandRows(hinterlandData(app.world));
    expect(rows.map((row) => [row.key, row.value])).toEqual([
      ['total', '2'],
      ['split', 'dovoz 2'],
      ['oldest', '45 min'],
    ]);
  });
});
