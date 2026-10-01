// T06-03: runGame + SaveController — načítanie = reštart nad obnoveným svetom v pauze, nová hra štartuje s defaultSpeed
// z nastavení, nastavenia a sloty prežijú reštart. Bootstrap je falošný (Pixi v Node nie je), zapojenie spravujú testy
// tak ako bootstrap: `applyStartSpeed(world, options.startSpeed)` a `SaveController({ loadWorld: options.onLoadGame })`.
import { describe, expect, it, vi } from 'vitest';
import { SetGameSpeedCommand } from '@sim/commands';
import { World, stateHash } from '@sim/world';
import type { AppHandle, BootstrapOptions } from '@app/bootstrap';
import { runGame } from '@app/run-game';
import { SaveController, createPersistence } from '@app/save/save-controller';
import { DEFAULT_SETTINGS } from '@app/settings';
import { SimBridge } from '@app/sim-bridge';
import { applyStartSpeed } from '@app/start-speed';
import { createWorld } from '../app-fixtures';
import { FakeStorage } from './save-fixtures';

const ROOT = {} as HTMLElement;

interface Booted {
  readonly options: BootstrapOptions;
  readonly destroy: ReturnType<typeof vi.fn>;
}

function fakeBoot() {
  const booted: Booted[] = [];
  const boot = (_root: HTMLElement, options: BootstrapOptions): Promise<AppHandle> => {
    const destroy = vi.fn();
    booted.push({ options, destroy });
    return Promise.resolve({ destroy } as unknown as AppHandle);
  };
  return { boot, booted };
}

describe('runGame: rýchlosť pri štarte', () => {
  it('prvá hra štartuje s defaultSpeed z nastavení; bez uložených nastavení 1×', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence: createPersistence(() => new FakeStorage()) });
    await runner.current();
    expect(booted[0]?.options.startSpeed).toBe(DEFAULT_SETTINGS.defaultSpeed);
    expect(booted[0]?.options.startSpeed).toBe(1);
  });

  it('uložená predvolená rýchlosť sa použije pri štarte (aj pauza 0)', async () => {
    const storage = new FakeStorage();
    const persistence = createPersistence(() => storage);
    persistence.settings.set({ ...DEFAULT_SETTINGS, defaultSpeed: 0 });
    const { boot, booted } = fakeBoot();
    await runGame(ROOT, { boot, persistence }).current();
    expect(booted[0]?.options.startSpeed).toBe(0);
  });

  it('„Nová hra“ čítá nastavenia v čase reštartu (zmena v Nastaveniach platí hneď)', async () => {
    const persistence = createPersistence(() => new FakeStorage());
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence, nextSeed: () => 11 });
    await runner.current();
    persistence.settings.set({ ...DEFAULT_SETTINGS, defaultSpeed: 8 });
    booted[0]?.options.onNewGame?.();
    await runner.current();
    expect(booted[1]?.options.startSpeed).toBe(8);
  });

  it('sloty a nastavenia (persistence) zdieľajú všetky hry relácie', async () => {
    const persistence = createPersistence(() => new FakeStorage());
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence });
    await runner.current();
    booted[0]?.options.onNewGame?.();
    await runner.current();
    expect(booted[0]?.options.persistence).toBe(persistence);
    expect(booted[1]?.options.persistence).toBe(persistence);
  });
});

