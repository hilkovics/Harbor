/**
 * InputController (ARCHITECTURE §15.2): zmení vstup hráča (myš, koleso, klávesy) na pohyb kamery, ghost stavby
 * a `Command`-y. Nepozná DOM ani Pixi — dostáva normalizované vstupy (`pointerDown`, `keyDown`, …) a hovorí s
 * kamerou, ghostom a `SimBridge` cez úzke rozhrania, takže sa dá testovať v Node. Väzbu na skutočné DOM udalosti
 * (a rozhodnutie „patrí to UI alebo canvasu“) robí `dom-input.ts`.
 *
 * Režimy sú explicitný stavový automat (`INPUT_TRANSITIONS`, CLAUDE.md konvencie):
 *
 * | stav           | význam                                                    |
 * |----------------|-----------------------------------------------------------|
 * | `idle`         | bežný pohľad; ľavý/stredný ťah = posun kamery             |
 * | `pan`          | prebieha posun kamery ťahom (mimo build módu)             |
 * | `build`        | build mód „cesta“; hover ghost jednej bunky               |
 * | `build_place`  | ľavý ťah: zbiera bunky pre `PlaceRoad`                    |
 * | `build_remove` | pravý ťah: zbiera bunky pre `RemoveRoad`                  |
 * | `build_pan`    | stredný ťah v build móde: posun kamery, mód ostáva        |
 * | `build_module` | vybraný modul z BuildBaru; ghost footprintu sleduje kurzor |
 * | `build_module_place` | ľavé tlačidlo stlačené: pustenie umiestni modul     |
 * | `build_module_pan`   | stredný ťah v móde modulu: posun kamery, mód ostáva |
 *
 * Ovládanie: `B` build mód ciest, `Esc` zruší ťah, potom mód (v `idle` zruší výber modulu v inšpektore), `Space`
 * pauza/obnova poslednej nenulovej rýchlosti (rovnaká logika ako klik na ⏸: `resolveSpeedRequest`), `1–4` rýchlosti
 * podľa poradia v `time.speeds`, WASD/šípky posun kamery, koleso zoom s pivotom pod kurzorom.
 *
 * Build mód modulov (T02-10): výber v BuildBare (`BuildSelection`) prepne do `build_module`; `R` otočí ghost
 * 0 → 90 → 180 → 270, ľavý klik umiestni modul (`validate` → `dispatch(PlaceModule)` len pri `ok`), Esc alebo pravý klik
 * mód zruší (výber sa vynuluje). Po umiestnení mód ostáva aktívny. V `idle` klik (bez ťahu) na bunku modulu vyberie
 * modul (`ModuleSelection`; žeriav má prednosť pred kotviskom pod ním), klik do prázdna výber zruší.
 *
 * Zásada „nič sa nemení bez validácie“: ghost sa farbí podľa `bridge.validate`, `dispatch` ide len po úspešnej
 * validácii celého ťahu (príkazy sú atomické — jedna neplatná bunka odmietne celý ťah).
 */
import {
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  type Command,
  type ValidationReason,
  type ValidationResult,
} from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { CellCoord, Rotation } from '@sim/grid';
import type { Camera } from '@render/camera';
import type { BuildLayer, GhostCell, GhostView } from '@render/build-layer';
import type { ModuleGhostVM } from '@render/view-models';
import { interpolateCells } from './cell-line';
import { CLICK_SLOP_PX, KEY_PAN_MAX_DT_MS, KEY_PAN_PX_PER_SECOND, WHEEL_DELTA_MODE_PX, WHEEL_ZOOM_PER_PX } from './config';
import { nextRotation, placeCommand, previewModule, type ModulePreview } from './module-build';
import type { SelectionSource } from './selection-cell';
import type { SimBridge } from './sim-bridge';
import { resolveSpeedRequest } from './speed-request';

// ---- stavový automat ----

export type InputState =
  | 'idle'
  | 'pan'
  | 'build'
  | 'build_place'
  | 'build_remove'
  | 'build_pan'
  | 'build_module'
  | 'build_module_place'
  | 'build_module_pan';

