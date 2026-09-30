/**
 * Ladiaci háčik `window.__sim` (ARCHITECTURE §16, E2E): sprístupní `World` a `SimBridge` Playwrightu a konzole.
 * Aktívny výlučne vo vývojovom builde (`import.meta.env.DEV`); v produkčnom builde je z modulu mŕtvy kód.
 */
import type { ModuleGhostVM } from '@render/view-models';
import { commandFromJSON, type SerializedCommand, type ValidationResult } from '@sim/commands';
import type { World } from '@sim/world';
import type { SimEntitiesVM } from './entities-vm';
import type { SimBridge } from './sim-bridge';

/**
 * Čo renderer práve kreslí (`window.__sim.rendered()`): počty views (e2e overí, že `syncEntities` naozaj vytvorilo
 * views) a stav vrstvy stavby (ghost, obrys výberu).
 */
export interface RenderedCounts {
  readonly modules: number;
  readonly cranes: number;
  readonly ships: number;
  /** Vozidlá (`VehicleView`, F3). */
  readonly vehicles: number;
  /** Bunky ghostu stavby (cesta aj modul), ktoré sú práve zobrazené. */
  readonly ghostCells: number;
  /** Značky konektorov ghostu modulu, ktoré sú práve zobrazené. */
  readonly ghostConnectors: number;
  /** Obrys výberu modulu (`selection_ring`) je zobrazený. */
  readonly selectionRing: boolean;
}

export interface DevHook {
  readonly world: World;
  readonly bridge: SimBridge;
  /**
   * Aktuálne render view-modely (moduly, žeriavy, lode, vozidlá) — presne to, čo dostáva `WorldRenderer.syncEntities`.
   * Bez `grid`, takže sa dá vrátiť z `page.evaluate`.
   */
  readonly entities: () => SimEntitiesVM;
  /**
   * Príkaz zo serializovaného tvaru (`{ type: 'PlaceRoad', cells: [...] }`, `{ type: 'BuyVehicle', … }`) — e2e ním
   * postaví cesty, sklady a depo bez klikania. Ide cez `validate` a `dispatch` len pri `ok` (pravidlo 5); vráti výsledok
   * validácie (`ok`, `reasons`, `costCents`), aby test videl prečo príkaz neprešiel. Aplikuje sa pri najbližšom frame.
   */
  readonly dispatchJSON: (command: SerializedCommand) => ValidationResult;
  /**
   * STRED bunky (x, y) v súradniciach stránky (CSS px, vrátane posunu canvasu) — presne tam, kam má e2e kliknúť.
   * Doplní bootstrap z kamery (T01-11).
   */
  cellToScreen?: (cellX: number, cellY: number) => { x: number; y: number };
  /** Počet views vo vrstvách rendereru (moduly, žeriavy, lode) a stav ghostu; doplní bootstrap z rendereru. */
  rendered?: () => RenderedCounts;
  /**
   * Ghost modulu, ktorý ovládanie práve odovzdalo rendereru (`valid`, konektory po rotácii), alebo `null`, keď žiadny
   * nie je. Doplní bootstrap z `InputController`.
   */
  moduleGhost?: () => ModuleGhostVM | null;
  /**
   * Vycentruje kameru na bunku (x, y), voliteľne s daným zoomom (1 = bunka `--cell` px) — e2e s ním zamerá pohľad na
   * Root berth. Doplní bootstrap z kamery.
   */
  centerOn?: (cellX: number, cellY: number, zoom?: number) => void;
}

declare global {
  interface Window {
    __sim?: DevHook;
  }
}

export interface DevHookOptions {
  /** Predvolene `import.meta.env.DEV`; test ho vie vynútiť. */
  readonly enabled?: boolean;
  /** Kam háčik zapísať; predvolene `window` (v Node bez `window` sa nič nestane). */
  readonly target?: { __sim?: DevHook } | null;
  readonly cellToScreen?: DevHook['cellToScreen'];
  readonly rendered?: DevHook['rendered'];
  readonly moduleGhost?: DevHook['moduleGhost'];
  readonly centerOn?: DevHook['centerOn'];
}

/** Nainštaluje `window.__sim = { world, bridge, entities, dispatchJSON, cellToScreen?, rendered?, moduleGhost?, centerOn? }`. Vráti háčik, alebo `null`, ak je vypnutý/nie je cieľ. */
export function installDevHook(bridge: SimBridge, options: DevHookOptions = {}): DevHook | null {
  const enabled = options.enabled ?? import.meta.env.DEV;
  if (!enabled) return null;
  const target = options.target === undefined ? (typeof window === 'undefined' ? null : window) : options.target;
  if (target === null) return null;
  const hook: DevHook = {
    world: bridge.world,
    bridge,
    entities: () => bridge.entities(),
    dispatchJSON: (json) => {
      const command = commandFromJSON(json);
      const result = bridge.validate(command);
      if (result.ok) bridge.dispatch(command);
      return result;
    },
  };
  if (options.cellToScreen !== undefined) hook.cellToScreen = options.cellToScreen;
  if (options.rendered !== undefined) hook.rendered = options.rendered;
  if (options.moduleGhost !== undefined) hook.moduleGhost = options.moduleGhost;
  if (options.centerOn !== undefined) hook.centerOn = options.centerOn;
  target.__sim = hook;
  return hook;
}
