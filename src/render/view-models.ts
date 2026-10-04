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
  /**
   * Len berth: kapacita apronu a obsadené sloty (`slot` = index do `sprites.<defId>.apronSlots` v manifeste). F6c: `empty` = jednotka je
   * prázdny kontajner (`direction: 'empty'`, kreslí sa farbou `--cargo-empty`); `lineToken` = farba linky jednotky (`LineDef.colorToken`,
   * `line-blue`, …) — prázdny kontajner nesie pásik v jej farbe. Chýba = F2–F6 správanie (oranžový kontajner). Plní `SimBridge`.
   */
  apron?: { capacity: number; units: { slot: number; unitId: number; typeId: string; empty?: boolean; lineToken?: string }[] };
  /**
   * Len sklad (kind `storage`): kapacita, uložené a rezervované jednotky. Sprite skladu sa volí podľa `stored / capacity`
   * (`fillState`); `reserved` renderer nekreslí (je to údaj pre UI).
   */
  storage?: { capacity: number; stored: number; reserved: number };
  /**
   * Len sklad (F5b č. 8): posledná operácia s kontajnerom na slote — vozidlo ho uložilo (`put`, `CargoMoved` do `in_storage`),
   * alebo vzalo (`take`, z `in_storage`). `tick` = tick udalosti; renderer podľa trojice (`tick`, `slot`, `kind`) pozná novú
   * operáciu a spustí animáciu portálového žeriavu dvora nad daným slotom. `SimBridge` ju dopĺňa z udalostí (sim ju nevedie).
   * F6c: `empty` = operácia s prázdnym kontajnerom (`direction: 'empty'`) — kontajner na spreaderi je sivý (`--cargo-empty`); depo
   * prázdnych (`depot`) drží prázdne vždy, takže ho nepotrebuje.
   */
  lastStorageOp?: { slot: number; tick: number; kind: 'put' | 'take'; empty?: boolean };
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
   * doku `sprites.<defId>.docks[i]`) a či je rampa prevádzková (`false` → odznak `overlay.warning_badge`). F6c: `stagedEmpty[i]` =
   * koľko z `staged[i]` jednotiek je prázdnych kontajnerov (`direction: 'empty'`; kreslia sa sivé, za plnými); chýba = žiadne.
   * `SimBridge` do `staged[i]` prázdne kontajnery na doku zarátava (sim ich do `LoadingRamp.stagedAt` nepočíta — prázdny nie je náklad na odvoz).
   */
  ramp?: { docks: number; staged: readonly number[]; operational: boolean; stagedEmpty?: readonly number[] };
  /**
   * Jednotky vo VGM hold v tomto module (F6a, ADR-032 bod 7; `world.cargo.get(id).hold !== null`): `count` = všetky takéto
   * jednotky modulu (sklad: `in_storage`, rampa: `at_ramp`, berth: `on_apron`); renderer ukáže odznak `overlay.warning_badge`
   * s číslom. Rampa dopĺňa `docks[i]` = počet jednotiek v hold na doku `docks[i]` (odznak pri doku), berth `slots` = indexy slotov
   * apronu s jednotkou v hold (odznak pri slote). Chýba / `count` 0 = bez odznaku. Plní `SimBridge`.
   */
  held?: { count: number; docks?: readonly number[]; slots?: readonly number[] };
  /**
   * Len depo prázdnych (F6c, `StorageParams.role: 'empty_depot'`, ADR-034): stav kvality uskladnených prázdnych kontajnerov a miesta
   * opráv. `available` = použiteľné, `damaged` = poškodené čakajúce na opravu, `inRepair` = v oprave (nanajvýš `repairBays`),
   * `repairBays` = počet miest opravy (`EmptyDepot.repairBays`). Súčty zo `depotCargoSplit(world, moduleId)` cez linky. Renderer ukáže
   * odznak poškodených (`--cargo-empty-damaged`, počet) a odznak opráv (`--ui-warning`, `inRepair/repairBays`); nulový počet = bez
   * odznaku. Depo kreslí sivé kontajnery (sprite z manifestu) aj na portálovom žeriave. Plní `SimBridge`.
   */
  depot?: { available: number; damaged: number; inRepair: number; repairBays: number };
}

