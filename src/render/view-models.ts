/**
 * Render view-modely (docs/tasks/phase-02.md a phase-03.md, „Render view-modely“): jediná zmluva medzi simom a rendererom.
 *
 * Renderer nikdy nečíta `World` — dostane tieto ploché, readonly-podobné DTO (naplní ich SimBridge, T02-09) a vytvára,
 * aktualizuje a ničí view podľa `id`. Všetky polohy sú v bunkách gridu; px sa počítajú až v rendereri (`--cell`).
 */

/** Rotácia v stupňoch v smere hodinových ručičiek (0 = sever hore). */
export type ViewRotation = 0 | 90 | 180 | 270;

/** Strana bunky / modulu (svetová strana). */
export type ViewSide = 'n' | 'e' | 's' | 'w';

export interface ModuleVM {
  id: number;
  defId: string;
  kind: string;
  /** Ľavý horný roh footprintu PO rotácii (bunky). */
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  /** Rozmery footprintu PO rotácii (bunky). */
  w: number;
  h: number;
  /** Len berth: kapacita apronu a obsadené sloty (`slot` = index do `sprites.<defId>.apronSlots` v manifeste). */
  apron?: { capacity: number; units: { slot: number; unitId: number; typeId: string }[] };
  /**
   * Len sklad (kind `storage`): kapacita, uložené a rezervované jednotky. Sprite skladu sa volí podľa `stored / capacity`
   * (`fillState`); `reserved` renderer nekreslí (je to údaj pre UI).
   */
  storage?: { capacity: number; stored: number; reserved: number };
  /**
   * Len sklad (F5b č. 8): posledná operácia s kontajnerom na slote — vozidlo ho uložilo (`put`, `CargoMoved` do `in_storage`),
   * alebo vzalo (`take`, z `in_storage`). `tick` = tick udalosti; renderer podľa trojice (`tick`, `slot`, `kind`) pozná novú
   * operáciu a spustí animáciu portálového žeriavu dvora nad daným slotom. `SimBridge` ju dopĺňa z udalostí (sim ju nevedie).
   */
  lastStorageOp?: { slot: number; tick: number; kind: 'put' | 'take' };
  /**
   * Len moduly s konektormi: má aspoň jeden cestný konektor pripojený k ceste? `false` → odznak `overlay.warning_badge`;
   * `undefined` (F2 VM, modul bez konektorov) → bez odznaku.
   */
  connected?: boolean;
  /**
   * Len brána kamiónov (kind `gate`, F4): dĺžka virtuálnej fronty pred bránou a či práve púšťa kamión (závora hore).
   * `entryConnector` je index konektora v defe modulu (= poradie `sprites.<defId>.connectors` v manifeste), na ktorom kamióny
   * do brány vchádzajú z portálu; renderer pri ňom kreslí `overlay.queue_badge` s číslom. Renderer vstupnú stranu
   * nepozná (závisí od ciest), preto ju dodáva sim; chýba = 0 (prvý konektor).
   */
  gate?: { queueLength: number; open: boolean; entryConnector?: number };
  /**
   * Len čakacia plocha (kind `waiting_area`, F4): počet stojísk a ich obsadenosť. `occupied[i]` patrí stojisku
   * `sprites.<defId>.stalls[i]` v manifeste (obsadené aj rezervované sa zvýrazní).
   */
  waitingArea?: { bays: number; occupied: readonly boolean[] };
  /**
   * Len nakladacia rampa (kind `ramp`, F4): počet dokov, počet pripravených kontajnerov na každom doku (`staged[i]` patrí
   * doku `sprites.<defId>.docks[i]`) a či je rampa prevádzková (`false` → odznak `overlay.warning_badge`).
   */
  ramp?: { docks: number; staged: readonly number[]; operational: boolean };
}

export interface CraneVM {
  id: number;
  defId: string;
  berthId: number;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  state: 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked';
  /** Postup aktuálnej fázy 0..1. */
  progress: number;
  holding: { unitId: number; typeId: string } | null;
}

export interface ShipVM {
  id: number;
  classId: string;
  /** Kategória nákladu lode (`container`, `bulk`, `liquid`, `gas`, `roro`); určuje variant sprite. */
  cargoCategory: string;
  state: string;
  /** Stred lode v bunkách; renderer interpoluje `lerp(prev, curr, alpha)`. */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** 0 = predok na sever, v smere hodinových ručičiek. */
  heading: 0 | 90 | 180 | 270;
  lengthCells: number;
  widthCells: number;
  unitsOnBoard: number;
  capacityUnits: number;
}

