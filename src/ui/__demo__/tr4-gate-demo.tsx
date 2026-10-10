/**
 * Demo brány R4 (TR4-04): inšpektor vstupného pruhu v režime Trouble (IN-8, front pred bránou), výstupný pruh v štandarde
 * (OUT-1, voľný), predbránová plocha s obsadenosťou a karta TTT v rade štatistík (prototyp design/ui/game-ui-t2.html, sekcie
 * `gate` a `landside`). Statické dáta, žiadna simulácia; klik na režim zapíše posledný príkaz pod panel.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GateLaneInspector, PreGateInspector, TurnTimeStat, type GateLaneInspectorData, type GateLaneMode, type PreGateInspectorData } from '../index';
import './demo-base';

export const GATE_IN_LANE: GateLaneInspectorData = {
  id: 8,
  label: 'IN-8',
  kind: 'in',
  mode: 'trouble',
  step: 'ocr',
  progress: 0.4,
  queueLength: 23,
  trucksProcessed: 1240,
  trucksPerHour: 38,
};

export const GATE_OUT_LANE: GateLaneInspectorData = {
  id: 12,
  label: 'OUT-1',
  kind: 'out',
  mode: 'standard',
  step: 'weigh',
  progress: 0.65,
  queueLength: 4,
  trucksProcessed: 980,
  trucksPerHour: 64,
};

export const PRE_GATE: PreGateInspectorData = {
  rows: [
    { label: 'P-1', slots: [true, true] },
    { label: 'P-2', slots: [true, true] },
    { label: 'P-3', slots: [true, false] },
    { label: 'P-4', slots: [true, true] },
    { label: 'P-5', slots: [true, false] },
    { label: 'P-6', slots: [false, false] },
  ],
  inlandWaiting: 7,
};

export const TTT_MINUTES = 52;

function GateDemo() {
  const [mode, setMode] = useState<GateLaneMode>(GATE_IN_LANE.mode);
  const [lastCommand, setLastCommand] = useState('—');
  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--ui-bg)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <GateLaneInspector
          data={{ ...GATE_IN_LANE, mode }}
          onSetMode={(next) => {
            setMode(next);
            setLastCommand(`setGateLaneMode(IN-8, ${next})`);
          }}
        />
        <GateLaneInspector data={GATE_OUT_LANE} onSetMode={(next) => setLastCommand(`setGateLaneMode(OUT-1, ${next})`)} />
        <PreGateInspector data={PRE_GATE} />
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ width: 'var(--side-panel-w)' }}>
          <TurnTimeStat minutes={TTT_MINUTES} />
        </div>
        <div style={{ width: 'var(--side-panel-w)' }}>
          <TurnTimeStat />
        </div>
      </div>
      <p data-field="last-command" style={{ color: 'var(--ui-text-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>
        Posledný príkaz: {lastCommand}
      </p>
    </main>
  );
}

/** Pripojí demo do `#root` (volá ho `tr4-gate-demo.main.ts`). */
export function mountTr4GateDemo(container: HTMLElement): void {
  createRoot(container).render(<GateDemo />);
}
