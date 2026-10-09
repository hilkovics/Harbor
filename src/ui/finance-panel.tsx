/**
 * Tabuľka kategórií financií s riadkom `Energia` (TR5-04). Pozn.: v `src/ui` dosiaľ neexistoval finančný panel (ikona
 * „Financie" v TopHUD nemá panel, DESIGN_BRIEF §6.5 ho plánuje); tento komponent je minimálny základ, do ktorého sa
 * energia zapája ako kategória ledgera `energy`.
 *
 * Čisto prezentačný: hodnoty v centoch, cena elektriny sa zobrazí ako výdaj (záporná delta). `energyCents` je
 * voliteľný a predvolene 0; `categories` je voliteľný zoznam ďalších riadkov (nemení sa ich správanie). Peniaze cez
 * `formatMoneyDelta`, čísla s `tabular-nums`.
 */
import { formatMoneyDelta } from './format';
import './finance-panel.css';

/** Riadok kategórie financií; `cents` je so znamienkom (príjem kladný, výdaj záporný). */
export interface FinanceCategoryRow {
  readonly id: string;
  readonly label: string;
  readonly cents: number;
}

export interface FinancePanelProps {
  readonly categories?: readonly FinanceCategoryRow[];
  /** Výdaj za elektrinu reefrov v centoch (kladné číslo = zaplatené); predvolene 0. */
  readonly energyCents?: number;
}

/** Názov kategórie energie v tabuľke. */
export const ENERGY_CATEGORY_LABEL = 'Energia';

export function FinancePanel({ categories = [], energyCents = 0 }: FinancePanelProps) {
  const safeEnergy = Number.isFinite(energyCents) ? energyCents : 0;
  return (
    <section className="finance-panel" aria-label="Financie" data-section="finance-categories">
      <table className="finance-panel__table">
        <tbody>
          {categories.map((row) => (
            <tr key={row.id} className="finance-panel__row" data-category={row.id}>
              <th scope="row" className="finance-panel__label">
                {row.label}
              </th>
              <td className="finance-panel__value" data-field={`category-${row.id}`}>
                {formatMoneyDelta(row.cents)}
              </td>
            </tr>
          ))}
          <tr className="finance-panel__row" data-category="energy">
            <th scope="row" className="finance-panel__label">
              {ENERGY_CATEGORY_LABEL}
            </th>
            <td className="finance-panel__value" data-field="energy">
              {formatMoneyDelta(-safeEnergy)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
