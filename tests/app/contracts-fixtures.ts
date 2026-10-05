// Spoločné pomôcky pre testy kontraktov v `src/app` (T05-07): aplikácia s upraveným `economy.json` a posun hry o ticky.
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import { DefRegistry } from '@sim/defs';
import { MAP } from '../sim/world/world-fixtures';
import { World } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import { setCash } from '../sim/helpers/economy';
import { SEED, type App } from './app-fixtures';

/**
 * Aplikácia s prepísanými poľami `economy.json` (napr. `bankruptcyDays: 1`, aby bankrot prišiel po prvom dni) a voliteľne
 * s nastavenou hotovosťou (aj zápornou — `startingCashCents` schéma zakazuje).
 */
export function createAppWithEconomy(patch: Partial<typeof economyJson>, cashCents?: number): App {
  const defs = DefRegistry.fromRaw({
    time: timeJson,
    economy: { ...economyJson, ...patch },
    infrastructure: infrastructureJson,
    cargo_types: cargoTypesJson,
    modules: modulesJson,
    ships: shipsJson,
    vehicles: vehiclesJson,
    trucks: trucksJson,
    logistics: logisticsJson,
    contract_templates: contractTemplatesJson,
    lines: linesJson,
  });
  const world = World.create(defs, MAP, SEED);
  if (cashCents !== undefined) setCash(world, cashCents);
  const bridge = new SimBridge(world);
  return { world, bridge, loop: new GameLoop(world, bridge) };
}

/** Posunie hru o `ticks` tickov (rýchlosť 1×, po dávkach najviac `maxTicksPerFrame`, každá dávka = jeden publish). */
export function runTicks(app: App, ticks: number): void {
  const batch = app.world.defs.time.maxTicksPerFrame;
  let left = ticks;
  while (left > 0) {
    const now = Math.min(batch, left);
    app.loop.frame(app.loop.tickMs * now);
    left -= now;
  }
}

/** Posunie hru o celé herné dni. */
export function runDays(app: App, days: number): void {
  runTicks(app, days * app.world.clock.ticksPerDay);
}

/** Id prvej ponuky (najnižšie id v stave `offered`). */
export function firstOfferId(app: App): number {
  for (const contract of app.world.contracts.values()) if (contract.state === 'offered') return contract.id;
  throw new Error('žiadna ponuka kontraktu');
}
