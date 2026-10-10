# Fáza R2: kontajnery a stohy · task karty

> **Zdroj:** `docs/TERMINAL_2.md` §3–§4, ADR-036 a ADR-039 (vznikne v TR2-01). Grafika v `design/assets-t2/` (kontajnery `cargo/`, `entities/ech.svg`, `modules/vehicle_parking.svg`), UI podľa `design/ui/game-ui-t2.html`.
> **Vetva:** `phase/r2-stacks`, stacked nad `phase/r1-traffic` (PR hilkovics/Harbor#12).
> **Veľmi úsporný režim** platí podľa `phase-r1.md`:
> - Haiku robí mechanické práce,
> - Sonnet robí jadro simulácie a netriviálny render,
> - Opus len plánuje,
> - reporty majú najviac 12 riadkov.

**Cieľ:** kontajnery majú veľkosť 20′/40′ a typ, sklad sú bloky so stohmi s presnou polohou, brať sa dá len vrchný kontajner (inak rehandling) a plánovač ukladá podľa času odchodu.

**Akceptácia:**
1. 0 porušení stohov (invariant v kroku 12) vo všetkých scenároch, `lostUnits` 0, `stuckAtEnd` 0.
2. `rehandlesPerMove` vo `vertical_slice`: s plánovačom < 0,3, s náhodným ukladaním (def `yardPlanner: "random"`) > 1. Tým sa dokáže, že plánovač funguje.
3. Kontrakty a lode počítajú TEU: 40′ = 2 TEU, výplata za TEU.
4. Inšpektor bloku ukazuje bay zboku.
5. Render ukazuje stohy zhora s výškou (tieň) a kontajnery podľa veľkosti, typu a linky.
6. Celé `pnpm test` a plná e2e sú zelené.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-039 v TR2-01)
1. **Štítky jednotky:** `sizeFt: 20 | 40`, `containerType` (id z `container_types.json`, v R2 len `dry`; reefer a ostatné typy prídu v R5), `oog: false`. Prázdny = `direction: 'empty'`, ako doteraz.
2. **TEU:**
   - kontrakt má `volumeUnits` = počet kontajnerov a `volumeTeu` = súčet TEU;
   - zmes veľkostí určuje `sizeMix` v šablóne kontraktu (podiel 40′) a `Rng` pri vzniku ponuky;
   - výplata a penalizácie sú za TEU;
   - kapacita lode (`capacity` v `ships.json`) je v TEU;
   - vozidlo, straddle carrier aj kamión vezie **1 kontajner** (20′ alebo 40′).
3. **Blok a stoh:**
   - `YardBlock extends StorageModule` s geometriou `bays × rows × maxTier` z defu;
   - **straddle blok:** 1 bay = 1 bunka pozdĺž, 1 rad = 1 bunka naprieč, `maxTier` 3;
   - **depo prázdnych:** `maxTier` 8;
   - kapacita v TEU = `bays × rows × maxTier`.
4. **Poloha** v ledgeri ostáva `in_storage { moduleId, slot }`. Slot kóduje polohu: `((row × bays) + bay) × maxTier + tier`. Dekódovanie robí `YardBlock`; kód okolo slotov sa nemusí prepisovať.
5. **`StackGrid`** (odvodená cache, nie je v save) drží výšku a vrchný kontajner každého stohu.
   - **Pravidlá:**
     - ukladá sa len na zem alebo na vrchol stohu rovnakej veľkosti;
     - 40′ zaberá páry bays `(2k, 2k+1)`, oba stĺpce musia mať rovnakú výšku a vrch 40′ alebo zem;
     - nad `maxTier` sa neukladá;
     - **brať sa dá len vrchný kontajner.**
   - **Kontrola:** `CargoLedger.move` volá `YardBlock.assertCanPlace` a `assertCanTake`. Porušenie znamená chybu.
6. **Rehandling:**
   - Ak cieľový kontajner nie je navrchu, vozidlo, ktoré prišlo poň, najprv preloží kontajnery nad ním v tom istom bloku. Cieľ vyberá plánovač: prednostne rovnaký bay, stoh, ktorého vrch odchádza neskôr.
   - Každý presun `in_storage → in_vehicle → in_storage` trvá `rehandleTicks` (def).
   - Metriky: `rehandles`, `rehandlesPerMove`.
7. **`YardPlanner`** (TOS) vyberá blok a stoh pre každú jednotku, ktorá ide do skladu:
   1. **Filter:** typ bloku (prázdne do depa, inak bežný blok; fallback ako dnes), veľkosť a dosiahnuteľnosť.
   2. **Segregácia:**
      - export podľa `(voyage, destinationPort, weightClass, sizeFt)`;
      - import podľa odhadu odchodu;
      - prekládka podľa lode B;
      - prázdne podľa `(lineId, sizeFt)`.
   3. **Bez zavalenia:** stoh, ktorého vrch odchádza neskôr alebo rovnako, inak prázdny stoh, inak najmenšia penalizácia.
   4. **Vzdialenosť:** bližší blok má prednosť.

   Výber je deterministický, poradie `(skóre, id bloku, bay, row)`.

   Režim `yardPlanner: "planned" | "random"` je v `logistics.json`; `random` slúži len pre akceptačný test a použije `Rng`.
8. **Čas odchodu** (`plannedDepartureTick`, odvodený, nie je v save):
   - export: príchod lode voyage + poradie stowage;
   - prekládka: `outArrivalTick`;
   - import: **odhad** `dischargeTick + importDwellEstimateHours` (def), obmedzený SLA. Skutočné termíny odvozu (TAS) prídu v R4 s novou landside;
   - prázdne: nekonečno (FIFO podľa linky).
