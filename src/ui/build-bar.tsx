/**
 * BuildBar (DESIGN_BRIEF §6.1–§6.2; rozloženie z prototypu design/ui/game-ui.source.html, <footer>): spodný pás
 * `--build-bar-h` (96 px) — hore riadok kategórií (taby, vpravo nápoveda R / Esc), pod ním položky aktívnej
 * kategórie: ikona + názov + cena · rozmer. Klávesy 1–4 patria rýchlostiam hry (ARCHITECTURE §15.2), preto taby
 * nemajú číselnú nápovedu. Stavy položky: dostupná / nedostatok peňazí (cena `--ui-money-neg`, tooltip „Chýba …";
 * položku ide vybrať — ghost je zelený s ikonou $ a klik nič nepostaví, ARCHITECTURE §8 bod 6) / zamknutá (zámok,
 * tooltip s dôvodom, nevyberateľná). Vybraná položka má accent obrys.
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov a bez prístupu k simulácii): zoznam kategórií, ceny
 * a `affordable`/`locked` mu dodá rodič zo snapshotu (`useSimSnapshot(selector, 100)`) a výber zapisuje ďalej cez
 * `dispatch(command)`. Napojenie prinesú T02-09 (dáta) a T02-10 (build mód). Kategórie mimo aktuálnej fázy majú
 * `enabled: false` — vizuálne zamknuté (zámok, `disabled`), klik sa ignoruje.
 *
 * Položky majú dve akcie (F3, T03-09): `build` (predvolená) = výber pre build mód (ghost, klik do mapy), `buy` =
 * okamžitý nákup bez ghostu (vozidlo: `straddle_carrier` ide do depa) — klik volá `onBuy(defId)`, položka sa nikdy
 * „nevyberie" (bez `aria-pressed`) a v cenovom riadku má namiesto rozmeru text „kúpiť". Stavy (dostupná / bez peňazí /
 * zamknutá) a tooltipy sú rovnaké; nákup bez peňazí sa ignoruje (nie je čo ukázať ako ghost), zamknutá `buy` položka
 * nesie dôvod v `lockedReason` (napr. „Postav depo vozidiel").
 *
 * Tretia akcia `road` (F3, T03-20: typy ciest v Landside): výber typu cesty ako pri `build` (prepínač s `aria-pressed`, opakovaný
klik ho zruší), ale cez vlastný stav a callback — `selectedRoadDefId` a `onSelectRoad` —, aby výber typu cesty
nekolidoval s výberom modulu. Cena je za bunku: položka nesie hotový text ceny `priceText` (`$2,000 / bunka`), ktorý
nahrádza formátovanú `costCents`; rovnaké pole ukazuje aj zástupné zamknuté položky (`čoskoro (F4)`).

Tooltipy sú čisté CSS (hover / focus-visible na položke), ale sú stále v DOM (`role="tooltip"` +
 * `aria-describedby`), takže ich prečíta aj asistívna technológia.
 */
import { formatFootprint, formatMoney } from './format';
import { Icon, toIconName, type IconName } from './icon';
import './build-bar.css';

/**
 * Čo klik na položku robí: `build` = výber pre build mód modulov (`onSelect`), `buy` = okamžitý nákup (`onBuy`),
 * `road` = výber typu cesty pre build mód ciest (`onSelectRoad`).
 */
export type BuildBarItemAction = 'build' | 'buy' | 'road';