/**
 * Udalosti, ktoré menia stav (nie pohyb myši ani zoom — tie stav nemenia). `module_selected` / `module_cleared` prichádzajú
 * zo zmeny výberu v BuildBare (`BuildSelection`).
 */
export type InputTrigger =
  | 'toggle_build'
  | 'cancel'
  | 'primary_down'
  | 'secondary_down'
  | 'middle_down'
  | 'release'
  | 'module_selected'
  | 'module_cleared';

/** Prechodová tabuľka; chýbajúci záznam = trigger sa v stave ignoruje (žiadne skryté prechody). */
export const INPUT_TRANSITIONS: Readonly<Record<InputState, Readonly<Partial<Record<InputTrigger, InputState>>>>> = Object.freeze({
  idle: { toggle_build: 'build', primary_down: 'pan', middle_down: 'pan', module_selected: 'build_module' },
  pan: { release: 'idle', cancel: 'idle' },
  build: {
    toggle_build: 'idle',
    cancel: 'idle',
    primary_down: 'build_place',
    secondary_down: 'build_remove',
    middle_down: 'build_pan',
    module_selected: 'build_module',
  },
  build_place: { release: 'build', cancel: 'build' },
  build_remove: { release: 'build', cancel: 'build' },
  build_pan: { release: 'build', cancel: 'build' },
  // Mód modulu: `B` prepne na stavbu ciest, pravé tlačidlo a Esc ho zrušia (výber v BuildBare sa vynuluje).
  build_module: {
    toggle_build: 'build',
    cancel: 'idle',
    primary_down: 'build_module_place',
    secondary_down: 'idle',
    middle_down: 'build_module_pan',
    module_selected: 'build_module',
    module_cleared: 'idle',
  },
  build_module_place: { release: 'build_module', cancel: 'build_module', module_cleared: 'idle' },
  build_module_pan: { release: 'build_module', cancel: 'build_module', module_cleared: 'idle' },
});

/** Nový stav po `trigger`, alebo `null`, ak sa v stave `from` ignoruje. */
export function transition(from: InputState, trigger: InputTrigger): InputState | null {
  return INPUT_TRANSITIONS[from][trigger] ?? null;
}

/** Stavy, v ktorých je build mód modulu zapnutý (je vybraná položka BuildBaru). */
export function isModuleState(state: InputState): boolean {
  return state === 'build_module' || state === 'build_module_place' || state === 'build_module_pan';
}

/** Stavy, v ktorých je zapnutý niektorý build mód (cesty alebo moduly). */
export function isBuildState(state: InputState): boolean {
  return state === 'build' || state === 'build_place' || state === 'build_remove' || state === 'build_pan' || isModuleState(state);
}

/** `MouseEvent.button` → trigger. */
const BUTTON_TRIGGER: Readonly<Record<number, InputTrigger | undefined>> = { 0: 'primary_down', 1: 'middle_down', 2: 'secondary_down' };

// ---- vstupy ----

export interface PointerInput {
  /** `MouseEvent.button`: 0 ľavé, 1 stredné, 2 pravé. */
  readonly button: number;
  /** Poloha v px vzhľadom na ľavý horný roh mapy (canvasu). */
  readonly x: number;
  readonly y: number;
}

export interface WheelInput {
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 px, 1 riadky, 2 stránky. */
  readonly deltaMode: number;
  readonly x: number;
  readonly y: number;
}

