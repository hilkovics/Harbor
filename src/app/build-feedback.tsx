/**
 * Štítok pri kurzore v build móde: počet buniek a cena, prípadne dôvody odmietnutia (ghost je v Pixi bez textu,
 * ARCHITECTURE §15.1 — popisy sú v DOM). Stav nesie ikona a text, nie len farba (DESIGN_BRIEF §6.4).
 *
 * Pri ghoste modulu (`kind: 'module'`, T02-10) štítok ukazuje názov, cenu a dôvody odmietnutia; pri nedostatku peňazí
 * (ghost zostáva zelený) ikonu $ (`ic_cash`) a text „Nedostatok peňazí“ (ARCHITECTURE §8 bod 6).
 *
 * Pri stavbe cesty (`kind: 'place'`, T03-20) štítok ukazuje typ cesty, počet buniek a cenu; pri prestavbe „Prestavba: $X,
 * vrátené $Y“ (stavba a refundácia z `PlaceRoadCommand.quote`) a čistú cenu, ktorá je pri záporných sumách príjem
 * (`+$Z`). Jednosmerka pridáva smer poslednej bunky (pri 1-bunkovom ťahu s nápovedou `R`). Nedostatok peňazí funguje ako
 * pri moduloch: zelený ghost, ikona $ a text „Nedostatok peňazí“.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { ValidationReason } from '@sim/commands';
import { formatMoney, formatMoneyDelta } from '@ui/format';
import { Icon, type IconName } from '@ui/icon';
import { moduleKindIcon } from '@ui/module-inspector';
import type { BuildFeedback } from './input-controller';
import { DIRECTION_LABEL, ROAD_KIND_LABEL } from './road-build';

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
  unknown_def: 'Neznámy typ stavby',
  no_water_side: 'Dlhá hrana musí byť pri vode',
  water_blocked: 'Voda pred kotviskom nie je voľná',
  no_berth: 'Žeriav musí stáť na kotvisku',
  rotation_mismatch: 'Iná rotácia než kotvisko',
  max_cranes: 'Kotvisko má maximum žeriavov',
  has_cranes: 'Na kotvisku stoja žeriavy',
  has_cargo: 'Modul obsahuje náklad',
  ship_docked: 'Pri kotvisku kotví loď',
  busy: 'Žeriav práve pracuje',
  unknown_module: 'Modul neexistuje',
  unknown_ship_class: 'Neznámy typ lode',
  unknown_cargo: 'Neznámy náklad',
  cargo_incompatible: 'Loď tento náklad neprevezie',
  invalid_units: 'Neplatný počet jednotiek',
  invalid_priority: 'Neplatná priorita',
  invalid_gang: 'Neplatný režim ťahačov',
  invalid_gate_mode: 'Neplatný režim pruhu brány',
  invalid_rotation: 'Neplatná rotácia',
  unknown_vehicle_def: 'Neznámy typ vozidla',
  unknown_depot: 'Depo neexistuje',
  depot_full: 'Depo je plné',
  not_connected: 'Nepripojené k ceste',
  unknown_vehicle: 'Vozidlo neexistuje',
  vehicle_busy: 'Vozidlo práve pracuje',
  has_vehicles: 'Depo má vozidlá',
  connector_blocked: 'Vstup nejde pripojiť k ceste',
  invalid_road_kind: 'Neznámy typ cesty',
  invalid_direction: 'Neplatný smer jednosmerky',
  has_trucks: 'Modul používa kamión',
  unknown_contract: 'Kontrakt neexistuje',
  contract_not_offered: 'Kontrakt už nie je v ponuke',
  no_berth_for_ship_class: 'Loď sa nezmestí k žiadnemu kotvisku',
  no_crane_for_category: 'Pri kotvisku pre loď chýba žeriav na tento náklad',
  berth_unreachable: 'Loď k vhodnému kotvisku nedopláva',
  no_gate_for_category: 'Pre export chýba brána pre tento náklad',
  no_storage_for_category: 'Pre export nie je dosiahnuteľný sklad na tento náklad',
  game_over: 'Hra skončila',
};

/** „1 bunka“, „2 bunky“, „5 buniek“. */
export function cellCountLabel(count: number): string {
  if (count === 1) return '1 bunka';
  if (count >= 2 && count <= 4) return `${String(count)} bunky`;
  return `${String(count)} buniek`;
}

