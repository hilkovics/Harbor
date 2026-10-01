// Spoločné pomôcky pre testy ukladania (T06-03): falošné úložisko a zostava „svet + most + SaveController“.
import type { World } from '@sim/world';
import { SaveController, createPersistence, type PersistenceServices } from '@app/save/save-controller';
import type { FileDownloader } from '@app/save/save-file';
import type { KeyValueStorage } from '@app/save/storage';
import type { ToastSpec } from '@app/toast-center';
import { createApp } from '../app-fixtures';

export const FIXED_NOW = '2026-10-01T12:00:00.000Z';

function quotaError(): Error {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

/** Falošné `localStorage`: zápis dlhší než `quotaChars` hodí `QuotaExceededError`, `failReads` hodí pri čítaní. */
export class FakeStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  quotaChars = Number.POSITIVE_INFINITY;
  failReads = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('read denied');
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (value.length > this.quotaChars) throw quotaError();
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

export interface Download {
  readonly fileName: string;
  readonly blob: Blob;
}

export interface SaveHarnessOptions {
  readonly checkInvariants?: boolean;
  /** Predvolene falošné úložisko; `persistence` ho prepíše (napr. úložisko, ktoré vyhadzuje). */
  readonly persistence?: PersistenceServices;
  /** Bez `loadWorld` (predvolene je k dispozícii). */
  readonly withoutLoadWorld?: boolean;
}

/** World + SimBridge + GameLoop + SaveController s falošným úložiskom, toastami a sťahovaním zachytenými do polí. */
export function saveHarness(options: SaveHarnessOptions = {}) {
  const app = createApp({ checkInvariants: options.checkInvariants ?? true });
  const storage = new FakeStorage();
  const persistence = options.persistence ?? createPersistence(() => storage);
  const toasts: ToastSpec[] = [];
  const loaded: World[] = [];
  const downloads: Download[] = [];
  const downloader: FileDownloader = {
    download: (fileName, blob) => {
      downloads.push({ fileName, blob });
    },
  };
  const controller = new SaveController({
    bridge: app.bridge,
    persistence,
    notify: (spec) => {
      toasts.push(spec);
    },
    ...(options.withoutLoadWorld === true
      ? {}
      : {
          loadWorld: (world: World) => {
            loaded.push(world);
          },
        }),
    now: () => FIXED_NOW,
    downloader,
  });
  // Zapojenie ako v `bootstrap`: autosave počúva udalosti mosta (bridge.publish ich rozosiela po frame).
  app.bridge.onEvents((events) => {
    controller.handleEvents(events);
  });
  /**
   * Posunie svet o aspoň `ticks` tickov cez `GameLoop` (frame po `maxTicksPerFrame` tickoch, po každom `publish` udalostí
   * mostu — ako v hre). Čas hry musí bežať (rýchlosť > 0).
   */
  const advance = (ticks: number): void => {
    const target = app.world.clock.tick + ticks;
    const frameMs = app.loop.tickMs * app.loop.maxTicksPerFrame;
    while (app.world.clock.tick < target) app.loop.frame(frameMs);
  };
  return { ...app, storage, persistence, toasts, loaded, downloads, controller, advance };
}
