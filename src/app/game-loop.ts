/**
 * GameLoop — fixný tick s akumulátorom (ARCHITECTURE §3). Prevádza reálny čas z render framov na celé ticky sveta.
 *
 * Logika je čistá: čas vstupuje výlučne ako argument `dtMs` (žiadne `Date.now`/`performance.now`), takže
 * ju možno testovať v Node. Jediné miesto, ktoré pozná `requestAnimationFrame`, je tenký wrapper `startRafLoop`
 * na konci súboru.
 *
 * Pravidlá jedného framu (`frame(dtMs)`):
 * 1. najprv `world.applyPending()` — príkazy hráča (aj `SetGameSpeed`) sa aplikujú hneď, aj počas pauzy;
 *    ekvivalentné príkazovej časti `tick()`, takže poradie udalostí sa nemení;
 * 2. rýchlosť 0 (pauza) → nič viac; akumulátor sa nemení (neakumuluje sa, ale ani nemaže → `alpha` ostane, obraz
 *    nepoškočí a po obnove plynulo pokračuje);
 * 3. inak `acc += dtMs × speed`, `n = min(floor(acc / tickMs), maxTicksPerFrame)`, vykoná sa `n` tickov;
 * 4. `acc -= n × tickMs`; ak sa zasiahol limit (proti špirále smrti), prebytok sa zahodí: `acc = min(acc, tickMs)`;
 * 5. `alpha = acc / tickMs` (0..1) — interpolácia medzi predošlým a aktuálnym tickom v renderi.
 */
import type { SimEvent } from '@sim/events';
import type { World } from '@sim/world';

/** Príjemca udalostí po každom frame (typicky `SimBridge`). */
export interface FrameEventSink {
  /** Volá sa po každom frame (aj s prázdnym poľom), aby sink mohol obnoviť odvodený stav. */
  publish(events: readonly SimEvent[]): void;
}

const NO_EVENTS: readonly SimEvent[] = Object.freeze([]);

export class GameLoop {
  /** Trvanie jedného ticku v ms pri rýchlosti 1× (`1000 / time.ticksPerRealSecond`). */
  readonly tickMs: number;
  /** Strop tickov za frame (`time.maxTicksPerFrame`). */
  readonly maxTicksPerFrame: number;

  private accMs = 0;
  private ticksInLastFrame = 0;

  constructor(
    private readonly world: World,
    private readonly sink: FrameEventSink | null = null,
  ) {
    const { ticksPerRealSecond, maxTicksPerFrame } = world.defs.time;
    if (!(ticksPerRealSecond > 0) || !Number.isFinite(ticksPerRealSecond)) {
      throw new RangeError(`GameLoop: time.ticksPerRealSecond musí byť konečné číslo > 0, dostal ${String(ticksPerRealSecond)}`);
    }
    if (!Number.isInteger(maxTicksPerFrame) || maxTicksPerFrame < 1) {
      throw new RangeError(`GameLoop: time.maxTicksPerFrame musí byť celé číslo ≥ 1, dostal ${String(maxTicksPerFrame)}`);
    }
    this.tickMs = 1000 / ticksPerRealSecond;
    this.maxTicksPerFrame = maxTicksPerFrame;
  }

  /** Podiel rozpracovaného ticku, 0..1 (`acc / tickMs`) — `pos = lerp(prev, curr, alpha)` v renderi. */
  get alpha(): number {
    return Math.min(1, this.accMs / this.tickMs);
  }

  /** Počet tickov vykonaných v poslednom `frame()` (diagnostika, testy). */
  get lastFrameTicks(): number {
    return this.ticksInLastFrame;
  }

  /**
   * Spracuje jeden render frame, ktorý trval `dtMs` reálnych milisekúnd. Vráti udalosti za celý frame
   * (príkazy + všetky ticky) v poradí vzniku a rovnaké pole odovzdá `sink.publish`.
   * @throws RangeError ak `dtMs` nie je konečné číslo ≥ 0
   */
  frame(dtMs: number): readonly SimEvent[] {
    if (!Number.isFinite(dtMs) || dtMs < 0) {
      throw new RangeError(`GameLoop.frame: dtMs musí byť konečné číslo ≥ 0, dostal ${String(dtMs)}`);
    }
    const { world } = this;
    let collected: SimEvent[] | null = null;
    const collect = (events: readonly SimEvent[]): void => {
      if (events.length === 0) return;
      collected ??= [];
      for (const event of events) collected.push(event);
    };

    collect(world.applyPending());

    let ticks = 0;
    const speed = world.clock.speed;
    if (speed > 0) {
      this.accMs += dtMs * speed;
      const due = Math.floor(this.accMs / this.tickMs);
      ticks = Math.min(due, this.maxTicksPerFrame);
      for (let i = 0; i < ticks; i++) collect(world.tick());
      this.accMs -= ticks * this.tickMs;
      // Zásah limitu: zvyšné ticky sa zahodia, aby sa hra po zdržaní nesnažila dobehnúť backlog.
      if (due > ticks) this.accMs = Math.min(this.accMs, this.tickMs);
      // Zaokrúhľovanie floatov môže nechať akumulátor o epsilon pod nulou.
      if (this.accMs < 0) this.accMs = 0;
    }
    this.ticksInLastFrame = ticks;

    const events: readonly SimEvent[] = collected ?? NO_EVENTS;
    this.sink?.publish(events);
    return events;
  }
}

// ---- rAF wrapper (jediné miesto s časovou závislosťou; v Node sa nepoužíva) ----

/** Plánovač framov; v prehliadači `requestAnimationFrame`, v testoch náhrada. */
export interface RafHost {
  request(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

/** Predvolený plánovač prehliadača. Odkazuje na `window` až pri volaní, takže import v Node je bezpečný. */
export const browserRafHost: RafHost = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => {
    window.cancelAnimationFrame(handle);
  },
};

/**
 * Spustí slučku: pri každom rAF spočíta `dt` z rozdielu časových pečiatok (prvý frame má `dt = 0`, záporný
 * rozdiel sa orezá na 0), zavolá `loop.frame(dt)` a potom `onFrame(alpha, events, dtMs)` na vykreslenie
 * (`dtMs` = reálny čas od minulého framu — napr. pre posun kamery klávesmi).
 * Vráti funkciu, ktorá slučku zastaví. Výnimka z `frame`/`onFrame` slučku ukončí (fail-fast).
 */
export function startRafLoop(
  loop: GameLoop,
  onFrame?: (alpha: number, events: readonly SimEvent[], dtMs: number) => void,
  host: RafHost = browserRafHost,
): () => void {
  let lastTimestamp: number | null = null;
  let handle: number | null = null;
  let running = true;

  const step = (timestampMs: number): void => {
    if (!running) return;
    const dtMs = lastTimestamp === null ? 0 : Math.max(0, timestampMs - lastTimestamp);
    lastTimestamp = timestampMs;
    const events = loop.frame(dtMs);
    onFrame?.(loop.alpha, events, dtMs);
    if (running) handle = host.request(step);
  };

  handle = host.request(step);
  return () => {
    running = false;
    if (handle !== null) host.cancel(handle);
    handle = null;
  };
}
