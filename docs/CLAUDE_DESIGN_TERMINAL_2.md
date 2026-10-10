# Manuál pre Claude Design: Terminál 2.0

> **Pre koho:** Claude Design (claude.ai/design), projekt Modular Harbor s design systémom z `docs/DESIGN_BRIEF.md` a `design/tokens.css`.
> **Čo z neho vznikne:** všetky chýbajúce SVG sprity, referenčné hárky a UI prototypy pre prestavbu „Terminál 2.0" (`docs/TERMINAL_2.md`).
> **Ako ho použiť:** nahraj tento súbor do projektu v Claude Design a postupuj po reláciách v §5. Každá relácia má hotový prompt na skopírovanie.

---

## 1. Postup práce

1. **Projekt v Claude Design.** Otvor existujúci projekt Modular Harbor, kde je design systém už nahraný. Ak ho nemáš, nahraj `docs/DESIGN_BRIEF.md` a `design/tokens.css` a urob reláciu 1 z briefu (§8).
2. **Prílohy, ktoré nahraj navyše:**
   - tento manuál,
   - `design/entities.html` a `design/modules.html` (ukážka doterajšieho štýlu),
   - pár screenshotov z hry, napríklad `tests/e2e/__screenshots__/f6d-hook-lowering.png`, `f6d-anchorage.png` a `f6c-live-terminal-*.png`.
3. **Relácie idú v poradí z §5.** Jedna relácia = jedna skupina výstupov. Na canvase žiadaj 2–3 varianty, vyber jeden a nechaj zmenu aplikovať na celú sadu.
4. **Export:**
   - sprity ako samostatné SVG s presnými názvami z tabuliek,
   - referenčné hárky a UI ako standalone HTML.
5. **Odovzdanie:** SVG ulož do repozitára do `design/assets-t2/<priečinok>/`, HTML do `design/assets-t2/` a `design/ui/`. Priečinok `assets/` nepoužívaj, kontroluje ho test manifestu. Druhá možnosť je poslať mi ZIP. Súbory do `assets/`, manifestu a enginu zapojím ja v príslušnej fáze R1–R7.

---

## 2. Čo sa v hre mení (kontext pre dizajn)

- **Kontajnery:** 20′ a 40′ v typoch suchý, reefer, open top, flat rack a tank. Prázdne sú sivé.
- **Sklad:** bloky so stohmi.
  - **RTG blok:** 6 radov, výška 5, pozdĺž bloku pruh pre kamióny a ťahače.
  - **Straddle blok:** výška 3.
  - **Plocha reach stackera:** 3 rady do hĺbky.
  - **Depo prázdnych:** výška 8, obsluhuje ho ECH.
  - **Reefer blok:** stojany so zásuvkami.
  - **OOG plocha:** kontajnery len na zemi.
- **Technika:** STS (existuje), terminálový ťahač s podvozkom, AGV, straddle carrier, RTG, RMG, reach stacker a ECH.
- **Kamióny:**
  - **Rampa a stojisko zanikajú.** Kamión prejde **modulárnou vstupnou bránou** s ľubovoľným počtom pruhov, pred ňou je predbránová plocha.
  - Pri bloku zastaví na odovzdávacom mieste (TP) a RTG mu kontajner naloží priamo na náves.
  - Na výstupe ho čakajú pruhy s váhou a skenerom.
- **Vozidlá cez seba neprechádzajú.** Stoja vo fronte za sebou, kamión a ťahač s návesom majú 3 bunky (≈ 18 m).
- **Vlak:** železničný terminál s RMG.

---

## 3. Pravidlá (doplnok k DESIGN_BRIEF, záväzné)

**Kresba:**
1. **Ľudia sa nekreslia.** Žiadne postavy šoférov, technikov, chodcov ani ikony s postavou. Bezpečná zóna je len značka na zemi.
2. Pohľad zhora, ortografický. **Vozidlá a stroje kresli nosom nahor** (jazda smerom hore).
3. **Mierka:** 1 bunka = 64 px = 6 m, teda 1 m ≈ 10,67 px. Plátno = bunky × 64. `viewBox` = `width` × `height`. Celé súradnice.
4. **Štýl:**
   - max 3 tóny na objekt, obrys 2 px v tmavšej variante base, `rx` 2;
   - svetlo zľava zhora;
   - tieňový filter `<filter id="s"><feDropShadow dx="2" dy="2" stdDeviation="0" flood-opacity=".2"/></filter>` len pre objekty nad terénom;
   - farby len z tokenov (§7);
   - žiadny text, logo ani gradient.

