/**
 * Nosič po cestách — spoločná báza pohybu interných vozidiel (`Vehicle`, F3) a kamiónov (`Truck`, F4) (ARCHITECTURE §7.3,
 * §7.4, §7.5, §7.6; ADR-019, ADR-020, ADR-021, ADR-024). Jedna implementácia pohybu po trase, žiadna druhá kópia:
 * trasa po bunkách ciest, progres úseku, rýchlosť podľa typu cieľovej bunky, obrat uprostred úseku, zastavenie bez cesty
 * a šum progresu. Stav FSM, náklad a väzby na moduly si drží podtrieda.
 *
 * - **Trasa** (`route`) = indexy buniek cesty: prvá je bunka, na ktorej nosič stojí alebo z ktorej práve vyšiel (`cell`),
 *   ďalšie sú cieľové bunky v poradí jazdy. **Progres** (`progress`, `[0, 1)`) je podiel úseku `cell → nextCell`;
 *   stojaci nosič má trasu `[cell]` a progres 0. Pohyb (`advance`) ide po úsekoch rýchlosťou `speedCellsPerTick ×
 *   speedFactor` typu cieľovej bunky úseku (ADR-020), zvyšok kroku sa prenáša do ďalšieho úseku.
 * - **Šum progresu** (review T03-13, ADR-021): progres je vždy 0 alebo `> PROGRESS_NOISE` (`isValidProgress`) — zvyšok
 *   kroku v double po prechode stredom bunky sa zahodí, takže obrat `1 − progress` nikdy nevyjde 1.
 * - Poloha `x`, `y` = stred nosiča v bunkách (float): stred `cell` (`+ 0,5`) posunutý o `progress` smerom k `nextCell`;
 *   prepočíta ju každý pohyb (a overuje krok 12 aj obnova save).
 * - `heading` = kardinálny kurz úseku (0 = sever, v smere hodinových ručičiek) — nikdy nie uhol z trigonometrie; stojaci
 *   nosič si ponechá kurz posledného úseku, rozbehnutý má vždy kurz svojho úseku (krok 12, ADR-021).
 * - `waitTicks` = odpočet stavu s čakaním (pobyt v module, nový pokus o cestu); mení ho systém podtriedy.
 * - `replanPending` = od naplánovania trasy sa zmenila cestná sieť (`World.markRoadsChanged`); systém pred ďalším pohybom
 *   preplánuje z kotvy (bunka, pri pohybe medzi bunkami `nextCell`).
 *
 * Trasu menia len `followRoute`, `turnAround`, `halt`, `advance` a `jumpTo` (abstrahovaný prechod telom modulu, ADR-011,
 * ADR-024). Chyby vstupu hlási podtrieda vlastnou triedou chyby (`invalidInput`).
 *
 * **Doprava bez prekrývania** (ADR-037, R1): nosič drží pruhové sloty (`LaneSlots`, kľúč `bunka × 2 + pruh`) — `body` (hlava
 * prvá, najviac `lengthCells`) a `ahead` (sloty pred hlavou, ktoré už drží: bunka, do ktorej vchádza, pri križovatke aj
 * reťaz). Úsek `cell → nextCell` smie nosič rozbehnúť, len keď mu to dovolí brána úseku (`AdvanceGate.tryEnter`); inak
 * zvyšok kroku prepadne, nosič stojí v strede bunky a `blockedTicks` rastie (počíta `TrafficSystem`). Slot sa v poli
 * môže opakovať (otočka cez vlastnú stopu) a uvoľní sa, až keď ho nosič nedrží ani raz. Bez brány sa pohyb správa ako
 * pred R1.
 */
import type { EntityId } from '../core/entity-id';
import { isRotation, type Rotation } from '../grid/rotation';
import { UNIT_SPEED_FACTOR, type SpeedFactorFn } from '../logistics/road-speed';
import { CELL_CENTER_OFFSET, cardinalHeading } from '../ships/ship-route';
import { keyCell, type SlotRegistry } from '../traffic/lane-slots';

