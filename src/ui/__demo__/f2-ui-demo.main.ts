// Vstup dema F2 (BuildBar + ModuleInspector): dev server ho servíruje ako /src/ui/__demo__/f2-ui-demo.html.
import { mountF2UiDemo } from './f2-ui-demo';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v f2-ui-demo.html');
}
mountF2UiDemo(container);
