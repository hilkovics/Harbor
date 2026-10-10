// TR5-04: texty toastov pre ReeferClaim, ReeferSkipped (bez bezplatnej zásuvky) a ReeferAlarm.
import { describe, expect, it } from 'vitest';
import { reeferAlarmToast, reeferClaimToast, reeferSkippedToast } from '@ui/index';

describe('reeferClaimToast', () => {
  it('reklamácia je danger s ikonou reefera a penále v peniazoch', () => {
    const toast = reeferClaimToast({ label: 'MSKU 412 038', penaltyCents: 120_000 });
    expect(toast).toEqual({
      tone: 'danger',
      icon: 'ic_reefer',
      title: 'Reklamácia reefera',
      text: 'MSKU 412 038 stál bez napájania nad limit · penále $1,200',
    });
  });
});

describe('reeferSkippedToast', () => {
  it('preskočený reefer je warning a výslovne hovorí, že nie je bezplatná zásuvka', () => {
    const toast = reeferSkippedToast({ label: 'CMAU 771 204', blockLabel: 'R2' });
    expect(toast.tone).toBe('warning');
    expect(toast.icon).toBe('ic_plug');
    expect(toast.title).toBe('Reefer preskočený');
    expect(toast.text).toBe('CMAU 771 204 nemá voľnú zásuvku · R2 · zostáva bez napájania, bez bezplatnej zásuvky');
  });

  it('bez bloku sa miesto nevypisuje', () => {
    expect(reeferSkippedToast({ label: 'TGHU 004 772' }).text).toBe(
      'TGHU 004 772 nemá voľnú zásuvku · zostáva bez napájania, bez bezplatnej zásuvky',
    );
  });
});

describe('reeferAlarmToast', () => {
  it('alarm je danger s teplotou, cieľom a odpočtom do reakcie', () => {
    const toast = reeferAlarmToast({ label: 'SUDU 618 220', temperatureC: -14, targetC: -18, minutesToRespond: 18 });
    expect(toast).toEqual({
      tone: 'danger',
      icon: 'ic_warning',
      title: 'Reefer alarm',
      text: 'SUDU 618 220 · −14 °C (cieľ −18 °C) · reagovať do 18 min',
    });
  });
});
