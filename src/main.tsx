import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@app/app';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Chýba element #root v index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