**Kontajnery a vozidlá:**
5. **Vozidlá a stroje sú bez kontajnera.** Kontajner skladá hra zo samostatného spritu. Straddle carrier a portálové stroje (RTG, RMG) majú **priehľadný stred**, aby kontajner a stoh pod nimi bolo vidieť.
6. **Typ kontajnera musí byť rozpoznateľný aj bez farby:** strecha so zvlnením, reefer s agregátom, plachta, rám flat racku, valec cisterny.
7. **Kontajnery** kresli zhora s dlhou osou **vodorovne**: 20′ = 64 × 26 px, 40′ = 128 × 26 px.

**Časti a stavy:**
8. **Pohyblivé časti** (rám, vozík, rameno, spreader, náves, závora) sú samostatné súbory. Na začiatok každého súboru daj komentár `<!-- pivot: x,y -->` (px v rámci súboru) a pri posuvných častiach aj `<!-- travel: os, od, do -->`.
9. **Moduly skladané vedľa seba** (pruhy brány) majú varianty `_single`, `_left`, `_mid` a `_right`, aby na seba nadväzovali, najmä strecha brány.
10. **Čitateľnosť:** každý sprite musí byť čitateľný pri 32 px na bunku. Over to v referenčnom hárku.

---

## 4. Inventár: čo ostáva, čo ide preč, čo chýba

| Stav | Assety |
|---|---|
| **Ostáva bez zmeny** | terén a voda (24), cesty, koľaje a potrubia (15), lode (všetky triedy a varianty), STS žeriav (`crane_container_gantry_base`, `_boom`, `_trolley`), `vehicle_depot`, ikony z `icons.svg`, overlaye `ghost_hatch`, `selection_ring`, `hover_outline`, `path_arrow`, `connector_marker`, `warning_badge`, `blocked_badge`, `heatmap_legend`, `queue_badge` |
| **Ide preč** (netreba upravovať) | `loading_ramp_*` (5), `truck_waiting_area`, `truck_gate` (+ `_barrier`), `container_yard_small`, `_medium`, `_large` (fill stavy; bloky kreslí engine), `empty_depot` (fill stavy), `forklift_*`, `container_teu` (nahradia ho typové kontajnery) |
| **Treba prekresliť** (iná mierka alebo koncept) | `straddle_carrier` (1×1 → 1×2, bez kontajnera), `empty_handler` → `ech`, `agv` (zastaraný → 1×3), `truck_container` → kabína + náves (1×1 + 1×2), `berth_standard` (8×3 → 8×4 s pruhmi), `locomotive` a `wagon_container` (1×2 → 1×3) |
| **Chýba** | všetko v §5: typové kontajnery, ťahač s podvozkom, RTG, RMG, reach stacker, ECH, pruhy brány a predbránová plocha, odstavná plocha, parkovisko techniky, značky TP a bezpečnej zóny, reefer stojan a stavy zásuviek, nové ikony, UI prototypy nových panelov, referenčný hárok skladu |

---

## 5. Relácie

> Poradie relácií zodpovedá fázam implementácie. Najprv treba relácie A a B (fáza R1–R2), ostatné môžu prísť neskôr. Fáza je pri každej relácii.

