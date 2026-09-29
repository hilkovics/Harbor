# BACKLOG.md — Modular Harbor

Nápady a problémy mimo aktuálnej fázy (CLAUDE.md, pravidlo 8). Každá položka: popis, pôvod (karta/fáza), návrh fázy.

## P0
–

## P1
- ReleaseParcel pri cestách/koľajach na prenajatej parcele nie je určené (ADR-008 ich tam povoľuje, §5.2 blokuje ukončenie prenájmu len pri moduloch): zostanú, odstránia sa s refundáciou, alebo ukončenie zablokujú? Rozhodnúť ADR-om. — pôvod: T00-19 · fáza: pred F7
- Agent test-runner doslova volá simrun data/scenarios/vertical_slice.json, ktorý neexistuje do F5; dovtedy sa používa smoke.json. — pôvod: T00-13 · fáza: F5

## P2
- Zlomkový flowUnitsPerTick (0.5/0.3) vs diskrétne CargoUnit batche (ADR-003) — delenie jednotky alebo akumulácia? — pôvod: T00-05 · fáza: pred F9
- DAYS_PER_MONTH v sim-clock.ts je privátne — exportovať (vzorec prenájmu §9.2 /30); do ADR-002 dopísať, že kalendár je konštanta v kóde. — pôvod: T00-12 · fáza: F7
- INITIAL_SPEED=1 nemusí byť v time.speeds (schéma vyžaduje len 0). — pôvod: T00-12 · fáza: F1
- Rng — seed | 0 aliasuje hodnoty nad 32 bitov (1 ≡ 2^32+1); povoliť len uint32. — pôvod: T00-12 · fáza: F1
- Rng.range môže vrátiť max pri veľkých magnitúdach, Infinity/NaN pri nekonečnom rozpätí; Rng.int nezdokumentované skreslenie ≤ span/2^32 → kontrola + JSDoc. — pôvod: T00-12 · fáza: F1
- Rng.weighted — pretečenie súčtu váh na Infinity; alokuje pole na každé volanie. — pôvod: T00-12 · fáza: F3
- SimClock.advance() alokuje objekt každý tick → vracať predpripravené zmrazené objekty. — pôvod: T00-12 · fáza: F6 (profiling)
- EventBus.flush realokuje pole a nemá strop → zmerať vo F5/F6, prípadne dvojitý buffer. — pôvod: T00-12 · fáza: F6
- Sumy v centoch bez Number.isSafeInteger / maximum 2^53−1 v schéme aj registry. — pôvod: T00-12 · fáza: F5
- SimClock gameMinute/Hour/Day/Month sú celkové počty od štartu, nie kalendárne zložky (hodina dňa, deň mesiaca) — HUD ich bude potrebovať. — pôvod: T00-09 · fáza: F1
- ESLint beží bez type-info (kvôli --stdin probe); type-aware pravidlá (no-floating-promises) doplniť. — pôvod: T00-02 · fáza: F6
- Hranica src/sim — známe zvyšky (úmyselné obchvaty, nízke riziko): Math[k]/Date[k] s premenným kľúčom, x['constructor'] cez string literál, destrukturovanie const { constructor: F } = …, toLocaleUpperCase/toLocaleLowerCase. — pôvod: T00-17, re-review T00-17 · fáza: podľa potreby
- Selektor .constructor zhodí aj legitímne (this.constructor as typeof A).k — vo F1 riešiť ModuleRegistry registráciou def → trieda (pravidlo 7) alebo new.target, nie výnimkou. Selektor Identifier[name='Math'] falošne hlási aj { Math: 1 } a x.Math. — pôvod: re-review T00-17 · fáza: F1
- DefRegistry divisorOf prijme záporného deliteľa (60 % -10 === 0); dnes kryté min: 1 → pridať value > 0 alebo JSDoc. — pôvod: re-review T00-16 · fáza: F1
- Import './' a '../' (s lomkou na konci) je v src/sim falošne zakázaný — povoliť alebo zdokumentovať. — pôvod: re-review T00-15 · fáza: F1

## Nápady
- Sim vo Web Workeri (ak tick > 8 ms pri 8×). — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F13
- Export kontrakty land → ship. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F12
- Pôžičky. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: ?
- Level crossing cesta × koľaj. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F10+
- Kontajnerové stacky ako 3D vizualizácia zaplnenosti vs 5 stavov spritu. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F3+
