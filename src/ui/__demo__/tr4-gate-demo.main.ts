// Vstup dema TR4 (brána, predbránová plocha, TTT): dev server ho servíruje ako /src/ui/__demo__/tr4-gate-demo.html.
import { mountTr4GateDemo } from './tr4-gate-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v tr4-gate-demo.html');
}
mountTr4GateDemo(container);
