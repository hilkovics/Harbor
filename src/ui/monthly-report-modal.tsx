/**
 * MonthlyReportModal (TF7-03): mesačný report (rozloženie z prototypu design/ui/game-ui.source.html, overlay `report`).
 * Hlavička s označením mesiaca, tri dlaždice (príjmy, výdaje, čistý zisk) s hotovosťou, tabuľka kategórií za mesiac
 * a „Najväčšie zmeny oproti predchádzajúcemu mesiacu“ (top 3 podľa absolútnej zmeny netta kategórie).
 *
 * Čisto prezentačný: `summary` dodá rodič (z ledgera); bez `summary` sa zobrazí prázdny stav. Zatvára sa cez
 * `ModalDialog` (✕, Esc) a tlačidlo „Zavrieť“ (`onClose`). Peniaze cez `formatMoney` / `formatMoneyDelta`.
 */
import { ModalDialog } from './modal-dialog';
import { financeBreakdownRows } from './finance-panel';
import { formatCount, formatMoney, formatMoneyDelta, moneySign } from './format';
import { categoryIds, finiteOr0, periodTotals, type FinanceChartCategory, type FinancePeriod } from './finance-charts';
import './monthly-report-modal.css';

/** Súhrn mesiaca: označenie („Mesiac 1 · deň 1–30“), aktuálne obdobie, predchádzajúce obdobie a kategórie. */
export interface MonthlyReportSummary {
  readonly monthLabel: string;
  readonly current: FinancePeriod;
  readonly previous?: FinancePeriod;
  readonly categories?: readonly FinanceChartCategory[];
}

export interface MonthlyReportModalProps {
  readonly summary?: MonthlyReportSummary;
  readonly onClose: () => void;
}

/** Počet najväčších zmien v reporte. */
export const TOP_CHANGES_COUNT = 3;

/** Zmena čistého zisku kategórie oproti predchádzajúcemu mesiacu (centy so znamienkom). */
export interface CategoryChange {
  readonly id: string;
  readonly label: string;
  readonly delta: number;
}

/**
 * Top zmeny netta kategórií (`(príjem − výdaj)` aktuálne − predchádzajúce): bez nulových zmien, zoradené podľa
 * absolútnej hodnoty zostupne (pri zhode poradie kategórií), najviac `count` položiek.
 */
export function topChanges(
  current: FinancePeriod,
  previous: FinancePeriod,
  categories: readonly FinanceChartCategory[] = [],
  count: number = TOP_CHANGES_COUNT,
): CategoryChange[] {
  const ids = categoryIds([current, previous], categories);
  const changes = ids.map((category) => {
    const now = finiteOr0(current.incomeByCat[category.id]) - finiteOr0(current.expenseByCat[category.id]);
    const before = finiteOr0(previous.incomeByCat[category.id]) - finiteOr0(previous.expenseByCat[category.id]);
    return { id: category.id, label: category.label, delta: now - before };
  });
  return changes
    .filter((change) => change.delta !== 0)
    .map((change, order) => ({ change, order }))
    .sort((a, b) => Math.abs(b.change.delta) - Math.abs(a.change.delta) || a.order - b.order)
    .slice(0, Math.max(0, Math.trunc(count)))
    .map((item) => item.change);
}

/** Tón čísla: pozitívne `--ui-money-pos`, negatívne `--ui-money-neg`. */
function toneClass(cents: number): string {
  const sign = moneySign(cents);
  if (sign > 0) return 'monthly-report__money--pos';
  if (sign < 0) return 'monthly-report__money--neg';
  return '';
}

export function MonthlyReportModal({ summary, onClose }: MonthlyReportModalProps) {
  return (
    <ModalDialog label="Mesačný report" title="Mesačný report" onClose={onClose} className="monthly-report" dialogId="monthly-report">
      {summary === undefined ? (
        <div className="modal-dialog__body monthly-report__body">
          <p className="monthly-report__empty" data-field="empty">
            Report za uplynulý mesiac zatiaľ nie je k dispozícii.
          </p>
        </div>
      ) : (
        <ReportBody summary={summary} />
      )}
      <div className="modal-dialog__footer">
        <button type="button" className="modal-btn modal-btn--primary" data-action="close" onClick={onClose}>
          Zavrieť
        </button>
      </div>
    </ModalDialog>
  );
}

function ReportBody({ summary }: { readonly summary: MonthlyReportSummary }) {
  const { current, previous } = summary;
  const categories = summary.categories ?? [];
  const totals = periodTotals(current);
  const rows = financeBreakdownRows(current, [current], categories);
  const changes = previous === undefined ? undefined : topChanges(current, previous, categories);
  return (
    <div className="modal-dialog__body monthly-report__body">
      <div className="monthly-report__head">
        <span className="monthly-report__eyebrow" data-field="month-label">
          {summary.monthLabel}
        </span>
      </div>
      <div className="monthly-report__tiles">
        <div className="monthly-report__tile">
          <span className="monthly-report__tile-label">Príjmy</span>
          <span className="monthly-report__tile-value" data-field="income">
            {formatMoney(totals.income)}
          </span>
        </div>
        <div className="monthly-report__tile">
          <span className="monthly-report__tile-label">Výdaje</span>
          <span className="monthly-report__tile-value" data-field="expense">
            {formatMoney(totals.expense)}
          </span>
        </div>
        <div className="monthly-report__tile">
          <span className="monthly-report__tile-label">Čistý zisk</span>
          <span className={`monthly-report__tile-value ${toneClass(totals.net)}`} data-field="net">
            {formatMoneyDelta(totals.net)}
          </span>
        </div>
      </div>
      <div className="monthly-report__cash">
        <span>Hotovosť na konci mesiaca</span>
        <span className="monthly-report__cash-value" data-field="cash">
          {formatMoney(current.cashEnd)}
        </span>
      </div>
      <table className="monthly-report__table" data-section="report-categories">
        <thead>
          <tr>
            <th scope="col">Kategória</th>
            <th scope="col" className="monthly-report__num">Príjem</th>
            <th scope="col" className="monthly-report__num">Výdaj</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-category={row.id}>
              <th scope="row">{row.label}</th>
              <td className="monthly-report__num" data-field={`income-${row.id}`}>
                {formatMoney(row.income)}
              </td>
              <td className="monthly-report__num" data-field={`expense-${row.id}`}>
                {formatMoney(row.expense)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="monthly-report__changes">
        <span className="monthly-report__section-title">Najväčšie zmeny oproti predchádzajúcemu mesiacu</span>
        {changes === undefined ? (
          <p className="monthly-report__empty" data-field="no-previous">
            Predchádzajúci mesiac ešte nie je k dispozícii.
          </p>
        ) : changes.length === 0 ? (
          <p className="monthly-report__empty" data-field="no-changes">
            Bez zmien oproti predchádzajúcemu mesiacu.
          </p>
        ) : (
          <ol className="monthly-report__change-list" data-field="changes">
            {changes.map((change, index) => (
              <li key={change.id} className="monthly-report__change" data-change={change.id}>
                <span className="monthly-report__rank">{formatCount(index + 1)}</span>
                <span className="monthly-report__change-label">{change.label}</span>
                <span className={`monthly-report__change-value ${toneClass(change.delta)}`}>{formatMoneyDelta(change.delta)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
