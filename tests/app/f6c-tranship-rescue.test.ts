// T6C-06b: zmeškaná, zachránená a predaná prekládka nad skutočným simom (nie syntetickými udalosťami). Svet z `exportWorld` (rozloženie F4 +
// dvory, rampa; sim helpery `tests/sim/helpers/f6a|f6c`) beží cez `GameLoop` + `SimBridge` a toasty ako v hre. Loď B „odpláva bez jednotiek“
// tak ako v sim testoch prekládky (kontrakt ukáže na loď, ktorá na mape nie je); zvyšok — `TranshipMissed`, penalizácia, `TranshipRescued`
// / `TranshipSold`, nakládka na záchrannú loď, výplata, kamión s predanými jednotkami — robí sim.
//
// Čo sa overuje: toasty „Tranship zmeškaný“ (so sumou penalizácie, bez samostatného toastu „vrátené jednotky“), „zachránený“, „predaný“,
// `ExportShipped` lode záchrany; karta (`rescueDeadlineTick` = „zmeškané“, po záchrane preč, `returnedUnits` = predané); pravidlo A / B
// v `ShipVM.cargoSplit` pri záchrannej lodi (jej vlastný import + cudzia prekládka); karty snapshotu = čerstvé karty v každom kroku.
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { TranshipContract } from '@sim/contracts';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import type { World } from '@sim/world';
import { contractCards, contractsTimeScale } from '@app/contract-cards';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import {
  EXPORT_SHIPPED_TOAST_TITLE,
  TRANSHIP_MISSED_TOAST_TITLE,
  TRANSHIP_RESCUED_TOAST_TITLE,
  TRANSHIP_SOLD_TOAST_TITLE,
  toastSpecsForEvents,
  type ToastSpec,
} from '@app/toast-center';
import { transhipCounters, transhipLegs, transhipMissed } from '@ui/contracts-panel';
import { formatMoney } from '@ui/format';
import { acceptCommand, exportWorld, f6aDefs } from '../sim/helpers/f6a';
import { acceptedImport, offerTranship } from '../sim/helpers/f6c';
import { assertCargoConservation } from '../sim/helpers/invariants';
import { oracleDeckSplit } from './f6c-fixtures';

const UNITS = 5;
const STEP = 10;

interface Setup {
  readonly world: World;
  readonly bridge: SimBridge;
  readonly loop: GameLoop;
  readonly contract: TranshipContract;
  readonly toasts: { readonly tick: number; readonly spec: ToastSpec }[];
  readonly events: { readonly tick: number; readonly event: SimEvent }[];
  readonly mismatches: string[];
  /** Posunie svet o `ticks` po krokoch `STEP` s kontrolou kariet a nákladu lodí v každom kroku. */
  advance(ticks: number): void;
  /** Pozorovania lodí: najväčší náklad podľa lode a jeho druhy. */
  readonly peaks: Map<number, { import: number; export: number }>;
  readonly rescue: { importContractId: number | undefined };
}

/** Prekládka 5 TEU prijatá a vyložená v sklade; loď B odplávala bez jednotiek (viď hlavička); s `rescue` je v knihe aj import záchrannej voyage. */
function missedTranship(options: { readonly rescue: boolean }): Setup {
  const world = exportWorld({ defs: f6aDefs({ economy: { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] } }), vehicles: ['straddle_carrier', 'straddle_carrier'] });
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  const toasts: { tick: number; spec: ToastSpec }[] = [];
  const events: { tick: number; event: SimEvent }[] = [];
  bridge.onEvents((batch) => {
    for (const event of batch) events.push({ tick: world.clock.tick, event });
    for (const spec of toastSpecsForEvents(world, batch)) toasts.push({ tick: world.clock.tick, spec });
  });
  const contract = offerTranship(world, { units: UNITS });
  bridge.dispatch(commandFromJSON(acceptCommand(contract.id)));
  loop.advance(1);
  const mismatches: string[] = [];
  const peaks = new Map<number, { import: number; export: number }>();
  const check = (): void => {
    const snapshot = bridge.snapshot();
    if (JSON.stringify(snapshot.contracts) !== JSON.stringify(contractCards(world))) mismatches.push(`tick ${String(world.clock.tick)}: karty snapshotu ≠ čerstvé karty`);
    for (const vm of snapshot.ships) {
      const expected = oracleDeckSplit(world, vm.id as EntityId);
      const actual = { import: vm.cargoSplit?.import ?? -1, export: vm.cargoSplit?.export ?? -1, empty: vm.cargoSplit?.empty ?? 0 };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`tick ${String(world.clock.tick)}: loď #${String(vm.id)} cargoSplit ${JSON.stringify(actual)} ≠ orákulum ${JSON.stringify(expected)}`);
      const peak = peaks.get(vm.id) ?? { import: 0, export: 0 };
      peaks.set(vm.id, { import: Math.max(peak.import, actual.import), export: Math.max(peak.export, actual.export) });
    }
  };
  const setup: Setup = {
    world,
    bridge,
    loop,
    contract,
    toasts,
    events,
    mismatches,
    peaks,
    rescue: { importContractId: undefined },
    advance(ticks) {
      for (let left = ticks; left > 0; left -= STEP) {
        loop.advance(Math.min(STEP, left));
        check();
      }
    },
  };
  // loď A privezie a vyloží prekládku do skladu
  for (let guard = 0; guard < 4_000 && !(contract.state === 'exporting' && world.cargo.countByKind('in_storage') === UNITS); guard++) setup.advance(STEP);
  expect(contract.state).toBe('exporting');
  if (options.rescue) setup.rescue.importContractId = acceptedImport(world, contract.lineId).contractId;
  contract.outShipId = 9_999 as EntityId;
  contract.outArrivalTick = world.clock.tick;
  setup.advance(STEP);
  return setup;
}

