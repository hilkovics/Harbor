// T06-03: nenápadné oznámenie („Automaticky uložené“) má vlastný čas zatvorenia (`ToastSpec.autoCloseMs`).
import { describe, expect, it } from 'vitest';
import { QUIET_TOAST_AUTO_CLOSE_MS, TOAST_AUTO_CLOSE_MS } from '@app/config';
import type { TimerHost } from '@app/snapshot-store';
import { ToastCenter, type ToastSpec } from '@app/toast-center';
import { createApp } from '../app-fixtures';

/** Ručne poháňané časovače (bez reálneho čakania). */
class FakeTimers implements TimerHost {
  now = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, entry] of [...this.timers]) {
      if (entry.at > this.now) continue;
      this.timers.delete(handle);
      entry.callback();
    }
  }
}

const base: ToastSpec = { key: 'k', tone: 'info', icon: 'ic_save', title: 'Automaticky uložené', text: 'Deň 2 · 00:00' };

describe('ToastSpec.autoCloseMs', () => {
  it('nenápadný toast sa zatvorí skôr než bežný', () => {
    const timers = new FakeTimers();
    const center = new ToastCenter(createApp().bridge, { timers });
    center.push({ ...base, key: 'quiet', autoCloseMs: QUIET_TOAST_AUTO_CLOSE_MS });
    center.push({ ...base, key: 'normal', title: 'Uložené' });
    expect(QUIET_TOAST_AUTO_CLOSE_MS).toBeLessThan(TOAST_AUTO_CLOSE_MS);
    timers.advance(QUIET_TOAST_AUTO_CLOSE_MS - 1);
    expect(center.get().map((toast) => toast.title)).toEqual(['Automaticky uložené', 'Uložené']);
    timers.advance(1);
    expect(center.get().map((toast) => toast.title)).toEqual(['Uložené']);
    timers.advance(TOAST_AUTO_CLOSE_MS);
    expect(center.get()).toEqual([]);
  });

  it('bez autoCloseMs platí predvolený čas zásobníka', () => {
    const timers = new FakeTimers();
    const center = new ToastCenter(createApp().bridge, { timers, autoCloseMs: 1234 });
    center.push(base);
    timers.advance(1233);
    expect(center.get()).toHaveLength(1);
    timers.advance(1);
    expect(center.get()).toHaveLength(0);
  });
});
