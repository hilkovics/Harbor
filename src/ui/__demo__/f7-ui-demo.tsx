/**
 * Demo F7 UI (TF7-03): FinancePanel s grafmi (Deň / Mesiac, StackedBars, LineChart, tabuľka za obdobie), ParcelPanel
 * (kúpa vs. prenájom, vypnutie podľa hotovosti) a MonthlyReportModal (top 3 zmeny). Statické dáta v tomto súbore,
 * žiadna simulácia. Spustenie: dev server → /src/ui/__demo__/f7-ui-demo.html; screenshot a kontrolu robí
 * tests/e2e/f7-ui-demo.spec.ts (mimo tohto tasku). Rozloženie: pravý panel hry (rozloženie prototypu
 * design/ui/game-ui.source.html, sekcie `finance`, `parcel`, overlay `report`).
 */
import { createRoot } from 'react-dom/client';
import './demo-base';
import { FinancePanel, type FinanceChartCategory, type FinancePeriod } from '../finance-panel';
import { MonthlyReportModal, type MonthlyReportSummary } from '../monthly-report-modal';
import { ParcelPanel, type ParcelInfo } from '../parcel-panel';
import './f7-ui-demo.css';

const CATEGORIES: readonly FinanceChartCategory[] = [
  { id: 'handling', label: 'Manipulácia' },
  { id: 'port_fees', label: 'Prístavné poplatky' },
  { id: 'storage', label: 'Skladovanie' },
  { id: 'wages', label: 'Mzdy' },
  { id: 'opex', label: 'Prevádzka' },
];

const DAILY: readonly FinancePeriod[] = [
  { label: '1', incomeByCat: { handling: 4_200_000, port_fees: 900_000 }, expenseByCat: { wages: 1_500_000, opex: 400_000 }, cashEnd: 1_234_560_00 },
  { label: '2', incomeByCat: { handling: 3_100_000, storage: 600_000 }, expenseByCat: { wages: 1_500_000, opex: 520_000 }, cashEnd: 1_290_000_00 },
  { label: '3', incomeByCat: { handling: 5_400_000, port_fees: 700_000 }, expenseByCat: { wages: 1_500_000, opex: 380_000, storage: 150_000 }, cashEnd: 1_380_000_00 },
  { label: '4', incomeByCat: { handling: 2_900_000, storage: 450_000 }, expenseByCat: { wages: 1_500_000, opex: 460_000 }, cashEnd: 1_300_000_00 },
  { label: '5', incomeByCat: { handling: 6_100_000, port_fees: 1_100_000 }, expenseByCat: { wages: 1_500_000, opex: 410_000, storage: 90_000 }, cashEnd: 1_520_000_00 },
  { label: '6', incomeByCat: { handling: 4_800_000, storage: 700_000 }, expenseByCat: { wages: 1_500_000, opex: 440_000 }, cashEnd: 1_580_000_00 },
  { label: '7', incomeByCat: { handling: 5_000_000, port_fees: 800_000 }, expenseByCat: { wages: 1_500_000, opex: 430_000, storage: 120_000 }, cashEnd: 1_654_560_00 },
];

const MONTHLY: readonly FinancePeriod[] = [
  { label: 'M1', incomeByCat: { handling: 120_000_000, port_fees: 28_620_000 }, expenseByCat: { wages: 90_000_000, opex: 31_290_000 }, cashEnd: 1_234_560_00 },
  { label: 'M2', incomeByCat: { handling: 134_000_000, port_fees: 31_000_000, storage: 9_000_000 }, expenseByCat: { wages: 90_000_000, opex: 36_000_000, storage: 5_000_000 }, cashEnd: 1_480_000_00 },
  { label: 'M3', incomeByCat: { handling: 118_000_000, port_fees: 26_000_000, storage: 12_000_000 }, expenseByCat: { wages: 90_000_000, opex: 35_000_000 }, cashEnd: 1_520_000_00 },
];

const PARCEL: ParcelInfo = { id: 'parcel_east_1', w: 12, h: 8, state: 'for_sale', priceCents: 64_000_000, leasePerMonthCents: 980_000 };

const REPORT: MonthlyReportSummary = {
  monthLabel: 'Mesiac 3 · deň 61–90',
  current: MONTHLY[2]!,
  previous: MONTHLY[1]!,
  categories: CATEGORIES,
};

/** Hotovosť v demo (centy, 500 000 $): nestačí na kúpu parcely za 640 000 $, ale na prenájom áno. */
const DEMO_CASH_CENTS = 50_000_000;

export function F7UiDemo() {
  return (
    <div className="f7-demo" data-demo="f7">
      <div className="f7-demo__column" data-column="finance">
        <FinancePanel daily={DAILY} monthly={MONTHLY} chartCategories={CATEGORIES} />
      </div>
      <div className="f7-demo__column" data-column="parcel">
        <ParcelPanel parcel={PARCEL} cash={DEMO_CASH_CENTS} onBuy={() => undefined} onLease={() => undefined} onRelease={() => undefined} releaseBlockedReason="Na parcele stojí modul" />
      </div>
      <div className="f7-demo__stage" data-column="report">
        <MonthlyReportModal summary={REPORT} onClose={() => undefined} />
      </div>
    </div>
  );
}

export function mountF7UiDemo(container: HTMLElement): void {
  createRoot(container).render(<F7UiDemo />);
}
