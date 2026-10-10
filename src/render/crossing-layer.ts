/**
 * CrossingLayer (R6, TR6-05): závory úrovňových priecestí (`EntitiesVM.crossings`). Zatvorená závora = červeno-biele pruhy cez bunku,
 * otvorená = len malé stĺpiky po stranách bunky. Farby z `EntityPalette` (`danger`, `label.color`), rozmery zlomkom bunky.
 */
import { Container, Graphics } from 'pixi.js';
import type { EntityPalette } from './tokens';
import type { CrossingVM } from './view-models';

const STRIPES = 4;
const BAR_THICKNESS = 0.12;
const POST_SIZE = 0.12;

export class CrossingLayer {
  readonly view = new Container({ label: 'crossings' });
  private readonly gfx = new Graphics();
  private lastKey = '';

  constructor(
    private readonly cellPx: number,
    private readonly palette: EntityPalette,
  ) {
    this.view.addChild(this.gfx);
  }

  /** Počet nakreslených priecestí. */
  count = 0;

  sync(crossings: readonly CrossingVM[]): void {
    const key = crossings.map((c) => `${String(c.x)},${String(c.y)},${c.barrier}`).join(';');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.count = crossings.length;
    const g = this.gfx;
    g.clear();
    const { cellPx } = this;
    const { danger, label } = this.palette;
    for (const c of crossings) {
      const left = (c.x - 0.5) * cellPx;
      const top = (c.y - 0.5) * cellPx;
      const post = POST_SIZE * cellPx;
      g.rect(left, top, post, post).fill({ color: danger.color, alpha: danger.alpha });
      g.rect(left + cellPx - post, top, post, post).fill({ color: danger.color, alpha: danger.alpha });
      if (c.barrier !== 'closed') continue;
      const barY = top + (post - BAR_THICKNESS * cellPx) / 2;
      const w = (cellPx - 2 * post) / STRIPES;
      for (let i = 0; i < STRIPES; i++) {
        const tone = i % 2 === 0 ? danger : label.color;
        g.rect(left + post + i * w, barY, w, BAR_THICKNESS * cellPx).fill({ color: tone.color, alpha: tone.alpha });
      }
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
