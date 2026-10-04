// Udalosti modulov (T02-04, „Spoločné rozhrania" F2): ModulePlaced { moduleId, defId, x, y, rotation, cells } a
// ModuleRemoved { moduleId, defId, cells } sú členmi únie SimEvent a prejdú EventBus bez zmeny.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { EventBus } from '@sim/core/event-bus';
import type { ModulePlacedEvent, ModuleRemovedEvent, SimEvent, SimEventOf } from '@sim/events';

const moduleId = 7 as EntityId;
const cells = [{ x: 40, y: 14 }, { x: 41, y: 14 }];

describe('ModulePlaced / ModuleRemoved', () => {
  it('sú v únii SimEvent a SimEventOf ich vyberie podľa typu', () => {
    const placed: SimEventOf<'ModulePlaced'> = { type: 'ModulePlaced', moduleId, defId: 'berth_standard', x: 40, y: 14, rotation: 0, cells };
    const removed: SimEventOf<'ModuleRemoved'> = { type: 'ModuleRemoved', moduleId, defId: 'berth_standard', cells };
    const typed: [ModulePlacedEvent, ModuleRemovedEvent] = [placed, removed];
    const bus = new EventBus<SimEvent>();
    for (const event of typed) bus.emit(event);
    expect(bus.flush()).toEqual([
      { type: 'ModulePlaced', moduleId: 7, defId: 'berth_standard', x: 40, y: 14, rotation: 0, cells },
      { type: 'ModuleRemoved', moduleId: 7, defId: 'berth_standard', cells },
    ]);
  });
});