const toastsOf = (setup: Setup, prefix: string): ToastSpec[] => setup.toasts.filter((entry) => entry.spec.key.startsWith(prefix)).map((entry) => entry.spec);
const cardOf = (setup: Setup) => {
  const card = setup.bridge.snapshot().contracts.find((entry) => entry.id === setup.contract.id);
  if (card === undefined) throw new Error('karta prekládky chýba v snapshote');
  return card;
};

describe('zmeškaná prekládka bez záchrany: zmeškané → predané', () => {
  let setup: Setup;
  beforeAll(() => {
    setup = missedTranship({ rescue: false });
  });
  const time = () => contractsTimeScale(setup.world);

  it('hneď po odplávaní lode B: toast „Tranship zmeškaný“ so sumou penalizácie a bez samostatného toastu „vrátené jednotky (rolled)“', () => {
    expect(setup.mismatches).toEqual([]);
    const missed = toastsOf(setup, 'tranship_missed:');
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ tone: 'danger', title: TRANSHIP_MISSED_TOAST_TITLE, panel: 'contracts' });
    expect(missed[0]?.text).toContain(`#${String(setup.contract.id)} · Tranship 5 TEU → Hamburg`);
    expect(missed[0]?.text).toContain(`plavba #${String(setup.contract.outVoyageId)}`);
    expect(missed[0]?.text).toContain('zmeškané: 5 jednotiek');
    expect(setup.contract.penaltiesCents).toBe(250_000); // ⌊odmena × transhipMissedRateOfReward⌋
    expect(missed[0]?.text).toContain(`penalizácia ${formatMoney(-250_000)}`);
    expect(toastsOf(setup, 'booking_penalty:')).toEqual([]);
    // tranship zmeškaný je penalizácia `rolled` v sime, hráčovi sa ukáže len raz
    expect(setup.events.filter((entry) => entry.event.type === 'BookingPenaltyApplied')).toHaveLength(1);
  });

  it('karta: `rescueDeadlineTick` = zmeškané (+ transhipRescueDays), všetkých 5 jednotiek čaká v sklade, panel ukáže odpočet na záchranu', () => {
    const card = cardOf(setup);
    const { world } = setup;
    const { economy } = world.defs;
    expect(card.state).toBe('exporting');
    expect(card.tranship?.rescueDeadlineTick).toBeDefined();
    expect((card.tranship?.rescueDeadlineTick ?? 0) - world.clock.tick).toBeGreaterThan((economy.transhipRescueDays - 0.1) * world.clock.ticksPerDay);
    expect(card.booking).toMatchObject({ bookedUnits: 5, arrivedUnits: 5, loadedUnits: 0, returnedUnits: 0 });
    expect(transhipMissed(card, time())).toMatchObject({ units: 5 });
    expect(transhipMissed(card, time())?.text).toMatch(/^Na záchranu zostáva /);
    expect(transhipCounters(card, time()).map((counter) => [counter.key, counter.count])).toEqual([['missed', 5]]);
    expect(transhipLegs(card, time())?.[1]).toMatchObject({ badge: 'B', tone: 'danger', timing: 'odplávala bez jednotiek' });
  });

  it('po lehote záchrany sa jednotky predajú: toast „Tranship predaný“, karta má predané = `returnedUnits`, kamión ich odvezie, nič sa nestratilo', () => {
    const { world } = setup;
    setup.advance(3 * world.clock.ticksPerDay + 2_000);
    for (let guard = 0; guard < 500 && world.cargo.exportedCount < UNITS; guard++) setup.advance(STEP);
    expect(setup.mismatches).toEqual([]);
    const sold = toastsOf(setup, 'tranship_sold:');
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatchObject({ tone: 'warning', title: TRANSHIP_SOLD_TOAST_TITLE, panel: 'contracts' });
    expect(sold[0]?.text).toContain('predané kamiónom (penalizácia): 5 jednotiek');
    const card = cardOf(setup);
    expect(card.state).toBe('failed');
    expect(card.unitsExported).toBe(5);
    expect(card.booking).toMatchObject({ arrivedUnits: 5, loadedUnits: 0, returnedUnits: 5 });
    // zlyhaný kontrakt je v histórii: „čakajú“ a „zmeškané“ zmizli, „predané“ ostáva ako výsledok
    expect(transhipMissed(card, time())).toBeNull();
    expect(transhipCounters(card, time()).map((counter) => [counter.key, counter.count])).toEqual([['sold', 5]]);
    expect(toastsOf(setup, 'contract_failed:')).toHaveLength(1);
    expect(toastsOf(setup, 'tranship_rescued:')).toEqual([]);
    expect(world.cargo.shippedCount).toBe(0);
    assertCargoConservation(world);
    const { cargo } = world;
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount - cargo.shippedCount).toBe(0);
  });
});

