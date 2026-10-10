/**
 * Esc zatvorí overlay aj vtedy, keď fokus nie je v dialógu (T06-03b). Keď fokus v dialógu je, Esc spracuje a zastaví
 * samotný `ModalDialog` (do okna sa nedostane); sem sa dostane len po kliku na zásterku alebo keď zmizol prvok s fokusom
 * (po zmazaní slotu), teda keď je `document.body` cieľom udalosti.
 */
import { useEffect } from 'react';
import type { OverlaySelection } from './overlay-selection';

export function useOverlayEscape(overlays: OverlaySelection): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Escape' && overlays.isOpen()) overlays.close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [overlays]);
}