/** Text štítka modulu: `Kotvisko · $400,000`, pri odmietnutí navyše dôvody (`· Dlhá hrana musí byť pri vode`). */
function moduleFeedbackText(feedback: BuildFeedback): string {
  const head = `${feedback.label ?? 'Modul'} · ${formatMoney(feedback.costCents)}`;
  if (feedback.ok) return head;
  return `${head} · ${feedback.reasons.map((reason) => REASON_TEXT[reason]).join(' · ')}`;
}

/** Cena ťahu cesty: `$X`; pri prestavbe „Prestavba: $X, vrátené $Y (čisto $Z)“, čistý príjem ako `+$Z` (T03-20). */
function roadMoneyText(feedback: BuildFeedback): string {
  const refund = feedback.refundCents ?? 0;
  if (refund <= 0) return feedback.costCents < 0 ? formatMoneyDelta(0 - feedback.costCents) : formatMoney(feedback.costCents);
  const net = feedback.costCents < 0 ? `príjem ${formatMoneyDelta(0 - feedback.costCents)}` : `čisto ${formatMoney(feedback.costCents)}`;
  return `Prestavba: ${formatMoney(feedback.buildCents ?? feedback.costCents + refund)}, vrátené ${formatMoney(refund)} (${net})`;
}

/** Text štítka stavby cesty: `Jednosmerná cesta · 5 buniek · $7,500 · → východ (R otočí)`; pri odmietnutí dôvody. */
function roadFeedbackText(feedback: BuildFeedback): string {
  if (!feedback.ok && !isFundsOnly(feedback)) return feedback.reasons.map((reason) => REASON_TEXT[reason]).join(' · ');
  const title = feedback.roadKind === undefined ? 'Cesta' : ROAD_KIND_LABEL[feedback.roadKind];
  const parts = [title, cellCountLabel(feedback.cellCount), roadMoneyText(feedback)];
  if (feedback.direction !== undefined) parts.push(feedback.rotatable === true ? `${DIRECTION_LABEL[feedback.direction]} (R otočí)` : DIRECTION_LABEL[feedback.direction]);
  if (!feedback.ok) parts.push(feedback.reasons.map((reason) => REASON_TEXT[reason]).join(' · '));
  return parts.join(' · ');
}

/** Text štítka pre spätnú väzbu (čistá funkcia — testovateľná bez DOM). */
export function feedbackText(feedback: BuildFeedback): string {
  if (feedback.kind === 'module') return moduleFeedbackText(feedback);
  if (feedback.kind === 'place') return roadFeedbackText(feedback);
  if (!feedback.ok) return feedback.reasons.map((reason) => REASON_TEXT[reason]).join(' · ');
  // Pri odstránení je cena záporná (refundácia) — zobrazí sa ako príjem so znamienkom.
  return `Odstrániť · ${cellCountLabel(feedback.cellCount)} · ${formatMoneyDelta(0 - feedback.costCents)}`;
}

/**
 * Ghost je zelený, ale hráč nemá na cenu — jediný dôvod odmietnutia je `insufficient_funds` (§8 bod 6). Platí pre moduly
 * aj stavbu ciest (od T03-20).
 */
export function isFundsOnly(feedback: BuildFeedback): boolean {
  return !feedback.ok && feedback.fundsShort === true && feedback.reasons.every((reason) => reason === 'insufficient_funds');
}

/** Ikona štítka: platný ťah/modul → ikona druhu, chýbajúce peniaze → `$`, inak varovanie (stav nesie ikona aj text). */
export function feedbackIcon(feedback: BuildFeedback): IconName {
  if (isFundsOnly(feedback)) return 'ic_cash';
  if (!feedback.ok) return 'ic_warning';
  if (feedback.kind === 'module') return moduleKindIcon(feedback.moduleKind ?? '');
  return feedback.kind === 'place' ? 'ic_road' : 'ic_demolish';
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
  const fundsOnly = isFundsOnly(feedback);
  const className = [
    'build-tip',
    feedback.ok ? 'build-tip--ok' : fundsOnly ? 'build-tip--funds' : 'build-tip--bad',
    flip ? 'build-tip--flip' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return (
    <div
      className={className}
      style={{ left: feedback.x, top: feedback.y }}
      role="status"
      data-field="build-tip"
      data-kind={feedback.kind}
      data-ok={feedback.ok}
      data-funds-short={fundsOnly}
    >
      <Icon name={feedbackIcon(feedback)} className="build-tip__icon" />
      <span className="build-tip__text">{feedbackText(feedback)}</span>
    </div>
  );
}
