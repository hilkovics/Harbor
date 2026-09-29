/**
 * BuildBar (DESIGN_BRIEF §6.1–§6.2; rozloženie z prototypu design/ui/game-ui.source.html, <footer>): spodný pás
 * `--build-bar-h` (96 px) — hore riadok kategórií (taby s klávesou 1–n, vpravo nápoveda R / Esc), pod ním položky
 * aktívnej kategórie: ikona + názov + cena · rozmer. Stavy položky: dostupná / nedostatok peňazí (cena
 * `--ui-money-neg`, tooltip „Chýba …") / zamknutá (zámok, tooltip s dôvodom). Vybraná položka má accent obrys.
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov a bez prístupu k simulácii): zoznam kategórií, ceny
 * a `affordable`/`locked` mu dodá rodič zo snapshotu (`useSimSnapshot(selector, 100)`) a výber zapisuje ďalej cez
 * `dispatch(command)`. Napojenie prinesú T02-09 (dáta) a T02-10 (build mód). Kategórie mimo aktuálnej fázy majú
 * `enabled: false` — vizuálne zamknuté (zámok, `disabled`), klik sa ignoruje.
 *
 * Tooltipy sú čisté CSS (hover / focus-visible na položke), ale sú stále v DOM (`role="tooltip"` +
 * `aria-describedby`), takže ich prečíta aj asistívna technológia.
 */
import { formatFootprint, formatMoney } from './format';
import { Icon, type IconName } from './icon';
import './build-bar.css';

export interface BuildBarItem {
  /** Id definície modulu (`berth_standard`) — to, čo sa pošle do `onSelect`. */
  readonly defId: string;
  readonly displayName: string;
  readonly costCents: number;
  /** Názov ikony zo spritu, s prefixom (`ic_berth`) aj bez neho (`berth`). */
  readonly icon: string;
  /** Rozmer v bunkách pri rotácii 0. */
  readonly footprint: { readonly w: number; readonly h: number };
  /** Zamknuté technológiou. */
  readonly locked: boolean;
  /** Hráč má na cenu hotovosť; `false` → cena červená, položku nejde vybrať. */
  readonly affordable: boolean;
  /**
   * Doplnok oproti karte T02-08 (voliteľný): dôvod zámku pre tooltip, napr. `Vyžaduje technológiu Kvapalné terminály
   * · 120 XP`. Bez neho tooltip ukáže všeobecný text.
   */
  readonly lockedReason?: string;
  /** Doplnok oproti karte (voliteľný): koľko chýba do ceny, v centoch — tooltip „Chýba $150,000". */
  readonly missingCents?: number;
}

export interface BuildBarCategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** `false` = kategória mimo aktuálnej fázy: zamknutý tab, nedá sa aktivovať. */
  readonly enabled: boolean;
  readonly items: readonly BuildBarItem[];
}

export interface BuildBarProps {
  readonly categories: readonly BuildBarCategory[];
  readonly activeCategoryId: string;
  readonly selectedDefId: string | null;
  readonly onSelectCategory: (id: string) => void;
  /** `defId` = vybraná položka; `null` = zrušenie výberu (klik na už vybranú položku). */
  readonly onSelect: (defId: string | null) => void;
  /**
   * Prefix `id` tooltipov (`aria-describedby`); pri viacerých BuildBar na jednej stránke musí byť unikátny.
   * Predvolene `build-bar`.
   */
  readonly idPrefix?: string;
}

export type BuildBarItemStatus = 'available' | 'unaffordable' | 'locked';

/** Stav položky; zámok má prednosť pred nedostatkom peňazí (zamknutú položku hráč nekúpi ani s peniazmi). */
export function itemStatus(item: Pick<BuildBarItem, 'locked' | 'affordable'>): BuildBarItemStatus {
  if (item.locked) return 'locked';
  return item.affordable ? 'available' : 'unaffordable';
}

/** Názov ikony pre `<Icon>`: `berth` aj `ic_berth` → `ic_berth`. */
export function toIconName(icon: string): IconName {
  return icon.startsWith('ic_') ? (icon as IconName) : `ic_${icon}`;
}

/** Text a ikona tooltipu položky; `null` = dostupná položka, tooltip sa nezobrazuje. */
export interface ItemTooltip {
  readonly title: string;
  readonly text: string;
  readonly icon: IconName;
  readonly tone: 'locked' | 'poor';
}

export const TOOLTIP_LOCKED_FALLBACK = 'Vyžaduje odomknutie technológiou';
export const TOOLTIP_POOR_FALLBACK = 'Cena presahuje hotovosť';

