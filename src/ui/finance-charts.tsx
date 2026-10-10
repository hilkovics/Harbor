/**
 * Grafy financií (TF7-03): vlastné SVG bez grafickej knižnice. `StackedBars` (príjmy nad osou, výdaje pod osou, farba
 * podľa kategórie z tokenov, legenda) a `LineChart` (hotovosť na konci obdobia). Vzhľad podľa prototypu
 * design/ui/game-ui.source.html (sekcia Financie: `finChart`, `cashChart`); len tokeny z design/tokens.css, žiadne pevné farby.
 *
 * Čisto prezentačné: vstupy sú hodnoty v centoch (`FinancePeriod`). Geometria a súčty sú čisté funkcie (`periodTotals`,
 * `categoryIds`, `stackedBarLayout`, `linePoints`), aby sa dali testovať bez DOM. Farby sú `var(--token)` v `style`
 * (atribút `fill` s `var()` prehliadače neberú).
 */
import { formatMoney } from './format';
import './finance-charts.css';

/** Súradnicový priestor SVG (šírka × výška); rozmer sa roztiahne cez `width: 100%`. */
export const CHART_WIDTH = 320;
export const CHART_HEIGHT = 120;
/** Vnútorný okraj grafu (px v súradnicovom priestore). */
const CHART_PAD = 6;

/** Farebné tokeny kategórií v poradí (kategória i dostane token `i mod n`). Len názvy z design/tokens.css. */
export const CATEGORY_COLOR_TOKENS = [
  '--ui-accent',
  '--ui-success',
  '--ui-warning',
  '--ui-xp',
  '--ui-danger',
  '--cargo-gas',
  '--cargo-bulk',
  '--ui-info',
] as const;

/** Hodnota `var(--token)` pre i-tu kategóriu (cyklicky); použiteľná v `style`. */
export function categoryColor(index: number): string {
  const count = CATEGORY_COLOR_TOKENS.length;
  const safe = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return `var(${CATEGORY_COLOR_TOKENS[safe % count] ?? '--ui-accent'})`;
}

/** Kategória financií: id (kľúč v `incomeByCat` / `expenseByCat`) a zobrazovaný názov. */
export interface FinanceChartCategory {
  readonly id: string;
  readonly label: string;
}

/**
 * Jedno obdobie (deň alebo mesiac). `incomeByCat` a `expenseByCat` sú v centoch; výdaje sú **kladné** sumy zaplatené
 * (ako `energyCents` vo FinancePanel), záporné znamienko dopĺňa UI. `cashEnd` je hotovosť na konci obdobia (so znamienkom).
 */
export interface FinancePeriod {
  readonly label: string;
  readonly incomeByCat: Readonly<Record<string, number>>;
  readonly expenseByCat: Readonly<Record<string, number>>;
  readonly cashEnd: number;
}

