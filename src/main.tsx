import { bootstrap } from '@app/bootstrap';
// Fonty self-hosted (bez CDN): latin + latin-ext pokrýva slovenčinu (ň, č, š, ž, ľ…). Váhy podľa tokenov --fw-*.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '../design/tokens.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v index.html');
}

const started = bootstrap(container);

// Vite HMR: pri výmene modulu zrušiť bežiacu hru (slučka, Pixi, poslucháče), inak by ich pribúdalo.
import.meta.hot?.dispose(() => {
  void started.then((handle) => {
    handle.destroy();
  });
});