export function itemTooltip(item: BuildBarItem): ItemTooltip | null {
  switch (itemStatus(item)) {
    case 'locked':
      return { title: 'Zamknuté', text: item.lockedReason ?? TOOLTIP_LOCKED_FALLBACK, icon: 'ic_lock', tone: 'locked' };
    case 'unaffordable': {
      const missing = item.missingCents;
      const text = missing !== undefined && missing > 0 ? `Chýba ${formatMoney(missing)}` : TOOLTIP_POOR_FALLBACK;
      return { title: 'Nedostatok peňazí', text, icon: 'ic_cash', tone: 'poor' };
    }
    case 'available':
      return null;
  }
}

/**
 * Čo sa stane po kliku na položku: `undefined` = nič (zamknutá / bez peňazí), `null` = zrušenie výberu (klik na už
 * vybranú položku), inak `defId` novej voľby.
 */
export function resolveItemSelection(item: BuildBarItem, selectedDefId: string | null): string | null | undefined {
  if (itemStatus(item) !== 'available') return undefined;
  return item.defId === selectedDefId ? null : item.defId;
}

/** Klávesa kategórie: poradie od 1 (prototyp: `1`–`6`). */
export function categoryKey(index: number): string {
  return String(index + 1);
}

/** Tooltip pre zamknutú kategóriu (mimo fázy). */
function categoryTitle(category: BuildBarCategory): string | undefined {
  return category.enabled ? undefined : `${category.label} · čoskoro`;
}

export function BuildBar({
  categories,
  activeCategoryId,
  selectedDefId,
  onSelectCategory,
  onSelect,
  idPrefix = 'build-bar',
}: BuildBarProps) {
  const active = categories.find((category) => category.id === activeCategoryId);
  return (
    <footer className="build-bar" aria-label="Stavba" data-active-category={activeCategoryId}>
      <div className="build-bar__tabs" role="tablist" aria-label="Kategórie stavby">
        {categories.map((category, index) => {
          const isActive = category.id === activeCategoryId;
          const classes = ['build-bar__tab'];
          if (isActive) classes.push('build-bar__tab--active');
          if (!category.enabled) classes.push('build-bar__tab--locked');
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              className={classes.join(' ')}
              aria-selected={isActive}
              disabled={!category.enabled}
              title={categoryTitle(category)}
              data-category={category.id}
              onClick={() => {
                if (category.enabled) onSelectCategory(category.id);
              }}
            >
              <Icon name={toIconName(category.icon)} className="build-bar__tab-icon" />
              <span>{category.label}</span>
              <kbd className="build-bar__key">{categoryKey(index)}</kbd>
              {!category.enabled && <Icon name="ic_lock" className="build-bar__tab-lock" />}
            </button>
          );
        })}
        <span className="build-bar__spacer" />
        <span className="build-bar__hints">
          <kbd className="build-bar__key">R</kbd>
          <span>otočiť</span>
          <kbd className="build-bar__key build-bar__key--gap">Esc</kbd>
          <span>zrušiť</span>
        </span>
      </div>
      <div className="build-bar__items" role="group" aria-label={active === undefined ? 'Položky' : `Položky: ${active.label}`}>
        {active === undefined || active.items.length === 0 ? (
          <span className="build-bar__empty">V tejto kategórii zatiaľ nie sú žiadne položky.</span>
        ) : (
          active.items.map((item) => {
            const status = itemStatus(item);
            const tip = itemTooltip(item);
            const selected = item.defId === selectedDefId;
            const tipId = `${idPrefix}-tip-${item.defId}`;
            const classes = ['build-bar__item', `build-bar__item--${status}`];
            if (selected) classes.push('build-bar__item--selected');
            return (
              <button
                key={item.defId}
                type="button"
                className={classes.join(' ')}
                aria-pressed={selected}
                aria-disabled={status !== 'available'}
                aria-describedby={tip === null ? undefined : tipId}
                data-def-id={item.defId}
                data-status={status}
                onClick={() => {
                  const next = resolveItemSelection(item, selectedDefId);
                  if (next !== undefined) onSelect(next);
                }}
              >
                <Icon name={toIconName(item.icon)} className="build-bar__item-icon" />
                <span className="build-bar__item-text">
                  <span className="build-bar__item-name">{item.displayName}</span>
                  <span className="build-bar__item-price">
                    <span className="build-bar__item-cost" data-field="item-cost">
                      {formatMoney(item.costCents)}
                    </span>
                    <span className="build-bar__item-size" data-field="item-size">
                      {`· ${formatFootprint(item.footprint)}`}
                    </span>
                  </span>
                </span>
                {item.locked && <Icon name="ic_lock" className="build-bar__item-lock" />}
                {tip !== null && (
                  <span role="tooltip" id={tipId} className={`build-bar__tip build-bar__tip--${tip.tone}`}>
                    <span className="build-bar__tip-title">
                      <Icon name={tip.icon} className="build-bar__tip-icon" />
                      {tip.title}
                    </span>
                    <span className="build-bar__tip-text">{tip.text}</span>
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </footer>
  );
}
