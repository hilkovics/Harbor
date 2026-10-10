// Vstup dema F7 (TF7-03): FinancePanel s grafmi, ParcelPanel a MonthlyReportModal; dev server ho servíruje ako /src/ui/__demo__/f7-ui-demo.html.
import { mountF7UiDemo } from './f7-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f7-ui-demo.html');
}
mountF7UiDemo(container);
