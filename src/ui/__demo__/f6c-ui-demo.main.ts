// Vstup dema F6c (prázdne kontajnery a prekládka: ContractsPanel, inšpektory, toasty): dev server ho servíruje ako /src/ui/__demo__/f6c-ui-demo.html.
import { mountF6cUiDemo } from './f6c-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f6c-ui-demo.html');
}
mountF6cUiDemo(container);