describe('zmeškaná prekládka so záchranou na ďalšiu voyage linky', () => {
  let setup: Setup;
  beforeAll(() => {
    setup = missedTranship({ rescue: true });
  });
  const time = () => contractsTimeScale(setup.world);

  it('toasty: „zmeškaný“ (so sumou) a „zachránený“ (čakajú na plavbu záchrannej lode), bez toastu o rolled penalizácii', () => {
    expect(setup.mismatches).toEqual([]);
    const rescueVoyage = setup.contract.outVoyageId;
    expect(rescueVoyage).not.toBe(setup.contract.voyageId);
    const missed = toastsOf(setup, 'tranship_missed:');
    const rescued = toastsOf(setup, 'tranship_rescued:');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.text).toContain(`penalizácia ${formatMoney(-250_000)}`);
    expect(rescued).toHaveLength(1);
    expect(rescued[0]).toMatchObject({ tone: 'info', title: TRANSHIP_RESCUED_TOAST_TITLE, panel: 'contracts' });
    expect(rescued[0]?.text).toContain(`zachránené: 5 jednotiek, čakajú na plavbu #${String(rescueVoyage)}`);
    expect(toastsOf(setup, 'booking_penalty:')).toEqual([]);
  });

  it('karta po záchrane: lehota záchrany zmizla, loď B je záchranná plavba, jednotky čakajú na loď B (nie „zmeškané“)', () => {
    const card = cardOf(setup);
    expect(card.tranship).toMatchObject({ outVoyageId: setup.contract.outVoyageId });
    expect(card.tranship).not.toHaveProperty('rescueDeadlineTick');
    expect(transhipMissed(card, time())).toBeNull();
    expect(transhipCounters(card, time()).map((counter) => [counter.key, counter.count])).toEqual([['waiting', 5]]);
    expect(transhipLegs(card, time())?.[1]).toMatchObject({ badge: 'B', tone: 'normal', text: `plavba #${String(setup.contract.outVoyageId)}` });
    // karta záchranného importu je samostatná karta tej istej voyage záchrannej lode
    const rescueImport = setup.bridge.snapshot().contracts.find((entry) => entry.id === setup.rescue.importContractId);
    expect(rescueImport).toMatchObject({ kind: 'import', voyageId: setup.contract.outVoyageId });
  });

  it('záchranná loď: jej import je `import`, cudzia prekládka je na nej `export` (pravidlo A / B podľa lode, nie podľa kontraktu); VM = orákulum v každom kroku', () => {
    const { world } = setup;
    for (let guard = 0; guard < 6_000 && setup.contract.state !== 'completed'; guard++) setup.advance(STEP * 5);
    expect(setup.mismatches).toEqual([]);
    expect(setup.contract.state).toBe('completed');
    const rescueShip = world.contracts.get(setup.rescue.importContractId as never)?.shipId as EntityId;
    expect(setup.contract.outShipId).toBe(rescueShip);
    // záchranná loď privezie 4 TEU importu (vyloží ich) a odvezie 5 prekladaných TEU; A-loď tranship kontraktu je iná loď
    expect(setup.peaks.get(rescueShip)).toEqual({ import: 4, export: 5 });
    expect(setup.contract.shipId).not.toBe(rescueShip);
    expect(setup.peaks.get(setup.contract.shipId as EntityId)).toEqual({ import: 5, export: 0 });
  });

  it('odchod záchrannej lode: ExportShipped.units = 5, toast ukáže triedu a cieľ z kontraktu prekládky (kontrakt lode B, nie lode A); výplata a konzervácia', () => {
    const { world } = setup;
    for (let guard = 0; guard < 400 && !setup.events.some((entry) => entry.event.type === 'ExportShipped'); guard++) setup.advance(STEP * 5);
    const shipped = setup.events.filter((entry) => entry.event.type === 'ExportShipped');
    expect(shipped.map((entry) => (entry.event.type === 'ExportShipped' ? entry.event.units : -1))).toEqual([5]);
    const toast = setup.toasts.find((entry) => entry.spec.title === EXPORT_SHIPPED_TOAST_TITLE);
    expect(toast?.spec.text).toBe('Feeder · 5 TEU → Hamburg');
    expect(toastsOf(setup, 'contract_completed:').map((spec) => spec.key)).toContain(`contract_completed:${String(setup.contract.id)}`);
    expect(setup.mismatches).toEqual([]);
    assertCargoConservation(world);
    expect(world.cargo.shippedCount).toBe(5);
    const { cargo } = world;
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount - cargo.shippedCount).toBe(0);
  });
});