/** Vozidlo na cestách (F3: straddle carrier). Poloha je stred vozidla v bunkách (stred bunky = `x + 0.5`). */
export interface VehicleVM {
  id: number;
  /** Id definície vozidla = kľúč `entities.<defId>` v manifeste (`straddle_carrier`). */
  defId: string;
  /** Stred vozidla v bunkách; renderer interpoluje `lerp(prev, curr, alpha)`. */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** 0 = predok na sever, v smere hodinových ručičiek (kardinálny podľa smeru posledného úseku cesty). */
  heading: 0 | 90 | 180 | 270;
  /**
   * Kurz v predchádzajúcom ticku (rovnako ako `prevX`, `prevY`); predvolene = `heading`. V zákrute sa jazdný pruh
   * (kolmý posun od osi cesty, `lane.ts`) interpoluje medzi pruhom predchádzajúceho a aktuálneho úseku, takže vozidlo
   * neskočí cez stredovú čiaru. `SimBridge` (T03-10) ho vyplní kurzom z predošlého snapshotu.
   */
  prevHeading?: 0 | 90 | 180 | 270;
  /** Vezie jednotku nákladu → sprite `states.loaded`. */
  loaded: boolean;
  /** Stav FSM vozidla (`idle`, `to_pickup`, …); renderer ho zatiaľ nekreslí, nesie ho pre ladenie a budúce odznaky. */
  state: string;
}

/**
 * Kamión na cestách (F4). Rovnaké pohybové polia ako `VehicleVM` (renderer ich vedie po pruhoch a oblúkoch spoločným
 * `vehiclePose`); sprite je `entities.<defId>` (`truck_container`, 1×2 bunky, kabína v smere jazdy) so stavmi `empty` / `loaded`.
 */
export interface TruckVM {
  id: number;
  /** Id definície kamióna = kľúč `entities.<defId>` v manifeste (`truck_container`). */
  defId: string;
  /** Stred kamióna v bunkách; renderer interpoluje `lerp(prev, curr, alpha)`. */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** 0 = kabína na sever, v smere hodinových ručičiek (kardinálny podľa smeru posledného úseku cesty). */
  heading: 0 | 90 | 180 | 270;
  /** Kurz v predchádzajúcom ticku; predvolene = `heading` (rovnako ako pri `VehicleVM`). */
  prevHeading?: 0 | 90 | 180 | 270;
  /** Vezie náklad → sprite `states.loaded`. */
  loaded: boolean;
  /**
   * Stav Truck FSM (`to_gate`, `gate_queue`, `waiting`, `loading`, …). Renderer podľa neho (a `prevState`) riadi len manéver
   * kamióna pri rampe: `to_dock` → `loading` (cúvanie do docku), `loading` → `to_gate_out` (výjazd predkom).
   */
  state: string;
  /**
   * Stav kamióna pred posledným tickom (`SimBridge` si ho pamätá spolu s pózou); chýba pri novom kamióne. Renderer z dvojice
   * `prevState` → `state` pozná práve dokončený príjazd k rampe (`to_dock` → `loading`) aj keď view vznikol až teraz.
   */
  prevState?: string;
  /**
   * Len v stave `loading` (F5b č. 11): sim poloha kamióna — stred vonkajšej bunky konektora docku a kurz príjazdu. `x`, `y`,
   * `heading` sú vtedy cieľová póza v doku (stred docku, kabína von z rampy). Kamión do docku cúva: renderer ho plynulo
   * vedie z `approach` do `x`, `y`, `heading` (`dock-maneuver.ts`), nie skokom.
   */
  approach?: { x: number; y: number; heading: ViewRotation };
}

export interface EntitiesVM {
  modules: readonly ModuleVM[];
  cranes: readonly CraneVM[];
  ships: readonly ShipVM[];
  /**
   * Vozidlá (F3). Voliteľné kvôli spätnej kompatibilite: VM zložené vo F2 (`src/app`) pole nemajú a renderer ho berie
   * ako prázdne. `SimBridge` (T03-10) ho vyplní vždy.
   */
  vehicles?: readonly VehicleVM[];
  /**
   * Kamióny (F4). Voliteľné kvôli spätnej kompatibilite: VM z F2/F3 pole nemajú a renderer ho berie ako prázdne.
   * `SimBridge` (T04-08) ho vyplní vždy.
   */
  trucks?: readonly TruckVM[];
}

export interface ModuleGhostVM {
  defId: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  w: number;
  h: number;
  valid: boolean;
  /** Konektory v SVETOVÝCH bunkách po rotácii; `side` = strana vjazdu (po rotácii). */
  connectors: { x: number; y: number; side: 'n' | 'e' | 's' | 'w' }[];
}