### Relácia A: Kontajnery (fáza R2, R5)
| Súbor (`design/assets-t2/cargo/`) | Plátno (px) | Obsah |
|---|---|---|
| `container_20_dry.svg` | 64×26 | Strecha so zvlnením (5 priečnych 1 px čiar), 4 rohové odliatky (tmavé štvorčeky 3×3). **Neutrálna svetlá base `#D9DDE2`** (hra ju tónuje farbou linky). |
| `container_40_dry.svg` | 128×26 | Ako 20′, 10 čiar. |
| `container_20_empty.svg`, `container_40_empty.svg` | 64×26, 128×26 | Ako dry, v sivej `--cargo-empty`. |
| `container_20_reefer.svg`, `container_40_reefer.svg` | 64×26, 128×26 | Biela strecha `#ECEFF3`, na jednom konci tmavý pás agregátu (8 px) s mriežkou (3 zvislé čiary), v rohu strechy malý glyf vločky. |
| `container_20_open_top.svg`, `container_40_open_top.svg` | 64×26, 128×26 | Plachta namiesto strechy (`#5D7A8C`), 3 priečne laná, zvlnený okraj. |
| `container_40_open_top_oog.svg` | 128×34 | Plachta vydutá nad okraje o 4 px na každú stranu (nadrozmer). |
| `container_20_flat_rack.svg`, `container_40_flat_rack.svg` | 64×26, 128×26 | Prázdna plošina: tmavý rám, priečne dosky, **vysoké čelné steny** na oboch koncoch (pásy 6 px). |
| `container_40_flat_rack_oog.svg` | 128×40 | Flat rack s nákladom (sivozelený stroj alebo bedňa), ktorý presahuje boky o 7 px; laná upevnenia. |
| `container_20_tank.svg` | 64×26 | Rámová konštrukcia s rohovými stĺpikmi, vo vnútri zaoblený valec (`#B8BEC7`), kruhový poklop a lávka. |

**Prompt A:**
> Podľa priloženého manuálu (§3, Relácia A) a design systému Modular Harbor vytvor sadu kontajnerov zhora: 20′ (64×26 px) a 40′ (128×26 px) v typoch dry, empty, reefer, open top, flat rack a tank, plus OOG varianty open top a flat rack. Dlhá os je vodorovná. Typ musí byť rozpoznateľný aj v odtieňoch sivej: zvlnenie, agregát s vločkou, plachta, rám s čelnými stenami, valec. Dry kresli v neutrálnej svetlej `#D9DDE2`, hra ho tónuje farbou linky (ukáž náhľad s tintom modrá `line-blue`, jantárová `line-amber`, tyrkysová `line-teal`). Žiadny text. Na hárku ukáž všetky kontajnery pri 64 px aj 32 px na bunku, na betóne `#9DA3AC` aj asfalte `#4B5058`, a jeden stoh 3 kontajnerov zhora (vrchný vidno celý, pod ním naznačené okraje).

### Relácia B: Vozidlá na cestách (fáza R1, R3, R7)
| Súbor (`design/assets-t2/entities/`) | Plátno | Obsah | Pivot |
|---|---|---|---|
| `truck_cab.svg` | 1×1, 64×64 | Ťahač externého kamióna: kabína `--truck-cab`, motor vpredu, točnica vzadu; telo 27×60 px. | točnica (32, 54) |
| `truck_trailer_40.svg` | 1×2, 64×128 | Kostrový náves 40′ bez kontajnera: rám `--truck-trailer`, 4 twistlocky, 3 nápravy vzadu; telo 27×124 px. | čap (32, 4) |
| `terminal_tractor_cab.svg` | 1×1, 64×64 | Terminálový ťahač: nízka jednomiestna kabína posunutá vľavo, zdvíhacia točnica; telo 30×60 px, `--vehicle-body`. | točnica (32, 52) |
| `terminal_tractor_chassis_40.svg` | 1×2, 64×128 | Terminálový podvozok (MAFI): plná plošina so 4 vodiacimi kužeľmi, labutí krk vpredu, 2 nápravy vzadu; telo 28×124 px. | čap (32, 4) |
| `straddle_carrier.svg` | 1×2, 64×128 | Straddle carrier v reálnej mierke (telo 52×102 px): dva bočné nosníky so 4 kolesami na každej strane, kabína hore vpravo, horný rám v tvare „H", **priehľadný stred**. | stred |
| `agv.svg` | 1×3, 64×192 | AGV bez kabíny: plochá plošina 32×160 px, pásy senzorov na oboch koncoch, 4 kontajnerové kužele. | stred |
| `vehicle_brake_lights.svg` | 1×1, 64×64 | Len dve malé červené svetlá (4×3 px) pri spodnom okraji, inak priehľadné (prekryv pre stojace vozidlo). | — |

