// Vstup dema F6a (export a booking: ContractsPanel, inšpektory, toasty): dev server ho servíruje ako /src/ui/__demo__/f6a-ui-demo.html.
import { mountF6aUiDemo } from './f6a-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f6a-ui-demo.html');
}
mountF6aUiDemo(container);
