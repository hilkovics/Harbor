# BACKLOG.md — Modular Harbor

Nápady a problémy mimo aktuálnej fázy (CLAUDE.md, pravidlo 8). Každá položka: popis, pôvod (karta/fáza), návrh fázy.

## P0
–

## P1
- ReleaseParcel pri cestách/koľajach na prenajatej parcele nie je určené (ADR-008 ich tam povoľuje, §5.2 blokuje ukončenie prenájmu len pri moduloch): zostanú, odstránia sa s refundáciou, alebo ukončenie zablokujú? Rozhodnúť ADR-om. — pôvod: T00-19 · fáza: pred F7
- Agent test-runner doslova volá simrun data/scenarios/vertical_slice.json, ktorý neexistuje do F5; dovtedy sa používa smoke.json. — pôvod: T00-13 · fáza: F5
- CraneSystem natvrdo počíta s cyklom kontajnerového importu → krok cyklu presunúť do podtried CraneModule alebo stratégie (§17 bod 5), inak bulk/liquid žeriav (flowUnitsPerTick) vynúti zásah do systému. — pôvod: review T02-13 · fáza: pred F7
- Idle vozidlo ostáva stáť na prístupovej bunke (návrat do depa chýba) a blokuje RemoveRoad tej bunky; open joby s odpojeným cieľovým skladom držia sloty a naložené vozidlo cyklí v no_path → návrat do depa + preradenie jobov + udalosť pre toast. Návrh v ADR-031 (Dôsledky): preradenie naloženého vozidla z `no_path` a rušenie open inbound jobov k odpojenému skladu = nový stav FSM vozidla, dôvod `JobCancelled`, udalosť pre toast (> 100 riadkov, vlastný ADR). — pôvod: T03-06, T03-13, ADR-031 · fáza: F7 pred parcelami alebo F11 (kongescia)
- `has_trucks` validácia pri odstránení brány/stojiska/rampy s kamiónmi (T04-02 nechal hook, T04-04 dodá logiku); odčítavanie trudy pri obnove modulov. — pôvod: T04-02, T04-12 · fáza: F4 (zásuvka existuje)
- Kamión v `no_path` drží bay (pred stojiskom) alebo dock (`to_dock`; od ADR-029 dock nedrží od spawnu), bez návratu či despawnu a bez udalosti `TruckNoPath`: buď vrátiť do depa a zrušiť job, alebo vypršať a despawnúť (nový stav alebo vypršanie, vlastný ADR); event `TruckNoPath` pre toast. Návrh v ADR-031 (Dôsledky). — pôvod: T04-04, T04-11, ADR-031 · fáza: F7 pred parcelami alebo F11 (kongescia)