export interface BuildBarItem {
  /** Id definície (`berth_standard`, `straddle_carrier`) — to, čo sa pošle do `onSelect` / `onBuy`. */
  readonly defId: string;
  readonly displayName: string;
  readonly costCents: number;
  /** Názov ikony zo spritu, s prefixom (`ic_berth`) aj bez neho (`berth`). */
  readonly icon: string;
  /** Rozmer v bunkách pri rotácii 0; pri `action: 'buy'` (vozidlo bez stopy) sa nezobrazuje, preto môže chýbať. */
  readonly footprint?: { readonly w: number; readonly h: number };
  /** Zamknuté technológiou. */
  readonly locked: boolean;
  /** Hráč má na cenu hotovosť; `false` → cena červená a tooltip „Chýba …", položku ale ide vybrať (ghost s ikonou $). */
  readonly affordable: boolean;
  /**
   * Doplnok oproti karte T02-08 (voliteľný): dôvod zámku pre tooltip, napr. `Vyžaduje technológiu Kvapalné terminály
   * · 120 XP`. Bez neho tooltip ukáže všeobecný text.
   */
  readonly lockedReason?: string;
  /** Doplnok oproti karte (voliteľný): koľko chýba do ceny, v centoch — tooltip „Chýba $150,000". */
  readonly missingCents?: number;
  /** F3 (voliteľný, predvolene `build`): `buy` = okamžitý nákup (vozidlo), klik volá `onBuy`; `road` = typ cesty, klik volá `onSelectRoad`. */
  readonly action?: BuildBarItemAction;
  /**
   * F3 (voliteľný): hotový text ceny namiesto formátovanej `costCents`, napr. `$2,000 / bunka` (cesta sa platí za bunku)
   * alebo `čoskoro (F4)` (zástupná zamknutá položka). Bez neho sa zobrazí `formatMoney(costCents)`.
   */
  readonly priceText?: string;
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
   * F3 (voliteľný, spätne kompatibilný): nákup položky s `action: 'buy'`. Volá sa len pre dostupnú (nezamknutú,
   * na cenu dosiahnuteľnú) položku; bez neho klik na `buy` položku nerobí nič.
   */
  readonly onBuy?: (defId: string) => void;
  /** `defId` vybranej cestnej položky (`action: 'road'`), alebo `null`/vynechané = build mód ciest nie je zapnutý. */
  readonly selectedRoadDefId?: string | null;
  /**
   * F3 (voliteľný): výber cestnej položky; `defId` = nový typ, `null` = zrušenie (opakovaný klik na vybranú položku).
   * Bez neho klik na `road` položku nerobí nič.
   */
  readonly onSelectRoad?: (defId: string | null) => void;
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

/** Akcia položky; bez `action` je to `build`. */
export function itemAction(item: Pick<BuildBarItem, 'action'>): BuildBarItemAction {
  return item.action ?? 'build';
}

/** Názov ikony pre `<Icon>`: `berth` aj `ic_berth` → `ic_berth` (definícia je v `icon.tsx`, tu ostáva pre spätnú kompatibilitu). */
export { toIconName };

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
 * Čo sa stane po kliku na položku: `undefined` = nič (zamknutá technológiou), `null` = zrušenie výberu (klik na už
 * vybranú položku), inak `defId` novej voľby. Drahá (`affordable: false`), ale nezamknutá položka sa vybrať dá:
 * hráč vidí ghost a cenu, len klik do mapy nič nepostaví (rozhodnutie orchestrátora k §8 bodu 6). Pre `road` položku
 * je `selectedDefId` aktuálny výber typu cesty (`selectedRoadDefId`), pre `build` výber modulu.
 */
export function resolveItemSelection(item: BuildBarItem, selectedDefId: string | null): string | null | undefined {
  if (itemAction(item) === 'buy') return undefined; // nákup sa nevyberá, ide cez `onBuy`
  if (itemStatus(item) === 'locked') return undefined;
  return item.defId === selectedDefId ? null : item.defId;
}

/** Klik na `buy` položku nakupuje len dostupná položka (zamknutá ani drahá nie; `build` položky nikdy). */
export function canBuyItem(item: Pick<BuildBarItem, 'action' | 'locked' | 'affordable'>): boolean {
  return itemAction(item) === 'buy' && itemStatus(item) === 'available';
}

/** Text ceny položky: `priceText`, inak formátovaná `costCents`. */
export function itemPriceText(item: Pick<BuildBarItem, 'priceText' | 'costCents'>): string {
  return item.priceText ?? formatMoney(item.costCents);
}

/** Popis akcie pri položke `buy` (v cenovom riadku namiesto rozmeru). */
export const BUY_ITEM_LABEL = 'kúpiť';

/** Text v cenovom riadku za cenou: „kúpiť" pri nákupe, rozmer pri stavbe; `null` = nič (stavba bez známeho rozmeru). */
export function itemDetail(item: Pick<BuildBarItem, 'action' | 'footprint'>): string | null {
  if (itemAction(item) === 'buy') return BUY_ITEM_LABEL;
  return item.footprint === undefined ? null : formatFootprint(item.footprint);
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
  onBuy,
  selectedRoadDefId = null,
  onSelectRoad,
  idPrefix = 'build-bar',
}: BuildBarProps) {
  const active = categories.find((category) => category.id === activeCategoryId);
  return (
    <footer className="build-bar" aria-label="Stavba" data-active-category={activeCategoryId}>
      <div className="build-bar__tabs" role="tablist" aria-label="Kategórie stavby">
        {categories.map((category) => {
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
            const action = itemAction(item);
            const tip = itemTooltip(item);
            // `buy` položka je akcia, nie prepínač: nikdy nie je „vybraná" a nemá `aria-pressed`.
            const selected = (action === 'build' && item.defId === selectedDefId) || (action === 'road' && item.defId === selectedRoadDefId);
            const tipId = `${idPrefix}-tip-${item.defId}`;
            const detail = itemDetail(item);
            const classes = ['build-bar__item', `build-bar__item--${status}`];
            if (action === 'buy') classes.push('build-bar__item--buy');
            if (action === 'road') classes.push('build-bar__item--road');
            if (selected) classes.push('build-bar__item--selected');
            return (
              <button
                key={item.defId}
                type="button"
                className={classes.join(' ')}
                aria-pressed={action === 'buy' ? undefined : selected}
                aria-disabled={status === 'locked'}
                aria-describedby={tip === null ? undefined : tipId}
                data-def-id={item.defId}
                data-status={status}
                data-action={action}
                onClick={() => {
                  if (action === 'buy') {
                    if (canBuyItem(item)) onBuy?.(item.defId);
                    return;
                  }
                  if (action === 'road') {
                    const road = resolveItemSelection(item, selectedRoadDefId);
                    if (road !== undefined) onSelectRoad?.(road);
                    return;
                  }
                  const next = resolveItemSelection(item, selectedDefId);
                  if (next !== undefined) onSelect(next);
                }}
              >
                <Icon name={toIconName(item.icon)} className="build-bar__item-icon" />
                <span className="build-bar__item-text">
                  <span className="build-bar__item-name">{item.displayName}</span>
                  <span className="build-bar__item-price">
                    <span className="build-bar__item-cost" data-field="item-cost">
                      {itemPriceText(item)}
                    </span>
                    {detail !== null && (
                      <span className="build-bar__item-size" data-field="item-size">
                        {`· ${detail}`}
                      </span>
                    )}
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