**Prompt B:**
> Podľa manuálu (§3, Relácia B) vytvor vozidlá zhora, nosom nahor, bez kontajnera. Nakresli ťahač externého kamióna a jeho 40′ náves ako dve časti, terminálový ťahač a jeho podvozok ako dve časti, straddle carrier v reálnej mierke s priehľadným stredom, AGV a prekryv brzdových svetiel. Do komentárov daj pivot točnice a čapu. Na hárku ukáž kamión aj ťahač zložené z častí: rovno, v zákrute s návesom zalomeným o 30° a 60° a s kontajnerom 40′ z relácie A na podvozku. Pridaj straddle carrier nad kontajnerom 40′ a porovnanie mierky s doterajším straddle carrierom. Žiadne postavy. Over čitateľnosť pri 32 px.

### Relácia C: Stroje skladu (fáza R2, R3, R6)
| Súbor (`design/assets-t2/entities/`) | Plátno | Obsah | Pivot / pohyb |
|---|---|---|---|
| `rtg_frame.svg` | 4×2, 256×128 | Mostový žeriav RTG (jazda pozdĺž bloku = os Y): 2 priečne nosníky cez 256 px, 2 bočné prahové nosníky s podvozkami kolies v rohoch, domček pohonu na jednej strane. `--crane-frame` a `--crane-boom`. **Priehľadný stred.** | rám sa posúva po Y |
| `rtg_trolley.svg` | 1×1, 64×64 | Vozík s kabínou a spreaderom: telo 40×56 px s kladkami, pod ním obrys spreadera 30×56 px. | pivot (32, 32); travel x 32–224 |
| `rmg_frame.svg` | 6×2, 384×128 | Koľajový RMG: koľajnicové podvozky, širšie rozpätie, konzola presahujúca o 1 bunku na jednej strane, priehľadný stred. | rám po Y |
| `rmg_trolley.svg` | 1×1, 64×64 | Vozík RMG so spreaderom. | pivot (32, 32); travel x 32–352 |
| `reach_stacker.svg` | 1×2, 64×128 | Čelný prekladač: telo 45×100 px, kabína vľavo, veľké predné kolesá, protizávažie vzadu, bez ramena. | — |
| `reach_stacker_boom.svg` | 1×2, 64×128 | Teleskopické rameno zhora, lúč šírky 14 px. | pivot (32, 116) |
| `reach_stacker_spreader_20.svg`, `_40.svg` | 1×1 (64×64), 2×1 (128×64) | Priečny spreader 64×10 px a 128×10 px s kĺbom v strede. | pivot v strede hornej hrany |
| `ech.svg` | 1×2, 64×128 | Manipulátor prázdnych: telo 43×90 px, široký stožiar vpredu (priečny nosník 60 px), kabína vľavo, protizávažie vzadu. | — |
| `ech_spreader_20.svg`, `_40.svg` | 1×1, 2×1 | Bočný úchop: tenký priečny rám 64×8 a 128×8 px s 2 čapmi. | pivot v strede |

**Prompt C:**
> Podľa manuálu (§3, Relácia C) vytvor stroje skladu: RTG a RMG (rám a vozík ako samostatné súbory, priehľadný stred rámu), reach stacker (telo, rameno, spreadery 20′ a 40′) a ECH (telo, úchopy 20′ a 40′). Do komentárov daj pivot a rozsah pohybu. Na hárku ukáž:
> - RTG nad blokom so 6 radmi kontajnerov a kamiónom v pruhu bloku, s vozíkom raz nad stohom a raz nad kamiónom;
> - reach stacker s kontajnerom 40′ držaným **priečne** pred sebou;
> - ECH pri stohu 8 prázdnych kontajnerov.
>
> Žiadne postavy, žiadny text.