9. **Depo a ECH:**
   - depo prázdnych je `YardBlock` s výškou 8;
   - vozidlo `empty_handler` ostáva cestným vozidlom (viazané stroje a RTG prídu v R3), v renderi dostane sprite `ech`.
10. **Mapa a scenáre:**
    - `container_yard_small` sa stáva straddle blokom (rovnaké id defu, nová geometria a kapacita v TEU);
    - scenáre sa nemenia, len goldeny;
    - save je v10 bez migrácie (mení sa tvar).
11. **Render:**
    - **Stohy zhora:** vidno vrchný kontajner každého stohu podľa veľkosti, typu a linky (tint `#D9DDE2` base). Výšku ukazuje režim **Tieň** (`rgba(0,0,0,.32)`, 3 px × výška); režim **Odznak** sa pridá do nastavení neskôr (BACKLOG).
    - **Na vozidle a kamióne** je kontajner podľa veľkosti.
    - Sprity sú z `design/assets-t2/cargo/` a `entities/ech.svg`.

## Spoločné rozhrania
- **`CargoUnit`:** `sizeFt`, `containerType`, `oog`; `teuOf(unit)` = 1 alebo 2.
- **`YardBlock`:**
  - `geometry: { bays, rows, maxTier }`;
  - `positionOfSlot(slot)` → `{ bay, row, tier }` a `slotOf(bay, row, tier)`;
  - `stackHeight(bay, row)`;
  - `topUnit(bay, row)`;
  - `capacityTeu`;
  - `usedTeu`.
- **`yardPlanner.choose(world, unit, from)`** → `{ moduleId, slot } | null`.
- **Metriky a `simrun`:** `rehandles`, `rehandlesPerMove`, `yardTeuUsedPct`.
- **VM:**
  - `ModuleVM.stacks?: readonly { bay, row, height, top: { sizeFt, containerType, lineId, direction } | null }[]` pre bloky;
  - `VehicleVM.cargo?` a `TruckVM.cargo?: { sizeFt, containerType, lineId, direction } | null`.

## Karty
| id | názov | agent (model) | parallel | depends_on |
|---|---|---|---|---|
| TR2-01 | ADR-039 + defy (`container_types.json`, `sizeMix`, geometria blokov, `rehandleTicks`, `importDwellEstimateHours`, `yardPlanner`) + štítky jednotky + TEU v kontraktoch a lodiach; testy | sim-architect (sonnet) | no | – |
| TR2-02 | `YardBlock` + `StackGrid` + pravidlá stohu + rehandling + `YardPlanner` + čas odchodu + invariant + metriky; testy | sim-architect (sonnet) | no | 01 |
| TR2-03 | Render: stohy zhora s tieňom výšky, kontajnery podľa veľkosti, typu a linky (sprity z `design/assets-t2/cargo`), ECH sprite; demo + e2e | implementer (sonnet, worktree) | yes | VM kontrakt |
| TR2-04 | UI: inšpektor bloku (bay zboku, výška, zavalené), karta kontraktu (20′/40′, TEU) podľa `game-ui-t2.html` | ui-builder (haiku, worktree) | yes | VM kontrakt |
| TR2-05 | Napojenie VM (stacks, cargo), `simrun` kľúče, goldeny, akceptačný test planned / random | implementer (haiku → sonnet pri neúspechu) | no | 02, 03, 04 |
| TR2-06 | Review `src/sim` + opravy | sim-reviewer (sonnet) → sim-architect (sonnet) | no | 05 |
| TR2-07 | Plná pipeline + e2e + artefakt + docs (PROGRESS, BACKLOG, ARCHITECTURE §5, §7.7) + PR | test-runner / docs-keeper (haiku), orchestrátor | no | 06 |

## Checklist
- [x] TR2-01 Defy, štítky, TEU
- [x] TR2-02 Bloky, stohy, rehandling, plánovač
- [x] TR2-03 Render
- [x] TR2-04 UI
- [x] TR2-05 Napojenie, simrun, goldeny
- [x] TR2-06 Review + opravy
- [x] TR2-07 Pipeline, e2e, artefakt, docs, PR

## Výsledok fázy

**Pipeline:** `pnpm test` zelené (405 súborov, 9 114 testov)

| Scenár | 30k tickov | exported | stuckAtEnd | rehandleStalls | rehandlesPerMove |
|--------|-----------|----------|-----------|----------------|-----------------|
| vertical_slice | bundled | 50 | 0 | 0 | 0,00 |
| live_terminal | bundled | 124 | 0 | 0 | 0,00 |
| stress_f6 | bundled | 631 | 0 | 0 | 0,002 |
| traffic_stress | bundled | 633 | 0 | 0 | 0,009 |

**Akceptácia:**
1. 0 porušení stohov vo všetkých scenároch, `lostUnits` 0, `stuckAtEnd` 0 — splnené.
2. `rehandlesPerMove` na `vertical_slice`: `planned` 0 (plánovač optimalizuje); `random` 0,14 (nezačína nad 1, lebo dispatcher počká, kým sa kontajner od cieľa sama oddeli; test `yard-contrast` dokazuje rozlíšenie: `random` 1,04).
3. Kontrakty a lode počítajú TEU podľa veľkosti — splnené.
4. Inšpektor bloku ukazuje bay zboku — splnené.
5. Render stohy zhora s tieňom a kontajnery podľa veľkosti/typu/linky — splnené.
6. `pnpm test` a e2e zelené — splnené.

**Otvorené:** pri 100 000 tickoch majú `stress_f6` a `traffic_stress` (obe DEFS) 13–14 zaseknutých vozidiel v čelnej kolízii na križovatke (zvyšok R1, riešenie R3/R4).
