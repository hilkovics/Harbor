# Fáza R4: landside bez rampy · task karty

> **Zdroj:** `docs/TERMINAL_2.md`, sekcie §7, §8 a §12 (riadok R4).
> **ADR:** ADR-041.
> **Grafika** je v `design/assets-t2/`:
> - `gate_in_lane*` a `gate_out_lane*` (`_single`, `_left`, `_mid`, `_right`),
> - `pre_gate_lane`,
> - `truck_holding`,
> - overlays `tp_marker`, `safe_zone` a `inspection_bay`.
>
> **Vetva:** `phase/r4-gates`, nadväzuje na `phase/r3-tractors-rtg` (PR hilkovics/Harbor#14).
> **Režim:** najšetrnejší, report agenta má najviac 10 riadkov.

**Cieľ:** kamióny prichádzajú cez modulárnu bránu s pruhmi a predbránovou plochou z viacerých portálov. Pri bloku zastavia na odovzdávacom mieste (TP) a RTG ich naloží alebo vyloží. Odchádzajú cez výstupnú bránu. Rampa a stojisko zanikajú.

**Akceptácia:**
1. `live_terminal` na novom rozložení: import, export, prázdne aj prekládka; `lostUnits` 0, `stuckAtEnd` 0; TTT (čas kamióna v termináli) sa meria.
2. 8 vstupných pruhov spracuje špičku 100 kamiónov za hodinu bez fronty na verejnej ceste.
3. Pri 100 000 tickoch nie sú zápchy v `live_terminal` ani v `stress_f6` (zvyšky z R1 a R3).
4. Render ukazuje pruhy brány so strechou, predbránovú plochu, TP značky pri blokoch a kamióny vedľa seba.
5. Celé `pnpm test` a plná e2e sú zelené.

## Rozhodnutia (zapíšu sa do ADR-041)
1. **Brána:**
   - Moduly `gate_in_lane` a `gate_out_lane`, každý 1×4 a jednosmerný. Kroky sú časy z defu (OCR, kontrola, lístok; váha, sken, plomba) a každý pruh obsluhuje 1 kamión naraz.
   - Susedné pruhy tvoria jednu bránu (render: strecha z kusov `_left`, `_mid`, `_right`).
   - Režimy `standard`, `express` a `trouble` sa prepínajú v inšpektore pruhu príkazom `SetGateLaneMode`.
   - `truck_gate`, `loading_ramp_*` a `truck_waiting_area` zanikajú z katalógu aj z máp. Clean break, save v12.
2. **Predbránová plocha** `pre_gate_buffer`:
   - má jeden vjazd a N radových pruhov po 2 kamióny;
   - pri vjazde dostane kamión pruh s najkratšou frontou (deterministicky);
   - keď je plocha plná, kamión čaká vo vnútrozemí (ADR-035), nie na ceste.
3. **Portály:** `MapDef.roadPortals[].trafficShare`. `harbor_01` dostane druhý portál na západe. Portál vyberá `Rng`, bránu odhad času. Vnútrozemie čaká zvlášť pri každom portáli.
4. **TP pri blokoch:**
   - kamión zastaví v pruhu RTG bloku na TP svojho bay a RTG ho obslúži (priority z R3);
   - pri straddle bloku nakladá a vykladá SC na hrane bloku;
   - vozidlo nikdy nejde k rampe.
   - **Bezpečná zóna:** pred zdvihom aj po ňom čas `safeZoneTicks`, bez kreslenia ľudí (ADR-036).
5. **Odstavná plocha** `truck_holding`: kamión, ktorý prišiel pred termínom alebo nemá pripravený kontajner, čaká tu. TOS ho zavolá k TP.
6. **Dual transaction:** kamión s 2 zastávkami, kde najprv vyloží export a potom naloží import, má jeden lístok.
7. **Lashing a unlashing** na kamióne je čas na TP alebo na odstavnej ploche (def).
8. **Prístup a doprava** (dôvod: zvyšok z R1 a R3):
   - každý modul má jednosmerný vjazd a výjazd (`access` v defe);
   - RTG blok dostane druhý výjazd alebo kratší návrat;
   - scenáre sa prerobia na jednosmerný okruh a `stress_f6` už pri 100 000 tickoch nemá zápchy.
9. **STS nohy:** nohy rámu STS stoja mimo jazdných pruhov kotviska, medzi pruhmi alebo na okraji (oprava z R3, karta TR4-00).

## Karty
| id | názov | agent | depends |
|---|---|---|---|
| TR4-00 | Oprava: nohy STS mimo jazdných pruhov (render a sprite, prípadne geometria pruhov kotviska) | implementer (sonnet, worktree) | – |
| TR4-01 | ADR-041 + defy a schémy (gate lanes, pre-gate, holding, portály `trafficShare`, časy) + sim: pruhy brány, predbránová plocha, výber portálu a brány, zrušenie rampy, stojiska a `truck_gate`, save v12; testy | sim-architect (sonnet) | – |
| TR4-02 | Sim: TP pri blokoch (RTG a SC obsluha kamiónov), odstavná plocha, dual transaction, lashing, bezpečná zóna, `access` a druhý výjazd bloku, scenáre jednosmerne, `live_terminal` + metrika TTT, 100k beh bez zápchy | sim-architect (sonnet) | 01 |
| TR4-03 | Render: pruhy brány so strechou, predbránová plocha, odstavná plocha, TP a safe zone overlay; demo | implementer (sonnet, worktree) | VM kontrakt |
| TR4-04 | UI: BuildBar (brána, plochy), inšpektor pruhu brány (režim, fronta, kamióny/h), TTT v štatistikách | ui-builder (haiku, worktree) | VM kontrakt |
| TR4-05 | Napojenie VM, `simrun`, e2e úpravy | implementer (sonnet) | 02, 03, 04 |
| TR4-05b | Obnova ukážok f4/f6a/f6c/t5b03 bez rampy | implementer (sonnet) | 05 |
| TR4-06 | Review + opravy | sim-reviewer → sim-architect | 05 |
| TR4-06b | Opravy review: defy, prednosť holdingu, index obsadenia, ARCHITECTURE | sim-architect (sonnet) | 06 |
| TR4-07 | e2e, artefakt, docs, PR | orchestrátor + haiku | 06 |

**VM kontrakt** (voliteľné polia):
- `ModuleVM.gateLane? { kind: 'in' | 'out', mode, roofPart: 'single' | 'left' | 'mid' | 'right', step?: string, progress?: 0..1 }`;
- `ModuleVM.tpCells? {x, y, busy}[]`;
- `ModuleVM.holdingSlots? {x, y, occupied}[]`;
- `TruckVM.state` zahŕňa `at_tp`, `holding`, `gate_lane`.

## Checklist
- [x] TR4-00 · [x] TR4-01 · [x] TR4-02 · [x] TR4-03 · [x] TR4-04 · [x] TR4-05 · [x] TR4-05b · [x] TR4-06 · [x] TR4-06b · [x] TR4-07

## Výsledok fázy
**Stav:** hotová s čiastočnou akceptáciou 2 (TR4-00 … TR4-07, vrátane TR4-05b a TR4-06b).

- **Pipeline:** `pnpm test` 397 súborov / 8 666 testov zelené; e2e 61/61 zelené.
- **Akceptácia:**
  1. SPLNENÉ: `live_terminal` na novom rozložení (import, export, prázdne, prekládka), lostUnits 0, stuckAtEnd 0, TTT sa meria (38 min).
  2. ČIASTOČNE: 8 vstupných pruhov zvládne 100 kamiónov/h bez fronty na verejnej ceste (`r4-gate-peak`, len brána); s obsluhou na TP je najlepšia hodina ≈ 69 kamiónov (strop: 12 TP + 60 státí).
  3. SPLNENÉ: `stress_f6`, `traffic_stress` (pôvodný seed), `live_terminal`: 100 000 tickov, 0 TrafficJam, stuckAtEnd 0.
  4. SPLNENÉ: render brány so strechou, predbránová plocha, TP, odstavná plocha.
  5. SPLNENÉ.
- Oprava nôh STS (TR4-00) hotová.
- **Otvorené** (→ `docs/BACKLOG.md` „Z Fázy R4“): STS čaká na ťahač ≈ 60 % (R3, geometria okruhu); priepustnosť TP pri špičke; férovosť výjazdu z brány (STUCK_TICKS 2000); zrušené ukážky dock-maneuver/rampa; WorldState v13; artefakt verzia 12.