/** Konečné číslo, inak 0 (neplatné hodnoty z VM sa nesmú dostať do geometrie ani do súm). */
export function finiteOr0(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

/** Súčty obdobia: príjem, výdaj (kladný) a čistý zisk `income - expense`. */
export interface PeriodTotals {
  readonly income: number;
  readonly expense: number;
  readonly net: number;
}

export function periodTotals(period: FinancePeriod): PeriodTotals {
  const income = Object.values(period.incomeByCat).reduce((sum, value) => sum + finiteOr0(value), 0);
  const expense = Object.values(period.expenseByCat).reduce((sum, value) => sum + finiteOr0(value), 0);
  return { income, expense, net: income - expense };
}

/**
 * Poradie kategórií: najprv `categories` (VM poradie), potom ďalšie id, ktoré sa vyskytli len v dátach obdobia
 * (názov = id). Bez duplicít.
 */
export function categoryIds(
  periods: readonly FinancePeriod[],
  categories: readonly FinanceChartCategory[] = [],
): FinanceChartCategory[] {
  const result: FinanceChartCategory[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push({ id, label });
  };
  for (const category of categories) add(category.id, category.label);
  for (const period of periods) {
    for (const id of [...Object.keys(period.incomeByCat), ...Object.keys(period.expenseByCat)]) add(id, id);
  }
  return result;
}

/** Úsek stĺpca: kategória, farba, horný a dolný okraj v súradniciach SVG (`y` menšie = vyššie). */
export interface BarSegment {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly y: number;
  readonly height: number;
}

export interface BarColumn {
  readonly label: string;
  readonly x: number;
  readonly width: number;
  readonly income: readonly BarSegment[];
  readonly expense: readonly BarSegment[];
  readonly totals: PeriodTotals;
}

export interface StackedBarLayout {
  readonly columns: readonly BarColumn[];
  /** Os nuly (y). */
  readonly zeroY: number;
  /** Hodnota zodpovedajúca hornému okraju (symetrická škála ± maxValue). */
  readonly maxValue: number;
}

/**
 * Rozloženie stĺpcov: symetrická škála ±maxValue (maxValue = najväčší súčet príjmov alebo výdajov, minimálne 1 cent),
 * príjmy sa kladú nad os od nuly nahor, výdaje pod os nadol. Kategórie sa skladajú v poradí `ids`.
 */
export function stackedBarLayout(
  periods: readonly FinancePeriod[],
  ids: readonly FinanceChartCategory[],
  width: number = CHART_WIDTH,
  height: number = CHART_HEIGHT,
): StackedBarLayout {
  const totals = periods.map(periodTotals);
  const maxValue = Math.max(1, ...totals.map((t) => Math.max(t.income, t.expense)));
  const zeroY = height / 2;
  const scale = (height / 2 - CHART_PAD) / maxValue;
  const band = periods.length > 0 ? width / periods.length : width;
  const barWidth = band * 0.6;
  const columns: BarColumn[] = periods.map((period, index) => {
    const incomeSegments: BarSegment[] = [];
    const expenseSegments: BarSegment[] = [];
    let incomeCum = 0;
    let expenseCum = 0;
    ids.forEach((category, colorIndex) => {
      const color = categoryColor(colorIndex);
      const income = finiteOr0(period.incomeByCat[category.id]);
      if (income > 0) {
        const top = zeroY - (incomeCum + income) * scale;
        const bottom = zeroY - incomeCum * scale;
        incomeSegments.push({ id: category.id, label: category.label, color, y: top, height: bottom - top });
        incomeCum += income;
      }
      const expense = finiteOr0(period.expenseByCat[category.id]);
      if (expense > 0) {
        const top = zeroY + expenseCum * scale;
        const bottom = zeroY + (expenseCum + expense) * scale;
        expenseSegments.push({ id: category.id, label: category.label, color, y: top, height: bottom - top });
        expenseCum += expense;
      }
    });
    return {
      label: period.label,
      x: index * band + (band - barWidth) / 2,
      width: barWidth,
      income: incomeSegments,
      expense: expenseSegments,
      totals: totals[index] ?? { income: 0, expense: 0, net: 0 },
    };
  });
  return { columns, zeroY, maxValue };
}

/** Body čiary: x rovnomerne po šírke, y podľa škály [lo, hi] (hi je hore). Prázdny vstup → prázdne pole. */
export interface LinePoint {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

export function linePoints(
  values: readonly number[],
  width: number = CHART_WIDTH,
  height: number = CHART_HEIGHT,
): { readonly points: readonly LinePoint[]; readonly lo: number; readonly hi: number; readonly zeroY: number } {
  const safe = values.map((value) => finiteOr0(value));
  const lo = Math.min(0, ...safe);
  const hi0 = Math.max(0, ...safe);
  const hi = hi0 === lo ? lo + 1 : hi0;
  const span = hi - lo;
  const top = CHART_PAD;
  const plotHeight = height - CHART_PAD * 2;
  const yOf = (value: number): number => top + ((hi - value) / span) * plotHeight;
  const n = safe.length;
  const points = safe.map((value, index) => ({
    x: n <= 1 ? width / 2 : (index * width) / (n - 1),
    y: yOf(value),
    value,
  }));
  return { points, lo, hi, zeroY: yOf(0) };
}

/** Cesta `M x y L …` pre čiarový graf (prázdna pre prázdny vstup). */
export function linePath(points: readonly LinePoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('');
}

/** Popisok bodu pre `<title>`: `label: príjem …, výdaj …, zisk …` (bez locale, cez `formatMoney`). */
function barTitle(column: BarColumn): string {
  const { income, expense, net } = column.totals;
  return `${column.label}: príjem ${formatMoney(income)}, výdaj ${formatMoney(expense)}, zisk ${formatMoney(net)}`;
}

export interface StackedBarsProps {
  readonly periods: readonly FinancePeriod[];
  readonly categories?: readonly FinanceChartCategory[];
  /** Prístupný názov grafu. */
  readonly label?: string;
}

/** Stĺpcový graf príjmov (nad osou) a výdavkov (pod osou) po kategóriách, s legendou. */
export function StackedBars({ periods, categories = [], label = 'Príjmy a výdaje' }: StackedBarsProps) {
  const ids = categoryIds(periods, categories);
  const layout = stackedBarLayout(periods, ids);
  return (
    <div className="finance-charts__stacked">
      <svg
        className="finance-charts__svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={label}
        data-chart="stacked-bars"
        preserveAspectRatio="none"
      >
        <line
          className="finance-charts__grid"
          x1={0}
          x2={CHART_WIDTH}
          y1={layout.zeroY}
          y2={layout.zeroY}
          style={{ stroke: 'var(--ui-border)' }}
        />
        {layout.columns.map((column) => (
          <g key={column.label} data-column={column.label}>
            <title>{barTitle(column)}</title>
            {[...column.income, ...column.expense].map((segment) => (
              <rect
                key={`${segment.id}-${segment.y.toFixed(1)}`}
                data-segment={segment.id}
                x={column.x}
                y={segment.y}
                width={column.width}
                height={Math.max(0, segment.height)}
                rx={2}
                style={{ fill: segment.color }}
              />
            ))}
          </g>
        ))}
      </svg>
      {ids.length > 0 ? (
        <ul className="finance-charts__legend" aria-label="Legenda kategórií">
          {ids.map((category, index) => (
            <li key={category.id} className="finance-charts__legend-item" data-legend={category.id}>
              <span className="finance-charts__swatch" style={{ background: categoryColor(index) }} />
              {category.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface LineChartProps {
  readonly values: readonly number[];
  readonly labels: readonly string[];
  /** Prístupný názov grafu. */
  readonly label?: string;
}

/** Čiarový graf hodnoty (napr. hotovosť na konci obdobia); nula je vyznačená osou. */
export function LineChart({ values, labels, label = 'Hotovosť na konci obdobia' }: LineChartProps) {
  const { points, zeroY } = linePoints(values);
  return (
    <div className="finance-charts__line">
      <svg
        className="finance-charts__svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={label}
        data-chart="line"
        preserveAspectRatio="none"
      >
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            className="finance-charts__grid"
            x1={0}
            x2={CHART_WIDTH}
            y1={CHART_PAD + fraction * (CHART_HEIGHT - CHART_PAD * 2)}
            y2={CHART_PAD + fraction * (CHART_HEIGHT - CHART_PAD * 2)}
            style={{ stroke: 'var(--ui-border)' }}
          />
        ))}
        <line className="finance-charts__zero" x1={0} x2={CHART_WIDTH} y1={zeroY} y2={zeroY} style={{ stroke: 'var(--ui-text-3)' }} />
        {points.length > 0 ? (
          <path
            className="finance-charts__path"
            d={linePath(points)}
            style={{ fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2, strokeLinejoin: 'round' }}
          />
        ) : null}
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={2.5}
            style={{ fill: 'var(--ui-accent)' }}
          >
            <title>{`${labels[index] ?? String(index + 1)}: ${formatMoney(point.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="finance-charts__axis" aria-hidden="true">
        {labels.map((text, index) => (
          <span key={`${text}-${index}`}>{text}</span>
        ))}
      </div>
    </div>
  );
}
