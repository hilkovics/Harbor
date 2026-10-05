# Fáza 6d — Oprava z playtestu 2 · task karty

> Zdroj: spätná väzba používateľa z hrania verzie po F6c (artefakt), ADR-029, ADR-033, ADR-034.
> Vetva: `phase/06d-playtest-2` (stacked nad `phase/06c-empties-tranship`). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora.
> Úsporný režim: implementácia na Sonnete, overovanie (test-runner) a odškrtávanie (docs-keeper) na Haiku; plná e2e raz za fázu.

**Pripomienky používateľa:**
1. „Chýba miesto alebo nefunguje systém, kde prichádzajúce kamióny uložia kontajnery. Teraz zaplnili všetky státia a nemôžu prísť žiadne ďalšie kamióny vykladať lode."
2. „Žeriavy stále nevykladajú kontajnery priamo na ťahače alebo vozíky."
3. „Priplávajúce lode najskôr preplávajú okolo prístavu a potom sa vzdialia a niekde stoja — nech rovno zostanú kotviť, v realistickom postavení voči brehu."

**Akceptácia fázy:** (1) scenár `landside_pressure` (zámka príjmu a výdaja pred opravou) dokončí všetky kontrakty, žiadny kamión nečaká v stojisku na niečo, čo prístav nevie zaručiť; (2) `directHandoverPct` v režime `under_hook` ≥ 90 % vo `vertical_slice`, `live_terminal`, `empty_cycle`, `export_roundtrip`, vozidlo stojí fyzicky pod žeriavom; (3) loď bez voľného kotviska pláva zo vstupu priamo na rejdu a kotví s jednotným kurzom; savy v1–v8 sa načítajú (v8 so starou rejdou sa normalizuje); `lostUnits = 0`, `pnpm test` a plná e2e zelené.

## Rozhodnutia orchestrátora
1. **Tri nezávislé karty v sime naraz, každá vo vlastnom worktree**, zlúčenie postupne s kontrolou konfliktov — výnimka zo single-writer pravidla, lebo menia rôzne systémy (kamióny / žeriav a vozidlá / lode). Spoločný bod je `WorldState` v9: každá zmena tvaru je samostatný helper volaný z `migrateV8ToV9` (T6D-01 `migrateLandsideV8ToV9`), zmeny významu rieši parser (T6D-03 `legacyAnchorage`), obnova (T6D-02 `adaptHookVehicle`).
2. **Kamióny (ADR-035):** kamióny, ktoré náklad privážajú (`delivery`) alebo čakajú na prázdny (`collect`), čakajú vo vnútrozemí mimo mapy a do prístavu vojdú len so zaručeným miestom (staging docku, sklad / depo, prázdny linky); stojisko má kvótu pre odvoz (`pickupReservedBays`). Nová štruktúra sa nevytvára — čakajúci kamión je splatná položka existujúceho plánu.
3. **Žeriav (dodatok ADR-033):** v režime `under_hook` stojí vozidlo fyzicky v bunke pod hákom (nábrežie kotviska je pre vozidlo jazdné, cestná sieť sa cezeň nespája), predvolený `craneBufferSlots` 0, metrika `directHandoverPct`; režim `apron` ostáva cez def. Ťahače + RTG ostávajú vo Fáze 10a.
4. **Lode (dodatok ADR-029):** rejda harbor_01 v zóne na otvorenom mori (riadok y = 3), loď bez voľného kotviska pláva zo vstupu priamo na rejdu (`arriving → waiting_anchorage`), na kotve jednotný kurz `map.anchorageHeading`, invariant `anchoringProblem`.
5. **Scenár `live_terminal`** dostane druhý dvor: po ADR-035 export vojde len so zaručeným miestom v sklade a jediný dvor s prekládkou bol plný (rolled exporty).

## Karty
| id | názov | agent (model) | parallel | depends_on |
|---|---|---|---|---|
| T6D-01 | Kamióny: vnútrozemie, vjazd so zaručeným miestom, kvóta stojísk pre odvoz, `DockIntake`, metriky `hinterlandQueue`, ADR-035, scenár `landside_pressure`, WorldState v9 (`hinterland`) | sim-architect (sonnet, worktree) | yes | – |
| T6D-02 | Žeriav: vozidlo fyzicky pod hákom, buffer 0, `directHandoverPct`, render spúšťania kontajnera na vozidlo, e2e `f6d-hook`, dodatok ADR-033 | sim-architect (sonnet, worktree) | yes | – |
| T6D-03 | Lode: rejda v otvorenom mori, priamy vstup na rejdu, jednotný kurz, `anchoringProblem`, migrácia v8 so starou rejdou, e2e `f6d-anchorage`, dodatok ADR-029 | sim-architect (sonnet, worktree) | yes | – |
| T6D-04 | Zlúčenie T6D-01..03, v9 = v8 + `hinterland` + nový význam rejdy, druhý dvor v `live_terminal`, goldeny; inšpektor brány s čakajúcimi kamiónmi; text toastu `EmptyPickupMissed` | general-purpose (sonnet) | no | 01, 02, 03 |
| T6D-05 | Review `src/sim/**` zmien 6d | sim-reviewer (sonnet) | no | 04 |
| T6D-05b | Opravy z review: žeriav pri bufferi 0 a vozidle v `no_path` odloží na apron, povinná `mission`, hot path vjazdu, cache bunky pod hákom, test obnovy savu spred T6D-02, texty ADR-035 | sim-architect (sonnet) | no | 05 |
| T6D-05c | Nakládka pod hákom cez apron, keď k bunke pod hákom nevedie cesta (regresia T6D-02 pri jednosmerkách) | sim-architect (sonnet) | no | 05b |
| T6D-06 | Plná pipeline + plná e2e, artefakt | test-runner (haiku) | no | 05c |
| T6D-07 | Docs: ARCHITECTURE, PROGRESS, BACKLOG, checklist, PR | implementer (sonnet) / docs-keeper (haiku) | no | 06 |

Vlny: {T6D-01 ‖ T6D-02 ‖ T6D-03} → T6D-04 → T6D-05 → T6D-05b → T6D-05c → T6D-06 → T6D-07.

## Checklist
- [x] T6D-01 Kamióny a vnútrozemie (ADR-035)
- [x] T6D-02 Žeriav odovzdáva priamo na vozidlo pod hákom (dodatok ADR-033)
- [x] T6D-03 Lode priamo na rejdu (dodatok ADR-029)
- [x] T6D-04 Zlúčenie, goldeny, `live_terminal`, inšpektor brány, toast
- [x] T6D-05 Review `src/sim` (MERGE: 0 blocking, 1 major, 9 minor)
- [x] T6D-05b Opravy z review
- [x] T6D-05c Nakládka pod hákom cez apron pri nedosiahnuteľnom háku
- [ ] T6D-06 Plná pipeline + e2e + artefakt
- [ ] T6D-07 Docs + PR

## Výsledok fázy
_(doplní orchestrátor po T6D-06)_
