// TopHUD vo F5: denný delta hotovosti a skutočné XP (prezentačný `TopHUDView`, hodnoty dodáva app vrstva).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TopHUDView, type TopHUDViewProps } from '@ui/top-hud';
import { fieldText } from './react-tree';

const MINUS = '−';

const BASE: TopHUDViewProps = {
  cashCents: 123_456_000,
  day: 11,
  hour: 14,
  minute: 20,
  speed: 1,
  speeds: [0, 1, 2, 4, 8],
  onSpeedChange: vi.fn(),
};

const render = (extra: Partial<TopHUDViewProps>): string => renderToStaticMarkup(createElement(TopHUDView, { ...BASE, ...extra }));

describe('TopHUDView — denný delta a XP', () => {
  it('kladný delta: znamienko +, zelená trieda, šípka hore', () => {
    const html = render({ dailyDeltaCents: 1_230_000, xp: 340 });
    expect(fieldText(html, 'cash-delta')).toBeNull(); // obsahuje vnorené SVG
    expect(html).toContain('top-hud__delta top-hud__delta--pos');
    expect(html).toContain('+$12,300/deň');
    expect(html).toContain('M12 4l10 16H2z');
  });

  it('záporný delta: U+2212, červená trieda, šípka dole', () => {
    const html = render({ cashCents: -4_820_000, dailyDeltaCents: -640_000, xp: 340 });
    expect(html).toContain('top-hud__delta top-hud__delta--neg');
    expect(html).toContain(`${MINUS}$6,400/deň`);
    expect(html).toContain('M12 20L2 4h20z');
    expect(html).toContain('data-debt="true"');
  });

  it('nulový delta: neutrálny bez šípky; chýbajúce dáta = zástupné —', () => {
    const zero = render({ dailyDeltaCents: 0 });
    expect(zero).toContain('$0/deň');
    expect(zero).not.toContain('top-hud__delta--pos');
    expect(zero).not.toContain('top-hud__delta--neg');
    const none = render({});
    expect(none).toContain('data-placeholder="true"');
    expect(fieldText(none, 'xp')).toBe('— XP');
  });

  it('XP: skutočná hodnota s oddeľovačom tisícov', () => {
    expect(fieldText(render({ xp: 340 }), 'xp')).toBe('340 XP');
    expect(fieldText(render({ xp: 12_340 }), 'xp')).toBe('12,340 XP');
    expect(render({ xp: 0 })).not.toContain('top-hud__xp--empty');
  });
});
