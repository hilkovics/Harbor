// Vstup dema F5 (kontrakty, HUD, bankrot): dev server ho servíruje ako /src/ui/__demo__/f5-ui-demo.html.
import { mountF5UiDemo } from './f5-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f5-ui-demo.html');
}
mountF5UiDemo(container);