### Relácia D: Brány a landside (fáza R1, R4)
| Súbor (`design/assets-t2/modules/` alebo `overlay/`) | Plátno | Obsah |
|---|---|---|
| `gate_in_lane_single.svg`, `_left.svg`, `_mid.svg`, `_right.svg` | 1×4, 64×256 | **Vstupný pruh brány** (jazda zdola nahor):<br>• asfalt so šírkou pruhu 44 px, po stranách polovice ostrovčekov 10 px (dva susedné kusy vytvoria ostrovček 20 px);<br>• na pravom ostrovčeku búdka 14×24 px so strieškou;<br>• **OCR portál** = tenký priečny nosník pri vjazde dole (y ≈ 236) s 2 kamerovými bodmi;<br>• stopčiara pri y ≈ 64, miesto závory pri y ≈ 56;<br>• strecha brány len ako obrys a priečne väzníky v hornej polovici (kamión pod ňou musí byť vidieť). Okraj strechy je uzavretý vľavo pri `_left`, vpravo pri `_right`, na oboch stranách pri `_single`; `_mid` je otvorený. |
| `gate_out_lane_single.svg`, `_left.svg`, `_mid.svg`, `_right.svg` | 1×4, 64×256 | **Výstupný pruh** (jazda zdola nahor; hráč otočí):<br>• **váha** pod celým kamiónom (oceľová plošina 40×176 px s rámom a 3 priečnymi spojmi);<br>• **skenerový portál** (U rám cez pruh) pri výjazde hore;<br>• búdka na ostrovčeku;<br>• strecha ako pri vstupných pruhoch. |
| `gate_lane_barrier.svg` | 1×1, 64×64 | Závora pruhu: rameno 46×4 px s pruhmi (červená a biela), stĺpik na ostrovčeku. `<!-- pivot: 9,32 -->`, zatvorená 0°, otvorená −90°. |
| `pre_gate_lane.svg` | 1×6, 64×384 | **Predbránový radový pruh**: asfalt, obrubníky po oboch stranách, 2 vyznačené miesta na kamión (stopčiary pri y ≈ 192 a 0), šípky smeru nahor. Hráč ich kladie vedľa seba pred pruhy brány. |
| `truck_holding.svg` | 6×5, 384×320 | **Odstavná plocha kamiónov**: 6 státí 1×3 (hore), ulička 2 bunky dole, biele čiary 1 px, šípky vjazdu a výjazdu. |
| `vehicle_parking.svg` | 4×4, 256×256 | **Parkovisko techniky** (ťahače, straddle): 4 státia 1×3 a ulička 1 bunka, žltý okraj (interná zóna). |
| `overlay/tp_marker.svg` | 1×1, 64×64 | Odovzdávacie miesto: žltý rám 2 px (`#F4D03F`) s rohmi „L" a malou šípkou smeru. |
| `overlay/safe_zone.svg` | 1×1, 64×64 | Bezpečná zóna: zelený šrafovaný obdĺžnik 40×24 px (`#3FA34D`, šrafy 45°). **Bez postavy a bez glyfu chodca.** |
| `overlay/inspection_bay.svg` | 1×3, 64×192 | Odstavný pruh kontroly: oranžové šrafy pozdĺž okrajov, v strede glyf lupy. |

**Prompt D:**
> Podľa manuálu (§3, Relácia D) vytvor modulárnu vstupnú a výstupnú bránu z pruhov 1×4 bunky s variantmi `single`, `left`, `mid` a `right`, aby sa dalo zložiť ľubovoľne široké pole pruhov so spoločnou strechou. Pridaj závoru pruhu, predbránový radový pruh, odstavnú plochu kamiónov, parkovisko techniky a značky na zem (TP, bezpečná zóna bez postavy, kontrolný pruh). Na hárku ukáž:
> - **bránu s 8 vstupnými a 4 výstupnými pruhmi** vedľa seba,
> - pred vstupnými pruhmi 8 predbránových pruhov napojených na rozvodnú cestu,
> - v pruhoch kamióny z relácie B (niektoré stoja, závory raz zatvorené a raz otvorené).
>
> Ďalej ukáž značky TP a bezpečnej zóny pri pruhu RTG bloku s kamiónom. Žiadne postavy.

