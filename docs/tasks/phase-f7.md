# Fáza 7: parcely, OPEX, mesačné zúčtovanie, finančné grafy · task karty

> **Zdroj:** `docs/IMPLEMENTATION_PLAN.md` Fáza 7; ARCHITECTURE §8 bod 2 (parcely) a §9 (ekonomika); GDD.
> **ADR:** ADR-044.
> **Vetva:** `phase/f7-parcels`, nadväzuje na `phase/r6-rail` (PR hilkovics/Harbor#17).
> **Režim:** najšetrnejší. Pred kartou agent zistí, čo už existuje (časť ekonomiky je hotová z F5/F6, napríklad `EconomySystem`, ledger, bankrot, `GameOver`). Dorába len chýbajúce.

**Cieľ:** hráč rozširuje územie kúpou alebo prenájmom parciel, platí prevádzku (údržbu, mzdy, prenájmy, energiu) a vidí financie v grafoch a v mesačnej správe.

**Akceptácia:**
1. Kúpa parcely odomkne stavanie v jej rámci. Na cudzej parcele sa stavať nedá. Prenájom s modulmi sa nedá uvoľniť.
2. Prenájom účtuje `price × leaseRate / 30` za deň. Údržba za deň sa rovná súčtu podľa defov.
3. `MonthClosed` vytvorí `MonthSummary` a udalosť `MonthlyReport`. Pri bankrote hra končí po `bankruptcyDays` (30) dňoch v mínuse.
4. `FinancePanel` ukazuje:
   - stĺpce príjmov a výdajov po kategóriách s prepínačom deň/mesiac;
   - čiaru hotovosti;
   - tabuľku kategórií.

   Všetky dáta sú reálne z ledgera. Mesačná správa sa zobrazí ako modal.
5. Render kreslí parcely na predaj, vlastnené a prenajaté. Klik na parcelu otvorí `ParcelPanel` s cenou kúpy a mesačným prenájmom.
6. Celé `pnpm test` a plná e2e sú zelené.

## Rozhodnutia (ADR-044)
1. **Parcely:** `Parcel` má stav `for_sale`, `owned` alebo `leased`. Príkazy sú `BuyParcel`, `LeaseParcel` a `ReleaseParcel`, všetky s krokmi `validate` a `apply`. Kontrolu parcely volajú všetky príkazy, ktoré stavajú (moduly, cesty, koľaje).
2. **Mapa:**
   - `harbor_01` má okrem štartovej parcely aj parcely na predaj s cenou v defe mapy;
   - `rail_yard` ostáva vlastnená;
   - rozhodne agent podľa existujúcej mapy a zdôvodní to v ADR.
3. **Denné zúčtovanie (`DayClosed`):** údržba modulov, mzdy (vozidlá, žeriavy, stroje RTG/RMG/RS, pruhy brány), prenájmy parciel. Energia sa už účtuje od R5.
4. **Mesačné zúčtovanie (`MonthClosed`):** `MonthSummary` podľa kategórií ledgera sa ukladá do kruhového buffera (24 mesiacov, v save), zároveň vzniká udalosť `MonthlyReport`.
5. **Save:** verzia v16.

## Karty
| id | názov | agent | depends |
|---|---|---|---|
| TF7-01 | ADR-044 + defy (ceny parciel, `leaseRate`, mzdy a údržba) + parcely, príkazy, kontrola na stavebných príkazoch + `DayClosed`, `MonthClosed`, `MonthSummary` + bankrot (overiť existujúci) + save v16; testy | sim-architect (sonnet) | – |
| TF7-02 | Render: `ParcelLayer` (na predaj, vlastnené, prenajaté, hover); demo | implementer (sonnet, worktree) | VM kontrakt |
| TF7-03 | UI: `ParcelPanel`, `FinancePanel` s grafmi (vlastné SVG, `StackedBars`, `LineChart`, tabuľka), modal `MonthlyReport` podľa `design/ui/game-ui-t2.html` | ui-builder (haiku, worktree) | VM kontrakt |
| TF7-04 | Napojenie VM a UI (klik na parcelu, príkazy, `FinanceVM` z ledgera), `simrun` (`opexPerDay`, `leaseCostPerDay`), e2e | implementer (sonnet) | 01, 02, 03 |
| TF7-05 | Review + opravy | sim-reviewer → sim-architect | 04 |
| TF7-06 | Pipeline, artefakt, docs, PR | orchestrátor + haiku | 05 |

**VM kontrakt** (voliteľné):
- `ParcelVM { id, rect: {x, y, w, h}, state: 'for_sale' | 'owned' | 'leased', priceCents, leasePerMonthCents }`;
- `FinanceVM.daily[]` a `FinanceVM.monthly[]` s položkami `{ label, incomeByCat, expenseByCat, cashEnd }`;
- `FinanceVM.categories`.

## Checklist
- [ ] TF7-01 · [ ] TF7-02 · [ ] TF7-03 · [ ] TF7-04 · [ ] TF7-05 · [ ] TF7-06

## Výsledok fázy
_(doplní orchestrátor)_