export interface KeyInput {
  /** `KeyboardEvent.code` (fyzická klávesa — nezávislé od rozloženia; na SK klávesnici sú číslice cez Shift). */
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

// ---- závislosti ----

/** Časť kamery, ktorú ovládanie používa; `Camera` ju spĺňa. */
export type InputCamera = Pick<Camera, 'pan' | 'zoomAt' | 'screenToCell'>;

/** Časť `SimBridge`, ktorú ovládanie používa. */
export type InputBridge = Pick<SimBridge, 'world' | 'dispatch' | 'validate' | 'snapshot' | 'onEvents'>;

/** Cieľ ghostu modulu (`BuildLayer.setModuleGhost`). */
export type ModuleGhostView = Pick<BuildLayer, 'setModuleGhost'>;

export interface InputControllerOptions {
  readonly bridge: InputBridge;
  readonly camera: InputCamera;
  readonly ghost: GhostView;
  /** Ghost modulu (footprint + konektory); typicky tá istá `BuildLayer` ako `ghost`. */
  readonly moduleGhost: ModuleGhostView;
  /** Výber položky v BuildBare (`defId`): jeho zmena zapína a vypína build mód modulov. */
  readonly buildSelection: SelectionSource<string>;
  /** Výber modulu na mape (id) pre inšpektor: nastavuje ho klik v `idle` móde, Esc ho zruší. */
  readonly moduleSelection: SelectionSource<EntityId>;
  /** Zmena režimu (kurzor, indikátor); volá sa len pri skutočnej zmene stavu. */
  readonly onStateChange?: (state: InputState) => void;
}

// ---- spätná väzba pre React (tooltip pri ghoste) ----

/** Druh stavby, ktorý ťah zbiera. */
export type BuildKind = 'place' | 'remove';

/** Druh spätnej väzby: ťah cesty (`place` / `remove`) alebo ghost modulu (`module`). */
export type FeedbackKind = BuildKind | 'module';

/**
 * Popis ghostu pre DOM (cena, dôvody) — kreslí ho React, nie Pixi. Nový objekt pri každej zmene; `null` = nič
 * nezobrazovať.
 */
export interface BuildFeedback {
  readonly kind: FeedbackKind;
  /** Celý ťah (alebo hover bunka) by prešiel validáciou. */
  readonly ok: boolean;
  readonly reasons: readonly ValidationReason[];
  /** Cena v centoch; pri `remove` záporná (refundácia, ADR-012). */
  readonly costCents: number;
  /** Počet buniek, ktoré príkaz skutočne zmení. */
  readonly cellCount: number;
  /** Poloha kurzora v px vzhľadom na mapu. */
  readonly x: number;
  readonly y: number;
  /** `true` počas ťahu, `false` pri hoveri. */
  readonly dragging: boolean;
  /** Len `module`: názov modulu (`displayName` defu). */
  readonly label?: string;
  /** Len `module`: druh modulu (`ModuleKind`) — určuje ikonu štítka. */
  readonly moduleKind?: string;
  /** Len `module`: hráč nemá na cenu — ghost môže byť zelený, ale klik nič nepostaví (ikona $). */
  readonly fundsShort?: boolean;
}

// ---- interné ----

interface Stroke {
  readonly kind: BuildKind;
  readonly cells: CellCoord[];
  readonly seen: Set<number>;
  /** Platnosť každej bunky samostatne (pre farbu ghostu); celkové rozhodnutie robí validácia celého ťahu. */
  readonly verdicts: Map<number, boolean>;
  /** Posledná bunka mapy, cez ktorú ťah prešiel — od nej sa interpoluje k ďalšej. */
  last: CellCoord | null;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

type PanDirection = 'left' | 'right' | 'up' | 'down';

/** Fyzické klávesy posunu kamery (`KeyboardEvent.code`). */
const PAN_KEYS: Readonly<Record<string, PanDirection | undefined>> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

const SPEED_KEY = /^(?:Digit|Numpad)([1-9])$/;

/** Udalosti sveta, po ktorých je ghost (platnosť, cena) zastaraný, hoci sa kurzor nepohol. */
const GHOST_STALE_EVENTS: ReadonlySet<string> = new Set([
  'RoadChanged',
  'MoneyChanged',
  'ModulePlaced',
  'ModuleRemoved',
  'ShipDocked',
  'ShipUndocked',
  'ShipDeparted',
]);

/** Ťah, ktorý nič nemení (bunka už má cestu), sa v ghoste ukazuje ako platný. */
function isNothingToDo(result: ValidationResult): boolean {
  return result.reasons.length === 1 && result.reasons[0] === 'empty';
}

export class InputController {
  private readonly bridge: InputBridge;
  private readonly camera: InputCamera;
  private readonly ghost: GhostView;
  private readonly moduleGhostView: ModuleGhostView;
  private readonly buildSelection: SelectionSource<string>;
  private readonly moduleSelection: SelectionSource<EntityId>;
  private readonly onStateChange: ((state: InputState) => void) | undefined;

