# BACKLOG.md — Modular Harbor

Nápady a problémy mimo aktuálnej fázy (CLAUDE.md, pravidlo 8). Každá položka: popis, pôvod (karta/fáza), návrh fázy.

## P0
–

## P1
- ReleaseParcel pri cestách/koľajach na prenajatej parcele nie je určené (ADR-008 ich tam povoľuje, §5.2 blokuje ukončenie prenájmu len pri moduloch): zostanú, odstránia sa s refundáciou, alebo ukončenie zablokujú? Rozhodnúť ADR-om. — pôvod: T00-19 · fáza: pred F7
- Agent test-runner doslova volá simrun data/scenarios/vertical_slice.json, ktorý neexistuje do F5; dovtedy sa používa smoke.json. — pôvod: T00-13 · fáza: F5
- §14 SaveGame obálka duplikuje version/seed/tick z WorldState v1 → rozhodnúť ADR-om. — pôvod: T01-17 · fáza: F6
- CraneSystem natvrdo počíta s cyklom kontajnerového importu → krok cyklu presunúť do podtried CraneModule alebo stratégie (§17 bod 5), inak bulk/liquid žeriav (flowUnitsPerTick) vynúti zásah do systému. — pôvod: review T02-13 · fáza: pred F7
- Idle vozidlo ostáva stáť na prístupovej bunke (návrat do depa chýba) a blokuje RemoveRoad tej bunky; open joby s odpojeným cieľovým skladom držia sloty a naložené vozidlo cyklí v no_path → návrat do depa + preradenie jobov + udalosť pre toast. — pôvod: T03-06, T03-13 · fáza: F4
- `has_trucks` validácia pri odstránení brány/stojiska/rampy s kamiónmi (T04-02 nechal hook, T04-04 dodá logiku); odčítavanie trudy pri obnove modulov. — pôvod: T04-02, T04-12 · fáza: F4 (zásuvka existuje)
- Kamión v `no_path` s rezervovaným bay a dock: buď vrátiť do depa a zrušiť job, alebo vypršať a despawnúť; možno nový stav `stuck` a ADR; event `TruckNoPath` pre toast. — pôvod: T04-04, T04-11 · fáza: F5
- **AcceptContract bez overenia pripravenosti prístavu:** žeriav kategórie kontraktu a dĺžka brežu; loď sa môže zablokať na kotvisku. — pôvod: T05-10 review · fáza: F5–F6

