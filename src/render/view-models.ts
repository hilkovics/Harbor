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

/** Smer kontajnera (`CargoUnit.direction`); `empty` = prázdny kontajner (sivý), ostatné sa kreslia podľa linky. */
export type ContainerDirectionVM = 'import' | 'export' | 'tranship' | 'empty';

/**
 * Štítky kontajnera pre render (R2, TERMINAL_2 §3): veľkosť 20′ / 40′, typ (`container_types.json`, v R2 len `dry`), linka (`CargoUnit.lineId`,
 * `null` = bez linky → neutrálna sivá) a smer. Podľa nich renderer volí sprite `container_<sizeFt>_<dry|empty>` a farbu linky (`container-sprites.ts`).
 */
export interface ContainerVM {
  sizeFt: 20 | 40;
  containerType: string;
  lineId: string | null;
  direction: ContainerDirectionVM;
  /** R5: nadrozmerný náklad (OOG) → sprite `container_<size>_<type>_oog`, ak existuje (inak bežný). */
  oog?: boolean;
  /** R5: stav zásuvky reefera (len vrchný kontajner stohu): odznak `overlay.reefer_plug_<stav>` na kontajneri. */
  reefer?: ReeferPlugStateVM;
}

/** Stav zásuvky reefera na bloku (`on` zapojený, `off` odpojený, `alarm` porucha). */
export type ReeferPlugStateVM = 'on' | 'off' | 'alarm';

/** Zásuvka reefer racku (R5): stred v bunkách sveta (stred bunky = +0,5) a stav (`empty` = voľná, nekreslí sa). */
export interface ReeferPlugVM {
  x: number;
  y: number;
  state: ReeferPlugStateVM | 'empty';
}

/** Jeden stoh bloku skladu (R2): pozícia `bay` × `row` (od 0), výška stohu (0 = prázdna pozícia) a vrchný kontajner (`null` pri výške 0). */
export interface StackVM {
  bay: number;
  row: number;
  height: number;
  top: ContainerVM | null;
}

/** Geometria bloku skladu (`YardBlock.geometry`, R2): `bays` pozdĺž lokálnej osi x (pri rot 0), `rows` naprieč (os y), `maxTier` = max. výška stohu. */
export interface StackGeometryVM {
  bays: number;
  rows: number;
  maxTier: number;
}