  private stateValue: InputState = 'idle';
  /** Vybraná definícia modulu v módoch `build_module*` (zrkadlo `buildSelection`), inak `null`. */
  private moduleDefId: string | null = null;
  private moduleRotation: Rotation = 0;
  /** Posledný ghost modulu odovzdaný rendereru (`null` = nezobrazený). */
  private moduleGhostValue: ModuleGhostVM | null = null;
  /** Poloha stlačenia ľavého tlačidla v `pan` móde, kým ťah nepresiahol `CLICK_SLOP_PX` (potom je to posun, nie klik). */
  private clickStart: Point | null = null;
  private stroke: Stroke | null = null;
  /** Tlačidlo myši, ktoré drží aktuálny ťah/posun; ďalšie tlačidlá sa ignorujú, kým sa nepustí. */
  private activeButton: number | null = null;
  private dragLast: Point | null = null;
  /** Posledná známa poloha kurzora nad mapou (`null` = kurzor je mimo). */
  private pointer: Point | null = null;
  private readonly heldPanKeys = new Set<PanDirection>();
  private lastRunningSpeed: number | undefined;
  private ghostShown = false;
  private feedbackValue: BuildFeedback | null = null;
  private readonly feedbackListeners = new Set<() => void>();
  private readonly stopEvents: () => void;
  private readonly stopSelection: () => void;
  private disposed = false;

  constructor(options: InputControllerOptions) {
    this.bridge = options.bridge;
    this.camera = options.camera;
    this.ghost = options.ghost;
    this.moduleGhostView = options.moduleGhost;
    this.buildSelection = options.buildSelection;
    this.moduleSelection = options.moduleSelection;
    this.onStateChange = options.onStateChange;
    const speed = this.bridge.snapshot().speed;
    if (speed !== 0) this.lastRunningSpeed = speed;
    // Udalosti sveta: posledná nenulová rýchlosť (aby ju poznal aj Space po zmene rýchlosti cez HUD) a zmena
    // ciest/peňazí, po ktorej je ghost zastaraný (príkaz sa aplikuje až vo frame po pustení tlačidla).
    this.stopEvents = this.bridge.onEvents((events) => {
      let worldChanged = false;
      for (const event of events) {
        if (event.type === 'GameSpeedChanged' && event.speed !== 0) this.lastRunningSpeed = event.speed;
        if (GHOST_STALE_EVENTS.has(event.type)) worldChanged = true;
      }
      if (worldChanged) this.refreshGhost();
    });
    // Výber v BuildBare zapína a vypína build mód modulov; výber, ktorý už pri vzniku existuje, sa uplatní hneď.
    this.stopSelection = this.buildSelection.subscribe(() => {
      this.onBuildSelectionChanged();
    });
    if (this.buildSelection.get() !== null) this.onBuildSelectionChanged();
  }

  // ---- čítanie stavu ----

  get state(): InputState {
    return this.stateValue;
  }

  get buildMode(): boolean {
    return isBuildState(this.stateValue);
  }

  /** Definícia modulu vybraná v build móde modulov (`null` mimo neho). */
  get selectedDefId(): string | null {
    return this.moduleDefId;
  }

  /** Rotácia ghostu modulu (`R`). */
  get rotation(): Rotation {
    return this.moduleRotation;
  }

  /** Ghost modulu, ktorý práve zobrazuje renderer (`null` = žiadny); pre ladenie a e2e. */
  moduleGhost(): ModuleGhostVM | null {
    return this.moduleGhostValue;
  }

  /** Aktuálna spätná väzba ghostu pre DOM (`useSyncExternalStore`: stabilná referencia medzi zmenami). */
  feedback(): BuildFeedback | null {
    return this.feedbackValue;
  }

  subscribeFeedback(listener: () => void): () => void {
    this.feedbackListeners.add(listener);
    return () => {
      this.feedbackListeners.delete(listener);
    };
  }

  // ---- myš ----

