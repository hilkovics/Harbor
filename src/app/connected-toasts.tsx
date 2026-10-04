/**
 * Toasts pripojené na `ToastCenter` (`@ui/toasts` je čisto prezentačný, T03-10): zásobník oznámení vľavo od pravého
 * panelu nad BuildBarom. Zoznam a jeho zmeny (nové udalosti zo simu, auto-zatvorenie, ×) spravuje `ToastCenter`
 * mimo Reactu; tu sa len číta cez `useSyncExternalStore`.
 *
 * `.app__ui` prepúšťa myš; obal `.app__toasts` ju vracia toastom (tlačidlá „Ukázať“ a ×).
 */
import { useSyncExternalStore } from 'react';
import { Toasts } from '@ui/toasts';
import type { ToastCenter } from './toast-center';

export interface ConnectedToastsProps {
  readonly center: ToastCenter;
}

export function ConnectedToasts({ center }: ConnectedToastsProps) {
  const toasts = useSyncExternalStore(center.subscribe, center.get, center.get);
  if (toasts.length === 0) return null;
  return (
    <div className="app__toasts">
      <Toasts toasts={toasts} />
    </div>
  );
}
