// Vstup dema F6 (Nastavenia, Uložiť a načítať): dev server ho servíruje ako /src/ui/__demo__/f6-ui-demo.html.
import { mountF6UiDemo } from './f6-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f6-ui-demo.html');
}
mountF6UiDemo(container);
