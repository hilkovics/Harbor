/**
 * GameOverModal pripojený na simuláciu (T05-07): zobrazí sa, keď `world.gameOver` (bankrot, ADR-025). Štatistiky sú zo
 * snapshotu (prežité dni = uzavreté herné dni, splnené kontrakty, XP), `bankruptcyDays` z defov ekonomiky. „Nová hra“
 * odovzdá `onNewGame` (bootstrap postaví nový svet s novým seedom a rovnakou mapou).
 *
 * `.app__ui` prepúšťa myš; obal `.app__modal` ju vracia modálu, takže mapa pod ním nereaguje.
 */
import { GameOverModal } from '@ui/game-over-modal';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

export interface ConnectedGameOverProps {
  readonly onNewGame: () => void;
}

export function ConnectedGameOver({ onNewGame }: ConnectedGameOverProps) {
  const bridge = useSimBridge();
  const gameOver = useSimSnapshot((snapshot) => snapshot.gameOver);
  const days = useSimSnapshot((snapshot) => snapshot.day);
  const completedContracts = useSimSnapshot((snapshot) => snapshot.completedContracts);
  const xp = useSimSnapshot((snapshot) => snapshot.xp);
  if (!gameOver) return null;
  return (
    <div className="app__modal">
      <GameOverModal
        daysSurvived={days}
        completedContracts={completedContracts}
        xp={xp}
        bankruptcyDays={bridge.defs.economy.bankruptcyDays}
        onNewGame={onNewGame}
      />
    </div>
  );
}
