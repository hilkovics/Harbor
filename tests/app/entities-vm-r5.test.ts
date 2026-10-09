// TR5-05: VM napojenie R5 — OOG a reefer stav na kontajneri, zásuvky reefer bloku, reach stacker na OOG ploche, financie (energia), čipy zmesi typov.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { ReachStacker } from '@sim/machines';
import { RtgBlock, YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import type { Contract } from '@sim/contracts';
import { typeMixChips } from '@app/contract-cards';
import { machineVMs, moduleVMs, reeferPlugState } from '@app/entities-vm';
import { financeVM } from '@app/finance-vm';
import { reeferInspectorData } from '@app/reefer-inspector-data';
import { createApp, runCommands } from './app-fixtures';

const TEU = 'container_teu';
const id = (value: number): EntityId => value as EntityId;

function build() {
  const app = createApp();
  runCommands(app, [
    { type: 'PlaceModule', defId: 'reefer_block_8', x: 48, y: 19, rotation: 0 },
    { type: 'PlaceModule', defId: 'oog_area', x: 54, y: 19, rotation: 0 },
  ]);
  const blocks = [...app.world.modules.values()].filter((module): module is YardBlock => module instanceof YardBlock);
  const reeferBlock = blocks.find((block) => block.def.id === 'reefer_block_8');
  const oogArea = blocks.find((block) => block.def.id === 'oog_area');
  if (reeferBlock === undefined || oogArea === undefined) throw new Error('bloky sa nepostavili');
  return { app, reeferBlock, oogArea };
}

/** Jednotka vznikne na lodi a reťazou povolených prechodov skončí v sklade bloku. */
function stock(world: World, block: YardBlock, containerType: string, bay: number, row: number, oog = false): EntityId {
  const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }, null, { direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium', sizeFt: 20, containerType, oog });
  world.cargo.move(unit.id, { kind: 'in_crane', craneId: id(901) });
  world.cargo.move(unit.id, { kind: 'on_apron', berthId: id(902), slot: 0 });
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: id(903) });
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, 0) });
  return unit.id;
}

describe('TR5-05: VM napojenie R5', () => {
  it('reefer blok nesie zásuvky so stavom podľa reeferov (empty = voľná) a top.reefer', () => {
    const { app, reeferBlock } = build();
    const plugged = stock(app.world, reeferBlock, 'reefer', 0, 0);
    const off = stock(app.world, reeferBlock, 'reefer', 1, 0);
    const alarm = stock(app.world, reeferBlock, 'reefer', 2, 0);
    const base = app.world.cargo.get(plugged)?.reefer;
    if (base === null || base === undefined) throw new Error('reefer stav chýba');
    app.world.cargo.setReefer(plugged, { ...base, plugged: true, unpluggedSinceTick: null });
    app.world.cargo.setReefer(off, { ...base, plugged: false, unpluggedSinceTick: 0 });
    app.world.cargo.setReefer(alarm, { ...base, plugged: true, unpluggedSinceTick: null, alarmUntilTick: 500 });
    const vm = moduleVMs(app.world).find((module) => module.id === reeferBlock.id);
    expect(vm?.plugs).toHaveLength(reeferBlock.plugCells().length);
    const at = (bay: number) => vm?.plugs?.[bay]?.state;
    expect([at(0), at(1), at(2), at(3)]).toEqual(['on', 'off', 'alarm', 'empty']);
    const top = vm?.stacks?.find((stack) => stack.bay === 0 && stack.row === 0)?.top;
    expect(top?.containerType).toBe('reefer');
    expect(top?.reefer).toBe(reeferPlugState(app.world.cargo.get(plugged)!));
    expect(top?.reefer).toBe('on');
    const panel = reeferInspectorData(app.world, reeferBlock.id);
    expect(panel?.plugsUsed).toBe(2);
    expect(panel?.alarms).toHaveLength(1);
    expect(panel?.unplugged).toHaveLength(1);
  });

  it('OOG kontajner nesie oog; reach stacker má angle, boom a stred v uličke', () => {
    const { app, oogArea } = build();
    const unitId = stock(app.world, oogArea, 'open_top', 0, 0, true);
    const top = moduleVMs(app.world).find((module) => module.id === oogArea.id)?.stacks?.find((stack) => stack.bay === 0 && stack.row === 0)?.top;
    expect(top?.oog).toBe(true);
    expect(app.world.cargo.get(unitId)?.oog).toBe(true);
    const machine = machineVMs(app.world).find((vm) => vm.defId === 'reach_stacker');
    expect(machine).toBeDefined();
    expect(app.world.machines.get(machine!.id as EntityId)).toBeInstanceOf(ReachStacker);
    expect(machine?.angle).toBe(270);
    expect(machine?.boom).toBe(0);
    expect(machine?.x).toBe(oogArea.origin.x + (oogArea as RtgBlock).laneCol + 0.5);
    expect(machine?.cargo).toBeNull();
  });

  it('financeVM: energia z kategórie ledgera `energy` (kladné = zaplatené)', () => {
    const { app } = build();
    expect(financeVM(app.world).energyCents).toBe(0);
    app.world.economy.post(-1200, 'energy');
    expect(financeVM(app.world).energyCents).toBe(1200);
    expect(financeVM(app.world).categories.some((row) => row.id === 'energy')).toBe(false);
  });

  it('typeMixChips: počty podľa unitTypes a OOG podľa oogUnits', () => {
    const contract = { unitTypes: ['dry', 'reefer', 'dry', 'flat_rack'], oogUnits: [3] } as unknown as Contract;
    expect(typeMixChips(contract)).toEqual([
      { type: 'dry', count: 2 },
      { type: 'reefer', count: 1 },
      { type: 'flat_rack', count: 1, oogCount: 1 },
    ]);
    expect(typeMixChips({ unitTypes: [], oogUnits: [] } as unknown as Contract)).toBeUndefined();
  });
});
