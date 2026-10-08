# Fáza R3: ťahače, RTG a TOS · task karty

> **Zdroj:** `docs/TERMINAL_2.md` §5–§6.3 a §7.6 (pruhy pod žeriavom).
> **ADR:** ADR-040, ktorý vznikne v TR3-01.
> **Grafika:** `design/assets-t2/`:
> - `modules/sts_frame`, `sts_trolley`, `sts_spreader_20`, `sts_spreader_40` a `berth_standard` (8×4);
> - `entities/terminal_tractor_cab`, `terminal_tractor_chassis_40`, `rtg_frame` (5×2) a `rtg_trolley`;
> - pivoty sú v `manifest-fragment.json` a `README.md`.
>
> **UI:** `design/ui/game-ui-t2.html` (inšpektor stroja).
> **Vetva:** `phase/r3-tractors-rtg`, nadväzuje na `phase/r2-stacks` (PR hilkovics/Harbor#13).
> **Režim:** najšetrnejší (pravidlá v `phase-r1.md`); report agenta má najviac 10 riadkov.

**Cieľ:** vykládka a nakládka cez STS → terminálový ťahač (TT) pod hákom → jednosmerný pruh RTG bloku → RTG uloží kontajner do stohu, opačne pri nakládke. Systém straddle carrierov ostáva ako alternatíva.

**Akceptácia:**
1. Scenár `tt_rtg.json` (2 STS, 1 RTG blok, 6 TT) vyloží a naloží 120 TEU, `lostUnits` 0, `stuckAtEnd` 0, `rehandleStalls` 0.
2. STS čaká na ťahač < 20 % času cyklu.
3. Pri 100 000 tickoch nevznikne zápcha na kotvisku ani v bloku.
4. Render ukazuje nový STS, kotvisko 8×4 s pruhmi, ťahač s podvozkom a RTG nad blokom.
5. Celé `pnpm test` a plná e2e sú zelené.

## Rozhodnutia (zapíšu sa do ADR-040)
1. **Terminálový ťahač** (`terminal_tractor`, `TerminalTractor extends Vehicle`):
   - `lengthCells` 3, `canLift: false`;
   - vezie 1 kontajner (20′ aj 40′);
   - jazdí len po interných cestách a nábreží.
   - **Straddle carrier** ostáva (`canLift: true`, stohuje v straddle bloku).
2. **RTG blok** (`rtg_block`, def a trieda `RtgBlock extends YardBlock`):
   - footprint 5×N; 6 radov × výška 5 a **jednosmerný pruh** pozdĺž bloku so vjazdom na jednom konci a výjazdom na druhom;
   - TP (odovzdávacie miesta) sú bunky pruhu podľa bay;
   - vozidlá do bloku nevchádzajú inak ako pruhom.
3. **RTG** je stroj viazaný na blok (`equipment.json`, `RtgCrane`, nová entita `YardMachine` v save). Poloha pozdĺž bloku je spojitá (`gantryCellsPerTick`).
   - **FSM** (tabuľka): `idle → travel → (shift)* → lift → trolley → lower → idle`.
   - **Časy:** `hoistTicksPerTier`, `trolleyTicksPerRow`, `lockTicks`.
   - **Ledger:** `in_vehicle → in_handler → in_storage` a opačne; nová lokácia `in_handler { machineId }`.
   - **Rehandling** robí RTG sám (z R2).
4. **Move a nohy (TOS):** úloha je reťaz nôh:
   - **vykládka:** STS → TT (pod hákom v pruhu kotviska) → RTG (TP v pruhu bloku);
   - **nakládka:** RTG → TT → STS.

   Kto príde na TP skôr, čaká. Typ cieľového bloku určuje reťaz cez tabuľku `HANDLING_CHAINS`, nie cez switch.
5. **Kotvisko 8×4:**
   - rady pod žeriavom sú 2 jednosmerné pruhy s TP pod každým žeriavom; pri pevnine je obchádzkový pruh (bez zastavovania);
   - smer pruhov je zľava doprava pri rotácii 0;
   - `harbor_01` starter: kotvisko 8×4, žeriav s novým STS spritom (rám 3×10, výložník nerotuje, vozík jazdí po Y).
6. **Priority RTG:** fronta stroja zoradená podľa `(priorita, čas vzniku, id)`, priority loď > kamión > housekeeping (def). Hráč ich mení v inšpektore bloku (príkaz `SetBlockPriority`).
7. **Prideľovanie ťahačov:** `pool` (najbližší voľný) alebo `gang` (`tractorsPerSts` na žeriav). Prepína sa príkazom `SetCraneGang` (inšpektor žeriavu).
8. **Reach stacker** sa presúva do R5 (OOG plocha).
9. **Save:** v10 bez migrácie, tvar sa mení.

## Karty
| id | názov | agent | depends |
|---|---|---|---|
| TR3-01 | ADR-040 + defy + `TerminalTractor` + `RtgBlock` + `YardMachine`/`RtgCrane` + `in_handler` + reťaz nôh (STS ↔ TT ↔ RTG) + scenár `tt_rtg.json` + testy | sim-architect (sonnet) | – |
| TR3-02 | Kotvisko 8×4 s jednosmernými pruhmi a obchádzkou, starter `harbor_01`, priority RTG, gang/pool (príkazy), metriky (`stsMovesPerHour`, `rtgMovesPerHour`, `stsWaitForTractorPct`), dlhý beh 100 000 tickov | sim-architect (sonnet) | 01 |
| TR3-03 | Render: nový STS (rám, vozík, spreader), kotvisko 8×4, ťahač (kabína + podvozok, kĺbovo), RTG nad blokom (rám + vozík), plocha RTG bloku; demo + e2e | implementer (sonnet, worktree) | VM kontrakt |
| TR3-04 | UI: BuildBar (RTG blok, ťahač, RTG), inšpektor stroja (stav, fronta, presuny/h), priority RTG, gang/pool | ui-builder (haiku, worktree) | VM kontrakt |
| TR3-05 | Napojenie VM, kľúče `simrun`, goldeny | implementer (haiku → sonnet) | 02, 03, 04 |
| TR3-06 | Review + opravy | sim-reviewer → sim-architect (sonnet) | 05 |
| TR3-07 | e2e, artefakt, docs, PR | orchestrátor + haiku | 06 |
| TR3-02b | Čakanie STS na ťahač: vyváženie RTG medzi bloky, oprava prefetchu v pruhu, zápchy pri 100k | sim-architect (sonnet) | 02 |
| TR3-02c | Vyváženie strojov RTG v plánovači, prefetch v poradí pruhu, latencia dispatchu pod hákom | sim-architect (sonnet) | 02b |
| TR3-02d | Dopredné plánovanie jobov pod hákom (`hookJobLookahead`), simrun s override hotovosti | sim-architect (sonnet) | 02c |
| TR3-06b | Review R3 opravy: ohraničené čakanie RTG, `WorldState` v11, výkon | sim-architect (sonnet) | 06 |
| TR3-07a | Úprava 10 e2e špecifikácií na kotvisko 8×4 | implementer (sonnet, worktree) | 06 |

**VM kontrakt** (render a UI, voliteľné polia):
- `MachineVM { id, defId, blockId, x, y, trolley: 0..1, hoist: 0..1, state, cargo: ContainerVM | null }` v `entities.machines`;
- `CraneVM.trolleyY` (0..1) a `CraneVM.cargo`;
- `ModuleVM.lanes?` (bunky pruhov kotviska a bloku so smerom);
- `VehicleVM.defId` `terminal_tractor`.

## Checklist
- [x] TR3-01 · [x] TR3-02 · [x] TR3-03 · [x] TR3-04 · [x] TR3-05 · [x] TR3-06 · [x] TR3-07
- [x] TR3-02b · [x] TR3-02c · [x] TR3-02d · [x] TR3-06b · [x] TR3-07a

## Výsledok fázy
**Pipeline:**
- `pnpm test`: 420 súborov, 9 264 testov zelených (1 timeout pod záťažou opravený na 60 s).
- `pnpm test:e2e`: 60/61 v plnom behu; `f5-app-contracts.spec.ts:28` padol pod záťažou a pri samostatnom behu prešiel. 10 špecifikácií upravených na kotvisko 8×4.

**Akceptácia:**
1. SPLNENÉ — `tt_rtg` 120 TEU, lostUnits 0, stuckAtEnd 0, rehandleStalls 0.
2. NESPLNENÉ — STS čaká na ťahač ≈ 60 % (`tt_rtg_2blocks` 59,8 %; cieľ < 20 %). Úzke miesto je obeh ťahačov (~67 buniek, ~135 tickov/job; 2 STS by chceli ~22 TT). Riešenie geometria/prístup v R4, ADR-040 TR3-02d.
3. SPLNENÉ — 100k `tt_rtg_2blocks`: stuck 0, 0 TrafficJam.
4. SPLNENÉ — render STS, kotvisko 8×4, TT, RTG.
5. SPLNENÉ — `pnpm test` zelené; e2e 60/61 v plnom behu, `f5-app-contracts.spec.ts:28` padol pod súbežnou záťažou a samostatne prešiel.

**Otvorené:** STS wait < 20 % → R4 (geometria / druhý výjazd z bloku); `stress_f6` 100k zvyškové zápchy (R1, 17 stuck) → R4; výber RTG kliknutím; RTG obsluha kamiónov → R4; reach stacker → R5; `WorldState` v11. Položky sú v `docs/BACKLOG.md` „Z Fázy R3“.