  /** Stlačenie tlačidla nad mapou. @returns `true`, ak ho ovládanie spracovalo. */
  pointerDown(input: PointerInput): boolean {
    const trigger = BUTTON_TRIGGER[input.button];
    if (trigger === undefined || this.activeButton !== null) return false;
    const next = transition(this.stateValue, trigger);
    if (next === null) return false;
    this.activeButton = input.button;
    this.pointer = { x: input.x, y: input.y };
    this.setState(next);
    if (next === 'pan' || next === 'build_pan' || next === 'build_module_pan') {
      this.dragLast = this.pointer;
      // Ľavý ťah v `idle` je posun kamery, ale ak sa myš nepohla, je to klik = výber modulu.
      this.clickStart = next === 'pan' && input.button === 0 ? this.pointer : null;
    } else if (next === 'build_place' || next === 'build_remove') {
      this.stroke = { kind: next === 'build_place' ? 'place' : 'remove', cells: [], seen: new Set(), verdicts: new Map(), last: null };
      this.extendStroke(this.cellAt(input.x, input.y));
    }
    this.refreshGhost();
    return true;
  }

  pointerMove(x: number, y: number): void {
    this.pointer = { x, y };
    if (this.dragLast !== null) {
      this.camera.pan(x - this.dragLast.x, y - this.dragLast.y);
      this.dragLast = this.pointer;
      const start = this.clickStart;
      if (start !== null && Math.hypot(x - start.x, y - start.y) > CLICK_SLOP_PX) this.clickStart = null;
    } else if (this.stroke !== null) {
      this.extendStroke(this.cellAt(x, y));
    }
    this.refreshGhost();
  }

  /** Kurzor opustil mapu: hover ghost zmizne (rozpracovaný ťah ostáva, kým sa nepustí tlačidlo). */
  pointerLeave(): void {
    this.pointer = null;
    this.refreshGhost();
  }

  /** Pustenie tlačidla. Ťah sa odošle, ak je platný; posun kamery sa len ukončí. */
  pointerUp(input: PointerInput): void {
    if (input.button !== this.activeButton) return;
    this.pointer = { x: input.x, y: input.y };
    const stroke = this.stroke;
    if (stroke !== null) {
      this.extendStroke(this.cellAt(input.x, input.y));
      this.commit(stroke);
    } else if (this.stateValue === 'build_module_place') {
      this.commitModule();
    }
    const click = this.stateValue === 'pan' && this.clickStart !== null;
    this.endInteraction('release');
    if (click) this.pickModule(this.cellAt(input.x, input.y));
  }

  /** Prerušenie ťahu zvonku (stratené zachytenie myši, `pointercancel`). Nič sa neodošle. */
  pointerCancel(): void {
    if (this.activeButton === null) return;
    this.endInteraction('cancel');
  }

  wheel(input: WheelInput): void {
    const unit = WHEEL_DELTA_MODE_PX[input.deltaMode] ?? WHEEL_DELTA_MODE_PX[0];
    this.camera.zoomAt(Math.exp(-input.deltaY * unit * WHEEL_ZOOM_PER_PX), input.x, input.y);
    this.pointer = { x: input.x, y: input.y };
    // Kamera sa pohla pod stojacim kurzorom: bunka pod ním je iná.
    if (this.stroke !== null) this.extendStroke(this.cellAt(input.x, input.y));
    this.refreshGhost();
  }

  // ---- klávesnica ----

  /** @returns `true`, ak kláves ovládanie spracovalo (volajúci potom zavolá `preventDefault`). */
  keyDown(input: KeyInput): boolean {
    if (input.ctrlKey || input.altKey || input.metaKey) return false;
    const direction = PAN_KEYS[input.code];
    if (direction !== undefined) {
      this.heldPanKeys.add(direction);
      return true;
    }
    if (input.repeat) return this.isCommandKey(input.code);
    if (input.code === 'KeyB') return this.handleTrigger('toggle_build');
    if (input.code === 'KeyR') return this.rotateModule();
    if (input.code === 'Escape') return this.handleTrigger('cancel');
    if (input.code === 'Space') {
      this.togglePause();
      return true;
    }
    const digit = SPEED_KEY.exec(input.code);
    if (digit !== null) return this.setSpeedByIndex(Number(digit[1]) - 1);
    return false;
  }

