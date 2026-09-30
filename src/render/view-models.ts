/**
 * Render view-modely (docs/tasks/phase-02.md a phase-03.md, „Render view-modely“): jediná zmluva medzi simom a rendererom.
 *
 * Renderer nikdy nečíta `World` — dostane tieto ploché, readonly-podobné DTO (naplní ich SimBridge, T02-09) a vytvára,
 * aktualizuje a ničí view podľa `id`. Všetky polohy sú v bunkách gridu; px sa počítajú až v rendereri (`--cell`).
 */

/** Rotácia v stupňoch v smere hodinových ručičiek (0 = sever hore). */
export type ViewRotation = 0 | 90 | 180 | 270;

/** Strana bunky / modulu (svetová strana). */
export type ViewSide = 'n' | 'e' | 's' | 'w';

export interface ModuleVM {
  id: number;
  defId: string;
  kind: string;
  /** Ľavý horný roh footprintu PO rotácii (bunky). */
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  /** Rozmery footprintu PO rotácii (bunky). */
  w: number;
  h: number;
  /** Len berth: kapacita apronu a obsadené sloty (`slot` = index do `sprites.<defId>.apronSlots` v manifeste). */
  apron?: { capacity: number; units: { slot: number; unitId: number; typeId: string }[] };
  /**
   * Len sklad (kind `storage`): kapacita, uložené a rezervované jednotky. Sprite skladu sa volí podľa `stored / capacity`
   * (`fillState`); `reserved` renderer nekreslí (je to údaj pre UI).
   */
  storage?: { capacity: number; stored: number; reserved: number };
  /**
   * Len moduly s konektormi: má aspoň jeden cestný konektor pripojený k ceste? `false` → odznak `overlay.warning_badge`;
   * `undefined` (F2 VM, modul bez konektorov) → bez odznaku.
   */
  connected?: boolean;
}

export interface CraneVM {
  id: number;
  defId: string;
  berthId: number;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  state: 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked';
  /** Postup aktuálnej fázy 0..1. */
  progress: number;
  holding: { unitId: number; typeId: string } | null;
}

export interface ShipVM {
  id: number;
  classId: string;
  /** Kategória nákladu lode (`container`, `bulk`, `liquid`, `gas`, `roro`); určuje variant sprite. */
  cargoCategory: string;
  state: string;
  /** Stred lode v bunkách; renderer interpoluje `lerp(prev, curr, alpha)`. */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** 0 = predok na sever, v smere hodinových ručičiek. */
  heading: 0 | 90 | 180 | 270;
  lengthCells: number;
  widthCells: number;
  unitsOnBoard: number;
  capacityUnits: number;
}

/** Vozidlo na cestách (F3: straddle carrier). Poloha je stred vozidla v bunkách (stred bunky = `x + 0.5`). */
export interface VehicleVM {
  id: number;
  /** Id definície vozidla = kľúč `entities.<defId>` v manifeste (`straddle_carrier`). */
  defId: string;
  /** Stred vozidla v bunkách; renderer interpoluje `lerp(prev, curr, alpha)`. */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** 0 = predok na sever, v smere hodinových ručičiek (kardinálny podľa smeru posledného úseku cesty). */
  heading: 0 | 90 | 180 | 270;
  /** Vezie jednotku nákladu → sprite `states.loaded`. */
  loaded: boolean;
  /** Stav FSM vozidla (`idle`, `to_pickup`, …); renderer ho zatiaľ nekreslí, nesie ho pre ladenie a budúce odznaky. */
  state: string;
}

export interface EntitiesVM {
  modules: readonly ModuleVM[];
  cranes: readonly CraneVM[];
  ships: readonly ShipVM[];
  /**
   * Vozidlá (F3). Voliteľné kvôli spätnej kompatibilite: VM zložené vo F2 (`src/app`) pole nemajú a renderer ho berie
   * ako prázdne. `SimBridge` (T03-10) ho vyplní vždy.
   */
  vehicles?: readonly VehicleVM[];
}

export interface ModuleGhostVM {
  defId: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  w: number;
  h: number;
  valid: boolean;
  /** Konektory v SVETOVÝCH bunkách po rotácii; `side` = strana vjazdu (po rotácii). */
  connectors: { x: number; y: number; side: 'n' | 'e' | 's' | 'w' }[];
}
