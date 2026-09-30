// Vstup dema F3 (sklad, depo, toasty): dev server ho servíruje ako /src/ui/__demo__/f3-ui-demo.html.
import { mountF3UiDemo } from './f3-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f3-ui-demo.html');
}
mountF3UiDemo(container);
