/**
 * Texty toastov pre udalosti reeferov (TR5-04). Čisté funkcie: z payloadu udalosti vrátia `tone`, `icon`, `title`
 * a `text` pre `ToastData` (`@ui/toasts`); id a `onClose` doplní rodič (app vrstva, TR5-05). Udalosti `ReeferClaim`,
 * `ReeferSkipped`, `ReeferAlarm` sú zatiaľ len štruktúrne typy tu — sim ich emituje až v TR5-01/TR5-05.
 *
 * Význam nesie aj text a ikona, nie len farba tónu (DESIGN_BRIEF §6.2). Peniaze cez `formatMoney`, teploty a odpočty
 * cez spoločné helpery z `reefer-inspector`.
 */
import { formatMoney } from './format';
import { formatMinutesLeft, reeferTemperatureText } from './reefer-inspector';
import type { ToastTone } from './toasts';

/** Obsah toastu bez `id` a `onClose`; rodič ho spojí s `ToastData`. */
export interface ReeferToastText {
  readonly tone: ToastTone;
  readonly icon: string;
  readonly title: string;
  readonly text: string;
}

/** `ReeferClaim`: reefer prekročil limit bez napájania a vznikla reklamácia (strata = penále). */
export interface ReeferClaimToastInput {
  /** Označenie kontajnera pre hráča. */
  readonly label: string;
  /** Penále / náhrada za reklamáciu v centoch (kladné číslo = suma, ktorú hráč stratí). */
  readonly penaltyCents: number;
}

/** `ReeferSkipped`: STS preskočil reefer, lebo nebola voľná zásuvka — bez napájania, bez „zadarmo" zásuvky. */
export interface ReeferSkippedToastInput {
  readonly label: string;
  /** Názov bloku, kde zásuvka chýba (voliteľný). */
  readonly blockLabel?: string;
}

/** `ReeferAlarm`: teplota reefera mimo rozsahu, hráč má reagovať do daného času. */
export interface ReeferAlarmToastInput {
  readonly label: string;
  /** Teplota a cieľ (voliteľné; sim ich zatiaľ nenesie — bez nich text teplotu vynechá). */
  readonly temperatureC?: number;
  readonly targetC?: number;
  readonly minutesToRespond: number;
}

export function reeferClaimToast({ label, penaltyCents }: ReeferClaimToastInput): ReeferToastText {
  return {
    tone: 'danger',
    icon: 'ic_reefer',
    title: 'Reklamácia reefera',
    text: `${label} stál bez napájania nad limit · penále ${formatMoney(penaltyCents)}`,
  };
}

export function reeferSkippedToast({ label, blockLabel }: ReeferSkippedToastInput): ReeferToastText {
  const place = blockLabel === undefined ? '' : ` · ${blockLabel}`;
  return {
    tone: 'warning',
    icon: 'ic_plug',
    title: 'Reefer preskočený',
    text: `${label} nemá voľnú zásuvku${place} · zostáva bez napájania, bez bezplatnej zásuvky`,
  };
}

export function reeferAlarmToast({ label, temperatureC, targetC, minutesToRespond }: ReeferAlarmToastInput): ReeferToastText {
  return {
    tone: 'danger',
    icon: 'ic_warning',
    title: 'Reefer alarm',
    text: `${label}${temperatureC === undefined ? '' : ` · ${reeferTemperatureText(temperatureC)}${targetC === undefined ? '' : ` (cieľ ${reeferTemperatureText(targetC)})`}`} · reagovať do ${formatMinutesLeft(minutesToRespond)}`,
  };
}
