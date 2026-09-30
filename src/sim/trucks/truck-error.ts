/**
 * Chyby kamiónov (ARCHITECTURE §7.5; ADR-024). `TruckError` znamená chybu programu alebo nekonzistentný svet (neplatný
 * vstup konštruktora, `World.addTruck`/`removeTruck` mimo pravidiel, stav bez modulu či nákladu, ktorý predpokladá) —
 * poškodený save hlási `WorldStateError`. Hráč kamióny nemení priamo (vznikajú v `landsideSystem`).
 */

export type TruckErrorCode =
  /** Neplatný vstup (id, poloha, kurz, stav, dock, bay…) alebo id, ktoré nepridelil alokátor / nejde vzostupne. */
  | 'invalid_input'
  /** `World.addTruck`: id už vo svete má kamión, vozidlo, modul, loď, job alebo jednotka nákladu. */
  | 'duplicate_id'
  /** `World.addTruck`: brána, stojisko alebo rampa kamióna vo svete nie je (alebo je iného druhu), dock mimo rozsahu. */
  | 'unknown_module'
  /** `World.addTruck`: bay stojiska už drží iný kamión. */
  | 'bay_taken'
  /** `World.addTruck`: dock rampy už drží iný kamión. */
  | 'dock_taken'
  /** `World.removeTruck`: kamión s daným id vo svete nie je. */
  | 'unknown_truck'
  /** `World.removeTruck`: kamión vezie náklad (`in_truck`) — jednotky by stratili držiteľa. */
  | 'has_cargo'
  /** `World.removeTruck`: kamión drží bay, dock alebo stojí vo fronte brány. */
  | 'busy'
  /** `Truck.transition`: prechod mimo `TRUCK_TRANSITIONS` alebo návrat z `no_path` do iného stavu, než z ktorého vypadol. */
  | 'invalid_transition'
  /** `landsideSystem`: kamión v stave bez modulu alebo nákladu, ktorý stav predpokladá (poškodený svet). */
  | 'inconsistent';

export class TruckError extends Error {
  readonly code: TruckErrorCode;

  constructor(code: TruckErrorCode, message: string) {
    super(message);
    this.name = 'TruckError';
    this.code = code;
  }
}
