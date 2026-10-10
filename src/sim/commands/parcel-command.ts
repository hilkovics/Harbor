/**
 * Spoločný základ príkazov nad parcelou (F7, ADR-044): `BuyParcel`, `LeaseParcel`, `ReleaseParcel`. Všetky nesú jediné
 * pole `parcelId`; podtrieda určuje pravidlá (`rules`) a zmenu (`change`). Cena = `costCents` výsledku (kúpa = cena
 * parcely, prenájom a uvoľnenie = 0; nájomné sa účtuje denne v `EconomySystem`).
 */
import type { Parcel } from '../grid/parcel';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkString, readPayload } from './payload';
import { SimCommand } from './sim-command';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

const PARCEL_COMMAND_KEYS: readonly string[] = ['type', 'parcelId'];
const NO_CELLS: ValidationResult['cells'] = Object.freeze([]);

/** Tvar JSON vstupu `{ type, parcelId }` → `parcelId` (iný tvar → `CommandError`). */
export function readParcelId(json: SerializedCommand, type: string): string {
  return checkString(readPayload(json, type, PARCEL_COMMAND_KEYS)['parcelId'], type, '/parcelId');
}

export abstract class ParcelCommand extends SimCommand {
  readonly parcelId: string;

  protected constructor(parcelId: string, type: string) {
    super();
    this.parcelId = checkString(parcelId, type, '/parcelId');
  }

  /** Dôvody odmietnutia pre existujúcu parcelu (bez `unknown_parcel`, `insufficient_funds`). */
  protected abstract rules(world: World, parcel: Readonly<Parcel>): readonly ValidationReason[];

  /** Cena v centoch pre existujúcu parcelu. */
  protected abstract price(world: World, parcel: Readonly<Parcel>): number;

  protected check(world: World): ValidationResult {
    const parcel = world.parcels.get(this.parcelId);
    if (parcel === undefined) return Object.freeze({ ok: false, reasons: orderReasons(new Set<ValidationReason>(['unknown_parcel'])), cells: NO_CELLS, costCents: 0 });
    const found = new Set<ValidationReason>(this.rules(world, parcel));
    const costCents = this.price(world, parcel);
    if (costCents > 0 && costCents > world.cashCents) found.add('insufficient_funds');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents });
  }

  /** Zmena stavu po úspešnej validácii. */
  protected abstract change(world: World, parcel: Parcel, costCents: number): void;

  apply(world: World): void {
    const result = this.validate(world);
    const parcel = world.parcels.get(this.parcelId);
    if (!result.ok || parcel === undefined) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    this.change(world, parcel, result.costCents);
  }

  toJSON(): SerializedCommand {
    return { type: this.type, parcelId: this.parcelId };
  }
}

/** Bunky parcely obsadené stavbou (modul, cesta, koľaj) — parcela s nimi sa nedá uvoľniť. */
export function parcelInUse(world: World, parcel: Readonly<Parcel>): boolean {
  const { x, y, w, h } = parcel.rect;
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      const cell = world.grid.at(cx, cy);
      if (cell.moduleId !== null || cell.road !== 'none') return true;
    }
  }
  return false;
}

