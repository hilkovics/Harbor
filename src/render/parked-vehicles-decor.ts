/**
 * Ozdoba depa vozidiel (`ModuleVM.parkedVehicles`, R1, ADR-037 bod 7): vozidlá v stave `parked` sa na mape nekreslia ako bežné
 * vozidlá (`EntityLayer`), ale ako **mriežka zmenšených spritov vnútri footprintu depa**. Poradie je deterministické (podľa `id`,
 * po riadkoch zľava doprava a zhora nadol), vozidlá stoja predkom do stojiska (smer ako rotácia 0 modulu, takže sa otáčajú s ním).
 *
 * Mriežka má `PARKING_ROWS` radov (depo má kryté a otvorené státia, `assets/modules/vehicle_depot.svg`) a toľko stĺpcov, aby sa
 * zmestila kapacita (`sprites.<defId>.stalls` v manifeste, najmenej počet zaparkovaných) — 10 miest na 3 × 3 bunkách je 5 × 2.
 * Plocha státí `PARKING_AREA` je podiel footprintu bez prejazdu pri vjazde; bunka mriežky je stojisko, vozidlo sa doňho zmenší
 * (`PARKING_FILL`) bez zväčšenia nad pôvodnú mierku. Bez poľa `parkedVehicles` sa ozdoba nevytvára a depo ostáva ako doteraz.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { parkingStalls, vehicleSprite, type CellSize } from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';
import { VEHICLE_SCALE } from './world-scale';

/** Počet radov státí (kryté a otvorené). */
export const PARKING_ROWS = 2;

/** Plocha státí ako podiel footprintu (zľava, zhora, šírka, výška): bez okrajov depa a prejazdu pri vjazde (sprite 192 × 192 px: x 12–182, y 12–150). */
export const PARKING_AREA = Object.freeze({ x: 12 / 192, y: 12 / 192, w: 170 / 192, h: 138 / 192 });

/** Podiel bunky mriežky, ktorý vozidlo zaberie (medzera medzi susedmi). */
export const PARKING_FILL = 0.9;

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja vozidla (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Rozmer vozidla bez záznamu v manifeste (bunky). */
const FALLBACK_FOOTPRINT: CellSize = { w: 1, h: 1 };

/** Jedno stojisko v lokálnom rámci modulu: stred (px sveta) a rozmer (px sveta). */
export interface ParkingSlot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Mriežka státí: počet radov a stĺpcov pre `capacity` miest. */
export function parkingGrid(capacity: number): { readonly rows: number; readonly columns: number } {
  const total = Math.max(1, Math.floor(capacity));
  const rows = Math.min(PARKING_ROWS, total);
  return { rows, columns: Math.ceil(total / rows) };
}

/**
 * Stojiská pre `capacity` miest vo footprinte `widthPx` × `heightPx` (px sveta, počiatok = stred footprintu): po riadkoch zľava
 * doprava a zhora nadol; index stojiska = poradie vozidla podľa `id`.
 */
export function parkingSlots(widthPx: number, heightPx: number, capacity: number): ParkingSlot[] {
  const { rows, columns } = parkingGrid(capacity);
  const left = -widthPx / 2 + PARKING_AREA.x * widthPx;
  const top = -heightPx / 2 + PARKING_AREA.y * heightPx;
  const width = (PARKING_AREA.w * widthPx) / columns;
  const height = (PARKING_AREA.h * heightPx) / rows;
  const slots: ParkingSlot[] = [];
  for (let index = 0; index < rows * columns; index++) {
    slots.push({ x: left + ((index % columns) + 0.5) * width, y: top + (Math.floor(index / columns) + 0.5) * height, width, height });
  }
  return slots;
}

/** Zaparkované vozidlá v poradí podľa `id` (kópia, vstup sa nemení). */
export function sortedParked(vehicles: readonly { readonly id: number; readonly defId: string }[]): { readonly id: number; readonly defId: string }[] {
  return [...vehicles].sort((a, b) => a.id - b.id);
}

/** Mierka vozidla `size` (px sveta) v stojisku `slot`: vojde sa do bunky mriežky s medzerou, nezväčšuje sa nad pôvodnú veľkosť. */
export function parkedScale(size: { readonly w: number; readonly h: number }, slot: ParkingSlot): number {
  return Math.min(1, (PARKING_FILL * slot.width) / size.w, (PARKING_FILL * slot.height) / size.h);
}

export class ParkedVehiclesDecor implements ModuleDecor {
  readonly view = new Container({ label: 'parked-vehicles-decor' });
  /** Kľúč naposledy nakresleného stavu (`id:defId` v poradí), aby sa neprekresľovalo zbytočne. */
  private key = '';
  private readonly parked = new Map<number, Container>();

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet nakreslených zaparkovaných vozidiel — pre testy. */
  get count(): number {
    return this.parked.size;
  }

  /** Nakreslené vozidlo `id` (`undefined`, ak nie je zaparkované) — pre testy. */
  vehicle(id: number): Container | undefined {
    return this.parked.get(id);
  }

  update(vm: ModuleVM): void {
    const vehicles = sortedParked(vm.parkedVehicles ?? []);
    const key = vehicles.map((vehicle) => `${String(vehicle.id)}:${vehicle.defId}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.parked.forEach((container) => {
      container.destroy({ children: true });
    });
    this.parked.clear();
    const { cellPx } = this.context.deps;
    const capacity = Math.max(parkingStalls(vm.defId) ?? 0, vehicles.length);
    const slots = parkingSlots(this.context.pose.baseW * cellPx, this.context.pose.baseH * cellPx, capacity);
    vehicles.forEach((vehicle, index) => {
      const container = this.createVehicle(vehicle.id, vehicle.defId, slots[index]);
      this.parked.set(vehicle.id, container);
      this.view.addChild(container);
    });
  }

  destroy(): void {
    this.parked.clear();
    this.view.destroy({ children: true });
  }

  /** Vozidlo v stojisku: sprite `states.empty` z manifestu (alebo telo z tokenov), zmenšený do bunky mriežky, predkom hore. */
  private createVehicle(id: number, defId: string, slot: ParkingSlot): Container {
    const { cellPx, palette, textures } = this.context.deps;
    const entry = vehicleSprite(defId);
    const footprint = entry?.footprint ?? FALLBACK_FOOTPRINT;
    const size = { w: footprint.w * cellPx * VEHICLE_SCALE, h: footprint.h * cellPx * VEHICLE_SCALE };
    const container = new Container({ label: `parked-vehicle-${String(id)}` });
    container.position.set(slot.x, slot.y);
    container.scale.set(parkedScale(size, slot));
    const texture = entry === undefined ? undefined : textures?.file(entry.states.empty);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(size.w, size.h);
      container.addChild(sprite);
    } else {
      const { body, dark } = palette.vehicle;
      const inset = FALLBACK_INSET_CELLS * cellPx;
      const graphics = new Graphics();
      graphics
        .rect(-size.w / 2 + inset, -size.h / 2 + inset, size.w - inset * 2, size.h - inset * 2)
        .fill({ color: body.color, alpha: body.alpha })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: dark.color, alpha: dark.alpha, alignment: 1 });
      container.addChild(graphics);
    }
    return container;
  }
}

export const parkedVehiclesDecorFactory: ModuleDecorFactory = {
  id: 'parked_vehicles',
  applies: (vm) => vm.parkedVehicles !== undefined,
  create: (vm, context) => new ParkedVehiclesDecor(vm, context),
};
