// Spoločné pomôcky pre testy ovládania mapy (T01-11, T02-10): falošné ghosty, výbery, ktoré `InputController`
// vyžaduje, a `harness()` — svet + most + kamera + ovládanie prepojené tak, ako ich zapojí bootstrap.
import type { CellCoord } from '@sim/grid';
import { Camera } from '@render/camera';
import type { GhostArrow, GhostCell, GhostView } from '@render/build-layer';
import type { ModuleGhostVM } from '@render/view-models';
import { BuildSelection } from '@app/build-selection';
import { InputController, type GhostArrowsTarget, type InputState, type KeyInput, type ModuleGhostView } from '@app/input-controller';
import { ModuleSelection } from '@app/module-selection';
import { RoadSelection } from '@app/road-selection';
import { createApp } from './app-fixtures';

/** Zaznamenáva ghost cesty (`setGhost` / `clearGhost`). */
export class FakeGhost implements GhostView {
  cells: readonly GhostCell[] = [];
  setCalls = 0;
  clearCalls = 0;

  setGhost(cells: readonly GhostCell[]): void {
    this.cells = cells;
    this.setCalls += 1;
  }

  clearGhost(): void {
    this.cells = [];
    this.clearCalls += 1;
  }
}

/** Zaznamenáva, čo `InputController` odovzdal rendereru ako ghost modulu. */
export class FakeModuleGhost implements ModuleGhostView {
  /** Aktuálny ghost (`null` = skrytý). */
  ghost: ModuleGhostVM | null = null;
  setCalls = 0;

  setModuleGhost(ghost: ModuleGhostVM | null): void {
    this.ghost = ghost;
    this.setCalls += 1;
  }
}

/** Zaznamenáva šípky smeru jednosmerky, ktoré `InputController` odovzdal rendereru (`null` = skryté). */
export class FakeGhostArrows implements GhostArrowsTarget {
  arrows: readonly GhostArrow[] | null = null;
  setCalls = 0;

  setGhostArrows(arrows: readonly GhostArrow[] | null): void {
    this.arrows = arrows;
    this.setCalls += 1;
  }
}

/** Závislosti výberu pre `new InputController({ …, ...selectionDeps() })`. */
export function selectionDeps(): { moduleGhost: FakeModuleGhost; buildSelection: BuildSelection; moduleSelection: ModuleSelection } {
  return { moduleGhost: new FakeModuleGhost(), buildSelection: new BuildSelection(), moduleSelection: new ModuleSelection() };
}

export function harness() {
  const { world, bridge, loop } = createApp();
  const camera = new Camera({
    cellPx: 64,
    mapWidth: world.grid.width,
    mapHeight: world.grid.height,
    viewportWidth: 1280,
    viewportHeight: 720,
    zoom: 1,
    focus: { x: 40, y: 18, w: 8, h: 4 },
  });
  const ghost = new FakeGhost();
  const deps = selectionDeps();
  const roadSelection = new RoadSelection();
  const arrows = new FakeGhostArrows();
  const states: InputState[] = [];
  const controller = new InputController({
    bridge,
    camera,
    ghost,
    ...deps,
    roadSelection,
    ghostArrows: arrows,
    onStateChange: (state) => states.push(state),
  });
  /** Stred bunky na obrazovke (poloha kurzora v px vzhľadom na mapu). */
  const at = (x: number, y: number): { x: number; y: number } => camera.cellCenterToScreen(x, y);
  const down = (cell: CellCoord, button = 0): boolean => controller.pointerDown({ button, ...at(cell.x, cell.y) });
  const move = (cell: CellCoord): void => {
    const p = at(cell.x, cell.y);
    controller.pointerMove(p.x, p.y);
  };
  const up = (cell: CellCoord, button = 0): void => {
    controller.pointerUp({ button, ...at(cell.x, cell.y) });
  };
  /** Frame bez plynutia času: aplikuje príkazy z fronty a rozpošle udalosti. */
  const frame = (): void => {
    loop.frame(0);
  };
  return { world, bridge, loop, camera, ghost, arrows, roadSelection, states, controller, at, down, move, up, frame, ...deps };
}

export const key = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  code,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

export const c = (x: number, y: number): CellCoord => ({ x, y });