  keyUp(code: string): void {
    const direction = PAN_KEYS[code];
    if (direction !== undefined) this.heldPanKeys.delete(direction);
  }

  /** Okno stratilo fokus: pustené klávesy by sa už nikdy nedoručili, preto sa zabudnú; rozpracovaný ťah sa zruší. */
  blur(): void {
    this.heldPanKeys.clear();
    if (this.activeButton !== null) this.endInteraction('cancel');
  }

  // ---- frame ----

  /** Volá sa raz za frame s reálnym časom od minulého framu: posun kamery klávesmi. */
  update(dtMs: number): void {
    if (this.heldPanKeys.size === 0 || !(dtMs > 0)) return;
    const held = this.heldPanKeys;
    const dirX = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const dirY = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
    if (dirX === 0 && dirY === 0) return;
    const step = (KEY_PAN_PX_PER_SECOND * Math.min(dtMs, KEY_PAN_MAX_DT_MS)) / 1000 / Math.hypot(dirX, dirY);
    // Kláves posúva POHĽAD, `Camera.pan` posúva OBSAH — opačné znamienko.
    this.camera.pan(-dirX * step, -dirY * step);
    this.refreshGhost();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvents();
    this.stopSelection();
    this.stroke = null;
    this.hideGhost();
    this.feedbackListeners.clear();
  }

  // ---- interné: klávesy ----

  private isCommandKey(code: string): boolean {
    return code === 'KeyB' || (code === 'KeyR' && isModuleState(this.stateValue)) || code === 'Escape' || code === 'Space' || SPEED_KEY.test(code);
  }

  private handleTrigger(trigger: InputTrigger): boolean {
    if (trigger === 'cancel' && this.activeButton !== null) {
      // Esc počas ťahu zruší ťah; tlačidlo je ešte stlačené, jeho neskoršie pustenie sa ignoruje.
      this.endInteraction('cancel');
      return true;
    }
    if (trigger === 'cancel' && this.stateValue === 'idle' && this.moduleSelection.get() !== null) {
      this.moduleSelection.select(null); // Esc v pokoji zavrie inšpektor
      return true;
    }
    const next = transition(this.stateValue, trigger);
    if (next === null) return false;
    this.setState(next);
    this.refreshGhost();
    return true;
  }

  private togglePause(): void {
    const current = this.bridge.snapshot().speed;
    const resume = this.lastRunningSpeed ?? this.bridge.world.defs.time.speeds.find((speed) => speed !== 0);
    this.dispatchSpeed(resolveSpeedRequest(0, current, resume));
  }

  /** Kláves `n` (0-based) = n-tá nenulová rýchlosť z `time.speeds` (zhoduje sa s nápovedou v SpeedControl). */
  private setSpeedByIndex(index: number): boolean {
    const running = this.bridge.world.defs.time.speeds.filter((speed) => speed !== 0);
    const speed = running[index];
    if (speed === undefined) return false;
    this.dispatchSpeed(speed);
    return true;
  }

  private dispatchSpeed(speed: number): void {
    this.bridge.dispatch(new SetGameSpeedCommand(speed));
  }

  // ---- interné: ťah ----

  private setState(next: InputState): void {
    const previous = this.stateValue;
    if (next === previous) return;
    this.stateValue = next;
    if (isModuleState(previous) && !isModuleState(next)) {
      // Odchod z módu modulu (Esc, pravý klik, `B`) vynuluje výber v BuildBare, aby položka nesvietila ďalej.
      this.moduleDefId = null;
      this.buildSelection.select(null);
    }
    this.onStateChange?.(next);
  }

  // ---- interné: build mód modulov ----