/**
 * Šum progresu úseku (review T03-13, ADR-021). Keď nosič v `advance` prejde stredom bunky, zvyšok kroku
 * `budget − remaining / factor` môže v double vyjsť rádovo 1e-17 namiesto presnej 0 a stať sa progresom ďalšieho úseku.
 * Taký progres nosič reálne nepohne (posun ≪ 1 ulp polohy), ale obrat `turnAround` (`1 − p`) z neho pre `p ≤ 2^-54`
 * spraví presne 1 — neplatný progres, ktorý obnova save odmietne. Progres ≤ `PROGRESS_NOISE` sa preto zahodí (nosič
 * ostane v strede bunky), takže platí `progress === 0 || progress > PROGRESS_NOISE` a `1 − progress < 1`. Hranica je
 * technická (presnosť double v rozsahu `[0, 1)`), nie laditeľná hodnota — preto konštanta v kóde, nie def.
 */
export const PROGRESS_NOISE = Number.EPSILON;

/** Je progres úseku platný: presne 0 (stred bunky) alebo v (`PROGRESS_NOISE`, 1)? `NaN`/`Infinity` → `false`. */
export function isValidProgress(progress: number): boolean {
  return progress === 0 || (progress > PROGRESS_NOISE && progress < 1);
}

/** Druh nosiča: interné vozidlo alebo kamión (tabuľky podľa druhu v `TrafficSystem`). */
export type CarrierKind = 'vehicle' | 'truck';

/** Poloha nosiča (stred v bunkách). */
export interface CarrierPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Poloha na úseku: stred bunky `cell` (`+ 0,5`) posunutý o `progress` smerom k `next` (bez ďalšej bunky alebo pri
 * progrese 0 stred `cell`). Rovnaké poradie operácií ako `Carrier.place`, takže výsledok je bitovo zhodný — krok 12
 * a obnova save ním overujú `x`, `y`.
 */
export function carrierPosition(cell: number, next: number | undefined, progress: number, width: number): CarrierPosition {
  const cx = cell % width;
  const cy = (cell - cx) / width;
  let x = cx + CELL_CENTER_OFFSET;
  let y = cy + CELL_CENTER_OFFSET;
  if (next !== undefined && progress !== 0) {
    const nx = next % width;
    const ny = (next - nx) / width;
    x += (nx - cx) * progress;
    y += (ny - cy) * progress;
  }
  return { x, y };
}

/**
 * Brána úseku pre `advance` (ADR-037): rozhoduje, či nosič smie vyraziť zo stredu bunky, a zapisuje sloty, keď hlava
 * dorazí do stredu ďalšej bunky.
 */
export interface AdvanceGate {
  /**
   * Smie nosič vyraziť zo stredu bunky `from` do susednej bunky `to` (`to` je `nextCell`)? Zaberie sloty vpredu (`ahead`):
   * bunku `to`, pri križovatke celú reťaz a výjazd. `false` = obsadené, nosič ostane stáť.
   */
  tryEnter(from: number, to: number): boolean;
  /** Hlava dorazila do stredu bunky `cell`: sloty vpredu sa presunú do tela a chvost sa uvoľní. */
  onReach(cell: number): void;
}

/** Pohybová časť vstupu konštruktora (nákup, spawn aj obnova zo save). */
export interface CarrierInit {
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  /** Trasa `[cell, …]` — indexy buniek (celé ≥ 0), aspoň bunka nosiča. Susednosť a súlad s `x`, `y` overuje svet. */
  readonly route: readonly number[];
  /** Predvolene 0; `> 0` len s ďalšou bunkou na trase. */
  readonly progress?: number;
  /** Predvolene 0. */
  readonly waitTicks?: number;
  /** Predvolene `false`. */
  readonly replanPending?: boolean;
  /** Kľúče slotov tela (hlava prvá); predvolene prázdne. Súlad so svetom overuje `carrierOverlapProblem`. */
  readonly body?: readonly number[];
  /** Kľúče slotov pred hlavou; predvolene prázdne. */
  readonly ahead?: readonly number[];
  /** Predvolene 0. */
  readonly blockedTicks?: number;
  /** Predvolene 0. */
  readonly rerouteCooldown?: number;
}

function isCellIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Problém polohy a kurzu vstupu (`label` = popis nosiča do správy), alebo `undefined`. */
export function carrierPoseProblem(label: string, init: Pick<CarrierInit, 'x' | 'y' | 'heading'>): string | undefined {
  const { x, y, heading } = init;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return `${label}: poloha (${String(x)}, ${String(y)}) musí byť konečné čísla`;
  if (!isRotation(heading)) return `${label}: kurz musí byť 0, 90, 180 alebo 270, dostal ${String(heading)}`;
  return undefined;
}

/**
 * Problém trasy, progresu a odpočtu vstupu, alebo `undefined`: trasa neprázdny zoznam indexov buniek, progres v `[0, 1)`
 * a `> 0` len s ďalšou bunkou, `waitTicks` celé ≥ 0. Vzťahy k svetu (susednosť, súlad polohy s trasou, šum progresu)
 * overuje svet (`carrierMotionProblem`).
 */
export function carrierRouteProblem(label: string, init: Pick<CarrierInit, 'route' | 'progress' | 'waitTicks'>): string | undefined {
  const { route } = init;
  const progress = init.progress ?? 0;
  const waitTicks = init.waitTicks ?? 0;
  if (!Array.isArray(route) || route.length === 0 || !route.every(isCellIndex)) return `${label}: trasa musí byť neprázdny zoznam indexov buniek (celé ≥ 0)`;
  if (!Number.isFinite(progress) || progress < 0 || progress >= 1) return `${label}: progres musí byť v [0, 1), dostal ${String(progress)}`;
  if (progress > 0 && route.length < 2) return `${label}: progres ${String(progress)} bez ďalšej bunky na trase`;
  if (!Number.isSafeInteger(waitTicks) || waitTicks < 0) return `${label}: waitTicks musí byť celé číslo ≥ 0, dostal ${String(waitTicks)}`;
  return undefined;
}

/** Pracovné pole `releaseSlots` (bez alokácie pri každom opustení cesty; použitie nie je reentrantné). */
const RELEASING: number[] = [];

export abstract class Carrier {
  x: number;
  y: number;
  heading: Rotation;
  /** Odpočet stavu s čakaním (pobyt v module, nový pokus o cestu); mení ho systém podtriedy. */
  waitTicks: number;
  /** Cestná sieť sa zmenila po naplánovaní trasy (`World.markRoadsChanged`); preplánuje systém podtriedy. */
  replanPending: boolean;
  /** Sloty tela od hlavy k chvostu (kľúč `bunka × 2 + pruh`); mení ich len nosič a `TrafficSystem` cez metódy nižšie. */
  readonly body: number[];
  /** Sloty pred hlavou, ktoré nosič už drží (bunka, do ktorej vchádza, reťaz križovatky). */
  readonly ahead: number[];
  /** Po sebe idúce ticky, v ktorých nosič chcel ísť, ale nemohol (slot drží iný nosič); 0 = nečaká. */
  blockedTicks: number;
  /** Zostávajúce ticky do ďalšieho preplánovania kvôli zápche (rozhodnutie orchestrátora R1 č. 12). */
  rerouteCooldown: number;
  private route: readonly number[];
  private routeIndex = 0;
  private segmentProgress: number;
  private slots: SlotRegistry | undefined;

