/**
 * Výsledok validácie príkazu (CLAUDE.md, pravidlo 5; ARCHITECTURE §12.2). UI volá `validate` na živý ghost
 * a `World` ho volá znova tesne pred `apply` (stav sa medzitým mohol zmeniť).
 */
import type { CellCoord } from '../grid/grid';

/**
 * Dôvody odmietnutia príkazu. Poradie je kanonické — výsledok validácie ich vracia v tomto poradí (`orderReasons`).
 * F1: prvých osem; F2 (docs/tasks/phase-02.md „Spoločné rozhrania", ADR-015): moduly (`PlaceModule`, `RemoveModule`)
 * a ladiaca loď (`SpawnShipDebug`, T02-05); F3 (docs/tasks/phase-03.md „Spoločné rozhrania", ADR-017): vozidlá
 * (`BuyVehicle`/`SellVehicle`, T03-04), depo a pripojenie modulov; typy ciest (`PlaceRoad`, T03-18, ADR-020); F4:
 * `has_trucks` (`RemoveModule` pozemného modulu, ktorý používa kamión, T04-04, ADR-024); F5: kontrakty
 * (`unknown_contract`, `contract_not_offered`) a koniec hry (`game_over`, T05-03, ADR-026); F6: pripravenosť prístavu
 * pri `AcceptContract` (`no_berth_for_ship_class`, `no_crane_for_category`, T06-07, ADR-031; `berth_unreachable`,
 * T06-08b, ADR-031 dodatok). Nový dôvod =
 * nový riadok tu + slovenský popis v UI (`REASON_TEXT`).
 */
export const VALIDATION_REASONS = [
  'out_of_bounds',
  'terrain',
  'occupied',
  'parcel_not_owned',
  'insufficient_funds',
  'no_road',
  'invalid_speed',
  'empty',
  /** `PlaceModule`: def s daným id v `modules.json` nie je. */
  'unknown_def',
  /** Kotvisko: bunka hrany pri vode (`waterSide` po rotácii) nesusedí s vodou. */
  'no_water_side',
  /** Kotvisko: pás `frontWaterCells` pred hranou nie je celý voľná voda v mape (modul, pás iného kotviska, okraj). */
  'water_blocked',
  /** Žeriav: footprint neleží celý na jednom kotvisku. */
  'no_berth',
  /** Žeriav: rotácia sa líši od rotácie kotviska. */
  'rotation_mismatch',
  /** Žeriav: kotvisko už má `maxCranes` žeriavov. */
  'max_cranes',
  /** `RemoveModule`: na kotvisku stoja žeriavy. */
  'has_cranes',
  /** `RemoveModule`: modul drží náklad alebo má obsadený/rezervovaný slot. */
  'has_cargo',
  /** `RemoveModule`: pri kotvisku (aj pri kotvisku pod žeriavom) kotví loď alebo k nemu pláva (`berthing`/`docked`). */
  'ship_docked',
  /** `RemoveModule`: žeriav je uprostred cyklu. */
  'busy',
  /** `RemoveModule`: modul s daným id neexistuje. */
  'unknown_module',
  /** `SpawnShipDebug` (T02-05): neznáma trieda lode. */
  'unknown_ship_class',
  /** `SpawnShipDebug` (T02-05): neznámy typ nákladu. */
  'unknown_cargo',
  /** `SpawnShipDebug` (T02-05): loď daný náklad neprevezie (kategória). */
  'cargo_incompatible',
  /** `SpawnShipDebug` (T02-05): počet jednotiek mimo rozsahu. */
  'invalid_units',
  /** `PlaceModule`: rotácia mimo 0, 90, 180, 270. */
  'invalid_rotation',
  /** `BuyVehicle` (T03-04): def vozidla s daným id vo `vehicles.json` nie je. */
  'unknown_vehicle_def',
  /** `BuyVehicle` (T03-04): modul s daným id nie je depo vozidiel. */
  'unknown_depot',
  /** `BuyVehicle` (T03-04): depo nemá voľné státie (`params.capacity`). */
  'depot_full',
  /** `BuyVehicle` (T03-04): depo nie je pripojené k ceste (`World.isConnected`). */
  'not_connected',
  /** `SellVehicle` (T03-04): vozidlo s daným id neexistuje. */
  'unknown_vehicle',
  /** `SellVehicle` (T03-04): vozidlo nie je `idle` alebo má náklad či job. */
  'vehicle_busy',
  /** `RemoveModule`: depu patria vozidlá (ADR-017). */
  'has_vehicles',
  /** `PlaceModule` (§8 bod 5, ADR-017): žiadny cestný konektor nemá vonkajšiu bunku s cestou ani voľnú pre cestu. */
  'connector_blocked',
  /** `PlaceRoad` (T03-18, ADR-020): `kind` nie je typ cesty z `ROAD_KINDS`. */
  'invalid_road_kind',
  /**
   * `PlaceRoad` (T03-18, ADR-020): `dirs` pri inom type než jednosmerka, chýbajúce `dirs` pri jednosmerke, iný počet
   * smerov než buniek alebo smer mimo N/E/S/W.
   */
  'invalid_direction',
  /** `RemoveModule` (T04-04, ADR-024): bránu, stojisko alebo rampu používa kamión (trasa, bay, dock). */
  'has_trucks',
  /** `AcceptContract` / `DeclineContract` (T05-03, ADR-026): kontrakt s daným id vo `world.contracts` nie je (aj expirovaný). */
  'unknown_contract',
  /** `AcceptContract` / `DeclineContract` (T05-03, ADR-026): kontrakt nie je ponuka v stave `offered`. */
  'contract_not_offered',
  /** Hra skončila bankrotom (`World.gameOver`, ADR-025); po `GameOver` ho hlási každý príkaz (`SimCommand`, ADR-027) ako jediný dôvod. */
  'game_over',
  /**
   * `AcceptContract` (T06-07, ADR-031): žiadny úsek kotvísk (§5.4) nemá pre triedu lode ponuky dosť dĺžky, hĺbky
   * a pásu vody — bez ohľadu na obsadenosť.
   */
  'no_berth_for_ship_class',
  /**
   * `AcceptContract` (T06-07, ADR-031): úsek kotvísk, ku ktorému loď ponuky dopláva, existuje, ale žiadny nemá žeriav
   * kategórie nákladu.
   */
  'no_crane_for_category',
  /**
   * `AcceptContract` (T06-08b, ADR-031 dodatok): úsek kotvísk s dĺžkou, hĺbkou a pásom vody pre loď ponuky existuje,
   * ale loď k žiadnemu nedopláva ani na prázdnej vode (bod priblíženia na súši, príliš úzka cesta po vode).
   */
  'berth_unreachable',
  /**
   * `AcceptContract` pri export / roundtrip bookingu (F6a, ADR-032, pripravenosť pozemnej strany ako `berthReadiness`): vo svete
   * nie je rampa kategórie nákladu bookingu — kamióny s exportom by nemali kam vyložiť.
   */
  'no_ramp_for_category',
  /**
   * `AcceptContract` pri export / roundtrip bookingu: rampa kategórie je, ale žiadna nie je prevádzková (chýba brána, stojisko
   * alebo cesta od portálu — `World.isRampOperational`), takže kamióny s exportom nevzniknú.
   */
  'ramp_inoperative',
  /**
   * `AcceptContract` pri export / roundtrip bookingu: prevádzková rampa je, ale žiadny sklad kategórie nákladu nie je z nej po
   * ceste dosiahnuteľný — vyložený export by nemal kam ísť.
   */
  'no_storage_for_category',
  /** `SetBlockPriority` (TR3-02, ADR-040 bod 6): `order` nie je druh úlohy z `YARD_PRIORITY_KINDS` (ship, truck, housekeeping). */
  'invalid_priority',
  /** `SetCraneGang` (TR3-02, ADR-040 bod 7): režim nie je `pool` / `gang`, alebo `tractorsPerSts` mimo `equipment.json` `tractors.minPerSts … maxPerSts`. */
  'invalid_gang',
] as const;

