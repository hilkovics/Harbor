/**
 * Ozdoby modulu (`ModuleDecor`): dynamická grafika nad telom modulu, ktorú riadi voliteľné pole `ModuleVM` — závora a fronta
 * brány (`gate`), obsadenosť stojísk (`waitingArea`), pripravené kontajnery a stav rampy (`ramp`). `ModuleView` ich
 * vytvorí lenivo, keď VM pole nesie, a pri každom `update` im ho podá; nový druh modulu = nová ozdoba v `module-decors.ts`,
 * nie vetva v `ModuleView`.
 *
 * Ozdoby žijú v lokálnom rámci modulu (rot 0, počiatok = stred footprintu, jednotka px sveta pri zoome 1); celý kontajner
 * modulu sa otáča o `rotation`, takže polohy zo záznamu manifestu (pri rot 0) netreba rotovať.
 */
import type { Container } from 'pixi.js';
import type { QueueBadgeDeps } from './badges';
import type { ModuleSpriteEntry } from './entity-assets';
import type { FootprintPose } from './footprint-pose';
import type { ModuleVM } from './view-models';

/** Čo `ModuleView` potrebuje od rendereru: náklad a odznaky + hodiny pre animáciu závory. */
export interface ModuleViewDeps extends QueueBadgeDeps {
  /** Čas v ms pre animácie závory; predvolene `performance.now`. V testoch sa podáva riadené hodiny. */
  readonly now?: () => number;
}

/** Kontext, v ktorom sa ozdoba vytvára. */
export interface ModuleDecorContext {
  readonly deps: ModuleViewDeps;
  /** Poloha a rozmery footprintu (lokálny rámec modulu). */
  readonly pose: FootprintPose;
  /** Záznam modulu v manifeste (`undefined` = modul bez spritu; ozdoba sa nakreslí, ak vie, kam ju dať). */
  readonly entry: ModuleSpriteEntry | undefined;
}

export interface ModuleDecor {
  /** Koreň ozdoby v lokálnom rámci modulu. */
  readonly view: Container;
  /** `true` = ozdoba hlási problém modulu; `ModuleView` ukáže odznak `overlay.warning_badge` (rovnako ako pri „nepripojené“). */
  readonly warning?: boolean;
  /** Zosúladí ozdobu s VM (pole VM môže chýbať — ozdoba sa vtedy skryje). */
  update(vm: ModuleVM): void;
  /** Násobok odznakov ozdoby pre zoom kamery (`badgeScaleForZoom`). */
  setBadgeScale?(scale: number): void;
  destroy(): void;
}

export interface ModuleDecorFactory {
  /** Stabilný kľúč ozdoby (jedna inštancia na `ModuleView`). */
  readonly id: string;
  /** Nesie VM dáta tejto ozdoby? */
  applies(vm: ModuleVM): boolean;
  create(vm: ModuleVM, context: ModuleDecorContext): ModuleDecor;
}
