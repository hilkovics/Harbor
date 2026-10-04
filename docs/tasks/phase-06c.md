# Fáza 6c — Prázdne kontajnery a tranship · task karty → míľnik **M2 „živý terminál"**

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 6c", `docs/PORT_OPERATIONS.md` §2.2–2.3, ARCHITECTURE (stav po F6a), ADR-032, ADR-033.
> Vetva: `phase/06c-empties-tranship` (stacked nad `phase/06a-export-booking`, PR hilkovics/Harbor#9). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> Úsporný režim: implementácia na Sonnete, overovanie (test-runner) a odškrtávanie (docs-keeper) na Haiku; plná e2e raz za fázu.

**Cieľ:** všetky štyri toky kontajnerov v jednom prístave — import, export, prázdne, tranship.

**Akceptácia fázy (M2):** scenár `live_terminal.json` s importom, exportom, návratom prázdnych + repositioningom a transhipom (loď A → loď B) beží bez chyby, `lostUnits = 0`, `--roundtrip-at` uprostred toku dá zhodný hash; savy v1–v7 sa načítajú; `pnpm test` a plná e2e zelené.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-034 v T6C-01)
1. **Linky:** `lines.json` (napr. 3 linky, def). Každá voyage a kontrakt má `lineId` (Rng pri vzniku ponuky); jednotky nesú `lineId`. Import/export z F6a dostanú linku tiež (migrácia: deterministicky prvá linka).
2. **Návrat prázdnych:** keď importná jednotka odíde kamiónom (`exported`), naplánuje sa návrat prázdneho kontajnera tej istej linky po `hinterlandDaysRange` (def, Rng; plán v stave). Kamión príde s **novou** jednotkou `direction: 'empty'` (vzniká `in_truck` na portáli, ako export), prejde bránou, vyloží sa na rampe a vozidlo ju odvezie do depa prázdnych. Nie každý import sa vráti: `emptyReturnRate` (def).
3. **Depot prázdnych** `empty_depot`: nová trieda `extends StorageModule` + def (vyššia kapacita na plochu — vyššie stohovanie), prijíma len prázdne. Prázdne smú do bežného dvora len ak depo chýba/je plné (fallback, metrika).
4. **Kontrola a M&R:** pri uložení do depa `damageChance` (def) → jednotka `status: 'damaged'` → oprava `repairHours` + `repairCostCents` (ledger kategória `maintenance_repair`) → `available`. Poškodenú nemožno vydať ani naložiť.
5. **Empty handler:** nové vozidlo `empty_handler` (def + trieda, rýchlejší zdvih, len `direction: 'empty'`), sprite dočasne z `forklift_*`. Dispatcher priraďuje joby prázdnych prednostne empty handlerom, inak bežným vozidlám.
6. **Výdaj prázdneho exportérovi:** pred príchodom naloženého exportu (F6a) príde pre časť booking jednotiek (`emptyPickupRate`, def) najprv prázdny kamión po prázdny kontajner **tej istej linky** (z depa cez rampu) a odíde s ním (`exported`). Ak linka nemá dostupný prázdny, kamión čaká `emptyPickupMaxWaitHours` a potom odíde prázdny (metrika `emptyPickupMisses`).
7. **Repositioning kontrakt** `kind: 'empty_repositioning'`: linka L chce naložiť N dostupných prázdnych na voyage V (vlastná loď alebo pridaný k exportu voyage); prázdne sa nakladajú **po plných** (stowage: plné heavy→light, potom prázdne), odmena za naložený kus, `shipped`. Readiness: depo + dostatok dostupných prázdnych linky v čase prijatia (alebo len depo — rozhodne T6C-01, jednoduchšie vyhrá).
8. **Tranship kontrakt** `kind: 'tranship'`: voyage A (prichádzajúca) nesie N jednotiek `direction: 'tranship'` s cieľovou voyage B tej istej linky, ktorá príde neskôr (`transhipGapDaysRange`, def). Jednotky sa vyložia (pod hák/apron), uložia zoskupene podľa B, naložia sa na B v jej stowage (spolu s exportom) → `shipped`. **Nikdy neprejdú bránou.** Ak B odpláva bez nich: penalizácia, jednotky sa naložia na ďalšiu voyage linky, alebo (ak žiadna nie je naplánovaná do `transhipRescueDays`) odídu kamiónom ako „predané" s penalizáciou — nič sa neteleportuje.
9. **Ledger:** `direction` pribudne `'empty' | 'tranship'`; prechody z F6a postačia (empty: `in_truck → at_ramp → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck → exported` alebo `… → on_ship → shipped`; tranship: import reťazec po sklad + export reťazec zo skladu). Konzervácia: `created = živé + exported + shipped`.
10. **WorldState v8** + migrácia v7 → v8 (linka, status, plány návratov a výdajov).
11. **Render/UI:** prázdne kontajnery inou farbou (token, sivá), poškodené s odznakom; depo prázdnych (sprite odvodený z dvora, iná farba strechy/čiarky — bez nových assetov ak sa dá); empty handler; ContractsPanel karty `empty_repositioning` a `tranship` (A → B, odpočet do príchodu B); inšpektor depa (dostupné / poškodené / v oprave podľa linky); toasty (návrat prázdnych, oprava hotová, tranship zmeškaný).