  /** Zmena výberu v BuildBare: nová položka zapne mód modulu (aj z módu ciest), `null` ho vypne. */
  private onBuildSelectionChanged(): void {
    if (this.disposed) return;
    const defId = this.buildSelection.get();
    if (defId === null) {
      this.moduleDefId = null;
      const cleared = transition(this.stateValue, 'module_cleared');
      if (cleared !== null) this.setState(cleared);
      this.refreshGhost();
      return;
    }
    if (this.activeButton !== null) this.endInteraction('cancel'); // rozpracovaný ťah / klik sa zahodí
    if (defId !== this.moduleDefId) this.moduleRotation = 0;
    this.moduleDefId = defId;
    const next = transition(this.stateValue, 'module_selected');
    if (next !== null) this.setState(next);
    this.refreshGhost();
  }

  /** `R`: otočí ghost o 90° v smere hodinových ručičiek; mimo módu modulu kláves nerobí nič. */
  private rotateModule(): boolean {
    if (!isModuleState(this.stateValue)) return false;
    this.moduleRotation = nextRotation(this.moduleRotation);
    this.refreshGhost();
    return true;
  }

  /** Náhľad modulu pod kurzorom (`null` = nie je vybraný def, kurzor je mimo mapy alebo def neexistuje). */
  private currentPreview(): ModulePreview | null {
    const defId = this.moduleDefId;
    const pointer = this.pointer;
    if (defId === null || pointer === null) return null;
    const { defs } = this.bridge.world;
    if (!defs.modules.has(defId)) return null;
    const cell = this.cellAt(pointer.x, pointer.y);
    if (!this.bridge.snapshot().grid.inBounds(cell.x, cell.y)) return null;
    return previewModule(defs.modules.get(defId), cell, this.moduleRotation, (command) => this.bridge.validate(command));
  }

  /** Pustenie ľavého tlačidla: odošle `PlaceModule` len ak ho validácia prijme (pri nedostatku peňazí nič). */
  private commitModule(): void {
    const preview = this.currentPreview();
    if (preview === null || !preview.placeable) return;
    this.bridge.dispatch(placeCommand(preview.placement));
  }

  /** Klik v `idle` móde: vyberie modul pod kurzorom (žeriav pred kotviskom), klik do prázdna výber zruší. */
  private pickModule(cell: CellCoord): void {
    const { world } = this.bridge;
    const module = world.craneAt(cell.x, cell.y) ?? world.moduleAt(cell.x, cell.y);
    this.moduleSelection.select(module === undefined ? null : module.id);
  }

  /** Ukončí ťah/posun tlačidlom (`release`) alebo zrušením (`cancel`); ťah sa pritom nikdy neodošle sám. */
  private endInteraction(trigger: 'release' | 'cancel'): void {
    const next = transition(this.stateValue, trigger);
    this.stroke = null;
    this.dragLast = null;
    this.clickStart = null;
    this.activeButton = null;
    if (next !== null) this.setState(next);
    this.refreshGhost();
  }

  private cellAt(x: number, y: number): CellCoord {
    return this.camera.screenToCell(x, y);
  }

  private makeCommand(kind: BuildKind, cells: readonly CellCoord[]): Command {
    return kind === 'place' ? new PlaceRoadCommand(cells) : new RemoveRoadCommand(cells);
  }

  private cellVerdict(kind: BuildKind, cell: CellCoord): boolean {
    const result = this.bridge.validate(this.makeCommand(kind, [cell]));
    return result.ok || (kind === 'place' && isNothingToDo(result));
  }

  /** Pridá do ťahu bunku pod kurzorom a všetky bunky medzi ňou a poslednou (4-súvislo), mimo mapy ignoruje. */
  private extendStroke(cell: CellCoord): void {
    const stroke = this.stroke;
    if (stroke === null) return;
    const { grid } = this.bridge.snapshot();
    if (!grid.inBounds(cell.x, cell.y)) return;
    const path = stroke.last === null ? [cell] : interpolateCells(stroke.last, cell);
    for (const step of path) {
      if (!grid.inBounds(step.x, step.y)) continue;
      const index = grid.index(step.x, step.y);
      if (stroke.seen.has(index)) continue;
      stroke.seen.add(index);
      stroke.cells.push(step);
      stroke.verdicts.set(index, this.cellVerdict(stroke.kind, step));
    }
    stroke.last = cell;
  }