## P2
- **Hladovanie `free`** (T05-10 review, minor, staging share): vol. priestor v sklade sa neprideluje pri `failed` kontraktoch → sklad zablokovaný; voľné sloty sa prideľujú pri výklade aj v stave `unloading`, nie len pri `exporting`. — pôvod: T05-10 review · fáza: F5–F6
- **Neohraničené penalizácie:** demurrage a late by mali byť ohraničené ≤ reward; pri bankrote. — pôvod: T05-10 review · fáza: F5–F6
- **`StoredCargoIndex` O(skupina):** splice pri odstránení kontraktu je O(n); použiť heap alebo bitset. — pôvod: T05-10 review · fáza: F6
- **Pool po načítaní v4:** po migráciida v4→v5 je pool prázdny, väčší skok k prvej ponuke (až nasledujúca DayClosed); vyplniť pool pri migácii. — pôvod: T05-10 review · fáza: F6
- **Free/failed wait behind SLA** (outbound priority): jednotky bez kontraktu a `failed` sa nemajú odohrať pred SLA jednotkami. — pôvod: T05-10 review · fáza: F5–F6
- **TopHUD panel icons bez funkcie:** ikony Financie/Štatistiky/Tech (Finance/Stats/Tech) sú clickable no-op → zablokiť alebo schová. — pôvod: T05-07 · fáza: F5–F6
- **contractsRevision** oddelené od REVISION_EVENTS → sledovanie zmien kontraktu. — pôvod: T05-07 · fáza: F6
- **E2E pre bankrot a novú hru:** test GameOver modalu a reštartu. — pôvod: T05-07 · fáza: F5
- **Toast sa zatvára aj počas pauzy:** auto-close by mal byť deaktivovaný (paused game). — pôvod: T05-12 · fáza: F5–F6
- **Orezaný výrez mapy pri paneli:** pri otvorení ContractsPanel sa mapa kreslí cez ľavý okraj panelu. — pôvod: T05-06 · fáza: F13 (vizuál)
- **Údržba ciest a modifikátory miezd:** road maintenance (nonzero v F5), wage tech modifiers (tech modifikátory pre mzdy vozidiel). — pôvod: T05-02 · fáza: F7–F8
- Štartové cesty z mapy (starter.roads, 30 buniek) sú zadarmo, ale RemoveRoad za ne vráti 50 % aktuálnej ceny (~$30k) — drobný exploit; pri moduloch vyriešené refundáciou zo zaplatenej ceny (ADR-015), pri cestách zvážiť to isté. — pôvod: T01-04, T02-04 · fáza: F13 (balans)
- Späť cez stojisko (čakacia plocha) nemá čas prechodu → kamión v `gate_queue_out` sa okamžite ocitne na výstupe. — pôvod: T04-04, T04-11 · fáza: F5
- Spätný prechod bránou v `gate_queue_out`: ak sa strana brány odstráni/obnoví pri prechode, fronta sa počíta znova a `trucksProcessed` sa zdvojí. — pôvod: T04-04, T04-11 · fáza: F6
- Brána čakala na cestu spoza seba (za portálom) pri určovaní prevádzkovosti rampy → t.č. sa oveľuje len cesta ku bráne; spätná cesta je optická. Rozhodnúť. — pôvod: T04-11 · fáza: F5
- Fronta brány sa kreslí čísle pri vstupnej strane (cell konektora), nie pri portáli; pri vizuálnych úpravách asset brány skontrolovať kolíziu s kabínou kamióna v `gate_queue`. — pôvod: T04-10, T04-06 · fáza: F13 (vizuál)
- Dlhý kamión v ľavej zákrute prečnieva asfaltu. — pôvod: T04-06, T04-11 · fáza: F13 (vizuál)
- Dispatcher paркuje idle vozidlá mimo depa na bunke docku; môžu sa prekrývať s kamiónmi v stojisku. — pôvod: T04-10 · fáza: F13
- Ramp operability cache v dispatcheri (F6 profiling): krok 8 opakuje isRampOperational za každý rampu. — pôvod: T04-11, T04-12 · fáza: F6
- DefRegistry: cross-validation kamión.cargoCategories vs ramp.params.category (vzor ALU manifest); schéma pre truck_container footprint. — pôvod: T04-01, T04-05 · fáza: F8
- WorldState v4 restore: validácia gates, waiting areas, ramps, trucks pri parse — omamené konektory, chýbajúce moduly. — pôvod: T04-04, T04-11 · fáza: F6
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
- validate:defs: krížová kontrola manifest ↔ def (capacity = slots × layers, stalls, connectors, footprint) priamo v nástroji; techRequired vozidiel a modulov voči tech_tree.json. — pôvod: T03-01, T03-04 · fáza: F8
- Geometria: cellCenter/cardinalHeading zo ships/ship-route do spoločného modulu; zdieľaný typ deps pre ShipView/VehicleView/CargoSprite; expectedSlotCapacity v invariantoch polymorfne namiesto instanceof. — pôvod: T03-02, T03-04, T03-08 · fáza: podľa potreby

