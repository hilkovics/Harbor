# BACKLOG.md — Modular Harbor

Nápady a problémy mimo aktuálnej fázy (CLAUDE.md, pravidlo 8). Každá položka: popis, pôvod (karta/fáza), návrh fázy.

## P0
–

## P1
- ReleaseParcel pri cestách/koľajach na prenajatej parcele nie je určené (ADR-008 ich tam povoľuje, §5.2 blokuje ukončenie prenájmu len pri moduloch): zostanú, odstránia sa s refundáciou, alebo ukončenie zablokujú? Rozhodnúť ADR-om. — pôvod: T00-19 · fáza: pred F7
- Agent test-runner doslova volá simrun data/scenarios/vertical_slice.json, ktorý neexistuje do F5; dovtedy sa používa smoke.json. — pôvod: T00-13 · fáza: F5
- WorldState v1 nemá moduleId/traffic → WorldState v2 + migrate(v1 → v2). — pôvod: review T01-13 (world-state.ts:27) · fáza: F2
- Testovací helper assertCargoConservation volá world.cargo?.assertConservation cez `as unknown as` → typované volanie + test, že ledger existuje. — pôvod: review T01-13 (tests/sim/helpers/invariants.ts:22) · fáza: F2
- §14 SaveGame obálka duplikuje version/seed/tick z WorldState v1 → rozhodnúť ADR-om. — pôvod: T01-17 · fáza: F6

## P2
- Štartové cesty z mapy (starter.roads, 30 buniek) sú zadarmo, ale RemoveRoad za ne vráti 50 % ceny (~$30k) — drobný exploit; zvážiť neodstrániteľné/nerefundovateľné štartové cesty alebo refundáciu len za zaplatené bunky. — pôvod: T01-04 · fáza: F13 (balans)
- Sprite AGV nemá „nižší, modrý pás“ z DESIGN_BRIEF §5.6 — je žltý ako straddle carrier; pri 32 px sú rozlíšiteľné len tvarom. Iterovať v Claude Design (vzorový prompt v §8) pred F8 (odomknutie AGV). — pôvod: Claude Design relácia 4 · fáza: F8
- Konektory modulov: kanonický zdroj sú assets/manifest.json → sprites.*.connectors (všetkých 23 modulov, Claude Design relácia 6); design/modules.html je len referenčný hárok — prevziať do modules.json vo F2–F4 alebo vedome odchýliť. — pôvod: Claude Design relácie 3 a 6 · fáza: F2
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
- Selektor .constructor zhodí aj legitímne (this.constructor as typeof A).k — vo F1 riešiť ModuleRegistry registráciou def → trieda (pravidlo 7) alebo new.target, nie výnimkou. Selektor Identifier[name='Math'] falošne hlási aj { Math: 1 } a x.Math. — pôvod: re-review T00-17 · fáza: F2 (ModuleRegistry)
- Import './' a '../' (s lomkou na konci) je v src/sim falošne zakázaný — povoliť alebo zdokumentovať. — pôvod: re-review T00-15 · fáza: podľa potreby
- RemoveRoad refundácia v double: floor(n × cost × rate) pri rate 0.29 dá −57999 namiesto −58000 → sadzba v bázických bodoch (celočíselne) alebo zapísať do ADR-012. — pôvod: review T01-13 (remove-road.ts:41) · fáza: F2
- World-state parseRoads nekontroluje ADR-008 (save s cestou na parcele na predaj sa načíta, cestu potom nejde odstrániť) → WorldStateError. — pôvod: review T01-13 (world-state.ts:124) · fáza: F6
- LoadedMap.grid je meniteľná šablóna dostupná cez world.map.grid; zápis sa prenesie do ďalších create/deserialize → createGrid() alebo typovo skryť. — pôvod: review T01-13 (map-loader.ts:39, world.ts:46) · fáza: F2
- Grid.neighbors4 alokuje pole → A* má iterovať DIRECTIONS_4 + inBounds/index. — pôvod: review T01-13 (grid.ts:163) · fáza: F3
- map-loader segmentInterior (Math.round) je asymetrický a pripúšťa diagonálu → zdieľaný 4-súvislý Bresenham pre loader aj ShipSystem. — pôvod: review T01-13 (map-loader.ts:207) · fáza: F3
- Road a rail portál môžu byť na tej istej bunke (ADR-006) → kontrola unikátnosti buniek portálov v loaderi. — pôvod: review T01-13 (map-loader.ts:184) · fáza: F2
- Globálny meniteľný commandRegistry → seal() po registrácii vstavaných príkazov. — pôvod: review T01-13 (command-registry.ts:59) · fáza: podľa potreby
- CommandRejected nenesie index záznamu scenára (len typ) → simrun hlási typ + tick + dôvody. — pôvod: T01-06 · fáza: podľa potreby
- Rozmery čiar v RoadLayer fallbacku (pás cesty 3/4, stredová čiara 1/32, pena 1/32, hrana nábrežia 1/16) sú pomenované zlomky, nie tokeny → zvážiť tokeny. — pôvod: T01-08 · fáza: F13
- Cesta pri okraji mapy (portál) sa nekreslí k okraju (susedia mimo mapy nie sú v maske autotile); road_end na bunke portálu vyčnieva 3 px pod značku portálu. — pôvod: T01-08, T01-16 · fáza: F13
- RoadLayer kreslí len road; rail doplniť. — pôvod: T01-08 · fáza: F10
- Snapshot sa mení len pri tick/speed/cash, grid/parcels sú živé referencie → počítadlo revision pre UI. — pôvod: T01-07 · fáza: F2
- WorldSnapshot neobsahuje speeds; HUD číta bridge.world.defs.time.speeds → speeds do snapshotu/bridge. — pôvod: T01-10 · fáza: F2
- Mapa harbor_01 nemá schemaVersion (§4.7); PlacedModuleSpec {defId, x, y, rotation} v schéme mapy upraviť pri F2. — pôvod: T01-01 · fáza: F2
- ARCHITECTURE: §12.1 bez GameSpeedChanged/CommandRejected; §12.2 Command bez toJSON(); §3 bez kalendárnych getterov SimClock; §18 nevymenúva ADR-007..013 → doc karta. — pôvod: T01-17 · fáza: F2
- Token --ui-money-neg (#E5484D) má kontrast 3,89:1 < 4,5:1 (§6.4) pre 16px tučnú zápornú sumu v HUD → svetlejší textový token (iterácia Claude Design). — pôvod: T01-10 · fáza: F13
- parcel_outline_for_sale cez 9-slice natiahne čiarkovanie nepravidelne → okrajová dlaždica pre TilingSprite alebo procedurálne čiarkovanie. — pôvod: T01-16 · fáza: F7
- Schéma asset-manifest.schema.json nie je v pnpm validate:defs (len test) → zapojiť do tools/validate-defs.ts. — pôvod: T01-16 · fáza: F2
- Výkon renderu overiť na reálnom GPU (headless SwiftShader so spritmi ~100–120 ms/frame, CPU JS 16–26 ms/3 s). — pôvod: T01-16 · fáza: F6

## Nápady
- Sim vo Web Workeri (ak tick > 8 ms pri 8×). — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F13
- Export kontrakty land → ship. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F12
- Pôžičky. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: ?
- Level crossing cesta × koľaj. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F10+
- Kontajnerové stacky ako 3D vizualizácia zaplnenosti vs 5 stavov spritu. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F3+
