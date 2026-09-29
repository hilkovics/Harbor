# BACKLOG.md — Modular Harbor

Nápady a problémy mimo aktuálnej fázy (CLAUDE.md, pravidlo 8). Každá položka: popis, pôvod (karta/fáza), návrh fázy.

## P0
–

## P1
- Vynútenie pravidiel 1/3 je denylist, dá sa obísť (new Date(), globalThis.Math.random, crypto.*, self, localStorage, navigator, setTimeout, process.hrtime, import 'node:fs', ľubovoľný npm balík, @sim/../render/x; files len *.ts). Návrh: src/sim/tsconfig.json (lib ES2023, types []), no-restricted-imports ako allowlist (@sim/, @data/, relatívne v sim), no-restricted-syntax na Date a globalThis.*, files {ts,tsx,mts,js}. — pôvod: T00-12 · fáza: pred F1
- tickGameSeconds 7/120 prejde validate:defs aj DefRegistry, ale SimClock hodí RangeError. Návrh: v schéme enum deliteľov 60 + rovnaké pravidlo v registry + test DefError('/tickGameSeconds'). — pôvod: T00-12 · fáza: pred F1
- Singleton defy time/economy (bez items[] s id) odporujú ARCHITECTURE §4 a nie sú zapísané v ADR → veta do §4 alebo ADR. — pôvod: T00-12 · fáza: F1
- Cesty vs parcely — §4.2 („requiresParcelOwnership vždy true okrem ciest na verejných bunkách") vs §5.1/§5.2; smie PlaceRoad stavať na bunky bez parcely? Rozhodnutie používateľa (ADR). — pôvod: T00-05 · fáza: pred F1
- Pravidlo 4 vs §4 — bez defu sú cena cesty/koľaje (2k/6k, §5.3), konštanty kongescie (0.9/0.25/200/3, §7.6), default internalTicks 6 (§7.3); určiť def a rozšíriť schému. — pôvod: T00-05 · fáza: F1/F3/F11
- internalTicks (§7.3) vs loadTicks/unloadTicks (§4.4) — sčítavajú sa? Rozhodnutie (ADR). — pôvod: T00-05 · fáza: pred F3
- Agent test-runner doslova volá simrun data/scenarios/vertical_slice.json, ktorý neexistuje do F5; dovtedy sa používa smoke.json. — pôvod: T00-13 · fáza: F5

## P2
- Zlomkový flowUnitsPerTick (0.5/0.3) vs diskrétne CargoUnit batche (ADR-003) — delenie jednotky alebo akumulácia? — pôvod: T00-05 · fáza: pred F9
- §5.1 spomína len PlaceRoadCommand, §12.2 aj PlaceRail/RemoveRail — zosúladiť text. — pôvod: T00-05 · fáza: F1
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

## Nápady
- Sim vo Web Workeri (ak tick > 8 ms pri 8×). — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F13
- Export kontrakty land → ship. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F12
- Pôžičky. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: ?
- Level crossing cesta × koľaj. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F10+
- Kontajnerové stacky ako 3D vizualizácia zaplnenosti vs 5 stavov spritu. — pôvod: ARCHITECTURE §18 (T00-05) · fáza: F3+