## Z Fázy 5b
- SVG kontajnerov na dvore (`container_yard_*_fill*.svg`) má 47×17 px a nezodpovedá mierke TEU 64×26 (DESIGN_BRIEF §4.1, tabuľka mierok); SVG modulov sa v F5b nemenili. — pôvod: T5B-03 (audit mierky) · fáza: F13 (grafika)
- Kontajnery na palube lode: vykresliť náklad na lodi podľa počtu jednotiek (`ShipVM.unitsOnBoard`); sprity lodí ho majú nakreslený staticky a nesúladne s TEU (DESIGN_BRIEF §4.1). — pôvod: T5B-03 · fáza: F12
- Šírka pruhu cesty je v renderi 26 px (`LANE_WIDTH_PX` = polovica asfaltu 52 px), DESIGN_BRIEF uvádza aj 32 px (§4.1: pruh 32 px by vyžadoval prekresliť moduly) → zjednotiť dokument alebo render. — pôvod: T5B-03 · fáza: F13
- Footprint straddle carrieru v sime (nosič na jednej bunke cesty) vs. vizuál 34×62 px (presahuje pruh o 4 px na stranu) → zosúladiť pri vybavení skladu. — pôvod: T5B-03 · fáza: F10a (vybavenie skladu)
- DESIGN_BRIEF §5.6 (entity) aktualizovať podľa novej mierky (§4.1) a manévru kamióna (cúvanie do docku). — pôvod: T5B-03 · fáza: F13
- `validate:defs`: krížová kontrola `berth.params.apronSlots` = počet slotov v `assets/manifest.json`, depo `capacity` = počet stalls a rampa `docks` = počet dockov v manifeste (rozširuje položku o kontrole manifest ↔ def v P2). — pôvod: T5B-01 · fáza: F6 (stabilizácia)
- Tretí dock rampy (`loading_ramp_container.docks` 3) vyžaduje konektor, záznam v manifeste, SVG a manéver kamióna; riešiť podľa kongescie na rampe. — pôvod: T5B-01 · fáza: F7/F11
- Vzdialený prečerpávací terminál (bója/SPM pre tankery mimo nábrežia). — pôvod: spätná väzba M1 (F5b) · fáza: F9/F12
- Balans: `truck_waiting_area.bays` 6 < 2 docky × `stagingPerDock` 4 = 8 kamiónov → občasné `NoWaitingBay` (vertical_slice: 2×); zvážiť 8 stojísk (asset 4×3 to unesie pri rozostupe 32 px) alebo nechať ako signál pre hráča postaviť ďalšie stojisko. — pôvod: T5B-07 · fáza: F13 (balans)
- `loadTicksPerUnit` 6 (0,6 s pri 1×) je kratší než animácia cúvania (1,6 s); render to dobieha `DOCK_CATCH_UP`. Zvážiť dlhšiu nakládku (zmení balans a goldeny). — pôvod: T5B-07 · fáza: F13 (balans)
- Manéver kamióna v renderi beží na reálnych hodinách → pri 4×/8× zaostáva za simom; prejsť na hodiny v simovom čase. — pôvod: T5B-07 · fáza: F13 (vizuál)
- DESIGN_BRIEF §5.1: doplniť, že hrana nábrežia `quay_edge_n` sa otáča o 1–3 štvrťotáčky pre boky mól (žiadne nové assety). — pôvod: T5B-07 · fáza: F13 (dokumentácia)
- Ceny trás lodí sú v kóde, nie v defe (pravidlo 4): `WaterNavigator` (`src/sim/ships/water-navigator.ts`) má lexikografickú cenu (pohyb, potom manévre; krok bokom a otočenie = 1 manéver) so štrukturálnou škálou z veľkosti mriežky a `logistics.json` nemá `shipNavigation` → presunúť do defu (napr. `sidewaysMoveCost`, `turnCost`) pre prirodzenejšie trasy; pokuta za blízkosť pobrežia/kotvísk v kóde zatiaľ neexistuje, zvážiť ju spolu s tým. — pôvod: T5B-02 (ADR-029) · fáza: F6 (stabilizácia)
- Konvoje na sea lane (časovo-priestorová rezervácia namiesto rezervácie celej trasy; dnes je na dráhe naraz najviac jedna loď). — pôvod: T5B-02 (ADR-029) · fáza: podľa potreby (desiatky lodí)
- Validácia mapy pre lodnú dopravu: anchorage mimo obálky sea lane a na otvorenej vode, šírka kanála ≥ `frontWaterCells` + šírka lode + 1. — pôvod: T5B-02 (ADR-029) · fáza: F6 (stabilizácia)
- Memo kandidátov pre lode pred vstupom podľa triedy lode (dnes sa počíta pre každú loď zvlášť). — pôvod: T5B-02 (ADR-029) · fáza: F6 (profiling)
- Úprava pobrežia hráčom: drahé mólo a zásyp podľa ADR-028 (príkazy `BuildPier` / `ReclaimLand`, verzia mutácie terénu, prekreslenie terénu, invalidácia `WaterNavigator`). — pôvod: spätná väzba M1 (F5b), ADR-028 · fáza: F12

## Nápady
- Sim vo Web Workeri (ak tick > 8 ms pri 8×). — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F13
- Export kontrakty land → ship. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F12
- Pôžičky. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: ?
- Level crossing cesta × koľaj. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F10+
- Kontajnerové stacky ako 3D vizualizácia zaplnenosti vs 5 stavov spritu. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F3+
