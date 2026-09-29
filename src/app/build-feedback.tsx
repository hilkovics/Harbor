/**
 * Štítok pri kurzore v build móde: počet buniek a cena, prípadne dôvody odmietnutia (ghost je v Pixi bez textu,
 * ARCHITECTURE §15.1 — popisy sú v DOM). Stav nesie ikona a text, nie len farba (DESIGN_BRIEF §6.4).
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { ValidationReason } from '@sim/commands';
import { formatMoney, formatMoneyDelta } from '@ui/format';
import { Icon } from '@ui/icon';
import type { BuildFeedback } from './input-controller';

/** Slovenské popisy dôvodov odmietnutia (úplná mapa: nový dôvod v sime = chyba kompilácie tu). */
export const REASON_TEXT: Readonly<Record<ValidationReason, string>> = {
  out_of_bounds: 'Mimo mapy',
  terrain: 'Nevhodný terén',
  occupied: 'Obsadené',
  parcel_not_owned: 'Parcela nie je vaša',
  insufficient_funds: 'Nedostatok peňazí',
  no_road: 'Tu nie je cesta',
  invalid_speed: 'Neplatná rýchlosť',
  empty: 'Nič na zmenu',
};

/** „1 bunka“, „2 bunky“, „5 buniek“. */
export function cellCountLabel(count: number): string {
  if (count === 1) return '1 bunka';
  if (count >= 2 && count <= 4) return `${String(count)} bunky`;
  return `${String(count)} buniek`;
}

/** Text štítka pre spätnú väzbu (čistá funkcia — testovateľná bez DOM). */
export function feedbackText(feedback: BuildFeedback): string {
  if (!feedback.ok) return feedback.reasons.map((reason) => REASON_TEXT[reason]).join(' · ');
  const title = feedback.kind === 'place' ? 'Cesta' : 'Odstrániť';
  // Pri odstránení je cena záporná (refundácia) — zobrazí sa ako príjem so znamienkom.
  const money = feedback.kind === 'place' ? formatMoney(feedback.costCents) : formatMoneyDelta(0 - feedback.costCents);
  return `${title} · ${cellCountLabel(feedback.cellCount)} · ${money}`;
}

export interface FeedbackSource {
  feedback(): BuildFeedback | null;
  subscribeFeedback(listener: () => void): () => void;
}

export function BuildFeedbackLabel({ source }: { source: FeedbackSource }) {
  // Viazané funkcie s stabilnou identitou (inak by sa useSyncExternalStore pri každom renderi znova prihlasoval).
  const store = useMemo(() => ({ subscribe: source.subscribeFeedback.bind(source), get: source.feedback.bind(source) }), [source]);
  const feedback = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (feedback === null) return null;
  const flip = typeof window !== 'undefined' && feedback.x > window.innerWidth / 2;
  const className = [
    'build-tip',
    feedback.ok ? 'build-tip--ok' : 'build-tip--bad',
    flip ? 'build-tip--flip' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  const icon = feedback.ok ? (feedback.kind === 'place' ? 'ic_road' : 'ic_demolish') : 'ic_warning';
  return (
    <div className={className} style={{ left: feedback.x, top: feedback.y }} role="status" data-field="build-tip" data-ok={feedback.ok}>
      <Icon name={icon} className="build-tip__icon" />
      <span className="build-tip__text">{feedbackText(feedback)}</span>
    </div>
  );
}
