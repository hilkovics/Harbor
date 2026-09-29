/**
 * Demo TopHUD (T01-10): statický falošný bridge, tri stavy (normálny, pauza, varovanie cash < 0) nad „mapou" z tokenov
 * terénu, aby bolo vidieť poloprehľadné `--ui-bg`. Klikanie na rýchlosť funguje (falošný bridge prepíše snapshot).
 * Spustenie: `mountTopHudDemo(element)` z ľubovoľného vstupného bodu (napr. dočasnej HTML stránky Vite dev servera).
 */
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { TopHUD } from '../top-hud';
import './demo-base';
import { createStaticBridge, type StaticState } from './static-bridge';

interface Variant {
  readonly title: string;
  readonly state: Partial<StaticState>;
  readonly dailyDeltaCents: number | null;
  readonly xp: number | null;
}

/**
 * Hodnoty prototypu design/ui/game-ui.source.html (aby šlo porovnať 1 : 1): normálny stav 1 234 560 USD, +12 300/deň,
 * 340 XP, Deň 12 · 14:20, 1×; varovanie −48 200 USD, −6 400/deň. Druhý rámik ukazuje HUD tak, ako beží vo F1
 * (bez dát pre delta a XP, hotovosť zo štartovných defs 1 200 000 USD).
 */
const VARIANTS: readonly Variant[] = [
  { title: 'Normálny — hodnoty prototypu (delta + XP)', state: { cashCents: 123_456_000 }, dailyDeltaCents: 1_230_000, xp: 340 },
  { title: 'Normálny — zástupné hodnoty (tak ako HUD beží vo F1)', state: {}, dailyDeltaCents: null, xp: null },
  { title: 'Pauza (ikona ⏸ sa zmení na ▶)', state: { cashCents: 123_456_000, speed: 0 }, dailyDeltaCents: 1_230_000, xp: 340 },
  { title: 'Varovanie — cash < 0', state: { cashCents: -4_820_000 }, dailyDeltaCents: -640_000, xp: 340 },
];

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-6)',
  padding: 'var(--space-6)',
  minHeight: '100vh',
  boxSizing: 'border-box',
  background: 'var(--ui-surface)',
  color: 'var(--ui-text)',
  fontFamily: 'var(--font-ui)',
};

const frameStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  height: 'calc(var(--hud-top-h) + var(--space-8) * 2)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--ui-border)',
  // Mapa z tokenov terénu: hlboká voda → plytčina → nábrežie (poloprehľadnosť HUD musí byť viditeľná).
  background:
    'linear-gradient(to bottom, var(--terrain-water-deep) 0 40%, var(--terrain-water-shallow) 40% 70%, var(--terrain-quay) 70% 100%)',
};

const captionStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  color: 'var(--ui-text-2)',
};

function VariantFrame({ variant }: { variant: Variant }) {
  // Jeden falošný bridge na rámik (vytvorí sa raz, stav si drží sám).
  const staticBridge = getStaticBridge(variant.state);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={captionStyle}>{variant.title}</div>
      <div style={frameStyle}>
        <SimBridgeProvider bridge={staticBridge.bridge}>
          <TopHUD dailyDeltaCents={variant.dailyDeltaCents} xp={variant.xp} />
        </SimBridgeProvider>
      </div>
    </section>
  );
}

const bridgeCache = new WeakMap<Variant['state'], ReturnType<typeof createStaticBridge>>();

/** Cache podľa identity `state` objektu (varianty sú modulové konštanty), aby re-render nevytváral nový bridge. */
function getStaticBridge(state: Variant['state']): ReturnType<typeof createStaticBridge> {
  let bridge = bridgeCache.get(state);
  if (bridge === undefined) {
    bridge = createStaticBridge(state);
    bridgeCache.set(state, bridge);
  }
  return bridge;
}

export function TopHudDemo() {
  return (
    <main style={pageStyle}>
      {VARIANTS.map((variant) => (
        <VariantFrame key={variant.title} variant={variant} />
      ))}
    </main>
  );
}

/** Pripojí demo do `element` (dočasná HTML stránka dev servera). */
export function mountTopHudDemo(element: HTMLElement): void {
  createRoot(element).render(<TopHudDemo />);
}