## Karty
| id | názov | agent (model) | parallel | depends_on |
|---|---|---|---|---|
| T6C-01 | Návrh + defy: ADR-034, „Spoločné rozhrania", `lines.json`, nové defy (empty_depot, empty_handler, ekonomika návratov/opráv/repositioning/tranship), schémy, DefRegistry, kostra typov, WorldState v8 + migrácia | sim-architect (sonnet) | no | – |
| T6C-02 | Sim 1: linky, plán návratov prázdnych, prázdne kamióny, depo + kontrola + M&R, empty handler, výdaj prázdneho exportérovi; scenár `empty_cycle.json` | sim-architect (sonnet) | no | 01 |
| T6C-03 | Sim 2: repositioning a tranship kontrakty (pool, readiness, stowage prázdnych po plných, tranship A → B, záchrana zmeškaného), scenár `live_terminal.json` + golden, simrun metriky | sim-architect (sonnet) | no | 02 |
| T6C-04 | Render: farba prázdnych, odznak poškodených, depo prázdnych, empty handler | implementer (sonnet, worktree) | yes | 01 |
| T6C-05 | UI + app: karty repositioning/tranship, inšpektor depa, toasty, VM | ui-builder (sonnet, worktree) | yes | 01 |
| T6C-06 | Napojenie render/UI na sim + e2e `f6c-live-terminal` | implementer (sonnet) | no | 03, 04, 05 |
| T6C-07 | Review `src/sim/**` + opravy | sim-reviewer (sonnet) → sim-architect (sonnet) | no | 03 |
| T6C-08 | Plná pipeline + e2e (test-runner, haiku), artefakt | test-runner (haiku) | no | 06, 07 |
| T6C-09 | Docs: ARCHITECTURE (sonnet), PROGRESS/BACKLOG/checklist (haiku), PR | implementer / docs-keeper | no | 08 |

Vlny: T6C-01 → {T6C-02 → T6C-03} ‖ {T6C-04 ‖ T6C-05} → T6C-06 ‖ T6C-07 → T6C-08 → T6C-09.

## Checklist
- [ ] T6C-01 · ADR-034, defy, Spoločné rozhrania, WorldState v8
- [ ] T6C-02 · Sim 1: linky, návrat prázdnych, depo, M&R, empty handler, výdaj exportérovi
- [ ] T6C-03 · Sim 2: repositioning, tranship, live_terminal, metriky
- [ ] T6C-04 · Render
- [ ] T6C-05 · UI + app
- [ ] T6C-06 · Napojenie + e2e
- [ ] T6C-07 · Review + opravy
- [ ] T6C-08 · Pipeline + artefakt
- [ ] T6C-09 · Docs + PR

## Spoločné rozhrania
*(doplní T6C-01 — záväzné pre paralelné karty T6C-04 a T6C-05)*