  /** Vstup musí byť overený podtriedou (`carrierPoseProblem`, `carrierRouteProblem`) — tu sa len uloží. */
  protected constructor(init: CarrierInit) {
    this.x = init.x;
    this.y = init.y;
    this.heading = init.heading;
    this.waitTicks = init.waitTicks ?? 0;
    this.replanPending = init.replanPending ?? false;
    this.route = Object.freeze([...init.route]);
    this.segmentProgress = init.progress ?? 0;
    this.body = [...(init.body ?? [])];
    this.ahead = [...(init.ahead ?? [])];
    this.blockedTicks = init.blockedTicks ?? 0;
    this.rerouteCooldown = init.rerouteCooldown ?? 0;
  }

  /** Id nosiča (držiteľ slotov). */
  abstract readonly id: EntityId;

  /** Druh nosiča. */
  abstract readonly kind: CarrierKind;

  /** Dĺžka nosiča v bunkách (`def.lengthCells`, ADR-037): najviac toľko slotov drží `body`. */
  abstract get lengthCells(): number;

  /** Popis do chybových správ (`straddle_carrier #7`, `truck_container #40`). */
  abstract get label(): string;

  /** Chyba neplatného vstupu metódy pohybu v triede chýb podtriedy (`VehicleError`, `TruckError` s kódom `invalid_input`). */
  protected abstract invalidInput(message: string): Error;

  /** Bunka, na ktorej nosič stojí, alebo z ktorej práve vyšiel (začiatok aktuálneho úseku). */
  get cell(): number {
    return this.route[this.routeIndex];
  }

  /** Cieľová bunka aktuálneho úseku; `undefined`, keď nosič nemá ďalší cieľ. */
  get nextCell(): number | undefined {
    return this.route[this.routeIndex + 1];
  }

  /** Progres aktuálneho úseku v `[0, 1)`; 0 = nosič stojí v strede `cell`. */
  get progress(): number {
    return this.segmentProgress;
  }

  /** Počet cieľových buniek pred nosičom (0 = koniec trasy — nosič stojí v strede `cell`). */
  get cellsAhead(): number {
    return this.route.length - 1 - this.routeIndex;
  }

  /** Zvyšok trasy `[cell, …]` (nová kópia — save, ladenie; nie hot path). */
  remainingRoute(): readonly number[] {
    return this.route.slice(this.routeIndex);
  }

  /**
   * Bunka zvyšku trasy na pozícii `offset` bez kópie (`0` = `cell`, `1` = `nextCell`, … `cellsAhead`); mimo rozsahu
   * `undefined`. Rovnaké bunky ako `remainingRoute()[offset]` — krok 12 ňou prechádza trasu bez alokácie.
   */
  routeCellAt(offset: number): number | undefined {
    return offset < 0 ? undefined : this.route[this.routeIndex + offset];
  }

  /**
   * Nová trasa (plánovanie): `route[0]` musí byť `cell` a pri pohybe medzi bunkami `route[1]` = `nextCell` (nosič
   * dokončí rozbehnutý úsek). Progres ostáva, príznak preplánovania zaniká. Pole sa uloží bez kópie — volajúci ho
   * nesmie meniť (cesty z `PathCache` sú zmrazené). Iný začiatok → `invalidInput`, nosič sa nezmení.
   */
  followRoute(route: readonly number[]): void {
    const between = this.segmentProgress > 0;
    if (route[0] !== this.cell || (between && route[1] !== this.nextCell)) {
      throw this.invalidInput(
        `${this.label}.followRoute: trasa musí začínať bunkou ${String(this.cell)}${between ? ` a pokračovať bunkou ${String(this.nextCell)}` : ''}, začína [${route.slice(0, 2).join(', ')}]`,
      );
    }
    this.route = route;
    this.routeIndex = 0;
    this.replanPending = false;
    this.pruneAhead();
  }