describe('runGame: načítanie uloženej hry', () => {
  it('onLoadGame(world) zruší bežiacu hru a spustí novú nad tým svetom v pauze', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence: createPersistence(() => new FakeStorage()) });
    await runner.current();
    expect(booted[0]?.options.onLoadGame).toBeTypeOf('function');
    const loaded = createWorld();
    booted[0]?.options.onLoadGame?.(loaded);
    await runner.current();
    expect(booted[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(booted).toHaveLength(2);
    expect(booted[1]?.options.world).toBe(loaded);
    expect(booted[1]?.options.startSpeed).toBe(0);
    expect(booted[1]?.options.onLoadGame).toBeTypeOf('function'); // ďalšie načítanie ide z novej hry
  });

  it('pauza má prednosť pred defaultSpeed z nastavení', async () => {
    const persistence = createPersistence(() => new FakeStorage());
    persistence.settings.set({ ...DEFAULT_SETTINGS, defaultSpeed: 8 });
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence });
    await runner.current();
    booted[0]?.options.onLoadGame?.(createWorld());
    await runner.current();
    expect(booted[0]?.options.startSpeed).toBe(8);
    expect(booted[1]?.options.startSpeed).toBe(0);
  });

  it('dvojité načítanie naraz spustí len jeden reštart; po dispose sa nenačíta', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence: createPersistence(() => new FakeStorage()) });
    await runner.current();
    const onLoad = booted[0]?.options.onLoadGame;
    onLoad?.(createWorld());
    onLoad?.(createWorld());
    await runner.current();
    expect(booted).toHaveLength(2);
    await runner.dispose();
    booted[1]?.options.onLoadGame?.(createWorld());
    await runner.current();
    expect(booted).toHaveLength(2);
  });
});

describe('uloženie → načítanie → štart v pauze (zostava ako v bootstrape)', () => {
  /** Hra bežiaca nad svetom `world` so `SaveController` napojeným na `runGame` rovnako ako v `bootstrap`. */
  async function setup() {
    const storage = new FakeStorage();
    const persistence = createPersistence(() => storage);
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, persistence });
    await runner.current();
    const world = createWorld({ checkInvariants: false });
    const controller = new SaveController({
      bridge: new SimBridge(world),
      persistence,
      notify: () => undefined,
      ...(booted[0]?.options.onLoadGame === undefined ? {} : { loadWorld: booted[0].options.onLoadGame }),
    });
    return { world, controller, runner, booted };
  }

  it('načítaná hra: rovnaký stateHash, v prvom frame sa pozastaví pred prvým tickom', async () => {
    const { world, controller, runner, booted } = await setup();
    for (let i = 0; i < 400; i += 1) world.tick();
    controller.save('1');
    const savedState = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    expect(world.clock.speed).toBe(1);

    expect(controller.load('1')).toEqual({ ok: true });
    await runner.current();
    expect(booted).toHaveLength(2);
    const loaded = booted[1]?.options.world as World;

    // Pred prvým frame je svet presne uložený stav.
    expect(stateHash(loaded)).toBe(stateHash(world));
    // „bootstrap“ zaradí štartovú rýchlosť; prvý frame ju aplikuje bez jediného ticku.
    applyStartSpeed(loaded, booted[1]?.options.startSpeed);
    loaded.applyPending();
    expect(loaded.clock.speed).toBe(0);
    expect(loaded.clock.tick).toBe(400);
    // Stav = uložený stav, v ktorom sa len zmenila rýchlosť na pauzu.
    const twin = World.deserialize(world.defs, world.map, savedState);
    twin.enqueue(new SetGameSpeedCommand(0));
    twin.applyPending();
    expect(stateHash(loaded)).toBe(stateHash(twin));
  });

  it('hra uložená v pauze sa načíta presne (bez zmeny hashu)', async () => {
    const { world, controller, runner, booted } = await setup();
    for (let i = 0; i < 100; i += 1) world.tick();
    applyStartSpeed(world, 0);
    world.applyPending();
    controller.save('2');
    const savedHash = stateHash(world);
    controller.load('2');
    await runner.current();
    const loaded = booted[1]?.options.world as World;
    applyStartSpeed(loaded, booted[1]?.options.startSpeed);
    expect(loaded.pendingCommandCount).toBe(0); // už stojí, príkaz netreba
    expect(stateHash(loaded)).toBe(savedHash);
  });

  it('chybný save: reštart sa nespustí, bežiaca hra ostáva', async () => {
    const { controller, runner, booted } = await setup();
    expect(controller.load('3').ok).toBe(false); // prázdny slot
    await runner.current();
    expect(booted).toHaveLength(1);
    expect(booted[0]?.destroy).not.toHaveBeenCalled();
  });
});
