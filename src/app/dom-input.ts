/**
 * Väzba `InputController` na DOM udalosti a rozhodnutie „patrí to UI alebo mape?“ (ARCHITECTURE §15.2).
 *
 * - myš a koleso: počúva sa len na prvku mapy (`host`). HUD a panely sú v DOM mimo neho (nad mapou), takže
 *   klik na tlačidlo HUD sa mape nikdy nedoručí,
 * - klávesy: počúvajú sa na okne, ale ak má fokus interaktívny prvok DOM (input, tlačidlo, odkaz, prvok s ARIA
 *   rolou ovládača), patria jemu — klávesy hry sa ignorujú, aby `Space` na fokusovanom tlačidle nerobilo dvojité veci
 *   (výnimka: `Ctrl+S`, rýchle uloženie, platí vždy),
 * - po kliku myšou na tlačidlo sa fokus z tlačidla zloží (klik s `detail > 0`; klávesnicová aktivácia má `detail = 0`
 *   a fokus si ponecháva), takže po kliku na „4×“ hotkeys ďalej fungujú.
 *
 * Typy sú štrukturálne (nie `HTMLElement`), aby sa väzba dala testovať v Node s falošným `EventTarget`.
 */
import { isQuickSaveKey, type InputController, type KeyInput, type PointerInput, type WheelInput } from './input-controller';

/** Prvok mapy (canvas host): udalosti myši, poloha a zachytenie ukazovateľa. */
export interface DomInputHost {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions): void;
  getBoundingClientRect(): { readonly left: number; readonly top: number };
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** Okno: klávesy, strata fokusu, kliky na prvky UI. */
export interface DomInputWindow {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions): void;
}

export interface DomInputOptions {
  readonly host: DomInputHost;
  readonly window: DomInputWindow;
  /**
   * Zloží fokus z prvku UI, keď hráč klikne do mapy (aby klávesy hry po kliku na mapu fungovali aj po tom, čo mal
   * fokus napr. tlačidlo cez Tab). Bootstrap dodá `document.activeElement.blur()`.
   */
  readonly releaseFocus?: () => void;
}

/** Značky, ktorým patria klávesy, keď majú fokus. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']);

/** ARIA roly ovládačov, ktoré si spracúvajú klávesy samy. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'textbox',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'searchbox',
]);

interface MaybeElement {
  readonly tagName?: unknown;
  readonly isContentEditable?: unknown;
  getAttribute?(name: string): string | null;
  closest?(selector: string): MaybeElement | null;
  blur?(): void;
}

/**
 * Tlačidlo (`<button>` alebo `role="button"`), v ktorom leží cieľ kliku — cieľom býva vnorená ikona (`<svg>`), nie
 * samotné tlačidlo, preto `closest`. Jediný prvok, ktorému po kliku myšou berieme fokus.
 */
function closestButton(target: unknown): MaybeElement | null {
  if (typeof target !== 'object' || target === null) return null;
  return (target as MaybeElement).closest?.('button, [role="button"]') ?? null;
}

/**
 * Patrí klávesová udalosť s týmto cieľom prvku UI (DOM), nie hre? `true` pre polia na písanie, tlačidlá, odkazy,
 * ovládače s ARIA rolou a `contenteditable`; `false` pre `body`, okno a neinteraktívne prvky.
 */
export function keyboardTargetBelongsToUi(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const element = target as MaybeElement;
  if (element.isContentEditable === true) return true;
  if (typeof element.tagName === 'string' && INTERACTIVE_TAGS.has(element.tagName.toUpperCase())) return true;
  const role = element.getAttribute?.('role');
  return typeof role === 'string' && INTERACTIVE_ROLES.has(role.toLowerCase());
}

interface PointerLike {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
}

interface WheelLike {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface KeyLike {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

interface ClickLike {
  readonly detail: number;
  readonly target: unknown;
}

/**
 * Pripojí ovládanie na DOM. Vráti funkciu, ktorá všetky poslucháče odstráni.
 * Udalosti spracované ovládaním majú zavolané `preventDefault` (Space nescrolluje, pravé tlačidlo neotvára menu).
 */
export function attachDomInput(controller: InputController, options: DomInputOptions): () => void {
  const { host, window: win } = options;
  const cleanups: Array<() => void> = [];

  const listen = (
    target: DomInputHost | DomInputWindow,
    type: string,
    handler: (event: Event) => void,
    listenerOptions?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, handler, listenerOptions);
    cleanups.push(() => {
      target.removeEventListener(type, handler, listenerOptions);
    });
  };

  const local = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = host.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const pointerInput = (event: PointerLike): PointerInput => ({ button: event.button, ...local(event.clientX, event.clientY) });

  // Myš: prvok mapy
  listen(host, 'pointerdown', (event) => {
    const pointer = event as unknown as PointerLike;
    options.releaseFocus?.();
    if (controller.pointerDown(pointerInput(pointer))) {
      event.preventDefault();
      host.setPointerCapture?.(pointer.pointerId);
    }
  });
  listen(host, 'pointermove', (event) => {
    const { x, y } = local((event as unknown as PointerLike).clientX, (event as unknown as PointerLike).clientY);
    controller.pointerMove(x, y);
  });
  listen(host, 'pointerup', (event) => {
    const pointer = event as unknown as PointerLike;
    controller.pointerUp(pointerInput(pointer));
    host.releasePointerCapture?.(pointer.pointerId);
  });
  listen(host, 'pointercancel', () => {
    controller.pointerCancel();
  });
  listen(host, 'pointerleave', () => {
    controller.pointerLeave();
  });
  // Pravé tlačidlo je v build móde „odstrániť“ — kontextové menu prehliadača by len prekážalo.
  listen(host, 'contextmenu', (event) => {
    event.preventDefault();
  });
  listen(
    host,
    'wheel',
    (event) => {
      const wheel = event as unknown as WheelLike;
      controller.wheel({ deltaY: wheel.deltaY, deltaMode: wheel.deltaMode, ...local(wheel.clientX, wheel.clientY) } satisfies WheelInput);
      event.preventDefault();
    },
    { passive: false },
  );

  // Klávesy: okno, ale UI má prednosť
  listen(win, 'keydown', (event) => {
    const key = event as unknown as KeyLike;
    const input: KeyInput = { code: key.code, repeat: key.repeat, ctrlKey: key.ctrlKey, altKey: key.altKey, metaKey: key.metaKey };
    // Ctrl+S (rýchle uloženie) platí aj s fokusom na prvku UI (tlačidlo, pole): inak by sa otvorilo „Uložiť stránku“.
    if (!isQuickSaveKey(input) && keyboardTargetBelongsToUi(event.target)) return;
    if (controller.keyDown(input)) event.preventDefault();
  });
  // Pustenie klávesu sa spracuje vždy: hráč mohol pustiť W až po prechode fokusu na tlačidlo.
  listen(win, 'keyup', (event) => {
    controller.keyUp((event as unknown as KeyLike).code);
  });
  listen(win, 'blur', () => {
    controller.blur();
  });
  // Po kliku myšou na tlačidlo mu fokus zoberieme, aby hotkeys ďalej fungovali (klávesnicová aktivácia má detail 0).
  listen(
    win,
    'click',
    (event) => {
      const click = event as unknown as ClickLike;
      if (click.detail > 0) closestButton(click.target)?.blur?.();
    },
    { capture: true },
  );

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
