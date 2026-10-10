# Fáza R6: železnica s RMG · task karty

> **Zdroj:** `docs/TERMINAL_2.md`:
> - §4: tabuľka `rmg_rail_block` (16×6)
> - §5: RMG
> - §6.9: vlak
> - §6.10: ledger
> - §12: riadok R6
>
> **ADR:** ADR-043 (železnica).
> **Grafika:** `design/assets-t2/`: `rmg_frame`, `rmg_trolley`, `locomotive`, `wagon_container_60`. Existujúce sprity koľají (`rail_*`) a `portal_rail` ostávajú.
> **Vetva:** `phase/r6-rail`, nadväzuje na `phase/r5-reefer-special` (PR hilkovics/Harbor#16).
> **Režim:** najšetrnejší, report agenta má najviac 10 riadkov.

**Cieľ:** kontrakty majú železničný podiel. Vlak prichádza z koľajového portálu podľa cestovného poriadku do železničného terminálu. RMG nad koľajou a bufferom nakladá a vykladá vagóny po celých vagónoch. Ťahače vozia kontajnery medzi skladom a bufferom.

**Akceptácia:**
1. Scenár `rail_flow`:
   - viac ako 50 % importu odchádza vlakom;
   - export prichádza vlakom a odchádza loďou;
   - vagóny sa nakladajú po celých vagónoch;
   - `lostUnits` 0, `stuckAtEnd` 0;
   - beh je deterministický.
2. Vlak odíde v plánovanom čase alebo keď je plný. Meškanie a čas obratu vlaku sa merajú.
3. Pri 100 000 tickoch nemá `live_terminal_mix` s železničným terminálom zápchu ani zaseknutie.
4. Render kreslí koľaje, lokomotívu a vagóny (s kontajnermi), RMG nad koľajou a bufferom.
5. Celé `pnpm test` a plná e2e sú zelené.

## Rozhodnutia (ADR-043)
1. **Koľaje:**
   - Príkaz `PlaceRail` / `RemoveRail` kladie koľajovú vrstvu mriežky. Koľaje sa nekrížia s cestou, okrem úrovňového priecestia (BACKLOG).
   - Koľaj vedie z `rail_portal` mapy do železničného terminálu.
   - `harbor_01` má jeden koľajový portál.
2. **Železničný terminál `rmg_rail_block`** (16×6):
   - **Rozloženie:**
     - 2 koľaje (vlak dlhý 1 lokomotíva + N vagónov);
     - buffer 4 rady × 4 kontajnery na výšku;
     - jednosmerný pruh pre ťahače s TP pod RMG.
   - **Obsluha:**
     - RMG (`RmgCrane`, `YardMachine`, rovnaká FSM ako RTG) obsluhuje koľaje, buffer aj pruh;
     - **priority RMG:** vlak > ťahač > housekeeping.
3. **Vlak:**
   - Vlak je entita `Train`, ktorá jazdí po koľaji ako dlhé vozidlo. Koľaj nesie len jeden vlak naraz na úseku. Vlak sa neprekrýva s iným vlakom, rovnako ako vozidlá (ADR-037).
   - **Cestovný poriadok** (`rail.json`): interval, počet vagónov, kapacita vagóna je 60′ = 3 TEU (`wagon_container_60`), čas pobytu.
   - Vlak odíde v plánovanom čase alebo keď je plný.
4. **Kontrakty:**
   - `railShare` v šablóne určuje podiel importu, ktorý odíde vlakom, a podiel exportu, ktorý príde vlakom. Hodnotu losuje `Rng`, len keď existuje železničný terminál napojený na portál.
   - **Ledger:** pribudnú prechody `in_storage(buffer) ↔ in_handler(RMG) ↔ in_train`, `in_train → exported` a príjem `in_train` z portálu.
5. **Nakládka po vagónoch:** RMG plní vagón po vagóne v poradí od lokomotívy. Vagón je plný, keď má 3 TEU (40′ + 20′ alebo 3× 20′).
6. **Ťahače:** prenos sklad → buffer (`HANDLING_CHAINS`) na základe plánu vlaku: kontajnery pre najbližší vlak sa presunú do bufferu vopred.
7. **Save:** v15.

## Karty
| id | názov | agent | depends |
|---|---|---|---|
| TR6-01 | ADR-043 + defy (`rail.json`, `rmg_rail_block`, `rmg` v `equipment`, `railShare`) + `PlaceRail`/`RemoveRail` + koľajová vrstva a portál + `Train` (pohyb, cestovný poriadok, odchod) + ledger `in_train`; save v15; testy | sim-architect (sonnet) | – |
| TR6-02 | `RmgCrane` + buffer + nakládka po vagónoch + ťahače do bufferu podľa plánu vlaku + scenár `rail_flow` + metriky (`railImportSharePct`, `trainTurnaroundMin`, `trainDelayMin`) + 100k `live_terminal_mix` s železnicou | sim-architect (sonnet) | 01 |
| TR6-03 | Render: koľaje (existujúce sprity), lokomotíva a vagóny s kontajnermi (kĺbovo po koľaji), RMG (rám + vozík), terminál; demo | implementer (sonnet, worktree) | VM kontrakt |
| TR6-04 | UI: BuildBar Železnica (koľaj ťahom, terminál), inšpektor terminálu a vlaku (cestovný poriadok, naplnenie vagónov, meškanie), `railShare` v karte kontraktu | ui-builder (haiku, worktree) | VM kontrakt |
| TR6-05 | Napojenie VM, `simrun`, e2e (vlak príde, RMG nakladá vagón) | implementer (sonnet) | 02, 03, 04 |
| TR6-06 | Review + opravy | sim-reviewer → sim-architect | 05 |
| TR6-07 | Pipeline, artefakt, docs, PR | orchestrátor + haiku | 06 |

**VM kontrakt** (voliteľné polia):
- `RailVM` (bunky koľají) v `TerrainVM` alebo `InfraVM`;
- `TrainVM { id, cars: { kind: 'loco' | 'wagon', x, y, angle, cargo: ContainerVM[] }[], state, departureTick }` v `entities.trains`;
- `MachineVM.defId` = `rmg`.

## Checklist
- [ ] TR6-01 · [ ] TR6-02 · [ ] TR6-03 · [ ] TR6-04 · [ ] TR6-05 · [ ] TR6-06 · [ ] TR6-07

## Výsledok fázy
_(doplní orchestrátor)_