  /** Odošle ťah, ak celý prejde validáciou; inak nič (ghost už ukázal prečo). */
  private commit(stroke: Stroke): void {
    if (stroke.cells.length === 0) return;
    const command = this.makeCommand(stroke.kind, stroke.cells);
    if (this.bridge.validate(command).ok) this.bridge.dispatch(command);
  }

  // ---- interné: ghost ----

  /** Prekreslí ghost a spätnú väzbu podľa stavu: ťah > hover v build móde > nič. */
  private refreshGhost(): void {
    if (this.disposed) return;
    if (isModuleState(this.stateValue)) {
      this.refreshModuleGhost();
      return;
    }
    const { grid } = this.bridge.snapshot();
    const stroke = this.stroke;
    let kind: BuildKind;
    let cells: readonly CellCoord[];
    let verdict: (cell: CellCoord) => boolean;
    let dragging: boolean;
    if (stroke !== null) {
      kind = stroke.kind;
      cells = stroke.cells;
      verdict = (cell) => stroke.verdicts.get(grid.index(cell.x, cell.y)) ?? false;
      dragging = true;
    } else if (this.stateValue === 'build' && this.pointer !== null) {
      const hover = this.cellAt(this.pointer.x, this.pointer.y);
      kind = 'place';
      cells = grid.inBounds(hover.x, hover.y) ? [hover] : [];
      verdict = (cell) => this.cellVerdict('place', cell);
      dragging = false;
    } else {
      this.hideGhost();
      return;
    }
    if (cells.length === 0) {
      this.hideGhost();
      return;
    }

    const whole = this.bridge.validate(this.makeCommand(kind, cells));
    if (!dragging && isNothingToDo(whole)) {
      this.hideGhost(); // hover nad hotovou cestou: nič sa nestane, ghost ani štítok by len rušili
      return;
    }
    // Nedostatok peňazí je vlastnosť celého ťahu, nie jednej bunky: preto sa označí celý ghost.
    const fundsShort = whole.reasons.includes('insufficient_funds');
    const ghostCells: GhostCell[] = cells.map((cell) => ({ x: cell.x, y: cell.y, valid: !fundsShort && verdict(cell) }));
    this.clearModuleGhost();
    this.ghost.setGhost(ghostCells);
    this.ghostShown = true;
    const at = this.pointer ?? { x: 0, y: 0 };
    this.setFeedback({
      kind,
      ok: whole.ok,
      reasons: whole.reasons,
      costCents: whole.costCents,
      cellCount: whole.cells.length,
      x: at.x,
      y: at.y,
      dragging,
    });
  }

  /** Ghost a štítok modulu pod kurzorom (mód `build_module*`); mimo mapy ich skryje. */
  private refreshModuleGhost(): void {
    const preview = this.currentPreview();
    if (preview === null) {
      this.hideGhost();
      return;
    }
    if (this.ghostShown) {
      this.ghost.clearGhost();
      this.ghostShown = false;
    }
    this.moduleGhostView.setModuleGhost(preview.ghost);
    this.moduleGhostValue = preview.ghost;
    const def = this.bridge.world.defs.modules.get(preview.placement.defId);
    const at = this.pointer ?? { x: 0, y: 0 };
    this.setFeedback({
      kind: 'module',
      ok: preview.result.ok,
      reasons: preview.result.reasons,
      costCents: preview.result.costCents,
      cellCount: preview.result.cells.length,
      x: at.x,
      y: at.y,
      dragging: this.stateValue === 'build_module_place',
      label: def.displayName,
      moduleKind: def.kind,
      fundsShort: preview.fundsShort,
    });
  }

  private clearModuleGhost(): void {
    if (this.moduleGhostValue === null) return;
    this.moduleGhostView.setModuleGhost(null);
    this.moduleGhostValue = null;
  }

  private hideGhost(): void {
    if (this.ghostShown) {
      this.ghost.clearGhost();
      this.ghostShown = false;
    }
    this.clearModuleGhost();
    this.setFeedback(null);
  }

  private setFeedback(next: BuildFeedback | null): void {
    const previous = this.feedbackValue;
    if (previous === null && next === null) return;
    this.feedbackValue = next;
    for (const listener of [...this.feedbackListeners]) listener();
  }
}
