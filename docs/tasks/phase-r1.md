# Fáza R1: doprava bez prekrývania · task karty

> **Zdroj:** `docs/TERMINAL_2.md` §7 a §10.3, ADR-036, ADR-037 a ADR-038. Rozhodnutia používateľa 1–10 sú potvrdené 2026-10-05.
> **Vetva:** `phase/r1-traffic`, stacked nad `design/terminal-2`, ktorá stojí nad `phase/06d-playtest-2` (PR hilkovics/Harbor#11).
> **Úsporný režim:**
> - implementácia na Sonnete (sim-architect, implementer, ui-builder, test-writer),
> - overovanie a odškrtávanie na Haiku,
> - plná e2e raz za fázu.

**Cieľ:** vozidlá ani kamióny nikdy neprechádzajú cez seba. Fronty sú fyzické a viditeľné. Nečinné vozidlá parkujú v depe. Zápchy sa zistia a buď sa riešia preplánovaním, alebo hlásia hráčovi.

**Akceptácia fázy:**
1. `carrierOverlapProblem` nikdy nevráti problém v žiadnom bundled scenári (krok 12 v každom ticku).
2. Na konci žiadneho scenára nie je nosič zaseknutý (`stuckAtEnd = 0`), `lostUnits = 0`, kontrakty sa dokončia ako doteraz alebo s vysvetlenou odchýlkou.
3. Rovnaký seed dá rovnaký hash. `--roundtrip-at` uprostred kolóny dá zhodný hash.
4. `pnpm bench`: `traffic_stress` (≈ 80 nosičov) má priemer < 2 ms na tick.
5. Staré savy (v1–v9) sa nenačítajú, hra zobrazí hlášku.
6. `pnpm test` a plná e2e sú zelené. Screenshot ukazuje kolónu kamiónov pred bránou bez prekryvu.

## Rozhodnutia orchestrátora (detail k ADR-037)

1. **Jazdný sused bunky:** cestná bunka (`road === 'road'`, ľubovoľný `roadKind`) alebo bunka nábrežia jazdná pre vozidlá (`QuayLanes`). Koľaj nie.
2. **Druh bunky (`CellLaneKind`):**
   - `two_lane` s ≤ 2 jazdnými susedmi má 2 sloty;
   - `two_lane` s ≥ 3 susedmi je `junction` (1 slot);
   - `one_way` a `one_lane` majú 1 slot;
   - nábrežie má 1 slot;
   - ostatné bunky sú `none`.

   Cache je odvodená a prepočíta sa pri zmene `roadVersion` alebo `moduleVersion`.
3. **Pruh v `two_lane` bunke:**
   - Konce bunky `e0 < e1` sú smery k jazdným susedom (N = 0, E = 1, S = 2, W = 3).
   - Vjazd zo strany `e0` znamená pruh 0, inak pruh 1.
   - Slepá bunka (1 koniec `e0`): vjazd z `e0` je pruh 0; výjazd späť cez `e0` (otočka) je pruh 1.
   - Bez strany vjazdu (spawn, výjazd z modulu) určuje pruh strana výjazdu: výjazd k `e1` je pruh 0, výjazd k `e0` je pruh 1.
   - Bunky s 1 slotom majú vždy pruh 0.
4. **Telo:**
   - `body` = sloty od hlavy k chvostu, najviac `lengthCells`; `ahead` = sloty pred hlavou, ktoré už nosič drží.
   - Stojaci nosič drží `body`, jazdiaci navyše `ahead[0]` (bunku, do ktorej vchádza).
   - Pri dosiahnutí stredu ďalšej bunky sa `ahead[0]` presunie do `body` a nadbytočný chvost sa uvoľní. Slot, ktorý telo drží viackrát, sa neuvoľní, kým ho drží aspoň raz.
   - Vlastný slot je vždy „voľný" pre svojho držiteľa, takže otočka cez vlastnú stopu je povolená.
5. **Križovatka:** keď je ďalšia bunka `junction`, nosič naraz zaberie ju, všetky nasledujúce `junction` na trase a prvú bunku za nimi. Buď všetky, alebo nič. Ak trasa končí v križovatke, zaberie len po koniec trasy.
6. **Úsek `one_lane`:**
   - Je to maximálny súvislý reťazec `one_lane` buniek, ktoré nie sú križovatky (odvodená cache).
   - Úsek drží smer a počet nosičov v ňom. Vstup z opačného konca je zakázaný, kým v úseku niekto ide oproti.
7. **Poradie v `TrafficSystem`:**
   - Pohybujúce sa nosiče (vozidlá aj kamióny v jazdných stavoch) sa zoradia podľa `(blockedTicks zostupne, id vzostupne)`.
   - `process(c)`: pri nevoľnom slote, ktorý drží nosič, čo sa ešte nehýbal, ho najprv spracuj (rekurzia). Ak je blokujúci nosič na zásobníku, ide o **cyklus**: zapíš ho a zastav.
   - Kto sa nepohol, hoci chcel, dostane `blockedTicks += 1`. Kto sa pohol, má `blockedTicks = 0`.
   - Zvyšok vzdialenosti sa pri zablokovaní zahodí: nosič stojí v strede bunky.
8. **Mimo cesty** (`offRoad`, nedrží sloty):
   - kamión v stojisku (`waiting`), v docku (`loading`, `unloading`) a počas prechodu bránou (nové stavy `gate_pass` a `gate_pass_out`);
   - vozidlo v depe (`parked`).

   Pravidlá vjazdu a výjazdu:
   - **Vjazd:** pri príchode na prístupovú bunku sa uvoľní celé telo.
   - **Výjazd:** potrebuje voľný slot výjazdovej bunky. Ak slot nie je voľný, nosič čaká vnútri; brána, bay a dock ostávajú obsadené.
9. **Brána:**
   - Kamión pri príchode na vonkajšiu prístupovú bunku ide do `gate_queue` (drží slot). Ďalšie kamióny stoja fyzicky za ním na ceste v stave `to_gate` (zablokované).
   - Začiatok prechodu: `gate_queue` → `gate_pass` (mimo cesty).
   - Koniec prechodu a voľný slot na druhej strane: → `to_bay`. Smer von funguje rovnako (`gate_queue_out` → `gate_pass_out` → `to_portal`).
   - Priepustnosť brány (`passTicks`) sa nemení. Teleport `jumpTo` ostáva len ako presun z bunky na bunku cez modul a vždy so zabraným slotom.
10. **Portál:**
    - **Vznik kamióna** (spawn, vjazd z vnútrozemia) potrebuje voľný slot bunky portálu. Inak kamión počká: spawn sa odloží, položka plánu ostane.
    - **Príchod na portál** znamená výjazd z mapy a uvoľní všetky sloty.
11. **Parkovanie vozidiel:**
    - Nečinné vozidlo (`idle`) bez úlohy po `idleParkDelayTicks` plánuje trasu do svojho depa: `to_depot`, po príchode na prístupovú bunku depa `parked`.
    - Priradenie úlohy: z `idle` alebo `to_depot` priamo `to_pickup` s preplánovaním; z `parked` cez `depot_exit` → `to_pickup`, až keď je voľný slot prístupovej bunky.
    - Kúpené vozidlo vzniká ako `parked`.
    - Dispatcher berie ako voľné stavy `idle`, `to_depot` a `parked`. Vzdialenosť sa počíta od kotvy, pri `parked` od prístupovej bunky depa.
12. **Zápcha** (koniec `TrafficSystem`, nosiče vzostupne podľa id):
    - **Preplánovanie:** nosič s `blockedTicks ≥ gridlockTicks`, ktorý je v cykle tohto ticku alebo má `blockedTicks ≥ stuckTicks`, skúsi preplánovať trasu mimo prvej blokovanej bunky. A* dostane dočasne zakázanú bunku a výsledok nejde do `PathCache`. Najviac raz za `rerouteCooldownTicks`.
    - **Hlásenie:** keď `blockedTicks` prvýkrát dosiahne `stuckTicks`, vznikne udalosť `TrafficJam` a `gridlockEvents += 1`.
    - **Uvoľnenie:** po prvom pohybe po hlásení vznikne `TrafficJamCleared`.
13. **Save v10:**
    - nosič dostane `body` (pole `[cell, lane]`), `ahead` a `blockedTicks`;
    - `offRoad` sa odvodí z tabuľky stavov;
    - `LaneSlots` a úseky sa pri načítaní prepočítajú;
    - konflikt slotov pri obnove znamená `WorldStateError`.
14. **Odstraňuje sa nepoužitá soft kongescia:** `congestion.slowdownPerExtraVehicle`, `penaltyTrafficDivisor` a `penaltyMax`. Ostáva `trafficDecayPerHour` pre heatmapu.

## Spoločné rozhrania (záväzné pre paralelné karty)

**Defy:**
- `vehicles.json` a `trucks.json` dostanú `lengthCells` (int ≥ 1): `straddle_carrier` 2, `empty_handler` 2, `truck_container` 3.
- `logistics.json` dostane sekciu `traffic: { gridlockTicks: 30, stuckTicks: 120, rerouteCooldownTicks: 60, idleParkDelayTicks: 6 }`.

**Sim (`@sim/traffic`):**
- `cellLaneKind(world, cell)` vracia `'two_lane' | 'single' | 'junction' | 'none'`.
- `laneFor(world, cell, entrySide | null, exitSide | null)` vracia `0 | 1`.
- `world.laneSlots.holderOf(cell, lane)` vracia `EntityId | null`.
- `carrierOverlapProblem(world)` vracia `string | null`.

**Nosič a stavy:**
- `Carrier` dostane `body`, `ahead`, `blockedTicks` a `lengthCells` (readonly getter).
- Vozidlo má nové stavy `to_depot`, `parked` a `depot_exit`.
- Kamión má nové stavy `gate_pass` a `gate_pass_out`.

**Udalosti:**
- `TrafficJam { carrierId, carrierKind: 'vehicle' | 'truck', cell: { x, y }, blockerIds: EntityId[] }`
- `TrafficJamCleared { carrierId, carrierKind }`

**VM** (`src/app/entities-vm.ts`; render a UI ich čítajú):
- `VehicleVM` a `TruckVM` dostanú:
  - `body: readonly { x: number; y: number }[]` (stredy buniek stopy od hlavy k chvostu, bez polohy hlavy),
  - `lengthCells`,
  - `offRoad: boolean`,
  - `blocked: boolean` (`blockedTicks > 0`),
  - `jammed: boolean` (`blockedTicks ≥ stuckTicks`).
- `ModuleVM` depa dostane `parkedVehicleIds: readonly number[]`.

**`simrun` (nové kľúče):** `gridlockEvents`, `trafficWaitTicks { vehicles, trucks }`, `maxBlockedTicks`, `stuckAtEnd`.

## Karty
| id | názov | agent (model) | parallel | depends_on |
|---|---|---|---|---|
| TR1-01 | Clean break savov: `WorldState` v10 (tvar ako v9), odstránenie migrácií v1–v9, legacy typov a volieb, adaptérov obnovy, fixtures a testov migrácií; app: starý save → hláška | sim-architect (sonnet) | no | – |
| TR1-02 | Jadro dopravy: defy (`lengthCells`, `traffic`), `LaneSlots`, `CellLaneKind`, pruhy, telo a `ahead`, `TrafficSystem` v kroku 6 (vozidlá aj kamióny), pravidlo križovatky, úseky `one_lane`, otočka, refaktor FSM krokov bez pohybu, invariant `carrierOverlapProblem`, save (`body`, `ahead`, `blockedTicks`), unit testy | sim-architect (sonnet) | no | 01 |
| TR1-03 | Moduly a portál: mimo cesty (stojisko, dock, `gate_pass`, `gate_pass_out`), výjazdy so slotom, fyzický front pred bránou, spawn a výjazd na portáli, pod hákom; úprava invariantov brány a stojiska | sim-architect (sonnet) | no | 02 |
| TR1-04 | Parkovanie a zápchy: `to_depot`, `parked`, `depot_exit`, dispatcher, kúpa do depa; detekcia cyklu, preplánovanie s dočasne zakázanou bunkou, `TrafficJam` a `TrafficJamCleared`, metriky | sim-architect (sonnet) | no | 03 |
| TR1-05 | TDD a scenáre: test „žiadny prekryv" nad všetkými bundled scenármi, kolóna pred bránou (FIFO, bez prekryvu), odstup za vodcom, protismer, križovatka, `one_lane`, parkovanie, zápcha (riešiteľná a neriešiteľná), determinizmus a roundtrip uprostred kolóny | test-writer (sonnet, worktree) | yes | 03 (API) |
| TR1-06 | Render: kĺbové vozidlá po stope (dočasne existujúci sprite), brzdové svetlá stojacich (procedurálne), vozidlá zaparkované v depe, kamión v `gate_pass`, zvýraznenie zápchy (bunky + odznak); demo scéna + e2e screenshot | implementer (sonnet, worktree) | yes | – (VM kontrakt) |
| TR1-07 | UI a app: toast „Zápcha" s akciou „Ukázať", texty nových stavov v inšpektoroch (vozidlo, kamión), depo „Zaparkované N / kapacita", hláška pri starom save; demo + testy | ui-builder (sonnet, worktree) | yes | – (VM kontrakt) |
| TR1-08 | Napojenie VM (body, offRoad, blocked, jammed, parkedVehicleIds) na sim, `simrun` kľúče, scenár `traffic_stress` + bench, úpravy rozloženia scenárov pri trvalej zápche, prepočet goldenov | implementer (sonnet) | no | 04, 06, 07 |
| TR1-09 | Review `src/sim/**` + opravy | sim-reviewer (sonnet) → sim-architect (sonnet) | no | 08 |
| TR1-10 | Plná pipeline + plná e2e + artefakt; docs (ARCHITECTURE §5.1, §6, §7.3–§7.8, §14; PROGRESS; BACKLOG) + PR | test-runner (haiku), implementer (sonnet), docs-keeper (haiku) | no | 09 |

**Vlny:** TR1-01 → TR1-02 → TR1-03 → TR1-04 → TR1-08 → TR1-09 → TR1-10.
- Paralelne od začiatku: TR1-06 a TR1-07 (worktree, demo nad VM kontraktom).
- Po TR1-03: TR1-05.

## Checklist
- [x] R0 Rozhodnutia: ADR-036 až ADR-038, plán, CLAUDE.md, PORT_OPERATIONS, manuál pre Claude Design
- [ ] TR1-01 Clean break savov (v10)
- [ ] TR1-02 Jadro dopravy
- [ ] TR1-03 Moduly a portál
- [ ] TR1-04 Parkovanie a zápchy
- [ ] TR1-05 TDD a scenáre
- [ ] TR1-06 Render
- [ ] TR1-07 UI a app
- [ ] TR1-08 Napojenie, simrun, bench, goldeny
- [ ] TR1-09 Review + opravy
- [ ] TR1-10 Pipeline, e2e, artefakt, docs, PR

## Výsledok fázy
_(doplní orchestrátor)_