## P2
- **Hladovanie `free`** (T05-10 review, minor, staging share): vol. priestor v sklade sa neprideluje pri `failed` kontraktoch → sklad zablokovaný; voľné sloty sa prideľujú pri výklade aj v stave `unloading`, nie len pri `exporting`. — pôvod: T05-10 review · fáza: F5–F6
- **Neohraničené penalizácie:** demurrage a late by mali byť ohraničené ≤ reward; pri bankrote. — pôvod: T05-10 review · fáza: F5–F6
- **`StoredCargoIndex` O(skupina):** splice pri odstránení kontraktu je O(n); použiť heap alebo bitset. — pôvod: T05-10 review · fáza: F6
- **Free/failed wait behind SLA** (outbound priority): jednotky bez kontraktu a `failed` sa nemajú odohrať pred SLA jednotkami. — pôvod: T05-10 review · fáza: F5–F6
- **TopHUD panel icons bez funkcie:** ikony Financie/Štatistiky/Tech (Finance/Stats/Tech) sú clickable no-op → zablokovať alebo schovať. — pôvod: T05-07 · fáza: F5–F6
- **contractsRevision** oddelené od REVISION_EVENTS → sledovanie zmien kontraktu. — pôvod: T05-07 · fáza: F6
- **E2E pre bankrot a novú hru:** test GameOver modalu a reštartu. — pôvod: T05-07 · fáza: F5
- **Toast sa zatvára aj počas pauzy:** auto-close by mal byť deaktivovaný (paused game). — pôvod: T05-12 · fáza: F5–F6
- **Orezaný výrez mapy pri paneli:** pri otvorení ContractsPanel sa mapa kreslí cez ľavý okraj panelu. — pôvod: T05-06 · fáza: F13 (vizuál)
- **Údržba ciest a modifikátory miezd:** road maintenance (nonzero v F5), wage tech modifiers (tech modifikátory pre mzdy vozidiel). — pôvod: T05-02 · fáza: F7–F8
- Štartové cesty z mapy (starter.roads, 30 buniek) sú zadarmo, ale RemoveRoad za ne vráti 50 % aktuálnej ceny (~$30k) — drobný exploit; pri moduloch vyriešené refundáciou zo zaplatenej ceny (ADR-015), pri cestách zvážiť to isté. — pôvod: T01-04, T02-04 · fáza: F13 (balans)
- Späť cez stojisko (čakacia plocha) nemá čas prechodu → kamión v `gate_queue_out` sa okamžite ocitne na výstupe. — pôvod: T04-04, T04-11 · fáza: F5
- Brána čakala na cestu spoza seba (za portálom) pri určovaní prevádzkovosti rampy → t.č. sa overuje len cesta ku bráne; spätná cesta je optická. Rozhodnúť. — pôvod: T04-11 · fáza: F5
- Fronta brány sa kreslí číslo pri vstupnej strane (cell konektora), nie pri portáli; pri vizuálnych úpravách asset brány skontrolovať kolíziu s kabínou kamióna v `gate_queue`. — pôvod: T04-10, T04-06 · fáza: F13 (vizuál)
- Dlhý kamión v ľavej zákrute prečnieva asfaltu. — pôvod: T04-06, T04-11 · fáza: F13 (vizuál)
- Dispatcher parkuje idle vozidlá mimo depa na bunke docku; môžu sa prekrývať s kamiónmi v stojisku. — pôvod: T04-10 · fáza: F13
- DefRegistry: cross-validation kamión.cargoCategories vs ramp.params.category (vzor ALU manifest); schéma pre truck_container footprint. — pôvod: T04-01, T04-05 · fáza: F8
- Viacero road portálov na mape (F10 landsideSystemu, T04-04 spawner používa portals[0]); dispatch determinismu cez DeviceRegistry. — pôvod: T04-04, T04-11 · fáza: F10
- Sprite AGV nemá „nižší, modrý pás“ z DESIGN_BRIEF §5.6 — je žltý ako straddle carrier; pri 32 px sú rozlíšiteľné len tvarom. Iterovať v Claude Design (vzorový prompt v §8) pred F8 (odomknutie AGV). — pôvod: Claude Design relácia 4 · fáza: F8
- Konektory modulov: kanonický zdroj sú assets/manifest.json → sprites.*.connectors; berth, crane (F2), container_yard_small a vehicle_depot (F3) sú prevzaté, ostatné moduly prevziať pri ich zavedení. — pôvod: Claude Design relácie 3 a 6 · fáza: F4
- Počty slotov v spritoch dvorov (medium 76×3 = 228, large 129×3 = 387) nesedia s capacityUnits v ARCHITECTURE §5.3 (180 / 384); small sedí (32×2 = 64). Sprity sú len vizualizácia 5 stavov, ale zosúladiť pri F3/F13 (balans) alebo požiadať Claude Design o úpravu. — pôvod: Claude Design relácia 3 · fáza: F3
- Zlomkový flowUnitsPerTick (0.5/0.3) vs diskrétne CargoUnit batche (ADR-003) — delenie jednotky alebo akumulácia? — pôvod: T00-05 · fáza: pred F9
- DAYS_PER_MONTH v sim-clock.ts je privátne — exportovať (vzorec prenájmu §9.2 /30); do ADR-002 dopísať, že kalendár je konštanta v kóde. — pôvod: T00-12 · fáza: F7
- INITIAL_SPEED = 1 je konštanta v sim-clock.ts → presunúť do time.initialSpeed (def + schéma + registry, kontrola ∈ speeds; pravidlo 4). — pôvod: T00-12, review T01-13 · fáza: F6
- Rng.weighted — pretečenie súčtu váh na Infinity; alokuje pole na každé volanie. — pôvod: T00-12 · fáza: F3
- SimClock.advance() alokuje objekt každý tick → vracať predpripravené zmrazené objekty. — pôvod: T00-12 · fáza: F6 (profiling)
- EventBus.flush realokuje pole a nemá strop → zmerať vo F5/F6, prípadne dvojitý buffer. — pôvod: T00-12 · fáza: F6
- Sumy v centoch bez Number.isSafeInteger / maximum 2^53−1 v schéme aj registry. — pôvod: T00-12 · fáza: F5
- ESLint beží bez type-info (kvôli --stdin probe); type-aware pravidlá (no-floating-promises) doplniť. — pôvod: T00-02 · fáza: F6
- Hranica src/sim — známe zvyšky (úmyselné obchvaty, nízke riziko): Math[k]/Date[k] s premenným kľúčom, x['constructor'] cez string literál, destrukturovanie const { constructor: F } = …, toLocaleUpperCase/toLocaleLowerCase. — pôvod: T00-17, re-review T00-17 · fáza: podľa potreby
- Selektor Identifier[name='Math'] falošne hlási aj { Math: 1 } a x.Math (časť so selektorom .constructor vyriešil ModuleRegistry registráciou, ADR-014). — pôvod: re-review T00-17 · fáza: podľa potreby
- Import './' a '../' (s lomkou na konci) je v src/sim falošne zakázaný — povoliť alebo zdokumentovať. — pôvod: re-review T00-15 · fáza: podľa potreby
- World-state parseRoads nekontroluje ADR-008 (save s cestou na parcele na predaj sa načíta, cestu potom nejde odstrániť) → WorldStateError. — pôvod: review T01-13 (world-state.ts:124) · fáza: F6
- map-loader segmentInterior (Math.round) je asymetrický a pripúšťa diagonálu → zdieľaný 4-súvislý Bresenham pre loader aj ShipSystem. — pôvod: review T01-13 (map-loader.ts:207) · fáza: F3
- Globálny meniteľný commandRegistry → seal() po registrácii vstavaných príkazov. — pôvod: review T01-13 (command-registry.ts:59) · fáza: podľa potreby
- CommandRejected nenesie index záznamu scenára (len typ) → simrun hlási typ + tick + dôvody. — pôvod: T01-06 · fáza: podľa potreby
- Rozmery čiar v RoadLayer fallbacku (pás cesty 3/4, stredová čiara 1/32, pena 1/32, hrana nábrežia 1/16) sú pomenované zlomky, nie tokeny → zvážiť tokeny. — pôvod: T01-08 · fáza: F13
- Cesta pri okraji mapy (portál) sa nekreslí k okraju (susedia mimo mapy nie sú v maske autotile); road_end na bunke portálu vyčnieva 3 px pod značku portálu. — pôvod: T01-08, T01-16 · fáza: F13
- RoadLayer kreslí len road; rail doplniť. — pôvod: T01-08 · fáza: F10
- Token --ui-money-neg (#E5484D) má kontrast 3,89:1 < 4,5:1 (§6.4) pre 16px tučnú zápornú sumu v HUD → svetlejší textový token (iterácia Claude Design). — pôvod: T01-10 · fáza: F13
- parcel_outline_for_sale cez 9-slice natiahne čiarkovanie nepravidelne → okrajová dlaždica pre TilingSprite alebo procedurálne čiarkovanie. — pôvod: T01-16 · fáza: F7
- Výkon renderu overiť na reálnom GPU (headless SwiftShader so spritmi ~100–120 ms/frame, CPU JS 16–26 ms/3 s). — pôvod: T01-16 · fáza: F6
- Alokácie v každom ticku (ship-route trasa inbound/outbound, Set čakajúcich lodí, kópia ships, polia/closures v berth-allocator, filter v StatResolver.resolve, fázy žeriavu) → predpočítať trasy mapy, znovupoužívať pracovné polia. — pôvod: review T02-13 · fáza: F6
- Krok 12 (DEV) stojí ~390 µs/tick: assertConservation 130–190 µs a prechod mriežky ~25 µs → zrýchliť assertConservation (mapa seenIn), inkrementálny prechod mriežky, read-only iterácia jednotiek skladu v ledgeri. — pôvod: T02-03, T03-13, T03-14 · fáza: F6
- Trajektória lode k kotvisku sa neoveruje voči súši (mapy s mólami) a lode sa môžu vizuálne prekrývať (spawn, súčasný príchod a odchod). — pôvod: T02-05 · fáza: F12
- Skoková rotácia lode pri berthing → docked; plynulé natáčanie v renderi. — pôvod: T02-05 · fáza: F13
- Úvodná kamera (zoom 0.5, breh na 1/3 výšky) skrýva príjazd lode po seaLane → rámovanie alebo tlačidlo „zamerať loď". — pôvod: T02-09 · fáza: F5
- DefRegistry: berth by mal mať footprint.w ≥ h; placement.waterSide len pri berth, mustAttachTo len pri crane. — pôvod: T02-03, T02-04 · fáza: podľa potreby
- Jednotná politika MoneyChanged s nulovou deltou (príkazy nad cestami ho emitujú vždy, nad modulmi len pri nenulovej zmene). — pôvod: T02-04 · fáza: F5
- UI: build-tip zvislý flip pri kurzore nad BuildBarom; text has_cargo pre žeriav („Žeriav drží kontajner"); selection_ring hrúbka pri zoome < 1 (frameScale); nápoveda/Del skratka na odstránenie. — pôvod: T02-10 · fáza: F13
- UI: .hud-icon (flex: none) je v top-hud.css, ale používa ho icon.tsx → vlastný icon.css; formatSpeed literál × → TIMES_SIGN; tooltip aj pre dostupné položky BuildBaru. — pôvod: T02-08 · fáza: F13
- Render: tilt výložníka k cieľovému slotu apronu; lazy načítanie textúr variantov lodí; culling/ParticleContainer pre entity. — pôvod: T02-07 · fáza: F6
- Docs: doplnkový ADR pre zmeny ARCHITECTURE bez vlastného ADR (kalendár SimClock, vypustenie berth_edge, displayName, schemaVersion/createGrid, snapshot v2/v3); §17 bod 5 text register(kind, factory); §4.5 TechEffect.target 'crane' vs StatResolver 'module'. — pôvod: T02-14 · fáza: F4 (docs), F9
- Zaokrúhľovanie celočíselných štatistík v StatResolver po mul (napr. cycleTicks × 0.85) → rozhodnúť ADR-om. — pôvod: T02-03 · fáza: F8
- Sprity úzkych ciest z Claude Design (road_one_lane_*, road_one_way_* s lievikmi) namiesto procedurálneho kreslenia; prompt: „Doplň sety spritov road_one_lane_{straight,corner,t,cross,end}.svg a road_one_way_{straight,corner,t,cross,end}.svg v štýle assets/infra/road_*.svg (64×64). Asfalt jedného pruhu 26 px (x 19–45), --road-base #4B5058, okraj 2 px #101113, bez stredovej čiary; roh štvrťkruh okolo (64;0) s polomermi 19 a 45 px; end polkruh r 13; one-way bez šípky (engine kreslí overlay.path_arrow); ramená pri širokej ceste 45° lievik 26→52 px hĺbky 13 px; do manifestu infra.road_one_lane a infra.road_one_way s connectsAtRot0." + token --road-edge v tokens.css a DESIGN_BRIEF §3 + ikony ic_road_two_lane/one_lane/one_way. — pôvod: T03-19, T03-20 · fáza: F13
- Render ciest a vozidiel: oblúky aj v T/krížových križovatkách (VehicleVM.nextHeading), šípka ghostu jednosmerky v zákrute na oblúku, plynulý prechod pruhu pri zmene typu cesty, zub pri širokej zákrute susediacej s úzkou, snap kurzu stojaceho vozidla v zákrute, čitateľnosť vozidiel pri zoome ≤ 0,5, vizuál no_path a path_arrow trasy, reserved sloty skladu vo vizuále. — pôvod: T03-17, T03-19, T03-08 · fáza: F13
- Zmena smeru jednosmerky stojí plnú cenu one_way − 50 % refund (konzistentné s prestavbou) → zvážiť lacnejšie otočenie smeru; alias infrastructure.road.costPerCellCents odstrániť (UI už používa roadKinds). — pôvod: T03-18, T03-20 · fáza: F13 (balans)
- Kongescia F11 mení cenu bunky bez zmeny roadVersion → PathCache/DistanceMatrix potrebujú ďalší spúšťač invalidácie; PathCache bez limitu veľkosti a kľúč nad SMI pri mapách > 46k buniek; cache priradenia vozidla pri nedosiahnuteľnom jobe podľa roadVersion. — pôvod: T03-03, T03-05, T03-13 · fáza: F11
- SlotReservations.reserve je O(capacity) — hint prvého voľného slotu vyžaduje počítadlo odchodov v CargoLedger; presná kontrola rezervácií (bitset) namiesto súčtov v kroku 12. — pôvod: T03-13, T03-14 · fáza: F6
- Joby s viacerými jednotkami pre vozidlá s kapacitou > 1 (AGV); počítadlá utilizácie vozidiel v sime pre štatistiky; TRAFFIC_ZERO_THRESHOLD do logistics.json. — pôvod: T03-06 · fáza: F8, F11
- Stavba modulu môže zablokovať posledný konektor iného modulu (ostane nepripojený) → varovanie v UI alebo pravidlo; kotvisko na móle nejde pripojiť (konektory len na juhu). — pôvod: T03-02 · fáza: F12
- UI F3: toast pre no_path a „Dvor je plný", akcia Ukázať pri „Chýba sklad" a rozlíšenie nepripojeného kotviska, herný čas pre auto-zatvorenie toastov, kódy vozidiel SC-01 v depe, sparkline vyťaženosti a fronta depa (F9), „Postaviť cestu ku konektoru" v banneri, skratka cyklovania typov ciest, hover smer existujúcej jednosmerky, DEV spawn 24 TEU; DESIGN_BRIEF §6 doplniť Toasts, buy/road položky BuildBaru a stav Nepripojené. — pôvod: T03-09, T03-10, T03-20 · fáza: F13
- validate:defs: zvyšok krížovej kontroly manifest ↔ def (capacity = slots × layers, connectors, footprint; `apronSlots`, stalls, docks a bays sú hotové v T06-06) a techRequired vozidiel a modulov voči tech_tree.json. — pôvod: T03-01, T03-04 · fáza: F8
- Geometria: cellCenter/cardinalHeading zo ships/ship-route do spoločného modulu; zdieľaný typ deps pre ShipView/VehicleView/CargoSprite; expectedSlotCapacity v invariantoch polymorfne namiesto instanceof. — pôvod: T03-02, T03-04, T03-08 · fáza: podľa potreby

## Z Fázy 5b
- SVG kontajnerov na dvore (`container_yard_*_fill*.svg`) má 47×17 px a nezodpovedá mierke TEU 64×26 (DESIGN_BRIEF §4.1, tabuľka mierok); SVG modulov sa v F5b nemenili. — pôvod: T5B-03 (audit mierky) · fáza: F13 (grafika)
- Kontajnery na palube lode: vykresliť náklad na lodi podľa počtu jednotiek (`ShipVM.unitsOnBoard`); sprity lodí ho majú nakreslený staticky a nesúladne s TEU (DESIGN_BRIEF §4.1). — pôvod: T5B-03 · fáza: F12
- Šírka pruhu cesty je v renderi 26 px (`LANE_WIDTH_PX` = polovica asfaltu 52 px), DESIGN_BRIEF uvádza aj 32 px (§4.1: pruh 32 px by vyžadoval prekresliť moduly) → zjednotiť dokument alebo render. — pôvod: T5B-03 · fáza: F13
- Footprint straddle carrieru v sime (nosič na jednej bunke cesty) vs. vizuál 34×62 px (presahuje pruh o 4 px na stranu) → zosúladiť pri vybavení skladu. — pôvod: T5B-03 · fáza: F10a (vybavenie skladu)
- DESIGN_BRIEF §5.6 (entity) aktualizovať podľa novej mierky (§4.1) a manévru kamióna (cúvanie do docku). — pôvod: T5B-03 · fáza: F13
- Tretí dock rampy (`loading_ramp_container.docks` 3) vyžaduje konektor, záznam v manifeste, SVG a manéver kamióna; riešiť podľa kongescie na rampe. — pôvod: T5B-01 · fáza: F7/F11
- Vzdialený prečerpávací terminál (bója/SPM pre tankery mimo nábrežia). — pôvod: spätná väzba M1 (F5b) · fáza: F9/F12
- Balans: `truck_waiting_area.bays` 6 < 2 docky × `stagingPerDock` 4 = 8 kamiónov → občasné `NoWaitingBay` (vertical_slice: 2×); zvážiť 8 stojísk (asset 4×3 to unesie pri rozostupe 32 px) alebo nechať ako signál pre hráča postaviť ďalšie stojisko. — pôvod: T5B-07 · fáza: F13 (balans)
- `loadTicksPerUnit` 6 (0,6 s pri 1×) je kratší než animácia cúvania (1,6 s); render to dobieha `DOCK_CATCH_UP`. Zvážiť dlhšiu nakládku (zmení balans a goldeny). — pôvod: T5B-07 · fáza: F13 (balans)
- Manéver kamióna v renderi beží na reálnych hodinách → pri 4×/8× zaostáva za simom; prejsť na hodiny v simovom čase. — pôvod: T5B-07 · fáza: F13 (vizuál)
- DESIGN_BRIEF §5.1: doplniť, že hrana nábrežia `quay_edge_n` sa otáča o 1–3 štvrťotáčky pre boky mól (žiadne nové assety). — pôvod: T5B-07 · fáza: F13 (dokumentácia)
- Konvoje na sea lane (časovo-priestorová rezervácia namiesto rezervácie celej trasy; dnes je na dráhe naraz najviac jedna loď). — pôvod: T5B-02 (ADR-029) · fáza: podľa potreby (desiatky lodí)
- Validácia mapy pre lodnú dopravu: anchorage mimo obálky sea lane a na otvorenej vode, šírka kanála ≥ `frontWaterCells` + šírka lode + 1. — pôvod: T5B-02 (ADR-029) · fáza: F6 (stabilizácia)
- Memo kandidátov pre lode pred vstupom podľa triedy lode (dnes sa počíta pre každú loď zvlášť). — pôvod: T5B-02 (ADR-029) · fáza: F6 (profiling)
- Úprava pobrežia hráčom: drahé mólo a zásyp podľa ADR-028 (príkazy `BuildPier` / `ReclaimLand`, verzia mutácie terénu, prekreslenie terénu, invalidácia `WaterNavigator`). — pôvod: spätná väzba M1 (F5b), ADR-028 · fáza: F12

## Z Fázy 6
- Toast prekrýva pätu modálneho dialógu: zásobník toastov má z-index nad zásterkou overlayov a modálov (aby boli chyby ukladania a importu vidno pri otvorenom dialógu), takže môže zakryť tlačidlá v päte dialógu (Nastavenia, Uložiť/načítať). — pôvod: T06-03b · fáza: F13 (vizuál)
- Špička prvého použitia `ShipTraffic`: prvý spawn lode v relácii stojí jednorazovo ~4 ms (tabuľka priechodnosti vody pre prvú veľkosť lode 4,3 ms po úprave zo 6,4 ms, konštruktor `WaterNavigator`, ~10 A* po vode, zahrievanie kódu; ďalšia veľkosť lode ~0,1 ms). Predpočítanie pri `World.create` bolo zamietnuté (spomalilo by tvorbu každého sveta v testoch, ADR-031) → ak špička v hre prekáža, predpočítať mimo `World.create`. — pôvod: T06-07 (ADR-031 bod 6), T06-05 · fáza: F11 (výkon)
- `truckWaitLimit` a defy ako súčasť kompatibility savu: save nenesie defy ani ich verziu; po zmene balansu (`data/defs/*.json`) obnova zarovná len `waitTicks` kamiónov na hranicu stavu podľa aktuálnych defov (`truckWaitLimit`, ADR-031 dodatok T06-08b), ostatné hodnoty závislé od defov (napr. fázy žeriavu, odpočty vozidiel) preberá zo savu a overuje len voči stavu, nie voči aktuálnym defom. Rozhodnúť politiku kompatibility (zarovnať aj ďalšie odpočty, odmietnuť, alebo napr. uložiť odtlačok defov do obálky a pri nezhode varovať). — pôvod: ADR-031 · fáza: podľa potreby (prvá zmena balansu po vydaní)
- `AcceptContract` overuje pripravenosť prístavu len pri prijatí: odstránenie žeriavu alebo kotviska po prijatí (pred príchodom lode) sa nekontroluje. — pôvod: T06-07 (ADR-031 bod 1) · fáza: podľa potreby
- Prirodzenejšie trasy lodí: cena posunu bokom a otočenia ako vážená cena v defe (napr. `shipNavigation.sidewaysMoveCost`, `turnCost` namiesto lexikografickej ceny manévrov, ktorú F6 len presunula do defu ako `turnManeuvers` / `sidewaysManeuvers`), prípadne pokuta za blízkosť pobrežia a kotvísk (v kóde neexistuje). — pôvod: T5B-02 (ADR-029), ADR-031 bod 7 · fáza: podľa potreby

## Z Fázy 6a
- `lostUnits()` v tests/sim/helpers/f6a.ts je tautológia (liveCount = created − exported − shipped) — nahradiť nezávislým počtom jednotiek v ledgeri. — pôvod: T6A-10a · fáza: F6c
- Pod hákom je dual cycle zriedkavý (7 z 36 nakládok v e2e): import sa vyloží skoro celý skôr, než prídu exporty pod hák; zvážiť plánovanie dvojcyklu (priorita exportu na ceste k žeriavu) — balans/priepustnosť. — pôvod: T6A-10a · fáza: F10a/F13
- Booking po lehote s naloženým nákladom končí `completed` s pomernou výplatou (nie `failed`) — overiť s balansom a dizajnom penalizácií. — pôvod: T6A-09b · fáza: F13
- Tokeny `--cargo-import` / `--cargo-export` v design/tokens.css namiesto dočasného mapovania v render/UI. — pôvod: T6A-06 · fáza: F13

## Z Fázy 6c
- **Vetvenie podľa druhu kontraktu/misie → polymorfné vlastnosti** (review T6C-07b, m3): tri miesta ešte vetvia podľa `kind` / misie namiesto vlastnosti triedy — `trucks/empty-plan.ts:42`, `world/world-invariants.ts:834` a `:1057`, `contracts/contract-book.ts:367`. Presunúť na polymorfné vlastnosti `Contract` / tabuľky misií (pravidlo 7), aby ďalší druh kontraktu (F7) nevyžadoval úpravu týchto miest. — pôvod: T6C-07 review · fáza: F7
- **Farby druhov nákladu nie sú zjednotené:** v inšpektore depa je `--ui-accent` tam, kde odznak depa používa `--ui-warning`; tranship je na mape oranžový (ako import), v inšpektore fialový (`--mi-tranship`). Zaviesť jeden token `--cargo-tranship` (spolu s `--cargo-import` / `--cargo-export` z F6a) a použiť ho v renderi aj UI. — pôvod: T6C-07 review (render + UI) · fáza: F13
- **Zmiešaná skupina export + repositioning ukazuje text exportu pri chýbajúcom depe:** sim vracia pre skupinu ponuky jediný dôvod (`no_storage_for_category`), takže karta skupiny nevie, či chýba sklad exportu alebo depo prázdnych repositioningu. Vrátiť dôvod po kontraktoch (alebo rozlíšiť článok) a v UI zobraziť text príslušného druhu. — pôvod: T6C-07 review (UI) · fáza: F13
- **Repositioning a tranship sa ponúkajú len v prístave s depom prázdnych** (ADR-034 dodatok T6C-03 bod 1): prístav bez depa o tieto druhy neprichádza a hráč nevie, prečo sa neobjavujú. Zvážiť tranship bez depa (obsah, ktorý nevyžaduje prázdne; stačí sklad kategórie) a hint v UI. — pôvod: T6C-03, T6C-07 review · fáza: F7/F11
- `tests/sim/__fixtures__/saves/generate-saves.ts` padá od F6a (booking ponuky, `toV6State`) — opraviť generátor. — pôvod: T6C-01 (ADR-034 dôsledky), T6C-09 · fáza: F7

## Z Fázy 6d
- **Plynulé natáčanie lode v rendereri:** kurz lode je kardinálny a otočenie o 180° na kotve (západná strana rejdy: plavba kurzom 270, na kotve `anchorageHeading` 90) je v prezentácii skok; renderer by mal uhol interpolovať (najkratší oblúk) počas posledného úseku. — pôvod: T6D-03 · fáza: F13
- **Obchádzka dlhej lode na rejde ide posunom bokom** (`sidewaysManeuvers`, ADR-029 B4): handy nemôže stáť zvisle bližšie k okraju mapy než polovicu svojej dĺžky, preto trasa k rade rejdy z východnej/západnej strany môže obsahovať úsek bokom; zvážiť vážené ceny manévrov (viď „Prirodzenejšie trasy lodí“). — pôvod: T6D-03 · fáza: F13
- **Validácia mapy:** rad rejdy musí ležať aspoň polovicu dĺžky najdlhšej lode od okraja mapy, kam loď zasahuje pri vstupe, a rozostupy anchorage ≥ dĺžka najdlhšej lode + 1 (dnes to stráži len test `anchorage-roadstead.test.ts` pre `harbor_01`, `validate:defs` nie). — pôvod: T6D-03 · fáza: F7
- **UI: stojisko a panel štatistík s vnútrozemím** — inšpektor brány už ukazuje „Vo vnútrozemí čaká“ s rozpisom a najdlhším čakaním (T6D-04); zostáva odznak pri stojisku, `hinterlandMetrics(world)` (priemer a maximum čakania) a `trucksWaitingInland`, `inlandWaitTicks`, `pickupBayStarvationTicks` do panelu štatistík. Hráč zatiaľ nevidí, prečo export / návrat nevošiel (stojisko nad kvótou, staging, miesto v sklade). — pôvod: T6D-01 (ADR-035) · fáza: F7 (UI)
- **Save v8, ktorý už uviazol v zámke stojísk, sa migráciou nerieši:** kamióny v stojisku držia všetky bays a staging je plný importu čakajúceho na odvoz, vpustené kamióny sa nevyháňajú. Zvážiť limit čakania kamióna `delivery` v stojisku (vzdať sa a odísť, ako `collect`) alebo ponuku „vyčistiť stojisko“. — pôvod: T6D-01 (ADR-035) · fáza: F13
- **Rezerva kapacity dvora pre import:** export vojde, kým je voľné miesto v sklade, takže dvor sa môže zaplniť exportmi skôr, než príde loď s importom (import sa vyloží až po nakládke exportu cez dual cycle). Zvážiť podiel kapacity vyhradený pre import (analogicky `pickupReservedBays`). — pôvod: T6D-01 (ADR-035) · fáza: F7
- **Kamióny `pickup` nečakajú vo vnútrozemí ako zoznam:** vznikajú podľa dopytu (náklad na docku), `pickupBayStarvationTicks` len počíta tiky bez voľného bay; ak by sa mala čakajúca fronta importu zobraziť hráčovi, treba ju modelovať (plán odvozov). — pôvod: T6D-01 (ADR-035) · fáza: F13
- **Vozidlá pod hákom sa môžu prekrývať:** dve vozidlá s jobom na ten istý žeriav stoja v tej istej bunke pod hákom (kongescia je „soft“ model, ARCHITECTURE §7.6), takže sa na obrazovke kreslia cez seba. Zvážiť v F11 (kongescia) front pred hákom (druhé vozidlo čaká na nábreží o bunku ďalej). — pôvod: T6D-02 · fáza: F11
- **Bunka pod hákom je pri párnej šírke žeriava pol bunky mimo osi výložníka** (hook = ľavá zo stredných buniek, `modules/hook-cell.ts`): kontajner sa pri spúšťaní posunie z vozíka o pol bunky vedľa; pre presné vyrovnanie by žeriav potreboval nepárnu šírku footprintu alebo os výložníka v strede bunky (zmena assetov Claude Design). — pôvod: T6D-02 · fáza: F10a (ťahače / terminálové vozidlá)
- **Ťahače s návesmi a vozíky (reach stacker) pod hákom:** vozidlá pod hákom sú zatiaľ straddle carrier / empty handler (1 × 1); renderer ich kreslí nad základňou žeriava. Pri ťahačoch s návesom (F10a) sa bunka pod hákom a rozmer nábrežia pre vozidlo prehodnotia. — pôvod: T6D-02 · fáza: F10a
- **Rezervovať staging pre prvý čakajúci kamión vo vnútrozemí:** v ticku, keď sa rampa po výpadku cesty stane prevádzkovou, krok 5 (dispatcher) rezervuje všetky staging miesta pre odvoz skôr, než krok 8 vpustí kamión s exportom (`export_roundtrip`: 8× `JobCreated` v ticku 30 601, posledný export vojde až v 30 943 / 31 042 po začiatku lashingu a jednotka je rolled). Alternatíva: prisľúbiť 1 miesto pre prvý čakajúci kamión (`DockIntake`) aj pred vjazdom — zmení správanie a goldeny. — pôvod: T6D-05 review · fáza: F7
- **FIFO naprieč bookingmi pri vjazde exportu:** `admitExportTrucks` vybavuje kontrakty vzostupne podľa id, každý celý skôr než ďalší; skutočné FIFO podľa `dueTick` naprieč bookingmi by vyžadovalo zlúčené poradie splatných položiek všetkých kontraktov (ADR-035 bod 1 už opisuje skutočné poradie). — pôvod: T6D-05 review · fáza: F7
- **Čas vjazdu vs. buffer 0:** `landside_pressure` `inlandWaitTicks` 4 439 (režim `apron`) vs. 18 478 (`under_hook`, buffer 0), max 1 882 vs. 4 765 — vozidlá čakajúce pod hákom oneskoria odvoz importu a kamióny dlhšie čakajú vo vnútrozemí; vyváženie počtu vozidiel a `craneBufferSlots` v predvolenom prístave. — pôvod: T6D-05 review · fáza: F7 (balans)
- **Záruka miesta v sklade len v čase vjazdu:** `trucks/hinterland-room.ts` (`inboundRoom`: voľné miesta − rozbehnuté jednotky) garantuje miesto pre kontajner z kamióna v okamihu vjazdu; neskôr ho môže zaberať iný tok (import z lode), kým kamión čaká v stojisku / na docku. Súvisí s „Rezerva kapacity dvora pre import“. — pôvod: T6D-05 review · fáza: F7
- **Nečinné vozidlo zaparkované pod hákom blokuje odstránenie kotviska:** `module-rules.ts` `has_vehicles` pre kotvisko s jazdným nábrežím (vozidlo na jeho bunkách); obchádzka: `SellVehicle` alebo odjazd vozidla. Zvážiť odoslanie nečinného vozidla do depa pri `RemoveModule`. — pôvod: T6D-05 review · fáza: F7
- **`DEFAULT_ANCHORAGE_HEADING = 90` je konštanta formátu mapy v kóde** (`grid/map-def.ts`): chýbajúce `anchorageHeading` v mape berie 90 (západná strana rejdy). Zvážiť povinné pole mapy (a `validate:defs`), aby mapa nezávisela od konštanty v sime. — pôvod: T6D-05 review · fáza: F7
- **`stress_f6` `pickupBayStarvationTicks` 23 385 / 30 000:** dlhodobé preťaženie stojísk pre odvoz (dopyt po kamióne na odvoz nemá voľný bay ~78 % behu; pre-existing, T6D-01 metrika to len zviditeľnila). Vyváženie počtu stojísk / `pickupReservedBays` / priepustnosti brány. — pôvod: T6D-05 review · fáza: F7 (balans)
- **Žeriav drží jednotku bez priradeného vozidla, kým je celá flotila v `no_path`:** T6D-05b odkladá na apron len jednotky, ktorých priradené vozidlo uviazlo; jednotka bez vozidla (žiadne nečinné) sa pri bufferi 0 drží do návratu vozidla (zámerný dizajn buffer 0, ADR-033 dodatok T6D-02). Pri trvalo prerušenej sieti by žeriav po vyplnení apronu držal jednotku, kým sa cesta neopraví. — pôvod: T6D-05 · fáza: F7

## Nápady
- Pripravenosť exportu pri prijatí (`AcceptContract` → `export-readiness.ts`) nekontroluje dosiahnuteľnosť po ceste sklad → kotvisko (nakládka) a rampa → sklad (prijatie): booking sa prijme aj keď sklad kategórie nemá cestu ku kotvisku lode voyage, jednotky sa potom nenaložia a booking skončí pomerne / `failed`. — pôvod: review `src/sim` po T6A-05 (T6A-09b) · fáza: podľa potreby (F6a stabilizácia)
- Pripravenosť exportu nepočíta s rezervou stojísk (bays) pre kamióny s exportom: plán príchodov `booked` kamiónov v okne pred cut-off sa môže stretnúť s plným stojiskom (kamión počká, plán sa nespotrebuje), prijatie však overuje len existenciu rampy, jej prevádzkovosť a sklad kategórie. — pôvod: review `src/sim` po T6A-05 (T6A-09b) · fáza: podľa potreby (F6a stabilizácia)

## Vyriešené vo F6
- §14 SaveGame obálka duplikovala `version` / `seed` / `tick` z `WorldState` — obálka v app vrstve nesie len `saveVersion`, svet verzuje `world.version`. — pôvod: T01-17 · vyriešené: T06-01 (ADR-030), ARCHITECTURE §14 prepísaná v T06-10
- **AcceptContract bez overenia pripravenosti prístavu** (žeriav kategórie kontraktu, kotvisko pre triedu lode; loď sa mohla zablokovať) — `berthReadiness` → `no_berth_for_ship_class`, `no_crane_for_category`, `berth_unreachable`. — pôvod: T05-10 review · vyriešené: T06-07, T06-08b (ADR-031)
- **Pool po načítaní v4:** po migrácii v4 → v5 bol pool prázdny až do najbližšej `DayClosed` — pool z save spred kontraktov (v1–v4) sa doplní v prvom ticku po načítaní (`ContractBook.untouched`). — pôvod: T05-10 review · vyriešené: T06-07 (ADR-031 bod 4)
- Spätný prechod bránou v `gate_queue_out`: dvojité `trucksProcessed` pri odstránení/obnove strany brány — nevzniká od review T04-11 (`completePass` počíta len dokončený prechod), pribudol regresný test aj so save uprostred prerušenia. — pôvod: T04-04, T04-11 · vyriešené: T06-07 (test)
- Ramp operability cache v dispatcheri: prevádzkovosť rampy aj ceny ciest boli už memo podľa `roadVersion` / `moduleVersion`; zrušenie open outbound jobov teraz beží len po zmene verzií (`OutboundCancelGate`). — pôvod: T04-11, T04-12 · vyriešené: T06-07 (ADR-031 bod 5)
- WorldState v4 restore: validácia brán, stojísk, rámp a kamiónov pri parse (chýbajúce konektory a moduly) — väzby kamiónov na moduly s cestou poľa (`checkTruckRefs`) a hranica odpočtu (`truckWaitLimit`, zarovnanie pri obnove); ostatné body pokrývala obnova už od T04-04 / T04-11 / ADR-029. — pôvod: T04-04, T04-11 · vyriešené: T06-07, T06-08b (ADR-031)
- `validate:defs`: krížová kontrola manifest ↔ def — `berth.params.apronSlots` = počet slotov v `assets/manifest.json`, `vehicle_depot.capacity` = stalls, `loading_ramp_*.docks` = docks, `truck_waiting_area.bays` = stalls. — pôvod: T5B-01 · vyriešené: T06-06
- Konštanty lodnej navigácie v kóde (pravidlo 4): `WaterNavigator` a geometria rezervácií čítajú `logistics.json` → `shipNavigation` (`approachMarginCells`, `sweepStepCells`, `turnManeuvers`, `sidewaysManeuvers`) so schémou a `ShipNavigationDef`. — pôvod: T5B-02 (ADR-029) · vyriešené: T06-07 (ADR-031 bod 7)
- **UI: karta brány s čakajúcimi kamiónmi vo vnútrozemí (časť)** — inšpektor brány ukazuje riadok „Vo vnútrozemí čaká“ s počtom, rozpisom odvoz / dovoz / výdaj prázdnych a najdlhším čakaním v hodinách a minútach herného času (`hinterlandQueue`, `hinterlandData`, `hinterlandRows`, `formatWaitDuration`); zvyšok (stojisko, panel štatistík) ostáva v „Z Fázy 6d“. — pôvod: T6D-01 (ADR-035) · vyriešené: T6D-04
- **Toast „Výdaj prázdneho zlyhal“ hovoril „kamión odišiel prázdny“** aj pre kamión, ktorý sa vzdal vo vnútrozemí — pri `EmptyPickupMissed.truckId === null` je text „kamión do prístavu nevošiel“ (zmiešaná dávka má všeobecný text). — pôvod: T6D-01 (ADR-035) · vyriešené: T6D-04

## Nápady
- Sim vo Web Workeri (ak tick > 8 ms pri 8×). — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F13
- Export kontrakty land → ship. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F12
- Pôžičky. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: ?
- Level crossing cesta × koľaj. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F10+
- Kontajnerové stacky ako 3D vizualizácia zaplnenosti vs 5 stavov spritu. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F3+

## Z Fázy R1
- Uviaznutie pri 20 vozidlách (stress_f6 `stuckAtEnd` 11): dvojice vozidiel sa v križovatke a na prístupovej bunke nemajú kam vyhnúť, lebo sloty blokuje chvost alebo telo druhého vozidla bez možnosti ústupu. Riešiť jednosmernými pruhmi modulov pri nábreží alebo F10a (pruhy do modelov navyše, R3/R4). — pôvod: TR1-09b (ADR-037 dodatok) · fáza: R3/R4
- `traffic_stress` len 16 vozidiel, lebo depá majú kapacitu 10 — mapa teda uniesie 20 vozidiel max (2 depá). Zvýšenie kapacity depá alebo počtu depá v balansovanom prístave (R3, balans). — pôvod: TR1-04, ADR-037 dodatok TR1-09b · fáza: R3 (balans)
- Starý render stojiska a docku: konstanta `TRUCK_LENGTH_PX` pre kamión dlhý 3 bunky, hoci render vozidla sú kĺbové. Pri R4 (rampa zaniká za jednosmernými pruhmi) sa vizuál opraví. — pôvod: T04-06, T04-11, T5B-07 · fáza: R4
- `ModuleVM.parkedVehicles` v app namiesto `parkedVehicleIds` zo specifikácie (VM ponechal zažradenú vlastnosť bez zmeny na kompatibilitu; render ju nepoužíva, inšpektor si dáta mapuje). — pôvod: TR1-08 · fáza: podľa potreby

## Z Fázy R2
- Zápcha R1 pri 100 000 tickoch: `stress_f6` a `traffic_stress` (DEFS) majú 13–14 zaseknutých vozidiel v čelnej kolízii na križovatke 43–45, 22–24 — zvyšok R1, riešenie R3/R4. — pôvod: TR2-05, TR2-07 · fáza: R3/R4
- Latentná chyba rezervácie apronu v dual cykle: nezhoda `[1,3,5] ≠ [1,5]` pri skúšobnej konfigurácii s viacerými žeriavmi — test `f2-stacks` zaznamenala prípad, vyriešiť v R3. — pôvod: TR2-04 (UI audit), TR2-06 · fáza: R3
- Riziko ramp-bound importu bez cieľa rehandlingu: fronta priorít v R3. — pôvod: TR2-06b (ADR-039 dodatok) — **vyriešené** únikem po `rehandleGiveUpTicks` (job dostane `rehandleAt === null` a čaká)
- Zosúladenie hint poolu kontraktov (`capacityUnits` 64 v defoch) s fyzickou kapacitou bloku 48 TEU (32 slots × 2 vrstvy pod `container_yard_small` geometriou, alebo 64 / 1.33 kvôli 40′ párom). — pôvod: TR2-04 (ADR-039) · fáza: R3 (balans)
- Odstránenie nepoužitých starých alokátorov: `allocateGroupedStorage`, `allocateEmptyStorage`, a podľa potreby `allocateExportStorage` / `allocateStorage` ak namiesto nich fungujú jobami. — pôvod: TR2-02 · fáza: R3
- Režim výšky stohu „Odznak" v nastaveniach (render overlay s maximálnou výškou bloku), podľa potreby pre hráči pri visuálnej orientácii vo veľkých stohoch. — pôvod: design/tasks/UI·výšky-stohu (TR2-09 UI render) · fáza: R4+
- Akceptácia „random > 1" na `vertical_slice` neľahko dosiahnuteľná bez seed tuningu (random uviazne vo fragmentovanom bloku); náhrada je test `yard-contrast` s pevnou geometriou a semenami — **vyriešené** testom `yard-contrast`. — pôvod: TR2-08 (scenár vertical_slice) · fáza: R3

## Z Fázy R3 (TR3-02)
- **Čakanie STS na ťahač (TR3-02b, stále otvorené):** zmerané `tt_rtg` 100 000 ticků: 6 ťahačov ≈ 66 %, 8–10 ťahačov ≈ 62 % (viac ťahačov nepomáha), 1 STS : 1 RTG ≈ 24–26 %. Druhý `rtg_block` v scenári sa nepoužije (0 presunov): plánovač (`chooseYardSlot`) berie vždy najbližší blok, prekládka 120 TEU sa zmestí do prvého. Cieľ < 20 % vyžaduje rozloženie jednotiek medzi bloky (vyváženie podľa vyťaženia stroja) alebo viac strojov na blok (`machinesPerBlock`). Nájdené pri pokuse o dva bloky: prefetch RTG (`startPrefetch`) môže začať cyklus pre ťahač, ktorého predbehne iný ťahač v pruhu (jednosmerný pruh, TP bližšie k vjazdu) → stroj čaká na ťahač, ktorý sa k TP nedostane (zápcha v pruhu pri ≥ 8 ťahačoch a 2 blokoch); oprava: prefetch len pre ťahač už v pruhu / na vjazde bez ťahača vpredu s bližším TP. — pôvod: TR3-02b · fáza: R3 (TR3-06) / R4
- **(pôvodný záznam TR3-02) Čakanie STS na ťahač pri 1 RTG na blok:** `tt_rtg` (2 STS, 1 RTG blok, 6 ťahačov) dá `stsWaitForTractorPct` ≈ 60 % (cieľ < 20 %). Príčina je kapacita stroja, nie ťahače: STS cyklus 12 ticků (30 presunov/h) vs RTG cyklus ≈ 14–15 ticků (26 presunov/h) — dva STS potrebujú ≈ 2 RTG na blok. Riešenie: viac strojov na blok (`machinesPerBlock`, obchádzanie ťahačov v pruhu), alebo prejazdný pruh s viacerými TP súčasne. — pôvod: TR3-02 · fáza: R3 (TR3-06) / R4
- **`stress_f6` 100 000 ticků, zvyškové zápchy R1 (TR3-02b, len hlásené):** pozri ADR-040 dodatok TR3-02b. — pôvod: TR3-02b · fáza: R3
- **Ťahač po vykládke stojí v pruhu RTG bloku, kým ho dispatcher nepošle ďalej** (`idle` bez cesty z pruhu, ak výjazd bloku nie je pripojený): blok bez výjazdovej cesty sa dá postaviť, ťahače v ňom uviaznu. Overiť pripojenie oboch konektorov (vjazd aj výjazd) pri `AcceptContract` / v dispatcheri. — pôvod: TR3-02 · fáza: R3 (TR3-06)
- **STS čaká na ťahač ≈ 62 % (TR3-02c):** s dvoma vyváženými RTG a 10 ťahačmi sa nezlepšilo; príčina je latencia dispatchu pod hákom (job vzniká pri štarte cyklu žeriava, `PAIRED_HOOK_LOAD_JOBS_PER_CRANE` = 1, `craneBufferSlots` 0): dopredné plánovanie jobov / predpozicovanie ťahačov pri háku. Prefetch problém z TR3-02b opravený (poradie pruhu). — pôvod: TR3-02c · fáza: R3 / R4
- **Obeh ťahačov ≈ 67 buniek obmedzuje STS (TR3-02d):** STS čaká ≈ 58 % aj s `hookJobLookahead` 6; potrebný by bol kratší návrat z bloku (obojsmerný výjazd / druhý vjazd, druhé depo pri kotvisku) alebo ≈ 22 ťahačov; dodatok k `PAIRED…` v riadku TR3-02c (latencia dispatchu) je vyriešený oknom, zostáva geometria okruhu. — pôvod: TR3-02d · fáza: R3 / R4
- **Výber RTG kliknutím:** hráč vyberie RTG priamo na mape (nie len cez inšpektor bloku), ako pri žeriavoch. — pôvod: R3 (výsledok fázy) · fáza: R4 (UI)
- **RTG obsluha kamiónov:** RTG pri bloku obsluhuje aj kamióny (rampa / stojisko) podľa `HANDLING_CHAINS`; dnes len STS ↔ TT ↔ RTG. — pôvod: R3 (výsledok fázy) · fáza: R4
- **Reach stacker:** vozidlo s dosahom pre OOG plochu; presunuté z R3 (ADR-040 bod 8). — pôvod: R3 (výsledok fázy, ADR-040 bod 8) · fáza: R5

## Z Fázy R4 (TR4-01)
- **`traffic_stress` beží na seede 6015 (hack):** pôvodný seed po zmene prúdu `Rng` (ADR-041) zahltil križovatku; seed bol zvolený tak, aby scenár dobehol bez zápchy. Latentná zápcha ostáva (jedna križovatka s frontou do križovatky) — vlastní ju TR4-02 (100 000 ticků bez zápchy v `stress_f6` a `live_terminal`). — pôvod: TR4-01 · fáza: R4
- **`stress_f6` 40 000 ticků: 6 udalostí zápchy (`gridlockEvents`), `lostUnits` 0, `stuckAtEnd` 0** — rovnaká príčina, rieši TR4-02 (`access` modulov, druhý výjazd bloku). — pôvod: TR4-01 · fáza: R4
- **Rampa a stojisko ostávajú ako interné moduly** (ADR-041 prechodné stavy): kamióny ich zatiaľ používajú ako cieľ nakládky; BuildBar ich stále ponúka, UI karta TR4-04 ich schová, TR4-02 (TP pri blokoch) ich zruší spolu s `loading_ramp_*` a scenármi. — pôvod: TR4-01 · fáza: R4
- **Odstavná plocha `truck_holding` je len def a trieda** bez správania (kamióny ju nepoužívajú). — pôvod: TR4-01 · fáza: R4 (TR4-02)
- **Odstránený test „vzájomné ťahanie čelných rámp“ (tie-test facing-ramp):** s jednosmernými pruhmi (ADR-041) sa dva vzájomne čelné vstupy do jedného úseku nestavajú; ak sa v R4+ vrátia obojsmerné rampy, test obnoviť. — pôvod: TR4-01
- **e2e špecifikácie (`tests/e2e/f3-road-build`, `f4-export-chain`, `f4-ui-demo`, `f5-vertical-slice`, `f6a-export`) a demá (`src/ui/__demo__`, `src/render/__demo__`) odkazujú na `truck_gate`/starý tvar brány:** upraví TR4-05 (napojenie VM, e2e) spolu s renderom (TR4-03) a UI (TR4-04); `pnpm test` (vitest) je zelené. — pôvod: TR4-01 · fáza: R4
- **Jeden vjazd plochy ≈ 70 kamiónov/h** (kamión dlhý 3 bunky pri 0,6 bunky za tick): špička 100/h vyžaduje dve plochy alebo dva portály (scenár `r4-gate-peak`). Ak treba jednu plochu na 100/h, zvážiť kratší kamión alebo druhý vjazd plochy. — pôvod: TR4-01 · fáza: R4+

## Z Fázy R4 (TR4-02)
- **Vyriešené v TR4-02:** `traffic_stress` beží na pôvodnom seede 6014 (100 000 ticků bez zápchy), `stress_f6` aj `live_terminal` 100 000 ticků bez `TrafficJam` a `stuckAtEnd` 0; rampa, čakacia plocha a ich scenáre zrušené; `truck_holding` má správanie (volanie z TOS). Zodpovedajúce riadky z TR4-01 sú tým uzavreté.
- **Odstránené testy kruhov „hook bez cesty“ (`hook-no-path`):** na jednosmernej priečnej ulici s jedným dvorom vozidlo bez trasy do depa a kamióny bez trasy späť uviaznu (zámerne nevyriešené, dnes testuje len prerušenie cesty). Ak sa vrátia obojsmerné rampy alebo druhé depo, obnoviť. — pôvod: TR4-02
- **Nečinné vozidlo parkuje na ceste:** keď depo nie je dosiahnuteľné jednosmernou cestou, nečinné vozidlo môže zablokovať jednosmernú ulicu; pri zadávaní stavby overiť pripojenie depa k okruhu. — pôvod: TR4-02
- **Časovanie scenárov `export_roundtrip` a `export_inbound`:** `RemoveRoad` / `PlaceRoad` v scenároch zachytávajú prechod posledného kamióna po cut-offe; v režimoch `apron` a `under_hook` majú inú trasu, preto okná (24 380 – 25 050 a 29 300 – 29 700) závisia od priepustnosti kamiónov. Pri zmene priepustnosti pregenerovať. — pôvod: TR4-02
- **Priepustnosť kamiónov a zlom uviaznutia:** viac kamiónov na TP znamená viac tokenov držaných v okruhu; pri 12 dvoroch na jednej ceste (`r4-gates-layout`) a režime pruhov `trouble` sa kamióny naúčtujú na spoločnom pruhu s straddle carriermi — test rozloženie oddeľuje jednosmerným okruhom. — pôvod: TR4-02
- **`in_train`:** lokácia nákladu nemá vstupný prechod (vlak príde vo fáze R7); `assertCargoConservation` ju zatiaľ vždy počíta ako 0. — pôvod: TR4-02 · fáza: R7
- **Špička 100/h:** pri jednom súbore tokenov (12 TP + 60 státí) sa 100 jednotiek za hodinu nerozloží do vzniku kamiónov v jednej hodine (≈ 69/h); zvýšiť počet státí / TP, alebo dovoliť vznik kamiónov nad kapacitu tokenov so státím vo vnútrozemí. — pôvod: TR4-02 · fáza: R4+
- **Manifest `assets/manifest.json`:** sprity `truck_waiting_area`, `loading_ramp_*` ostali ako sirotské záznamy (render a UI ich ešte odkazujú v `src/render/waiting-area-decor.ts`, demách a e2e); odstrániť v TR4-03 / TR4-05 spolu s renderom. — pôvod: TR4-02
- **Férovosť výjazdu z brány:** kamión v `gate_pass` čaká na voľný slot výjazdovej bunky pruhu, kým ho zahlcuje prejazdná doprava k odstavným plochám (špička 100/h: pobyt ≈ 1 470 – 1 680 ticku, nikdy trvalé uviaznutie); zvážiť prednosť výjazdu z brány pred prejazdnou dopravou. — pôvod: TR4-06b · fáza: R4+

## Z Fázy R4 (TR4-07)
- **Kapacita TP a státí pri špičke 100/h:** pozri „Špička 100/h“ v „Z Fázy R4 (TR4-02)“ (nezdvojené). — pôvod: TR4-07 · fáza: R4+
- **Férovosť výjazdu z brány:** pozri položku v „Z Fázy R4 (TR4-02)“ (nezdvojené). — pôvod: TR4-07 · fáza: R4+
- **STS čaká na ťahač ≈ 60 %:** pozri „Z Fázy R3 (TR3-02)“ (TR3-02b, TR3-02c, TR3-02d; nezdvojené). Geometria okruhu ostáva otvorená. — pôvod: TR4-07 · fáza: R4+
- **Zrušené ukážky dock-maneuver/rampa:** pozostatok po TR4-05b, stav treba potvrdiť. — pôvod: TR4-07 · fáza: R4 (docs)
- **WorldState v13:** plán R4 (ADR-041) uvádza save v12; číslo treba potvrdiť. — pôvod: TR4-07 · fáza: R4 (docs)
- **Artefakt verzia 12:** otvorené pri zverejnení artefaktu R4. — pôvod: TR4-07 · fáza: R4 (artefakt)

## Z Fázy R5 (TR5-02)
- **`rs_area` (8 × 4, 3 rady × 5/4/3 kontajnerov):** vyžaduje per-rad `maxTier` v `YardBlock` / `StackGrid`; plán R5 ju označil za voliteľnú. — pôvod: TR5-02 · fáza: R5+
- ~~**Reefer blok a OOG plocha v 100k `live_terminal`**~~ — vyriešené v TR5-02b (príčina: jednosmerná slepá cesta na vjazde bloku, nie okruh; scenár `live_terminal_mix`, ADR-042 dodatok TR5-02b). — pôvod: TR5-02 · fáza: R5
- **Kapacita TP a státí pri špičke 100/h (R4):** nezmenené (zmena `truck_holding.stalls` posúva všetky scenáre R4). — pôvod: TR5-02 · fáza: R5+
