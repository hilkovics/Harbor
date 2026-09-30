/**
 * Chyby vozidiel (ARCHITECTURE §4.4, §5; docs/tasks/phase-03.md rozhodnutie 4). `VehicleError` znamená chybu programu
 * alebo nekonzistentný svet (neplatný vstup konštruktora, `World.addVehicle`/`removeVehicle` mimo pravidiel) —
 * hráčske vstupy odmietajú `BuyVehicle.validate`/`SellVehicle.validate` a poškodený save `WorldStateError`.
 */

export type VehicleErrorCode =
  /** Neplatný vstup (id, poloha, kurz, stav, cena…) alebo id, ktoré nepridelil alokátor / nejde vzostupne. */
  | 'invalid_input'
  /** `World.addVehicle`: id už vo svete má vozidlo, modul, loď alebo jednotka nákladu. */
  | 'duplicate_id'
  /** `World.addVehicle`/`removeVehicle`: `depotId` nie je depo vozidiel vo svete. */
  | 'unknown_depot'
  /** `World.addVehicle`: depo nemá voľné státie. */
  | 'depot_full'
  /** `World.removeVehicle`: vozidlo s daným id vo svete nie je. */
  | 'unknown_vehicle'
  /** `World.removeVehicle`: vozidlo vezie náklad (`in_vehicle`) — jednotky by stratili držiteľa. */
  | 'has_cargo'
  /** `World.removeVehicle`: vozidlo nie je `idle` alebo má job. */
  | 'busy';

export class VehicleError extends Error {
  readonly code: VehicleErrorCode;

  constructor(code: VehicleErrorCode, message: string) {
    super(message);
    this.name = 'VehicleError';
    this.code = code;
  }
}
