# Prevádzka kontajnerového terminálu — doménový model a plán

> Zdroj: doplnenie od používateľa (2026-09-30) „Štyri toky kontajnerov". Tento dokument je **referencia pre plánovanie fáz**: porovnáva realitu terminálu so stavom hry po F6c (pôvodne po F5b), navrhuje zjednodušený herný model a zaraďuje ho do fáz. Detaily implementácie sa rozhodnú v ADR príslušnej fázy.
> Zásady ostávajú: nič sa neteleportuje (každý presun cez `CargoLedger.move`), determinizmus, data-driven, rozšírenia cez triedy a defy.

## 1. Stav hry po F6c (čo už zodpovedá realite)
| Realita | V hre dnes |
|---|---|
| Import: loď → sklad → kamión odvezie | **Áno** (F2–F5): kontrakt → loď → STS žeriav → apron → straddle carrier → dvor → rampa → kamión → `exported`. |
| STS žeriav kladie kontajnery na zem, nečaká na vozidlo | **Áno (režim `apron`)**: apron pod žeriavom (8 slotov po F5b), žeriav čaká len na voľný slot (§7.8); od F6a je predvolené odovzdávanie pod hákom (riadok nižšie). |
| Straddle carrier robí celý cyklus sám (nábrežie ↔ stoh ↔ kamión) | **Áno, zjednodušene**: `straddle_carrier` vozí apron → dvor → rampa; kamión nakladá na rampe (výmenná zóna), nie priamo v uličke stohu. |
| Brána s frontou, stojisko, kamión na dock | **Áno** (F4, F5b): FIFO brána, bays, cúvanie do docku (render). |
| Kontrakt ↔ loď, SLA, penalizácie | **Áno** (F5): import kontrakt, demurrage, late, fail. |
| Sklad so sotmi × vrstvami | **Čiastočne**: `container_yard_small` 32 slotov × 2 vrstvy, **bez poradia v stohu** (žiadny rehandling). |
| Export: booking (loď/voyage + cieľový prístav + počet TEU) | **Áno (F6a)**: kontrakt `export` alebo `roundtrip` (import + export jednej návštevy lode); ponuka sa prijíma ako skupina, odmena `exportPricePerUnitCents × TEU × urgency`, výplata pomerne k naloženým. |
| Rozložené príchody exportu a cut-off | **Áno (F6a)**: plán príchodov z `Rng` v okne pred cut-off, kamión príde naložený 1 TEU a prejde bránou; po cut-off je jednotka *rolled* (naloží sa len ako „last minute“, kým loď nelashuje, inak sa vráti odosielateľovi; penalizácia). Toast „cut-off o N h“. |
| Brána s kontrolou VGM | **Áno (F6a)**: s pravdepodobnosťou `vgmMissingChance` dostane jednotka hold na `vgmHoldHours`, nesmie sa naložiť a loď na ňu nečaká; hold sa uvoľní sám (bez interakcie hráča). |
| Exportný sklad zoskupený podľa lode | **Áno (F6a)**: export z docku ide do skladu, kde už leží jednotka tej istej voyage (inak najbližší s voľným miestom); import a export zdieľajú sklady, **bez poradia v stohu** (F14). |
| Stowage poradie nakládky | **Áno (F6a), zjednodušene**: `heavy → medium → light`, pri zhode id; dispatcher aj žeriav dodržiavajú poradie, odchýlky ráta metrika `stowageOrderViolations`. Viac prístavov a 40'/20' až F12. |
| Dual cycling žeriava | **Áno (F6a)**: loď s importom aj exportom pripraveným na nakládku → `dual_load` + `dual_unload` za `dualCycleFactor × cyklus` (metrika `dualCycleRate`). |
| Lashing + papiere | **Áno (F6a)**: po poslednej nakládke stav lode `lashing` (`lashingTicksPerUnit × naložené + paperworkTicks`), loď drží kotvisko; pri odchode sa export presunie do `shipped`. |
| Dual transaction | **Áno (F6a)**: kamión s exportom po vykládke na rampe zostane na docku a naloží import, ak je tam náklad na odvoz pre celú jeho kapacitu (metrika `dualTransactionRate`; v prirodzenom toku zriedkavé). |
| Odovzdávanie žeriav ↔ vozidlo pod hákom | **Áno (F6a)**: predvolený `handoverMode: under_hook` — vozidlo čaká pod žeriavom, apron je len buffer 0–1 jednotka na žeriav; čakanie žeriava a vozidla sa meria (`craneWaitForVehicleTicks`, `vehicleWaitUnderCraneTicks`). Režim `apron` ostáva v defe. |
| Návrat prázdnych z vnútrozemia | **Áno (F6c)**: keď import odíde kamiónom, po `hinterlandDaysRange` (Rng, podiel `emptyReturnRate`) sa vráti prázdny kontajner tej istej linky — kamión `delivery` s jednotkou `direction: 'empty'` prejde bránou, vyloží sa na rampe a vozidlo ho odvezie do depa. Tok sa plánuje len v prístave s depom a návrat prijme len voľné miesto v depe (inak `EmptyReturnDeclined`, nič sa nehromadí v dvore). |
| Depot prázdnych | **Áno (F6c)**: modul `empty_depot` (`EmptyDepot extends StorageModule`, kapacita 96, prijíma len prázdne, 2 miesta opravy); bežný dvor prázdne prijme len ako fallback, keď depo chýba. |
| Kontrola a M&R | **Áno (F6c)**: pri uložení do depa `damageChance` → `damaged` → oprava `repairHours` na jednom z `repairBays` → `available`; poplatok `repairCostCents` (ledger `maintenance_repair`); poškodený ani opravovaný kontajner sa nesmie vydať ani naložiť. |
| Empty handler | **Áno (F6c)**: vozidlo `empty_handler` (len `direction: 'empty'`, rýchlejšia manipulácia); dispatcher mu prideľuje joby prázdnych prednostne pred bežnými vozidlami. |
| Výdaj prázdneho exportérovi | **Áno (F6c)**: pred príchodom naloženého exportu (`emptyPickupRate`) príde kamión misie `collect` po prázdny kontajner tej istej linky, naloží ho na rampe a odíde (`exported`); bez dostupného prázdneho čaká `emptyPickupMaxWaitHours` a odíde prázdny (metrika `emptyPickupMisses`). |
| Repositioning prázdnych | **Áno (F6c)**: kontrakt `empty_repositioning` — linka nalodí N prázdnych z depa na loď voyage (aj spolu s exportom); nakladajú sa **po plných** (stowage), odmena za naložený kus. |
| Tranship (loď → loď) | **Áno (F6c)**: kontrakt `tranship` — loď A vyloží jednotky `direction: 'tranship'`, uložia sa zoskupene a naložia na loď B, ktorá príde neskôr (`transhipGapDaysRange`); **nikdy neprejdú bránou**. Zmeškaná loď B → penalizácia a záchrana na ďalšiu voyage linky, inak predaj kamiónom po lehote `transhipRescueDays`. |