### Relácia E: Nábrežie, sklad a reefery (fáza R2, R3, R5)
| Súbor | Plátno | Obsah |
|---|---|---|
| `modules/berth_standard.svg` (nová verzia) | 8×4, 512×256 | Kotvisko 8×4 (voda na severe):<br>• horný rad = hrana mola a 2 koľajnice STS;<br>• 2 pruhy pod žeriavom (prerušované deliace čiary, šípky smerom vpravo);<br>• obchádzkový pruh pri pevnine (plná čiara, šípky);<br>• betón `--module-base`. |
| `modules/reefer_rack.svg` | 1×1, 64×64 | Segment reefer stojana: oceľová lávka pozdĺž (pás 12 px, `--module-roof`), 2 stĺpiky so zásuvkami a káblami. Opakuje sa po bays. |
| `overlay/reefer_plug_on.svg` | 16×16 | Zelený krúžok s bleskom (zapojený). |
| `overlay/reefer_plug_alarm.svg` | 16×16 | Červený trojuholník s výkričníkom. |
| `overlay/reefer_plug_off.svg` | 16×16 | Sivý krúžok s prečiarknutou zástrčkou. |
| `yard-reference.html` | hárok | **Referenčný hárok skladu.** Plochy blokov kreslí engine, toto je vzor, podľa ktorého ich nakreslím. Obsah je v prompte. |

**Prompt E:**
> Podľa manuálu (§3, Relácia E) vytvor nové kotvisko 8×4 s pruhmi pod žeriavom a obchádzkovým pruhom a postav na ňom STS žeriav (existujúce časti base, boom a trolley) s terminálovým ťahačom na TP v pruhu pod žeriavom. Pridaj segment reefer stojana a 3 stavy zásuvky.
>
> Potom urob **referenčný hárok skladu** (`yard-reference.html`), ako má vyzerať plocha blokov pri 64 px a 32 px na bunku:
> - **RTG blok** 12 bays × 6 radov a pruh pre kamióny s TP značkami. Stohy rôznej výšky 1–5 vyjadri tieňom alebo odtieňom okraja vrchného kontajnera a malým číselným odznakom (odznak pridá engine, ty navrhni jeho vzhľad). Zmes typov a liniek. Jeden „zavalený" kontajner je zvýraznený.
> - **Straddle blok** 8 radov × výška 3.
> - **Depo prázdnych** s výškou 8.
> - **Reefer blok** so stojanmi a zásuvkami.
> - **OOG plocha** s flat rackmi na zemi.
>
> Použi asfalt `#4B5058`, biele 1 px čiary pozícií a žlté značky TP. Žiadne postavy.

### Relácia F: Železnica (fáza R6)
| Súbor (`design/assets-t2/entities/`) | Plátno | Obsah |
|---|---|---|
| `locomotive.svg` (nová verzia) | 1×3, 64×192 | Lokomotíva v reálnej mierke (≈ 19 m), `--train-loco`, kabíny na oboch koncoch, strešné prvky. |
| `wagon_container_60.svg` | 1×3, 64×192 | 60′ kontajnerový vagón bez nákladu: rám s kolíkmi pre 3× 20′ alebo 40′ + 20′, podvozky na koncoch, `--train-wagon`. |
| `rail-terminal-reference.html` | hárok | Vzor železničného terminálu: 2 koľaje s vlakom, RMG (z relácie C) nad koľajami a bufferom, pruh pre ťahače. |

**Prompt F:**
> Podľa manuálu (§3, Relácia F) vytvor lokomotívu a 60′ kontajnerový vagón v reálnej mierke, nosom nahor, bez kontajnerov. Na hárku ukáž vlak (lokomotíva + 6 vagónov) na 2 koľajach pod RMG s bufferom 4 radov kontajnerov a pruhom pre terminálové ťahače. Vagóny sú naložené v rôznych kombináciách 20′ a 40′. Žiadne postavy.

### Relácia G: Ikony (všetky fázy)
Pridaj symboly do existujúceho sprite `icons.svg`: 24 px mriežka, ťah 2 px, okrúhle konce, `currentColor`, `<symbol id="ic_…">`. **Žiadna ikona s postavou.**