export type ValidationReason = (typeof VALIDATION_REASONS)[number];

export interface ValidationResult {
  /** `true` = príkaz možno aplikovať; `false` = `reasons` je neprázdne a `apply` sa nesmie zavolať. */
  readonly ok: boolean;
  /** Dôvody odmietnutia (bez duplicít); pri `ok === true` prázdne. */
  readonly reasons: readonly ValidationReason[];
  /**
   * Bunky, na ktoré sa výsledok vzťahuje (ghost v UI ich zafarbí); príkazy bez buniek vracajú prázdne pole.
   * Príkazy nad vrstvou dopravy (`RoadLayerCommand`): unikátne bunky, ktoré `apply` zmení (nové aj prestavané), v poradí
   * prvého výskytu (pri odmietnutí tie, ktoré by samy prešli) — bunky už v cieľovom stave ani neplatné bunky tu nie sú;
   * pri neplatnom tvare príkazu (`invalid_road_kind`, `invalid_direction`) `[]`.
   * `PlaceModule`: celý footprint po rotácii row-major (aj pri odmietnutí a aj bunky mimo mapy; `[]` pri `unknown_def`
   * alebo `invalid_rotation`). `RemoveModule`: footprint modulu (`[]` pri `unknown_module`). ADR-015.
   */
  readonly cells: readonly CellCoord[];
  /**
   * Cena príkazu v centoch (USD), ktorú by `apply` strhol z hotovosti; 0 = zadarmo, záporná = príjem
   * (napr. refundácia `RemoveRoad`, ADR-012). Cesty: pri odmietnutí cena platnej časti (`cells`); pri prestavbe
   * `PlaceRoad` čistá cena = nové bunky − refundácia starých typov (ADR-020, rozpad `RoadLayerCommand.quote`). `PlaceModule`:
   * `def.costCents` aj pri odmietnutí (0 pri `unknown_def`); `RemoveModule`: −refundácia zo zaplatenej ceny (ADR-015).
   */
  readonly costCents: number;
}

/** Dôvody z množiny v kanonickom poradí `VALIDATION_REASONS` (deterministické, bez duplicít), zmrazené. */
export function orderReasons(found: ReadonlySet<ValidationReason>): readonly ValidationReason[] {
  return Object.freeze(VALIDATION_REASONS.filter((reason) => found.has(reason)));
}