## 2. Čo chýba (medzery) a herný model
### 2.1 Export (landside → loď)
- **Booking**: exportný kontrakt = loď (voyage) + cieľový prístav + počet TEU + **cut-off** (napr. 24 h pred príchodom lode). Kontajnery prichádzajú kamiónmi **rozložene počas niekoľkých dní** pred loďou (Rng rozdelenie príchodov), každý nesie `bookingId`, `destinationPort`, hmotnostnú triedu.
- **Brána (vstup)**: kontrola dokladov = `processTicks` brány; **VGM** (overená hmotnosť) — malá pravdepodobnosť chýbajúceho VGM → kontajner ide do „hold" (čaká X hodín, inak sa nenaloží). Brána pridelí cieľ: blok/pozíciu v exportnom sklade.
- **Cut-off**: čo príde po cut-off, prepadne na ďalšiu loď (booking sa presunie, malá penalizácia/strata reputácie); voliteľne drahý „last-minute" priamo na nábrežie.
- **Exportný sklad**: pozície zoskupené podľa lode → cieľového prístavu → hmotnosti (ťažké naspodok nakládky). Dispatcher ukladá tak, aby poradie nakládky nevyžadovalo prehadzovanie.
- **Dual transaction**: kamión, ktorý privezie export, si môže na tom istom termináli vyzdvihnúť import alebo prázdny → odchádza plný (menej prázdnych jázd; metrika `dualTransactionRate`).
- **Nakládka lode**: poradie z **stowage plánu** (zjednodušený: ťažké dole, posledný prístav na trase naspodok, prázdne na koniec a navrch; reefery/nebezpečný tovar a 40' až s typmi nákladu). Žeriav berie z apronu v poradí plánu; yard musí dodávať v poradí.
- **Dual cycling**: žeriav v jednom cykle vyloží import a naloží export (bez prázdnej jazdy) → vyšší výkon žeriavu, keď loď má obidva smery.
- **Lashing + dokumentácia**: po poslednej nakládke `lashingTicks` + `paperworkTicks`, potom `undocking` (loď dovtedy blokuje kotvisko).

### 2.2 Prázdne kontajnery
- **Životný cyklus**: import plný → kamión odvezie → po `hinterlandDays` sa **vráti prázdny** (kamión privezie prázdny) → depot prázdnych → kontrola (pravdepodobnosť poškodenia) → M&R (čas + náklad) → dostupný.
- **Depot prázdnych** (`empty_depot`, nový modul, trieda `extends StorageModule`): vyššie stohovanie (6–8), rýchlejšia manipulácia; obsluhuje **empty handler** (nové vozidlo, rýchle, len prázdne, len v depote a na výmenu s kamiónom).
- **Výstupy**: (a) exportér si vyzdvihne prázdny (kamión príde prázdny → odíde s prázdnym → neskôr privezie export), (b) **repositioning** — linka nalodí prázdne (kontrakt typu `empty_repositioning`, nakladajú sa na koniec a navrch).
- **Vlastník = linka**: kontajner má `lineId`; kamión dostane prázdny len od linky svojho bookingu.

### 2.3 Tranship (loď → loď)
- Kontrakt `tranship`: loď A vyloží jednotky s cieľom „loď B" (príde neskôr) → **transshipment blok** v sklade → nakládka na loď B. **Nikdy neopustí terminál bránou**; ledger prechody `in_storage → in_vehicle → on_apron → in_crane → on_ship` (reverzný reťazec, rovnaký ako export).

### 2.4 Sklad: bloky, stohy, rehandling, pre-marshalling
- **Blok** s pozíciami **bay–row–tier**; výška stohu podľa vybavenia (straddle 2–3, RTG 5–6, empty handler 6–8).
- **Rehandling**: ak je potrebný kontajner zavalený, stroj musí najprv preložiť tie nad ním (čas + vyťaženie) → dôvod pre dobré ukladanie a **pre-marshalling** (deň pred loďou presun exportov do bloku pri nábreží v poradí nakládky).
- Metriky: `rehandlesPerMove`, vyťaženie strojov bloku.

### 2.5 Vybavenie skladu (alternatívne systémy)
- **Odovzdávací bod žeriav ↔ vozidlo** je „pod hákom" (požiadavka 2026-10-04): **variant A** (F6a) — straddle carrier čaká pod STS žeriavom, apron je len buffer 0–1; **variant B** (F10a) — STS kladie priamo na terminálový ťahač, ktorý v sklade vyloží RTG.
- **Straddle carrier** (dnes): jeden stroj na celý cyklus, široké uličky → nižšia hustota (stoh 2–3), rýchly, drahý na údržbu.
- **Shuttle carrier**: 1 nad 1, len nábrežie ↔ blok (blok obsluhuje RTG/RMG).
- **RTG/RMG + terminálové ťahače/AGV**: vysoká hustota (6–7 radov + pruh, stoh 5–6); ťahač sám nezdvihne — čaká v pruhu bloku na RTG. **RTG je úzke hrdlo**: priorita lodi pred externými kamiónmi, rehandling; presun RTG medzi blokmi je pomalý. **RMG** na železnici nakladá vlaky (F10).
- Hráč volí systém podľa priestoru a rozpočtu (defy + triedy: `YardCrane`, `TerminalTractor`, `ShuttleCarrier`, `EmptyHandler`).

### 2.6 Denný rytmus (emergentný)
Nevyžaduje extra kód, vznikne z vyššie uvedeného: exporty prichádzajú v špičke kamiónov pred loďou, import sa odváža po lodi, pre-marshalling popoludní, večer loď (vykládka + nakládka, dual cycling), noc lashing a odchod. Voliteľne **denný profil príchodov kamiónov** (def) pre špičky.

## 3. Zaradenie do fáz (rozhodnutie orchestrátora, delegované používateľom)
| Fáza | Obsah | Odhad |
|---|---|---|
| **5b** (beží) | spätná väzba z hrania — tok kamiónov, lode bez prekryvu, mapa s mólami, mierka | — |
| **6** | Save/Load, čas, nastavenia, stabilizácia (bez zmeny) | 1,5 SD |
| **6a — Export a booking** — **hotová** *(nová; presunuté „export kontrakty" z F12)* | booking (loď + cieľový prístav + cut-off), rozložené príchody exportov, brána s VGM hold, exportný sklad zoskupený podľa lode/prístavu/hmotnosti, nakládka lode podľa zjednodušeného stowage plánu, dual cycling žeriavu, lashing + papiere pred odchodom, dual transaction kamiónov; odovzdávanie žeriav ↔ vozidlo pod hákom (variant A, ADR-033) | 3 SD — hotové |
| **6c — Prázdne a tranship** — **hotová** *(nová)* | `lineId`, návrat prázdnych z vnútrozemia, depot prázdnych + empty handler, kontrola a M&R, výdaj prázdneho exportérovi, repositioning kontrakty, tranship kontrakty (loď → loď) | 2,5 SD — hotové |
| 7 | Parcely, OPEX, grafy (bez zmeny) | 2 SD |
| 8 | XP a tech tree — odomyká RTG/shuttle/AGV/empty depot | 1,5 SD |
| 9 | Nové komodity (bulk, liquid, gas, RoRo), **reefery a nebezpečný tovar** v stowage pláne | 3–4 SD |
| 10 | Železnica + **RMG** na koľajovom termináli | 2 SD |
| **10a — Vybavenie skladu** *(nová)* | RTG/RMG bloky, terminálové ťahače/AGV (dvojfázový systém), shuttle carrier, priorita lode v bloku, presun RTG medzi blokmi | 2,5 SD |
| 11 | Analytika, heatmapa, kongescia (+ metriky rehandlingu, dual transaction/cycling) | 1,5 SD |
| 12 | Lode naplno, reputácia; **stowage plán naplno** (40'/20', posledný prístav, prázdne navrch); **stavanie móla/zásyp (ADR-028)** | 2,5 SD |
| 13 | Balans, UX, tutoriál, výkon, release | 3 SD |
| **14 — Sklad: stohy a rehandling** *(nová, voliteľná, úplne na konci — rozhodnutie používateľa)* | pozície bay–row–tier, poradie v stohu, rehandling (čas stroja), pre-marshalling pred loďou, metriky rehandlingu; dovtedy sklad = kapacita bez poradia, RTG bez rehandlingu | 2,5 SD |

Plán sa tým predĺži o ≈ 11 SD (spolu ≈ 40 SD). Poradie: 5b → 6 → 6a → 6c → 7 → … → 13 → 14 (voliteľná). Fázy 6a a 6c spolu tvoria **M2 „živý terminál"**: všetky štyri toky kontajnerov — **M2 splnený** (F6c, scenár `live_terminal`: import, export, prázdne + repositioning a prekládka A → B v jednom prístave, `lostUnits` 0).

## 4. Dopady na architektúru (na rozhodnutie v ADR fáz)
- `CargoUnit` dostane `direction: 'import' | 'export' | 'tranship' | 'empty'`, `bookingId?`, `lineId`, `destinationPort?`, `weightClass`, `status` (napr. `vgm_hold`, `damaged`).
- `CargoLedger` prechody: reverzný reťazec `in_truck → at_gate → in_vehicle → in_storage → in_vehicle → on_apron → in_crane → on_ship` (§7.1 rozšíriť); `exported` ostáva konečný pre landside odchod; nový konečný `shipped` pre odchod na lodi.
- `Contract` → rodina tried (`ImportContract`, `ExportContract`, `TranshipContract`, `EmptyRepositioningContract`) podľa pravidla 7.
- `StorageModule` → poradie v stohu (`StackPosition {bay,row,tier}`), `ExportYard`/`ImportYard`/`EmptyDepot` ako politiky alebo triedy.
- Nová vrstva plánovania: `StowagePlan` (poradie nakládky), `YardPlanner` (pridelenie pozície pri bráne, pre-marshalling).