/** Smer cyklu žeriavu (`CraneModule.cycle`, ADR-032 bod 11): vykládka, nakládka a dve polovice dual cyklu. */
export type CraneCycleVM = 'unload' | 'load' | 'dual_load' | 'dual_unload';

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
  holding: { unitId: number; typeId: string; empty?: boolean } | null;
  /**
   * Smer cyklu (F6a): `unload` = loď → apron (F2), `load` = apron → loď (vozík ide opačne), `dual_load` / `dual_unload` = polovice
   * dual cyklu. Chýba = `unload` (VM z F2–F6). `SimBridge` ho berie z `crane.cycle`.
   */
  cycle?: CraneCycleVM;
  /**
   * Bunka pod hákom (F6d, ADR-033 dodatok T6D-02): stred bunky vo svete (bunky, `x + 0.5`), kde pri odovzdaní stojí vozidlo — pevninský riadok
   * footprintu žeriava na osi výložníka (`hookCellOfCrane`). Renderer podľa nej spustí držaný kontajner z vozíka na vozidlo (vykládka) a pri
   * nakládke ho z vozidla zdvihne. Chýba = režim `apron` (vozidlo si jednotku berie z apronu, kontajner ostáva pod vozíkom). Plní `SimBridge`.
   */
  hook?: { x: number; y: number };
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
  /**
   * Náklad na palube podľa smeru (F6a; `shipCargoSplit(world, shipId)`): import a export v jednotkách. Keď je pole prítomné,
   * renderer kreslí kontajnery na palube podľa počtu (import oranžovo, export modro) na prázdnom sprite paluby; chýba = F2–F6
   * správanie (sprite `loaded`, kým je `unitsOnBoard > 0`). F6c: `empty` = prázdne kontajnery (sivé, tesne pred exportom). Prekládka
   * (`tranship`) sa zarátava do `import` (loď A, prichádzajúca) alebo do `export` (loď B, odchádzajúca) — rozhoduje `SimBridge`.
   */
  cargoSplit?: { import: number; export: number; empty?: number };
  /**
   * Lashing lode (F6a; stav `lashing`): `ticksLeft` = `ship.lashingTicksLeft`, `ticksTotal` = celkový počet tickov lashingu
   * (`ShipLashingStarted.ticks`, `SimBridge` si ho pamätá). Renderer ukáže odznak s prstencom postupu. Chýba = bez odznaku.
   */
  lashing?: { ticksLeft: number; ticksTotal: number };
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
  /**
   * F6c: vezená jednotka je prázdny kontajner (`direction: 'empty'`) → sprite `states.carries_empty` (sivý kontajner), ak ho def v manifeste
   * má (`empty_handler` nesie len prázdne, jeho `loaded` je sivý vždy). Pri `loaded: false` sa ignoruje. Chýba = `false`.
   */
  carriesEmpty?: boolean;
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
  /**
   * Vezie náklad → sprite `states.loaded`. Exportný kamión (`mission` delivery, F6a) je naložený už od spawnu (`in_truck > 0`),
   * prázdny je až po vyložení na rampe. Pri manévri pri rampe renderer drží sprite z príchodu, kým kamión necúva do docku
   * (nakládka / vykládka sa deje v doku, sim je rýchlejší než manéver).
   */
  loaded: boolean;
  /**
   * F6c: vezená jednotka je prázdny kontajner (návrat prázdnych, výdaj exportérovi) → sprite `states.carries_empty`; chýba = `false`. Kamión misie
   * `collect` je pred naložením prázdny (`loaded: false`), po naložení nesie `carriesEmpty`; kamión, ktorý prázdny dovezie, si hodnotu pamätá aj po
   * vyložení (renderer kreslí kontajner z príchodu, kým kamión cúva do docku).
   */
  carriesEmpty?: boolean;
  /**
   * Stav Truck FSM (`to_gate`, `gate_queue`, `waiting`, `loading`, `unloading`, …). Renderer podľa neho (a `prevState`) riadi len
   * manéver kamióna pri rampe: `to_dock` → `loading` / `unloading` (cúvanie do docku; `unloading` = exportný kamión vykladá, F6a),
   * `loading` / `unloading` → `to_gate_out` (výjazd predkom); `unloading` → `loading` (dual transaction) kamión v doku necháva.
   */
  state: string;
  /**
   * Stav kamióna pred posledným tickom (`SimBridge` si ho pamätá spolu s pózou); chýba pri novom kamióne. Renderer z dvojice
   * `prevState` → `state` pozná práve dokončený príjazd k rampe (`to_dock` → `loading`) aj keď view vznikol až teraz.
   */
  prevState?: string;
  /**
   * Len v stave `loading` alebo `unloading` (F5b č. 11, F6a): sim poloha kamióna — stred vonkajšej bunky konektora docku a kurz príjazdu. `x`, `y`,
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