export interface ModuleVM {
  id: number;
  defId: string;
  /** R5: zásuvky reefer racku (`reefer_rack`) — ikony `overlay.reefer_plug_*` v bunkách sveta. */
  plugs?: readonly ReeferPlugVM[];
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
   * Jednotky vo VGM hold v tomto module (F6a, ADR-032 bod 7; `world.cargo.get(id).hold !== null`): `count` = všetky takéto
   * jednotky modulu (sklad: `in_storage`, berth: `on_apron`); renderer ukáže odznak `overlay.warning_badge` s číslom. Berth dopĺňa
   * `slots` = indexy slotov apronu s jednotkou v hold (odznak pri slote). Chýba / `count` 0 = bez odznaku. Plní `SimBridge`.
   */
  held?: { count: number; slots?: readonly number[] };
  /**
   * Len depo prázdnych (F6c, `StorageParams.role: 'empty_depot'`, ADR-034): stav kvality uskladnených prázdnych kontajnerov a miesta
   * opráv. `available` = použiteľné, `damaged` = poškodené čakajúce na opravu, `inRepair` = v oprave (nanajvýš `repairBays`),
   * `repairBays` = počet miest opravy (`EmptyDepot.repairBays`). Súčty zo `depotCargoSplit(world, moduleId)` cez linky. Renderer ukáže
   * odznak poškodených (`--cargo-empty-damaged`, počet) a odznak opráv (`--ui-warning`, `inRepair/repairBays`); nulový počet = bez
   * odznaku. Depo kreslí sivé kontajnery (sprite z manifestu) aj na portálovom žeriave. Plní `SimBridge`.
   */
  depot?: { available: number; damaged: number; inRepair: number; repairBays: number };
  /**
   * Len depo vozidiel (R1, ADR-037 bod 7): vozidlá zaparkované v depe (stav `parked`). Modul ich kreslí ako mriežku zmenšených spritov
   * vnútri footprintu v poradí podľa `id` (`parked-vehicles-decor.ts`). Chýba = depo sa kreslí ako doteraz. Plní `SimBridge` (TR1-08).
   */
  parkedVehicles?: readonly { id: number; defId: string }[];
  /**
   * Len blok skladu s presnou polohou kontajnerov (R2, `YardBlock`: `container_yard_small`, `empty_depot`): stohy v poradí ľubovoľnom (renderer ich
   * zoradí podľa výšky). Pri 40′ kontajneri nesú stohy oboch bays páru `(2k, 2k + 1)` ten istý vrchný kontajner; renderer ho nakreslí raz.
   * Keď je pole prítomné, telo modulu sa kreslí zhora (mriežka pozícií + vrchný kontajner každého stohu s tieňom výšky, `stacks-decor.ts`) a stav
   * zaplnenia (`fillNN`) ani portálový žeriav sa nepoužijú. Chýba = sklad sa kreslí ako doteraz. Plní `SimBridge` (TR2-05).
   */
  stacks?: readonly StackVM[];
  /**
   * Geometria bloku pre mriežku pozícií (R2). Chýba = renderer ju odvodí zo `stacks` (`max(bay) + 1`, `max(row) + 1`, `max(height)`), takže nevyplnená
   * mriežka môže byť menšia, než blok je; `SimBridge` ju preto vypĺňa vždy.
   */
  stackGeometry?: StackGeometryVM;
  /**
   * R3 (TERMINAL_2, TR3-03): jednosmerné pruhy kotviska a bloku — bunky (svet, ľavý horný roh bunky) so smerom jazdy. Renderer ich kreslí ako
   * šípkový overlay nad telom modulu (`lanes-decor.ts`). Chýba / prázdne = bez overlaya. Plní `SimBridge` (TR3-05).
   */
  lanes?: readonly LaneCellVM[];
  /**
   * R4 (TERMINAL_2, TR4-03): pruh brány (`gate_in_lane` / `gate_out_lane`) — strecha podľa polohy v rade susedných pruhov (`roofPart`; chýba = `single`),
   * krok spracovania (`step`: `ocr`, `check`, `weigh`, … ; chýba = voľný pruh, závora hore) a jeho postup 0..1. Renderer kreslí strechu, závoru, štítok kroku a pruh
   * postupu (`gate-lane-decor.ts`). Plní `SimBridge` (TR4-05).
   */
  gateLane?: GateLaneVM;
  /** R4: odovzdávacie miesta RTG bloku (svet, bunky) — overlay `tp_marker`, pri `busy` aj `safe_zone` (`tp-holding-decor.ts`). */
  tpCells?: readonly TpCellVM[];
  /** R4: miesta odstavnej plochy kamiónov (svet, bunky) a ich obsadenosť (`tp-holding-decor.ts`). */
  holdingSlots?: readonly HoldingSlotVM[];
}

/** Pruh brány (R4): smer, režim, časť strechy, aktuálny krok a jeho postup. */
export interface GateLaneVM {
  kind: 'in' | 'out';
  mode: string;
  roofPart?: 'single' | 'left' | 'mid' | 'right';
  step?: string;
  /** Postup kroku 0..1. */
  progress?: number;
}

/** Odovzdávacie miesto RTG (R4): bunka (svet) a či je práve obsadené (kamión / ťahač pri bloku). */
export interface TpCellVM {
  x: number;
  y: number;
  busy: boolean;
}

/** Miesto odstavnej plochy (R4): bunka (svet) a či na ňom stojí kamión. */
export interface HoldingSlotVM {
  x: number;
  y: number;
  occupied: boolean;
}