  /**
   * Obrat uprostred úseku (preplánovanie, ktorého cesta z `nextCell` vedie hneď späť do `cell`): nosič ostane na mieste,
   * úsek sa otočí (`route[0]` = doterajšia `nextCell`, `route[1]` = doterajšia `cell`, progres `1 − progress`), prepočíta
   * sa poloha a kurz (`width` = šírka mriežky). Bez obratu by nosič dorazil do `nextCell` a vrátil sa — v ticku by sa
   * reálne nepohol. Nosič bližšie k `nextCell` než `PROGRESS_NOISE` (`1 − progress ≤ PROGRESS_NOISE`) stojí v jej strede:
   * šum sa zahodí ako v `advance` (progres 0, poloha sa posunie najviac o `PROGRESS_NOISE`).
   * Chyby (`invalidInput`, nosič sa nezmení): nosič nie je medzi bunkami, iný začiatok trasy, alebo poistka proti šumu —
   * progres taký malý, že `1 − progress` vyjde 1 (neplatný progres; `advance` ho už nevytvorí, ADR-021).
   */
  turnAround(route: readonly number[], width: number): void {
    const next = this.nextCell;
    if (this.segmentProgress === 0 || next === undefined || route[0] !== next || route[1] !== this.cell) {
      throw this.invalidInput(
        `${this.label}.turnAround: obrat vyžaduje pohyb medzi bunkami a trasu [${String(next)}, ${String(this.cell)}, …], dostal [${route.slice(0, 2).join(', ')}]`,
      );
    }
    const turned = 1 - this.segmentProgress;
    if (!(turned < 1)) {
      throw this.invalidInput(
        `${this.label}.turnAround: progres ${String(this.segmentProgress)} je šum pod PROGRESS_NOISE — obrat by dal neplatný progres ${String(turned)}`,
      );
    }
    // Sloty (ADR-037): hlava sa presunie do doterajšej `nextCell` (jej slot už nosič drží vpredu), zvyšok reťaze križovatky
    // sa uvoľní; späť do `cell` vedie nosič slot, ktorý má v tele — pri dosiahnutí jej stredu sa zopakuje na čele.
    if (this.ahead.length > 0) {
      const head = this.ahead[0];
      this.dropAhead(1);
      this.ahead.length = 0;
      this.body.unshift(head);
      this.trimBody();
    }
    this.route = route;
    this.routeIndex = 0;
    this.segmentProgress = turned > PROGRESS_NOISE ? turned : 0;
    this.replanPending = false;
    this.place(width);
  }

  /** Zahodí zvyšok trasy (bez cesty, `no_path`): ostane `[cell]`, pri pohybe medzi bunkami `[cell, nextCell]`. */
  halt(): void {
    const next = this.nextCell;
    this.route = this.segmentProgress > 0 && next !== undefined ? Object.freeze([this.cell, next]) : Object.freeze([this.cell]);
    this.routeIndex = 0;
    this.replanPending = false;
    this.pruneAhead();
  }

  /**
   * Abstrahovaný prechod telom modulu (brána, stojisko — ADR-011, ADR-024): stojaci nosič sa objaví v strede bunky
   * `cell` na druhej strane modulu s trasou `[cell]` (kurz ostáva). Nosič medzi bunkami alebo bunka, ktorá nie je
   * index ≥ 0 → `invalidInput`, nosič sa nezmení.
   */
  jumpTo(cell: number, width: number): void {
    if (this.segmentProgress !== 0 || !isCellIndex(cell)) {
      throw this.invalidInput(`${this.label}.jumpTo: prechod modulom vyžaduje stojaci nosič a bunku ≥ 0, progres ${String(this.segmentProgress)}, bunka ${String(cell)}`);
    }
    this.releaseSlots();
    this.route = Object.freeze([cell]);
    this.routeIndex = 0;
    this.replanPending = false;
    this.place(width);
  }

