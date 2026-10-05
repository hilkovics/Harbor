# Fáza 5 — Kontrakty, ledger, HUD → VERTICAL SLICE (M1) · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 5" (+ riadok Model mix), ARCHITECTURE §4.6, §6 (krok 2), §9.1, §9.2, §12, §13, §14; ADR-013, ADR-015, ADR-016, ADR-023, ADR-024.
> Vetva: `phase/05-contracts-vertical-slice` (stacked nad `phase/04-export-trucks`, PR hilkovics/Harbor#5). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> UI prototyp: `design/ui/game-ui.source.html` (`contracts`, `contracts_empty`, TopHUD).

**Cieľ:** hráč prijme kontrakt, splní ho a dostane peniaze aj XP. Penalizácie fungujú a základná herná slučka je uzavretá.

**Akceptácia fázy (M1):**
- Novú hru sa dá odohrať od prijatia kontraktu po výplatu bez debug príkazov.
- `/sim-check` je zelený a `lostUnits = 0`.
- **Testy:**
  - vzorec odmeny a urgency;
  - demurrage po `berthAllowanceTicks`;
  - late penalty po SLA;
  - fail po 3 dňoch → odmena prepadne;
  - completion → `cash += reward − penalties` a XP;
  - pool má ≤ `offersPerDay` ponúk a ponuky expirujú;
  - **golden report** `vertical_slice.json` (cash na konci, exported units, on-time) uložený do `tests/sim/__golden__/`.

**Rozhodnutia orchestrátora (zapíšu sa do ADR-025..027 v kartách sim-architecta):**
1. **Peniaze** sú celočíselné v centoch. Sadzby sa počítajú v bázických bodoch rovnako ako `refundCents` (ADR-015): demurrage 50 bp/h a late 500 bp/deň z `reward`. Zaokrúhľuje sa nadol.
2. **Ekonomika a ledger (§9.2):**
   - Každá zmena hotovosti ide cez `Economy.post(amountCents, category, refId?)`. Ten zapíše `LedgerEntry` a emituje `MoneyChanged`.
   - Existujúce priame zmeny `cashCents` prejdú na `Economy` bez zmeny súm (CAPEX modulov, ciest a vozidiel, predaje, refundácie).
   - Pri `DayClosed`:
     - `maintenance` = Σ `maintenancePerDayCents` všetkých postavených modulov vrátane starter modulov;
     - `wages` = Σ `wagePerDayCents` vozidiel a žeriavov (žeriav dostane nový parameter `params.wagePerDayCents`);
     - vznikne `DaySummary`.
   - Pri `MonthClosed` vznikne `MonthSummary` a `MonthlyReport`.
   - Lease pozemkov príde až vo F7.
   - **Dôsledok:** zmenia sa `cashEnd` v reportoch F1–F4 (napr. `f1_roads` 108 300 000). Nové očakávané hodnoty sa zapíšu v T05-02 s odôvodnením a ostatné karty ich prevezmú.
3. **Bankrot:** `cash < 0` počas `bankruptcyDays` dní za sebou (počítané pri `DayClosed`) → udalosť `GameOver` a sim sa ďalej netickuje (flag).
4. **Contract FSM (§9.1):**
   - Hlavná vetva: `offered →(AcceptContract) accepted →(spawn lode) ship_en_route →(loď zakotví) unloading →(unitsUnloaded == volumeUnits, loď odpláva) exporting →(unitsExported == volumeUnits) completed`.
   - Odbočky: `failed` pri `daysLate > failAfterDaysLate`, `offered → expired` pri `offerExpiresTick`. `DeclineContract` = `offered → expired` s dôvodom `declined`, bez nového stavu.
   - Prechody sú v explicitnej tabuľke.
5. **Loď kontraktu:**
   - Pri prijatí sa nastaví `shipArrivalTick = now + rng.range(arrivalDaysRange)` (dni z defu) a `slaDeadlineTick = shipArrivalTick + slaDays`.
   - V ticku príchodu sa spawne loď triedy `shipClassId` s `volumeUnits` jednotkami `contractId`. Spawn ide cez existujúci kód spawnu lode, bez duplikácie `SpawnShipDebug`.
   - Platí `volumeUnits ≤ ship.capacityUnits` a `≤ apronSlots…` iba ak to vyžaduje existujúca validácia.
6. **Penalizácie:**
   - Demurrage sa ráta za každú celú hodinu státia lode pri kotvisku nad `berthAllowanceTicks` (def lode), late za každý celý deň po `slaDeadlineTick`.
   - Priebežne sa akumulujú v `contract.penaltiesCents` a emitujú `PenaltyApplied{contractId, kind, amountCents}`.
   - Z hotovosti sa strhnú jednou transakciou (`penalty`) až pri `completed` alebo `failed`. Pri completion sa súčasne pripíše `contract_revenue` = reward.
7. **XP:** `xpReward = volumeUnits × cargo.xpPerUnit × xpMultiplier` (def). Pri completion platí `xp += round(xpReward × (onTime ? 1 : lateXpFactor))`, kde `lateXpFactor = 0.5` (def). `tier = floor(completed / contractsPerTier)` (10, def).
8. **Pool:**
   - Pri štarte hry (tick 0) a pri každom `DayClosed` sa pool doplní do `offersPerDay`.
   - Šablóny sa vyberajú váhovo s filtrom `minTier` cez jediný `Rng`.
   - Objem = `clamp(round(U(volumeScaleRange) × capacityHint), volumeUnitsRange)` a zároveň `≤` kapacita lode šablóny.
   - `capacityHint = max(minCapacityHint, min(berthCapacityPerDay, storageCapacity))`:
     - `berthCapacityPerDay` = Σ žeriavov `ticksPerDay / cycleTicks`;
     - `storageCapacity` = Σ `capacityUnits` skladov;
     - `minCapacityHint` je v defe, aby prvá ponuka na prázdnom prístave nemala objem 0.
   - Odmena = `volumeUnits × basePricePerUnitCents × urgency`, kde `urgency = 1 + urgencyFactor × (1 − slaDays / maxSlaDays)` (bp aritmetika, `maxSlaDays` = max `slaDaysRange` šablón).
9. **Dispatcher krok 2 (§7.3):** outbound joby vznikajú len pre jednotky kontraktu v stave `exporting`. Poradie je podľa `slaDeadlineTick` vzostupne, potom id kontraktu, potom FIFO. Jednotky bez kontraktu (`contractId === null`, scenáre F2–F4 a `SpawnShipDebug`) sú exportovateľné vždy kvôli spätnej kompatibilite. **Zmena (T05-11, ADR-027 dodatok):** outbound smú aj jednotky kontraktu v stave `unloading` (`outbound = 'sla'`), aby objem nad voľnú kapacitu skladov nezablokoval sklad, apron a kotvisko; `completed` stále vyžaduje `unitsExported == volumeUnits` a `exporting` ostáva stavom po odchode lode.
10. **Debug spawn:** UI tlačidlo „Spawn feeder (DEV)" sa odstráni. Príkaz `SpawnShipDebug` ostáva pre scenáre a testy a UI ho nepoužíva. `vertical_slice` ide bez neho.
11. **WorldState v5** obsahuje `contracts`, pool, `economy` (DaySummary/MonthSummary, posledných N `LedgerEntry` podľa defu), `xp`, `completedContracts`, bankrotové počítadlo a `gameOver`. Pribudne migrácia v4 → v5 (prázdne kontrakty a pool, prázdny ledger so zachovaným `cashCents`).
12. **Čo sa neukladá:** priority dispatchera sa odvodzujú, neukladajú.

## Checklist
- [x] T05-01 · Defy: `contract_templates.json` (3 šablóny), `economy.json` rozšírenie, `params.wagePerDayCents` žeriavu, schémy, DefRegistry
- [x] T05-02 · Sim: `Economy` + `Ledger` (post, DaySummary/MonthSummary, maintenance, wages, bankrot) — prevedenie všetkých zmien hotovosti; ADR-025
- [x] T05-03 · Sim: `Contract` FSM + `ContractSystem` (pool, Accept/Decline, loď kontraktu, SLA, demurrage, late, fail, completion, XP); ADR-026
- [x] T05-04 · Sim: dispatcher krok 2 podľa kontraktu + SLA priorita; WorldState v5 + migrácia; `GameOver`; ADR-027
- [x] T05-05 · Testy (TDD): vzorce, penalizácie, pool, scenár `vertical_slice` + golden report
- [x] T05-06 · UI: `ContractsPanel`, TopHUD (delta/deň, XP), `GameOverModal`, tóny toastov (predstih, worktree)
- [x] T05-07 · App: snapshot v5, Accept/Decline, HUD, toasty kontraktov, GameOver, odstránenie DEV spawn tlačidla
- [x] T05-08 · Tooling: `simrun` metriky kontraktov a ekonomiky, golden report
- [x] T05-09 · E2E: nová hra → prijatie kontraktu → výplata, screenshoty
- [x] T05-10 · Review `src/sim/**`
- [x] T05-11 · Opravy z review + ARCHITECTURE zosúladenie
- [x] T05-12 · `/sim-check` s `vertical_slice` (M1) + plná pipeline
- [x] T05-13 · Uzavretie fázy (PROGRESS, BACKLOG) + PR

**Úsporný režim (rozhodnutie používateľa):** plná e2e sada beží raz za fázu (T05-12); ostatné karty spúšťajú len dotknuté špecifikácie.

Vlny: 01 → 02 → 03 → 04 (sim sériovo) ‖ {05 (TDD, worktree od 01), 06 (UI, beží od konca F4)} → {07 ‖ 08} → 09 → 10 → 11 → 12 → 13.
Single writer `src/sim/**`: T05-01 (defs), potom T05-02..T05-04 sériovo, T05-11.

## Spoločné rozhrania (záväzné pre paralelné karty)

```ts
// src/sim/defs
interface ContractTemplateDef { id; cargoTypeId; volumeUnitsRange: [number, number]; slaDaysRange: [number, number];
  shipClassIds: string[]; weight: number; minTier: number }
interface EconomyDef { …existujúce…, urgencyFactor: number /*0.6*/, arrivalDaysRange: [number, number] /*[0.5, 2]*/,
  volumeScaleRange: [number, number] /*[0.4, 1.2]*/, minCapacityHint: number, contractsPerTier: number /*10*/,
  xpMultiplier: number /*1*/, lateXpFactor: number /*0.5*/, ledgerEntriesKept: number }

// src/sim/economy
interface LedgerEntry { tick: number; amountCents: number; category: LedgerCategory; refId?: string }
interface DaySummary { day: number; incomeCents: Partial<Record<LedgerCategory, number>>; expenseCents: Partial<Record<LedgerCategory, number>>; cashEndCents: number }
class Economy { readonly cashCents: number; post(amountCents: number, category: LedgerCategory, refId?: string): void;
  readonly entries: readonly LedgerEntry[]; readonly daily: readonly DaySummary[]; readonly monthly: readonly MonthSummary[];
  todayDeltaCents(): number; readonly daysNegative: number }

// src/sim/contracts
type ContractState = 'offered' | 'accepted' | 'ship_en_route' | 'unloading' | 'exporting' | 'completed' | 'failed' | 'expired';
class Contract { id; templateId; cargoTypeId; volumeUnits; rewardCents; xpReward; offeredTick; offerExpiresTick;
  acceptedTick?; shipClassId; shipId?; shipArrivalTick?; slaDeadlineTick?; unitsUnloaded; unitsExported; penaltiesCents; state }
// World: contracts: ReadonlyMap<EntityId, Contract>; economy: Economy; xp: number; completedContracts: number; tier: number; gameOver: boolean
// Commands: AcceptContract { contractId }, DeclineContract { contractId }
```
Nové `ValidationReason`: `unknown_contract`, `contract_not_offered`, `game_over` (a iné podľa potreby, text v `REASON_TEXT`).
Nové `SimEvent`:
- `ContractOffered { contractId }`
- `ContractAccepted { contractId }`
- `ContractStateChanged { contractId, from, to }`
- `ContractCompleted { contractId, rewardCents, penaltiesCents, xp, onTime }`
- `ContractFailed { contractId, penaltiesCents }`
- `ContractExpired { contractId, reason: 'timeout' | 'declined' }`
- `PenaltyApplied { contractId, kind: 'demurrage' | 'late', amountCents }`
- `DayClosedSummary { day, summary }` (alebo rozšírený `DayClosed`)
- `MonthlyReport { month, summary }`
- `GameOver { reason: 'bankruptcy', day }`

---

### T05-01 · Defy: `contract_templates.json`, `economy.json`, mzda žeriavu, schémy, DefRegistry
- model: sonnet
- agent: implementer
- parallel: no (mení `src/sim/defs`, platí single writer)
- depends_on: –
- inputs: ARCHITECTURE §4.6, §9.1, §9.2; „Rozhodnutia orchestrátora" 1, 2, 7, 8; „Spoločné rozhrania"; `src/sim/defs/**`, `tools/validate-defs.ts`, `data/defs/{economy,ships,cargo_types,modules}.json`
- outputs: `data/defs/contract_templates.json` (+ schéma); `data/defs/economy.json` (+ schéma); `data/defs/modules.json` (`crane_container_gantry.params.wagePerDayCents`) + schéma; `src/sim/defs/**`; `tools/validate-defs.ts`; testy
- požiadavky:
  - **3 šablóny container** (napr. `container_feeder_express`, `container_feeder_standard`, `container_handy_bulk_run`) s `volumeUnitsRange` v rozsahu kapacity lodí (`feeder` 120, `handy` 300), `slaDaysRange` (napr. [2,3], [3,5], [5,8]), `shipClassIds`, `weight` a `minTier` (0, 0, 1).
  - **`economy.json`:** nové polia podľa „Spoločných rozhraní" s hodnotami z komentárov. `minCapacityHint` = 24, `ledgerEntriesKept` = 2 000. Hodnoty musia byť rozumné a zdôvodnené vo výsledku.
  - **Žeriav:** `wagePerDayCents` = 25 000.
  - **Katalóg a gettery:** katalóg `defs.contractTemplates`, gettery. Krížová kontrola: `cargoTypeId` a `shipClassIds` existujú a `volumeUnitsRange[1] ≤` min. kapacity lodí šablóny.
- acceptance:
  - `pnpm validate:defs`
  - `pnpm vitest run tests/sim/defs tests/tools`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/{core,grid,cargo,modules,ships,vehicles,trucks,movement,logistics,systems,world,commands,events,economy,contracts}/**, src/render/**, src/ui/**, src/app/**
- estimate: S

### T05-02 · Sim: `Economy` + `Ledger`, maintenance, wages, bankrot; ADR-025
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T05-01
- inputs: ARCHITECTURE §6, §9.2, §12, §14; „Rozhodnutia orchestrátora" 1, 2, 3, 11; `src/sim/economy/**`, `src/sim/world/**`, `src/sim/commands/**`
- outputs: `src/sim/economy/**` (`economy.ts`, `ledger.ts`, súhrny); `src/sim/systems/economy-system.ts` (DayClosed/MonthClosed, krok podľa §6); úpravy commands a world; `docs/DECISIONS.md` (ADR-025); testy
- požiadavky:
  - `Economy.post` ako jediná cesta zmeny hotovosti. Všetky existujúce miesta (grep `cashCents`) prevedie, `MoneyChanged` sa emituje ako doteraz.
  - `DayClosed`: maintenance, wages, `DaySummary`, bankrotové počítadlo. `MonthClosed`: `MonthSummary`, `MonthlyReport`. Bankrot = `GameOver` a flag.
  - Save: ekonomika v stave sveta (v5 finalizuje T05-04, tu stačí pripraviť serializáciu).
  - Nové očakávané `cashEnd` pre `f1_roads`, `f2_unload`, `apron_to_yard` a `full_import_chain` vypočítaj a zapíš do testov a do ADR-025, vrátane vysvetlenia rozdielu (údržba starter modulov a mzdy).
- acceptance:
  - `pnpm vitest run tests/sim`
  - `pnpm -s simrun data/scenarios/full_import_chain.json --ticks 40000 --report | jq -e '.lostUnits == 0 and .exportedUnits == 120'`
  - `grep -c '^## ADR-025:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, data/defs/** (okrem `REASON_TEXT` v src/app/build-feedback.tsx pri novom dôvode)
- estimate: M

### T05-03 · Sim: `Contract` FSM + `ContractSystem`; ADR-026
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T05-02
- inputs: ARCHITECTURE §6 (krok 2), §9.1; „Rozhodnutia orchestrátora" 4–8; `src/sim/ships/**`, `src/sim/systems/ship-system.ts`, `src/sim/commands/spawn-ship-debug.ts`; TDD testy T05-05
- outputs: `src/sim/contracts/**`; `src/sim/systems/contract-system.ts` (krok 2 v `World.tick()` podľa §6); `src/sim/commands/{accept-contract,decline-contract}.ts`; `docs/DECISIONS.md` (ADR-026); testy
- požiadavky:
  - FSM s explicitnou tabuľkou prechodov. Pool (rozhodnutie 8), odmena a urgency v bp aritmetike, prijatie/odmietnutie, spawn lode s nákladom kontraktu (spoločný kód so `SpawnShipDebug`).
  - `unitsUnloaded` (žeriav, pri `on_ship → in_crane` alebo pri vyložení na apron, zdôvodni) a `unitsExported` (`in_truck → exported`) aktualizuj cez udalosti ledgera alebo hooky, bez O(n) skenov každý tick.
  - Demurrage a late penalty, fail, completion (rozhodnutia 6 a 7), XP a tier.
  - Determinizmus: jediný `Rng`, poradie podľa id.
- acceptance:
  - `pnpm vitest run tests/sim`
  - `grep -c '^## ADR-026:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/** (okrem `REASON_TEXT`), data/defs/**
- estimate: L

### T05-04 · Sim: dispatcher krok 2 podľa kontraktu, WorldState v5, GameOver; ADR-027
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T05-03
- inputs: ARCHITECTURE §7.3, §14; „Rozhodnutia orchestrátora" 9–12; ADR-023; TDD testy T05-05 (vetva z worktree)
- outputs: `src/sim/logistics/**`; `src/sim/world/**` (v5 + migrácia v4→v5); `docs/DECISIONS.md` (ADR-027); zlúčené TDD testy T05-05; `data/scenarios/vertical_slice.json` (od T05-05); `tests/sim/__golden__/vertical_slice.json`
- požiadavky:
  - Outbound len pre `exporting` kontrakty (+ jednotky bez kontraktu), SLA priorita (rozhodnutie 9), bez nových O(n × m) skenov.
  - WorldState v5 + migrácia + roundtrip uprostred kontraktu (pred príchodom lode, pri vykládke, pri exporte).
  - `GameOver`: sim sa netickuje, príkazy vracajú `game_over`.
  - TDD testy T05-05: prenes ich cez `git checkout <vetva> -- <súbory>` a zazeleň bez zmäkčenia akceptácie. Golden report vygeneruj a ulož.
- acceptance:
  - `pnpm vitest run tests/sim`
  - `pnpm -s simrun data/scenarios/vertical_slice.json --ticks 60000 --report | jq -e '.lostUnits == 0 and .contractsCompleted >= 1'`
  - `grep -c '^## ADR-027:' docs/DECISIONS.md` = 1
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/** (okrem `REASON_TEXT`), data/defs/**, data/maps/**
- estimate: M

### T05-05 · Testy (TDD): vzorce, penalizácie, pool, `vertical_slice` + golden
- model: sonnet
- agent: test-writer
- parallel: yes (worktree od T05-01, zlúči sa v T05-04)
- depends_on: T05-01
- inputs: „Akceptácia fázy", „Rozhodnutia orchestrátora", „Spoločné rozhrania"; `tests/sim/helpers/{f4,f4-layout}.ts`, `data/scenarios/full_import_chain.json`
- outputs: `data/scenarios/vertical_slice.json`; `tests/sim/contracts/*.test.ts`; `tests/sim/economy/*.test.ts`; `tests/sim/scenarios/f5-vertical-slice.test.ts`; `tests/sim/helpers/f5.ts`
- požiadavky:
  - **Tabuľkové testy vzorcov:** odmena, urgency, demurrage po `berthAllowanceTicks` (celé hodiny), late po SLA (celé dni), fail po `failAfterDaysLate`, completion (`cash += reward − penalties`, XP on-time a late), pool (≤ `offersPerDay`, expirácia, `minTier`), maintenance a wages pri `DayClosed`, bankrot po 30 dňoch.
  - **Scenár `vertical_slice.json`:** stavba ako `full_import_chain` (cesty, dvory, depo + 2 vozidlá, brána, stojisko, rampa), `AcceptContract` prvej ponuky (id ponuky zisti deterministicky, napr. príkaz s `contractId` prvej ponuky pri seede) a beh 60 000 tickov. Kontrakt je `completed`, `lostUnits 0`, on-time.
  - **Golden report** (`cashEnd`, `exportedUnits`, `onTimeRate`, `contractsCompleted`, `xp`) v `tests/sim/__golden__/vertical_slice.json`. Súbor vygeneruje T05-04, test ho porovná.
  - Invarianty a konzervácia v každom ticku, determinizmus, roundtrip uprostred kontraktu.
  - Testy teraz padajú zo správneho dôvodu. Uveď hlášky.
- acceptance: `pnpm typecheck && pnpm lint`; nové testy padajú len za behu na chýbajúcom API
- do_not_touch: src/**, tools/**, data/defs/**, data/maps/**
- estimate: M

### T05-06 · UI: `ContractsPanel`, TopHUD, `GameOverModal` (predstih)
- model: sonnet
- agent: ui-builder
- parallel: yes (worktree, spustená na konci F4)
- depends_on: –
- outputs: `src/ui/**`; demo `f5-ui-demo` + screenshot; `tests/ui/**`
- acceptance: `pnpm vitest run tests/ui`; `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; `CI=1 pnpm test:e2e`
- do_not_touch: src/sim/**, src/render/**, src/app/**, data/**
- estimate: M

### T05-07 · App: snapshot v5, Accept/Decline, HUD, toasty, GameOver, bez DEV spawn
- model: sonnet
- agent: implementer
- parallel: yes (s T05-08)
- depends_on: T05-04, T05-06
- outputs: `src/app/**`; `tests/app/**`
- požiadavky:
  - Snapshot: kontrakty (karty podľa typov z T05-06), cash, delta za deň, XP, tier, gameOver.
  - `ContractsPanel` otváraný z TopHUD (ikona kontraktov) alebo trvalo podľa prototypu. Accept/Decline cez `dispatch` s živou validáciou (`disabledReason`).
  - Toasty: nová ponuka (zlúčené), prijatie, výplata (success), penalizácia (warning, dedup), fail (danger), `MonthlyReport` (info).
  - `GameOverModal` a „Nová hra" (reštart bootstrapu).
  - Odstrániť DEV tlačidlo „Spawn feeder (DEV)" a jeho konfiguráciu. Prispôsobiť dotknuté e2e testy F2–F4: použiť `dispatchJSON` so `SpawnShipDebug` alebo prijatie kontraktu.
  - `REVISION_EVENTS` rozšíriť o nové udalosti.
- acceptance: `pnpm vitest run tests/app`; `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; len dotknuté e2e špecifikácie (`CI=1 pnpm exec playwright test tests/e2e/<spec>`), plná sada až v T05-12
- do_not_touch: src/sim/**, data/**
- estimate: M

### T05-08 · Tooling: `simrun` metriky kontraktov a ekonomiky
- model: sonnet
- agent: implementer
- parallel: yes (s T05-07)
- depends_on: T05-04
- outputs: `tools/simrun.ts`; `tests/tools/**`
- požiadavky:
  - Nové kľúče: `contractsOffered`, `contractsAccepted`, `contractsCompleted`, `contractsFailed`, `contractsExpired`, `onTimeRate` (existujúci kľúč naplniť: completed on-time / completed, inak `null`), `penaltiesCents`, `revenueCents`, `xp`, `tier`, `maintenanceCents`, `wagesCents`, `gameOver`.
  - Report `vertical_slice` sa zhoduje s golden súborom.
- acceptance: `pnpm -s simrun data/scenarios/vertical_slice.json --ticks 60000 --report | jq -e '.lostUnits == 0 and .contractsCompleted >= 1 and .onTimeRate != null'`; `pnpm vitest run tests/tools && pnpm typecheck && pnpm lint`
- do_not_touch: src/**, data/defs/**, data/maps/**
- estimate: S

### T05-09 · E2E: nová hra → kontrakt → výplata
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T05-07, T05-08
- outputs: `tests/e2e/f5-vertical-slice.spec.ts`; screenshoty `f5-contracts.png`, `f5-payout.png`
- požiadavky:
  - Rozloženie F4 postav cez `dispatchJSON` alebo UI. Kontrakt prijmi **cez UI** (ContractsPanel, tlačidlo „Prijať").
  - Bez `SpawnShipDebug`. Zrýchlená hra, čakanie cez `window.__sim` až po `ContractCompleted`.
  - HUD hotovosť = svet, XP > 0, toast výplaty.
  - Screenshoty si prezri (Read) a popíš ich.
- acceptance: `CI=1 pnpm exec playwright test tests/e2e/f5-vertical-slice.spec.ts`; `test -s tests/e2e/__screenshots__/f5-contracts.png -a -s tests/e2e/__screenshots__/f5-payout.png`
- do_not_touch: src/sim/**, data/**
- estimate: M

### T05-10 · Review `src/sim/**`
- model: opus
- agent: sim-reviewer
- depends_on: T05-04, T05-05, T05-08
- inputs: `git diff phase/04-export-trucks..HEAD -- src/sim tests/sim data tools`
- acceptance: verdikt MERGE (0 blocking)
- estimate: S

### T05-11 · Opravy z review + ARCHITECTURE zosúladenie
- model: opus
- agent: sim-architect
- depends_on: T05-10
- outputs: `src/sim/**` (opravy s testami); `docs/ARCHITECTURE.md` (§4.6, §5, §6, §7.3, §9, §12, §13, §14, §18 do ADR-027)
- acceptance: `grep -n 'ADR-027' docs/ARCHITECTURE.md`; `pnpm typecheck && pnpm lint && pnpm test`
- estimate: M

### T05-12 · `/sim-check` s `vertical_slice` (M1) + plná pipeline
- model: haiku
- agent: test-runner
- depends_on: T05-01..T05-11
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs && pnpm build`
  - `pnpm -s simrun data/scenarios/vertical_slice.json --ticks 60000 --report` (cash, exported, lostUnits = 0, onTimeRate; zhoda s golden)
  - `full_import_chain`, `apron_to_yard`, `f2_unload`, `f1_roads` s novými očakávanými hodnotami z ADR-025
  - `CI=1 pnpm test:e2e` + screenshoty `f5-*`
- estimate: S

### T05-13 · Uzavretie fázy (PROGRESS, BACKLOG) + PR
- model: haiku
- agent: docs-keeper
- depends_on: T05-12
- outputs: `docs/tasks/phase-05.md` (checklist); `docs/PROGRESS.md` (M1); `docs/BACKLOG.md`
- acceptance: `! grep -n '^- \[ \] T05-' docs/tasks/phase-05.md`
- estimate: S
