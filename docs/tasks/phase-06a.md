# Fáza 6a — Export a booking · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 6a", `docs/PORT_OPERATIONS.md` §2.1 a §4, ARCHITECTURE §7.1–7.8, §9.1, §14; ADR-026, ADR-027, ADR-029, ADR-030.
> Vetva: `phase/06a-export-booking` (stacked nad `phase/06-save-load`, PR hilkovics/Harbor#8). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora; úsporný režim (plná e2e raz za fázu).

**Cieľ:** prístav obsluhuje aj export. Hráč prijme booking, exportné kontajnery prichádzajú kamiónmi rozložene pred loďou, brána ich skontroluje, uložia sa do skladu, naložia sa na loď v poradí plánu a loď po lashingu odpláva. Jedna loď môže zároveň vykladať import a nakladať export.

**Akceptácia fázy:**
- scenár `export_roundtrip` (import aj export na jednej lodi): exporty prídu pred cut-off, naložia sa v poradí plánu, loď odpláva až po lashingu a papieroch; `lostUnits = 0`; `/sim-check` zelený;
- vertical slice ďalej funguje (import-only kontrakty sa správajú ako doteraz, golden sa smie zmeniť len so zdôvodnením);
- savy v1–v6 sa načítajú (migrácia na v7); roundtrip uprostred nakládky dáva zhodný `stateHash`.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-032 v T6A-01)
1. **Návštevu lode (voyage) a kontrakty oddeliť.** Pribudne pojem **voyage** (návšteva lode: trieda lode, príchod, `destinationPort`, odchod). Kontrakt má `kind: 'import' | 'export'` a odkaz na voyage. Import kontrakt = dnešné správanie. **Export booking** = počet TEU na danú voyage s `destinationPort` a **cut-off** (`cutoffHours` pred príchodom lode, def). Jedna voyage môže mať import kontrakt aj export booking (šablóna `kind: 'roundtrip'` vygeneruje obe naraz, alebo pool ponúkne export k už prijatej voyage — rozhodne T6A-01, jednoduchšie vyhrá). Rodina tried podľa pravidla 7 (`ImportContract` / `ExportContract` alebo stratégia na `Contract`), žiadne switch-e podľa `kind`.
2. **CargoUnit** dostane `direction: 'import' | 'export'`, `voyageId`, `destinationPort | null`, `weightClass: 'light' | 'medium' | 'heavy'` (Rng pri vzniku, rozdelenie v defe) a `hold: null | { reason: 'vgm', untilTick }`. Import jednotky: `weightClass` sa tiež určí (pre budúci stowage), na import nemá vplyv.
3. **Reverzný reťazec ledgera** (§7.1 rozšíriť riadkami tabuľky): export jednotka **vzniká v kamióne** pri spawne (`CARGO_SPAWN_KINDS` += `in_truck`), potom `in_truck → at_ramp → in_vehicle → in_storage → in_vehicle → on_apron → in_crane → on_ship → shipped`. **`shipped`** je nový konečný stav (ako `exported`), nastane, keď loď s jednotkou opustí mapu (`despawned`). Počítadlo `shippedCount`. `assertCargoConservation` počíta aj `shipped`.
4. **Príchody exportov:** pri prijatí bookingu sa naplánujú príchody kamiónov rovnomerne náhodne (jediný `Rng`) v okne `[arrival − exportArrivalWindowDays, cutoff]` (def). Plán je súčasť stavu (save). Kamión príde naložený jedným TEU, prejde bránou (kontrola = existujúce `processTicks`), stojiskom, zacúva k rampe, **vyloží** (rampa je výmenná zóna), vozidlo odvezie jednotku do skladu.
5. **VGM hold:** pri bráne s pravdepodobnosťou `vgmMissingChance` (def) dostane jednotka `hold vgm` na `vgmHoldHours` (def). Jednotka v hold sa nesmie naložiť na loď. Hold sa uvoľní automaticky po čase (zjednodušenie; žiadna interakcia hráča).
6. **Cut-off a neskoré exporty:** kamión, ktorý prejde bránou po cut-off, je **rolled**: jednotka sa prijme (nič sa neteleportuje), ale naloží sa len ak loď ešte nezačala lashing („last minute", penalizácia `lateExportPenaltyBp`); ak loď už odplávala alebo lashuje, jednotka sa **vráti odosielateľovi** kamiónom cez existujúci outbound tok (`exported`) s penalizáciou `rolledPenaltyBp`. Booking sa splní, ak sa naloží ≥ `bookingFulfilmentPct` (def) TEU; inak čiastočná odmena podľa naložených TEU a penalizácia.
7. **Sklad:** bez poradia v stohu (to je Fáza 14). Dispatcher ukladá exporty **zoskupene**: preferuje sklad, kde už ležia jednotky tej istej voyage, inak najbližší s voľným miestom. Import a export zdieľajú sklady. Metrika `exportGroupingPct` (podiel exportov voyage v jej najväčšom sklade).
8. **Stowage plán (zjednodušený):** pri dokovaní lode sa určí poradie nakládky jej exportov: `heavy → medium → light`, pri zhode podľa id (jeden cieľový prístav na voyage vo F6a; viac prístavov + 40'/20' až F12). Dispatcher posiela jednotky na apron **v poradí plánu**; žeriav nakladá z apronu v poradí plánu (ak ďalšia v poradí ešte nie je na aprone, nakladá sa najbližšia nasledujúca dostupná — neblokovať žeriav; metrika `stowageOrderViolations`).
9. **Apron** zdieľa sloty pre vykládku aj nakládku. Rezervácia: aspoň `apronExportReserve` slotov (def, napr. 2 z 8) pre export počas nakládky, aby import nezablokoval export a naopak.
10. **Žeriav — nakládka a dual cycling:** nový smer cyklu `apron → ship` (rovnaké fázy grabbing/swinging/placing s rovnakými časmi). Ak loď má import na vykládku aj export pripravený na aprone, žeriav robí **dual cycle**: naloží export a cestou späť vezme import; čas dvojcyklu = `dualCycleFactor × (single cycle)` (def, napr. 1,5 namiesto 2). Metrika `dualCycleRate`. Poradie: kým je loď plná importu a nemá voľné miesto, najprv vykladať (kapacita lode `capacityUnits` platí pre import + export na palube).
11. **Lashing a papiere:** po poslednej naloženej jednotke (a vyložení importu) loď prejde do stavu `lashing` (`lashingTicksPerUnit × naložené` + `paperworkTicks`, def v `ships.json`/`economy.json`), drží kotvisko, potom `undocking`. Demurrage beží ďalej podľa ADR-026.
12. **Dual transaction kamiónov:** exportný kamión po vyložení na rampe zostane na docku a **naloží import**, ak je na tom docku import jednotka pripravená na odvoz (SLA poradie ADR-027); inak odíde prázdny. Importné kamióny (bez exportu) jazdia ako doteraz. Metrika `dualTransactionRate` = podiel exportných kamiónov, ktoré odišli s importom.
13. **Ekonomika:** odmena exportu = `exportPricePerUnitCents × naložené TEU × urgency` (rovnaký vzorec ako import, ADR-026), penalizácie v bp (rolled, last-minute, nesplnený booking). XP ako pri importe.
14. **WorldState v7** + migrácia v6 → v7 (jednotky dostanú `direction: 'import'`, `weightClass` deterministicky bez Rng — napr. `medium`, `hold: null`; existujúce kontrakty `kind: 'import'`; voyage sa odvodí z lodí/kontraktov).
15. **UI/Render (mimo sim):** ContractsPanel ukáže export booking (cieľový prístav, cut-off, prišlo/naložené/hold), loď ukáže náklad na palube (import/export) a stav `lashing`; inšpektor skladu rozdelí import/export; kamión prichádzajúci naložený má loaded sprite už pri príchode; žeriav anim. aj pri nakládke (smer opačný).

## Karty
| id | názov | model | agent | parallel | depends_on | est |
|---|---|---|---|---|---|---|
| T6A-01 | Návrh: ADR-032, typy a „Spoločné rozhrania" (voyage, kontrakt kind, CargoUnit polia, ledger prechody, nové stavy lode/kamióna/žeriava, udalosti, snapshot), skeleton + WorldState v7 migrácia | opus | sim-architect | no | – | M |
| T6A-02 | Defy: `contract_templates` (export/roundtrip šablóny), `economy`/`ships`/`logistics` nové polia (cut-off, okno príchodov, VGM, penalizácie, lashing, dualCycleFactor, apronExportReserve, weightClass rozdelenie), schémy, DefRegistry, validate-defs | sonnet | implementer | yes (worktree) | 01 | S |
| T6A-03 | TDD: scenár `export_roundtrip.json` + testy (príchody pred cut-off, VGM hold, rolled, poradie nakládky, dual cycle, lashing, dual transaction, konzervácia so `shipped`, save v6→v7, roundtrip uprostred nakládky) | sonnet | test-writer | yes (worktree) | 01 | M |
| T6A-04 | Sim: ledger reverzný reťazec + `shipped`, booking/voyage v ContractSystem, plán príchodov, spawn naložených kamiónov, brána + VGM + rolled | opus | sim-architect | no | 01, 02 | L |
| T6A-05 | Sim: dispatcher export (rampa → sklad zoskupene, sklad → apron v poradí plánu, rezerva apronu), žeriav nakládka + dual cycling, stav lode `lashing`, dual transaction kamiónov | opus | sim-architect | no | 04 | L |
| T6A-06 | Render: naložený kamión pri príchode, vykladanie na rampe (cúvanie ako pri nakládke), žeriav nakládka (opačný smer), náklad na palube lode podľa počtu (import/export farebne), indikátor lashing | sonnet | implementer | yes (worktree) | 01 | M |
| T6A-07 | UI + app: ContractsPanel export booking (cieľ, cut-off, prišlo/naložené/hold), inšpektor skladu import/export, inšpektor lode (náklad, lashing), toasty (cut-off o 6 h, rolled, loď odplávala s exportom), snapshot v7 | sonnet | ui-builder → implementer | yes (worktree) | 01 | M |
| T6A-08 | Tooling: simrun metriky (shippedUnits, rolledUnits, vgmHolds, dualCycleRate, dualTransactionRate, stowageOrderViolations, exportGroupingPct), golden `export_roundtrip` | sonnet | implementer | yes (worktree) | 01 | S |
| T6A-09 | Review `src/sim/**` + opravy | opus | sim-reviewer → sim-architect | no | 05 | M |
| T6A-10 | e2e `f6a-export` (prijať booking → kamióny s exportom → nakládka → odchod), plná e2e, screenshoty, `/sim-check`, artefakt | sonnet / haiku | implementer / test-runner | no | 03–09 | M |
| T6A-11 | Docs: ARCHITECTURE (§7.1, §7.3, §7.5, §7.8, §9.1, §12, §14), PORT_OPERATIONS §1 stav, PROGRESS, BACKLOG, PR | haiku / sonnet | docs-keeper | no | 10 | S |

Vlny: T6A-01 → {T6A-02 ‖ T6A-03 ‖ T6A-06 ‖ T6A-07 ‖ T6A-08} → T6A-04 → T6A-05 → T6A-09 → T6A-10 → T6A-11.
Worktree karty začínajú `git reset --hard <HEAD phase/06a-export-booking>` (worktree sa zakladá z `main`).

## Checklist
- [ ] T6A-01 · ADR-032, typy, Spoločné rozhrania, WorldState v7
- [ ] T6A-02 · Defy + schémy
- [ ] T6A-03 · TDD export_roundtrip
- [ ] T6A-04 · Sim: ledger, booking/voyage, príchody, brána, VGM, rolled
- [ ] T6A-05 · Sim: dispatcher export, žeriav nakládka + dual cycle, lashing, dual transaction
- [ ] T6A-06 · Render
- [ ] T6A-07 · UI + app
- [ ] T6A-08 · simrun metriky + golden
- [ ] T6A-09 · Review + opravy
- [ ] T6A-10 · e2e + pipeline + artefakt
- [ ] T6A-11 · Docs + PR

## Spoločné rozhrania
*(doplní T6A-01 — záväzné pre paralelné karty T6A-02, 03, 06, 07, 08)*