/** Bunka pruhu so smerom jazdy (R3): `dir` = strana, ktorou vozidlo bunku opúšťa (`e` = doprava). */
export interface LaneCellVM {
  x: number;
  y: number;
  dir: ViewSide;
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
  /**
   * R3 (STS): poloha vozíka pozdĺž osi Y rámu 0..1 (0 = nos k vode / `travel.yMin`, 1 = backreach / `travel.yMax`). Chýba = odvodí sa z `state` a
   * `progress` (`trolleyTravelFraction`, pevnina = 1). Plní `SimBridge` (TR3-05).
   */
  trolleyY?: number;
  /** R3 (STS): kontajner na spreaderi (veľkosť určuje spreader 20′ / 40′); chýba / `null` = bez kontajnera (spreader 40′). */
  cargo?: ContainerVM | null;
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

/**
 * R1 (ADR-037, TERMINAL_2 §7.3, §7.10): stopa nosiča na ceste. Spoločné voliteľné polia `VehicleVM` a `TruckVM`; chýbajú vo VM
 * z F2–F6 a vtedy sa nosič kreslí ako doteraz (sprite vycentrovaný na `x`, `y`). Hodnoty zo simu dodá `SimBridge` (TR1-08).
 */
export interface CarrierTrailVM {
  /**
   * Stredy buniek stopy od hlavy k chvostu, bez polohy hlavy (súradnice ako `x`, `y`: stred bunky + 0,5). Keď je pole prítomné
   * a nosič nie je `offRoad`, renderer kreslí sprite kĺbovo po stope (`articulated-pose.ts`): predok pri hlave (`x`, `y`),
   * natočenie podľa tetivy stopy. Krátka stopa (po výjazde z modulu) je platná; prázdna znamená, že nosič ešte nemá telo.
   */
  body?: readonly { x: number; y: number }[];
  /** Dĺžka nosiča v bunkách (def `lengthCells`: kamión 3, straddle carrier 2); chýba = `body.length + 1`. */
  lengthCells?: number;
  /** Nosič je mimo cesty (stojisko, dok, prechod bránou, depo): nedrží sloty a kreslí sa vycentrovaný na `x`, `y` ako doteraz. */
  offRoad?: boolean;
  /** Nosič chcel ísť, ale nemohol (`blockedTicks > 0`): pri `!offRoad` sa kreslia brzdové svetlá. */
  blocked?: boolean;
  /** Nosič je v zápche (`blockedTicks ≥ stuckTicks`): červené bunky pod hlavou a stopou a odznak nad hlavou. */
  jammed?: boolean;
}

/** Vozidlo na cestách (F3: straddle carrier). Poloha je stred vozidla v bunkách (stred bunky = `x + 0.5`). */
export interface VehicleVM extends CarrierTrailVM {
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
  /**
   * R2: vezený kontajner podľa veľkosti, typu a linky (`null` = žiadny). Keď je pole prítomné, kontajner na vozidle sa kreslí z neho (sprite
   * `container_<sizeFt>_<dry|empty>`, dry tónovaný farbou linky; na ECH pod spreaderom) a `carriesEmpty` sa ignoruje. Chýba = kontajner TEU podľa
   * `loaded` / `carriesEmpty` ako doteraz. Plní `SimBridge` (TR2-05).
   */
  cargo?: ContainerVM | null;
  /**
   * Stav FSM vozidla (`idle`, `to_pickup`, …, R1: `to_depot`, `parked`, `depot_exit`). Renderer podľa neho nekreslí vozidlo v stave
   * `parked` (stojí v depe, kreslí ho modul cez `ModuleVM.parkedVehicles`); inak ho nesie pre ladenie a odznaky.
   */
  state: string;
}

/**
 * Kamión na cestách (F4). Rovnaké pohybové polia ako `VehicleVM` (renderer ich vedie po pruhoch a oblúkoch spoločným
 * `vehiclePose`); sprite je `entities.<defId>` (`truck_container`, 1×2 bunky, kabína v smere jazdy) so stavmi `empty` / `loaded`.
 */
export interface TruckVM extends CarrierTrailVM {
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
   * prázdny je až po vyložení na TP (R4).
   */
  loaded: boolean;
  /**
   * F6c: vezená jednotka je prázdny kontajner (návrat prázdnych, výdaj exportérovi) → sprite `states.carries_empty`; chýba = `false`. Kamión misie
   * `collect` je pred naložením prázdny (`loaded: false`), po naložení nesie `carriesEmpty`; kamión, ktorý prázdny dovezie, si hodnotu pamätá aj po
   * vyložení.
   */
  carriesEmpty?: boolean;
  /**
   * R2: vezený kontajner podľa veľkosti, typu a linky (`null` = žiadny); 20′ leží na návese vpredu, 40′ na celej jeho dĺžke. Chýba = kontajner TEU
   * podľa `loaded` / `carriesEmpty` ako doteraz. Plní `SimBridge` (TR2-05).
   */
  cargo?: ContainerVM | null;
  /**
   * Stav Truck FSM (`to_gate`, `gate_queue`, `gate_pass` / `gate_pass_out` (prechod pruhom brány), `pre_gate`, `holding`, `to_tp`, `at_tp`, `at_edge_tp`, …). Renderer podľa neho nič neriadi,
   * nesie ho pre ladenie a odznaky (R4).
   */
  state: string;
  /**
   * Stav kamióna pred posledným tickom (`SimBridge` si ho pamätá spolu s pózou); chýba pri novom kamióne. Slúži na ladenie a odznaky.
   */
  prevState?: string;
}

/**
 * Stroj v bloku skladu (R3, RTG): portál nad blokom. `x`, `y` = stred rámu (pivot) v bunkách (stred bunky = +0,5), rám jazdí po osi Y, vozík po osi X rámu.
 * `trolley` 0..1 = poloha vozíka naprieč rámom (0 = vľavo, 1 = vpravo, pruh kamióna), `hoist` 0..1 = výška zdvihu kontajnera (0 = dole, 1 = hore).
 */
export interface MachineVM {
  id: number;
  /** Id definície stroja (`rtg`, `rmg`, …); sprity z `entities.rtg` / `entities.rmg` v manifeste (každé `rtg*` id sa kreslí ako `rtg`). RMG (R6): `x`,`y` = pivot rámu, `trolley` 0..1 naprieč rámom. */
  defId: string;
  blockId: number;
  x: number;
  y: number;
  trolley: number;
  hoist: number;
  state: string;
  cargo: ContainerVM | null;
  /** R5 (`reach_stacker`): uhol stroja v stupňoch v smere hodinových ručičiek (0 = predkom hore). */
  angle?: number;
  /** R5 (`reach_stacker`): vysunutie výložníka 0..1 (0 = zasunutý). */
  boom?: number;
}

/** Stav vlaku (R6): príchod, státie pri termináli (nakladá sa), odchod. */
export type TrainStateVM = 'arriving' | 'at_terminal' | 'departing' | (string & {});

/**
 * Jeden voz vlaku (R6): `x`, `y` = STRED vozňa v bunkách sveta (vozeň je 1 × 3 bunky), `angle` = smer v stupňoch v smere hodinových ručičiek
 * (0 = predok hore, ako `VehicleVM`). Každý voz má vlastnú polohu a uhol, takže vlak sa po zákrute láme kĺbovo. `cargo` = kontajnery na vagóne
 * od predku: 60′ vagón uvezie 3 TEU (3 × 20′, alebo 40′ + 20′); lokomotíva ho nemá.
 */
export interface TrainCarVM {
  kind: 'loco' | 'wagon';
  x: number;
  y: number;
  angle: number;
  cargo: readonly ContainerVM[];
}

/** Vlak (R6, `EntitiesVM.trains`): lokomotíva a vagóny od hlavy; `departureTick` = tick odchodu podľa cestovného poriadku (UI). */
export interface TrainVM {
  id: number;
  cars: readonly TrainCarVM[];
  state: TrainStateVM;
  departureTick?: number;
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
  /** Stroje v blokoch (R3, RTG). Voliteľné: VM bez poľa nekreslí nič. */
  machines?: readonly MachineVM[];
  /** Vlaky (R6). Voliteľné: VM bez poľa nekreslí nič. */
  trains?: readonly TrainVM[];
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