| Skupina | Symboly |
|---|---|
| Kontajnery | `ic_container_20`, `ic_container_40`, `ic_reefer` (vločka), `ic_open_top`, `ic_flat_rack`, `ic_tank`, `ic_plug` |
| Sklad | `ic_rehandle` (dva kontajnery so šípkou), `ic_stack_height`, `ic_tp` (značka miesta), `ic_appointment` (kalendár s hodinami) |
| Technika | `ic_tractor`, `ic_straddle`, `ic_rtg`, `ic_rmg`, `ic_reach_stacker`, `ic_ech`, `ic_agv`, `ic_train` |
| Landside | `ic_gate_in`, `ic_gate_out`, `ic_weighbridge`, `ic_ocr`, `ic_seal`, `ic_twistlock`, `ic_safe_zone` (**štít**, nie postava), `ic_holding` (kamión so „P") |
| Doprava | `ic_traffic_jam`, `ic_one_way`, `ic_terminal_only` (cesta so zámkom) |

**Prompt G:**
> Podľa manuálu (§3, Relácia G) rozšír ikonovú sadu `icons.svg` o symboly z tabuľky v rovnakom štýle ako existujúce `ic_*`. Žiadna ikona nesmie obsahovať postavu, bezpečnú zónu zobraz štítom. Na hárku ukáž nové aj staré ikony pri 16, 24 a 32 px na tmavom pozadí UI.

### Relácia H: UI prototypy (fáza R1–R5)
Rozšír `design/ui/game-ui.html` (jeden interaktívny prototyp s prepínačom stavov). Použi len tokeny z `tokens.css` a statické dáta. Nové alebo zmenené obrazovky:

| # | Obrazovka | Obsah |
|---|---|---|
| 1 | **BuildBar** | Kategórie Nábrežie, Sklad, Landside, Technika, Cesty a Železnica (zamknutá).<br>• **Sklad:** RTG blok, straddle blok, plocha reach stackera, reefer blok, depo prázdnych, OOG plocha.<br>• **Landside:** vstupný pruh, výstupný pruh, predbránový pruh, odstavná plocha, parkovisko techniky.<br>• **Technika:** ťahač, straddle, RTG, reach stacker, ECH; AGV zamknuté.<br>• **Cesty:** typ (dvojpruhová, jednopruhová, jednosmerná) a prístup (všetci, len technika, len kamióny). |
| 2 | **Inšpektor bloku** | Hlavička; obsadenosť (TEU a %), rehandling na presun, priradené RTG.<br>**Pohľad na bay zboku:** mriežka rady × výška, kontajnery farbou a glyfom typu, zavalené zvýraznené, pri reeferoch stav zásuvky. Výber bay posuvníkom.<br>Priority RTG (loď / vlak / kamión), prepínač housekeepingu. |
| 3 | **Inšpektor stroja** (RTG, ťahač, straddle, RS, ECH) | Stav, aktuálny presun (odkiaľ → kam, typ kontajnera), fronta ďalších 5 úloh s ikonami, presuny za hodinu, % čakania. Pri RTG pridelenie k bloku, pri ťahači gang alebo pool. |
| 4 | **Inšpektor brány** (skupina pruhov) | Zoznam pruhov so stavom (voľný, spracúva, problém) a režimom (štandard, express, trouble), dĺžka frontu v predbránovej ploche, priemerný čas prechodu, kamióny za hodinu. |
| 5 | **Inšpektor kamióna** | Misia, lístok (zastávky: blok, TP), aktuálny stav **textom** (napr. „Šofér v bezpečnej zóne", „Zaisťuje twistlocky"), čas v termináli (TTT), čakanie. |
| 6 | **Panel landside** (v štatistikách) | TTT priemer a p95 za 24 h (graf), front pred bránami, termíny včas a neskoro, kamióny v predbránovej ploche, na odstavnej ploche a vo vnútrozemí podľa portálu. |
| 7 | **Panel reeferov** | Zásuvky obsadené / celkom, zoznam reeferov bez napájania s odpočtom do limitu, alarmy, cena energie za deň. |
| 8 | **Karta kontraktu** (úprava) | Zmes kontajnerov (20′ / 40′, ikony typov s počtami), okno termínov odvozu, počet reeferov. |
| 9 | **Toasty a upozornenia na mape** | „Zápcha" s akciou „Ukázať" a štýlom zvýraznenia buniek na mape, „Reefer alarm", „Zásuvky plné", „Brána preplnená". |
| 10 | **Štatistiky** (doplnenie) | STS presuny za hodinu, RTG presuny za hodinu, rehandling na presun, udalosti zápch, legenda heatmapy čakania. |

**Prompt H:**
> Podľa manuálu (§3, Relácia H) rozšír interaktívny prototyp `game-ui.html` o obrazovky z tabuľky (BuildBar s novými kategóriami, inšpektor bloku s pohľadom na bay zboku, inšpektor stroja, brány a kamióna, panel landside s grafom TTT, panel reeferov, upravenú kartu kontraktu, toasty a zvýraznenie zápchy na mape, doplnené štatistiky). Len tokeny z `tokens.css`, statické dáta, rozloženie 1920×1080 s overlayom nad placeholderom mapy, over aj 1280×720. Stav šoféra zobrazuj iba textom, nikde nekresli postavy. Ku každej obrazovke daj prepínač stavov (prázdny, bežný, varovanie).

---

## 6. Odovzdanie

```
design/assets-t2/
  cargo/      container_20_dry.svg … container_20_tank.svg
  entities/   truck_cab.svg, truck_trailer_40.svg, terminal_tractor_*.svg, straddle_carrier.svg, agv.svg,
              vehicle_brake_lights.svg, rtg_*.svg, rmg_*.svg, reach_stacker*.svg, ech*.svg,
              locomotive.svg, wagon_container_60.svg
  modules/    gate_in_lane_*.svg, gate_out_lane_*.svg, gate_lane_barrier.svg, pre_gate_lane.svg,
              truck_holding.svg, vehicle_parking.svg, berth_standard.svg, reefer_rack.svg
  overlay/    tp_marker.svg, safe_zone.svg, inspection_bay.svg, reefer_plug_*.svg
  icons/      icons.svg (celý sprite s novými symbolmi)
  cargo-sheet.html, vehicles-sheet.html, machines-sheet.html, gates-sheet.html,
  yard-reference.html, rail-terminal-reference.html
design/ui/game-ui.html, game-ui.source.html (aktualizované)
```

Ak Claude Design vie vygenerovať aj **zlomok manifestu**, pridaj `design/assets-t2/manifest-fragment.json`: id, footprint, súbory, časti s pivotom a rozsahom pohybu. Nie je to povinné, doplním ho aj sám.

## 7. Farby (tokeny, hex)
| Token | Hex | Použitie |
|---|---|---|
| `--vehicle-body` | `#F4D03F` (obrys `#AA8A0A`) | interná technika (ťahač, straddle, RS, ECH) |
| `--vehicle-dark` | `#2B2B2B` | pneumatiky, podvozky |
| `--truck-cab` | `#3A6EA5` | kabína externého kamióna |
| `--truck-trailer` | `#C9CDD3` | náves |
| `--train-loco` / `--train-wagon` | `#2F5D8A` / `#7A7F87` | vlak |
| `--crane-frame` / `--crane-boom` | `#E3B23C` / `#C88B1F` (obrys `#5A3E0E`) | STS, RTG, RMG |
| `--module-base` / `--module-roof` / `--module-outline` | `#9DA3AC` / `#B8BEC7` / `#5C626B` | betón, strechy, obrysy |
| `--road-base` | `#4B5058` | asfalt |
| `--cargo-empty` | `#6E7783` (light `#98A1AD`, dark `#4A525C`) | prázdne kontajnery |
| nové (pridám do `tokens.css`) | `#D9DDE2` (neutrálny kontajner), `#ECEFF3` (reefer), `#5D7A8C` (plachta), `#3FA34D` (bezpečná zóna), `#F4D03F` (značka TP) | |

## 8. Kontrolný zoznam pred odovzdaním
- [ ] Nikde nie sú ľudia (sprity, ikony, UI).
- [ ] Plátno a viewBox presne podľa tabuľky; celé súradnice; nos hore.
- [ ] Vozidlá a stroje bez kontajnera; straddle, RTG a RMG majú priehľadný stred.
- [ ] Obrys 2 px, max 3 tóny, tieň len nad terénom, žiadny text ani gradient.
- [ ] Typ kontajnera rozpoznateľný aj bez farby.
- [ ] Pruhy brány na seba nadväzujú vo variantoch `single`, `left`, `mid`, `right`.
- [ ] Pivot a rozsah pohybu sú v komentári pri každej pohyblivej časti.
- [ ] Všetko čitateľné pri 32 px na bunku (hárky to ukazujú).
- [ ] Súbory sú v `design/assets-t2/` a `design/ui/`, nič v `assets/`.
