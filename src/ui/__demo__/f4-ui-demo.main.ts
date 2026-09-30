// Vstup dema F4 (brána, stojisko, rampa, BuildBar Landside): dev server ho servíruje ako /src/ui/__demo__/f4-ui-demo.html.
import { mountF4UiDemo } from './f4-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f4-ui-demo.html');
}
mountF4UiDemo(container);
