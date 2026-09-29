import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@app/app';
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