  /**
   * Posunie nosič po trase o `distance` buniek pri faktore 1 (zvyšok kroku prechádza do ďalšieho úseku; na konci trasy
   * nosič zastane v strede poslednej bunky a zvyšok prepadne), prepočíta `x`, `y` a kurz. `width` = šírka mriežky
   * (index → súradnice). Úsek `cell → nextCell` ide rýchlosťou `distance × speedFactor(nextCell)` (typ cieľovej bunky,
   * ADR-020): zvyšok kroku sa meria v bunkách pri faktore 1, takže úsek s faktorom `f` spotrebuje `zvyšok / f`. Pri
   * faktore 1 je výpočet bitovo rovnaký ako bez typov ciest. Progres `≤ PROGRESS_NOISE` (zvyšok kroku po prechode stredom
   * bunky) sa zahodí — nosič ostane v strede bunky (ADR-021). Vráti `true`, keď nosič stojí na konci trasy. Bez
   * alokácie.
   *
   * **Brána** (`gate`, ADR-037): pred rozbehnutím úseku zo stredu bunky sa spýta `gate.tryEnter(cell, nextCell)`; `false`
   * znamená, že nasledujúci slot je obsadený — nosič ostane stáť v strede bunky (kurz sa nemení) a zvyšok kroku prepadne.
   * Po dosiahnutí stredu bunky zavolá `gate.onReach(cell)`. Bez brány pohyb nezávisí od slotov.
   */
  advance(distance: number, width: number, speedFactor: SpeedFactorFn = UNIT_SPEED_FACTOR, gate?: AdvanceGate): boolean {
    let budget = distance;
    while (budget > 0 && this.routeIndex + 1 < this.route.length) {
      if (gate !== undefined && this.segmentProgress === 0 && !gate.tryEnter(this.route[this.routeIndex], this.route[this.routeIndex + 1])) break;
      this.heading = this.segmentHeading(width);
      const factor = speedFactor(this.route[this.routeIndex + 1]);
      const remaining = 1 - this.segmentProgress;
      const step = budget * factor;
      if (step < remaining) {
        budget = 0;
        const progressed = this.segmentProgress + step;
        if (progressed < 1) {
          // Šum pod PROGRESS_NOISE nastane len na začiatku úseku (progres 0) — nosič ostane v strede bunky.
          if (progressed > PROGRESS_NOISE) this.segmentProgress = progressed;
          continue;
        }
        // Zaokrúhlenie by dalo progres 1 — nosič dorazí do stredu ďalšej bunky, zvyšok (< 1 ulp) prepadne.
      } else {
        budget -= remaining / factor;
      }
      this.routeIndex += 1;
      this.segmentProgress = 0;
      gate?.onReach(this.route[this.routeIndex]);
    }
    this.place(width);
    return this.cellsAhead === 0;
  }

