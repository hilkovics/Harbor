import { runGame } from '@app/run-game';
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

// „Nová hra“ po bankrote zruší bežiacu hru a spustí novú (nový seed, rovnaká mapa) — viď `runGame`.
const game = runGame(container);

// Vite HMR: pri výmene modulu zrušiť bežiacu hru (slučka, Pixi, poslucháče), inak by ich pribúdalo.
import.meta.hot?.dispose(() => {
  void game.dispose();
});