  // -------------------------------------------------------------------------------------------------------
  // Sloty (ADR-037)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Pripojí nosič k pruhovým slotom sveta (`World.addVehicle` / `addTruck`) a zapíše sloty, ktoré už drží (`body`, `ahead`
   * z obnovy save). Slot iného držiteľa vyhodí `Error` — svet to overuje vopred.
   */
  attachSlots(slots: SlotRegistry): void {
    this.slots = slots;
    for (const key of this.body) slots.claim(key, this.id);
    for (const key of this.ahead) slots.claim(key, this.id);
  }

  /**
   * Zaberá nosič bunku `cell`? Stojí na nej, je to cieľová bunka jeho rozbehnutého úseku, alebo ju drží niektorý slot tela
   * či slot vpredu (ADR-037: chvost a rezervovaná reťaz križovatky sú tiež pod nosičom). Chránené bunky `RemoveRoad` / `PlaceRoad`.
   */
  occupiesCell(cell: number): boolean {
    if (this.cell === cell || (this.segmentProgress > 0 && this.nextCell === cell)) return true;
    for (const key of this.body) if (keyCell(key) === cell) return true;
    for (const key of this.ahead) if (keyCell(key) === cell) return true;
    return false;
  }

  /** Drží nosič slot `key` (v tele alebo vpredu)? */
  holdsKey(key: number): boolean {
    return this.body.includes(key) || this.ahead.includes(key);
  }

  /** Počet buniek, ktoré nosič drží (tvar tela + vpredu). */
  get heldSlotCount(): number {
    return this.body.length + this.ahead.length;
  }

  /** Zaberie slot `key` pred hlavou (bunka, do ktorej nosič vchádza, reťaz križovatky). Slot musí byť voľný alebo vlastný. */
  reserveAhead(key: number): void {
    this.slots?.claim(key, this.id);
    this.ahead.push(key);
  }

  /** Zaberie slot hlavy nosiča, ktorý ešte nič nedrží (vstup do jazdného stavu). */
  reserveHead(key: number): void {
    this.slots?.claim(key, this.id);
    this.body.unshift(key);
    this.trimBody();
  }

  /**
   * Hlava dorazila do stredu bunky `cell`: slot `ahead[0]` sa presunie na čelo tela a nadbytočný chvost (nad `lengthCells`)
   * sa uvoľní. Bunka, ktorú telo už drží (otočka cez vlastnú stopu), zopakuje svoj slot na čele. Nosič bez slotov nič nemení.
   */
  reachCell(cell: number): void {
    const first = this.ahead[0];
    if (first !== undefined && keyCell(first) === cell) {
      this.ahead.shift();
      this.body.unshift(first);
    } else if (this.body.length > 0 && keyCell(this.body[0]) !== cell) {
      const held = this.body.find((key) => keyCell(key) === cell);
      if (held === undefined) return;
      this.body.unshift(held);
    }
    this.trimBody();
  }

  /**
   * Nosič dorazil na miesto pobytu pri module (prístupová bunka, bunka pod hákom): drží už len slot hlavy, chvost sa uvoľní
   * (ADR-037 dodatok R1: pobyt pri module nedrží telo, telo sa pri odchode „rozvinie“ ako pri výjazde z modulu). Stojaci chvost by
   * v križovatke a v protismernom pruhu blokoval nosiče, ktoré na ňom nezávisia (cykly čakania pri otočke na obojsmernej ceste).
   */
  releaseTail(): void {
    if (this.body.length <= 1) return;
    const dropped = this.body.splice(1);
    for (const key of dropped) this.releaseIfUnheld(key);
  }

  /**
   * Ústup o jednu bunku (zlom zaseknutého cyklu, `TrafficSystem.rotateCycles`): stojaci nosič s telom aspoň z dvoch buniek uvoľní
   * slot hlavy a vráti sa na druhú bunku tela; doterajšia bunka ostane prvou bunkou zvyšku trasy (nosič sa tam vráti, keď je voľná).
   * Chyba (`invalidInput`, nosič sa nezmení): nosič sa hýbe medzi bunkami, drží sloty vpredu alebo má telo z jednej bunky.
   */
  retreat(width: number): void {
    const behind = this.body[1];
    if (this.segmentProgress !== 0 || this.ahead.length > 0 || behind === undefined || keyCell(behind) === this.cell) {
      throw this.invalidInput(`${this.label}.retreat: ústup vyžaduje stojaci nosič bez slotov vpredu s telom z aspoň dvoch buniek`);
    }
    const head = this.body.shift();
    this.route = Object.freeze([keyCell(behind), ...this.route.slice(this.routeIndex)]);
    this.routeIndex = 0;
    this.replanPending = false;
    this.place(width);
    if (head !== undefined) this.releaseIfUnheld(head);
  }

  /**
   * Otočka na mieste: hlava tela prejde do druhého pruhu tej istej bunky (`TrafficSystem`, dodatok ADR-037 TR1-09b). Slot `key`
   * musí byť voľný alebo vlastný; pôvodný slot hlavy sa uvoľní, ak ho telo už inak nedrží.
   */
  swapHead(key: number): void {
    const old = this.body[0];
    if (old === undefined || old === key) return;
    this.slots?.claim(key, this.id);
    this.body[0] = key;
    this.releaseIfUnheld(old);
  }

  /** Dvojica nosičov v jednej bunke si vymení pruhy hláv naraz (obaja sa otáčajú opačne: každý potrebuje pruh toho druhého). */
  exchangeHeads(other: Carrier): void {
    const mine = this.body[0];
    const theirs = other.body[0];
    if (mine === undefined || theirs === undefined || mine === theirs) return;
    this.slots?.release(mine, this.id);
    other.slots?.release(theirs, other.id);
    this.slots?.claim(theirs, this.id);
    other.slots?.claim(mine, other.id);
    this.body[0] = theirs;
    other.body[0] = mine;
  }

  /** Uvoľní posledný slot tela (pretočenie zaseknutého cyklu: chvost uvoľní miesto nosiču za ním, `TrafficSystem.rotateCycles`). */
  dropTail(): void {
    const key = this.body.pop();
    if (key !== undefined) this.releaseIfUnheld(key);
  }

  /** Uvoľní všetky sloty (telo aj vpredu); príznaky zápchy nemení. */
  releaseSlots(): void {
    if (this.body.length === 0 && this.ahead.length === 0) return;
    const keys = RELEASING;
    keys.length = 0;
    for (const key of this.body) keys.push(key);
    for (const key of this.ahead) keys.push(key);
    this.body.length = 0;
    this.ahead.length = 0;
    for (const key of keys) this.releaseIfUnheld(key);
    keys.length = 0;
  }

  /** Nosič opustil jazdný stav (ADR-037): uvoľní celé telo a vynuluje čakanie aj odpočet preplánovania. */
  leaveRoad(): void {
    this.releaseSlots();
    this.blockedTicks = 0;
    this.rerouteCooldown = 0;
  }

  /** Uvoľní sloty `ahead` od pozície `from` (nepoužité reťaze po zmene trasy). */
  private dropAhead(from: number): void {
    const dropped = this.ahead.splice(from);
    for (const key of dropped) this.releaseIfUnheld(key);
  }

  /** Po zmene trasy: sloty `ahead`, ktoré už nezodpovedajú bunkám trasy pred nosičom, sa uvoľnia. */
  private pruneAhead(): void {
    for (let i = 0; i < this.ahead.length; i++) {
      if (keyCell(this.ahead[i]) !== this.routeCellAt(i + 1)) {
        this.dropAhead(i);
        return;
      }
    }
  }

  /** Telo nad `lengthCells` slotov: chvost sa uvoľní. */
  private trimBody(): void {
    while (this.body.length > this.lengthCells) {
      const key = this.body.pop();
      if (key !== undefined) this.releaseIfUnheld(key);
    }
  }

  /** Slot sa v registri uvoľní, až keď ho nosič nedrží ani raz (v tele ani vpredu). */
  private releaseIfUnheld(key: number): void {
    if (this.slots === undefined || this.holdsKey(key) || this.slots.holderOfKey(key) !== this.id) return;
    this.slots.release(key, this.id);
  }

  /** Prepočíta `x`, `y` (a kurz pri pohybe medzi bunkami) z `cell`, `nextCell` a progresu. */
  place(width: number): void {
    const cell = this.cell;
    const cx = cell % width;
    const cy = (cell - cx) / width;
    this.x = cx + CELL_CENTER_OFFSET;
    this.y = cy + CELL_CENTER_OFFSET;
    const next = this.nextCell;
    if (next === undefined || this.segmentProgress === 0) return;
    const nx = next % width;
    const ny = (next - nx) / width;
    this.heading = this.segmentHeading(width);
    this.x += (nx - cx) * this.segmentProgress;
    this.y += (ny - cy) * this.segmentProgress;
  }

  /** Kurz aktuálneho úseku `cell → nextCell`; bez ďalšej bunky doterajší kurz. */
  private segmentHeading(width: number): Rotation {
    const next = this.nextCell;
    if (next === undefined) return this.heading;
    const cell = this.cell;
    const dx = (next % width) - (cell % width);
    const dy = (next - (next % width)) / width - (cell - (cell % width)) / width;
    return cardinalHeading(dx, dy) ?? this.heading;
  }
}
