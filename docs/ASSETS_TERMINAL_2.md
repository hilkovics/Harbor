# Terminál 2.0: zoznam nových SVG a usmernenie ku generovaniu

> Patrí k `docs/TERMINAL_2.md`. Tento súbor môžeš celý odovzdať relácii Claude Code, ktorá bude grafiku kresliť.
> Štýl a pravidlá sú záväzné podľa `docs/DESIGN_BRIEF.md` (§2–§5, §7) a `design/tokens.css`.

## 1. Kam ukladať (dôležité)

Nové SVG ukladaj do **`design/assets-t2/<priečinok>/<id>.svg`**, nie do `assets/`. Pre priečinok `assets/` platí:
- test `tests/tools/asset-manifest.test.ts` vyžaduje, aby každé SVG v `assets/` malo záznam v `assets/manifest.json`;
- `validate:defs` kontroluje rozmery.

Súbory do `assets/` presuniem ja v príslušnej fáze R1–R7, spolu so záznamom v manifeste, pivotmi a testami.

Priečinky (rovnaké ako v `assets/`):
- `entities/` (vozidlá a stroje),
- `modules/` (budovy a plochy),
- `cargo/` (kontajnery),
- `overlay/` (značky, malé prvky),
- `icons/` (symboly do `icons.svg`).

## 2. Spoločné pravidlá (výťah z DESIGN_BRIEF)

**Pohľad a orientácia:**
- Ortografický pohľad zhora, bez perspektívy.
- Vozidlá a stroje kresli **nosom nahor**: smer jazdy je hore, dĺžka ide po osi Y.
- Engine otáča len po 90°.

**Mierka a rozmery:**
- **1 bunka = 64 px = 6 m**, teda 1 m ≈ 10,67 px.
- Plátno je presne `šírka_buniek × 64` na `výška_buniek × 64`.
- `viewBox="0 0 W H"`, `width` a `height` zhodné s viewBoxom.
- Výnimka: kontajnery v `cargo/` majú rozmer v px podľa tabuľky.
- Celočíselné súradnice. Objekty sú ≥ 4 px od okraja plátna, ak tabuľka nehovorí inak.

**Farby, obrysy, tieň:**
- **Max 3 tóny na objekt** (base, light, dark) a **obrys 2 px** v tmavšej variante base (−25 % L). Nikdy čierny.
- `rx` 2 px, vnútorné čiary 1 px, 1 px svetlá linka na hornej a ľavej hrane.
- Svetlo prichádza zľava zhora.
- Tieň len pre objekty nad terénom:
  `<filter id="s"><feDropShadow dx="2" dy="2" stdDeviation="0" flood-opacity=".2"/></filter>` a obal `<g filter="url(#s)">`.
- Farby len z `design/tokens.css` (hex hodnoty sú v §6).

**Zakázané:** text, logá, rastrové textúry a gradienty.

**Čitateľnosť:**
- Farba nikdy nie je jediný nositeľ informácie. Typ kontajnera má aj tvar alebo glyf.
- Objekt musí byť rozpoznateľný pri **32 px na bunku** (polovičný zoom).

**Stavy a časti:**
- Stavy sú samostatné súbory, nie CSS.
- Pohyblivé časti (rám, vozík, rameno, náves) sú samostatné súbory. Ku každej časti uveď v komentári na začiatku súboru **pivot** v px.
- **Vozidlá a stroje kresli bez kontajnera.** Kontajner skladá render zo samostatného spritu z `cargo/`. Výnimka je straddle carrier: ten má rám s prázdnym stredom, aby kontajner pod ním bolo vidieť.

**Pomenovanie a pozadie:**
- Názov `{id}[_{variant}][_{state}].svg`, malými písmenami, `snake_case`.
- Priehľadné pozadie (okrem plôch modulov).

## 3. Zoznam podľa fáz

Stĺpec „Plátno" udáva bunky (šírka × výška) a px.

### R1: doprava bez prekrývania
| Súbor | Plátno | Obsah | Pivot / pozn. |
|---|---|---|---|
| `entities/truck_cab.svg` | 1×1, 64×64 | Ťahač externého kamióna zhora: kabína `--truck-cab`, motor vpredu, točnica vzadu. Telo 27×60 px. | Pivot točnice (40, 54); náves sa k nemu pripája |
| `entities/truck_trailer_40.svg` | 1×2, 64×128 | Kostrový náves 40′ bez kontajnera: rám `--truck-trailer`, 4 twistlocky (malé štvorčeky v rohoch kontajnerovej plochy), 3 nápravy vzadu. Telo 27×124 px. | Pivot čapu (32, 4) |
| `entities/straddle_carrier.svg` | 1×2, 64×128 | Straddle carrier v reálnej mierke (9,6 × 4,9 m → telo 52×102 px). Dva bočné nosníky s kolesami (4 na každej strane), kabína hore vpravo, horný rám ako „H". **Stred priehľadný** (kontajner pod ním). `--vehicle-body`, `--vehicle-dark`. | Stred plátna |
| `entities/vehicle_brake_lights.svg` | 1×1, 64×64 | Dve malé červené brzdové svetlá (4×3 px) pri spodnom okraji, inak priehľadné. Render ich prekryje cez stojace vozidlo. | — |
| `modules/vehicle_parking.svg` | 4×3, 256×192 | Parkovisko techniky: asfalt `--road-base`, 4 státia 1×3 bunky s bielymi čiarami 1 px, šípka vjazdu. | Konektor dole v strede |

### R2: kontajnery a stohy
| Súbor | Plátno (px) | Obsah | Pozn. |
|---|---|---|---|
| `cargo/container_20_dry.svg` | 64×26 | Strecha 20′ zhora: zvlnenie (5 priečnych 1 px čiar), rohové odliatky (4 tmavé štvorčeky 3×3). **Neutrálna svetlá base `#D9DDE2`**, render ju tónuje farbou linky (tint). | Dlhá os vodorovne |
| `cargo/container_40_dry.svg` | 128×26 | To isté pre 40′ (10 čiar). | |
| `cargo/container_20_empty.svg` | 64×26 | Ako dry, farby `--cargo-empty` (sivá), bez tintu. | |
| `cargo/container_40_empty.svg` | 128×26 | | |
| `entities/ech.svg` | 1×2, 64×128 | Manipulátor prázdnych (ECH): telo 43×90 px, široký stožiar vpredu (priečny nosník 60 px), kabína vľavo, protizávažie vzadu. | Kontajner render kreslí **priečne pred stožiarom** |
| `entities/ech_spreader_20.svg` | 1×1, 64×64 | Bočný úchop pre 20′: tenký priečny rám 64×8 px s 2 čapmi. | Pivot (32, 4) |
| `entities/ech_spreader_40.svg` | 2×1, 128×64 | Úchop pre 40′: rám 128×8 px. | Pivot (64, 4) |

### R3: ťahače, RTG a TOS
| Súbor | Plátno | Obsah | Pivot / pozn. |
|---|---|---|---|
| `entities/terminal_tractor_cab.svg` | 1×1, 64×64 | Terminálový ťahač: krátka nízka kabína (jednomiestna, posunutá vľavo), točnica so zdvíhacou platňou. Telo 30×60 px, `--vehicle-body`. | Pivot točnice (32, 52) |
| `entities/terminal_tractor_chassis_40.svg` | 1×2, 64×128 | Terminálový podvozok (MAFI): plná plošina s vodiacimi rohmi (4 kužele), labutí krk vpredu, 2 nápravy vzadu. Telo 28×124 px, `--vehicle-dark` a `--truck-trailer`. | Pivot čapu (32, 4) |
| `entities/rtg_frame.svg` | 4×2, 256×128 | Mostový žeriav RTG zhora (nos hore = jazda pozdĺž bloku):<br>• 2 priečne nosníky cez celú šírku (256 px),<br>• 2 pozdĺžne prahové nosníky na krajoch s 2 podvozkami kolies v každom rohu,<br>• elektro/diesel domček na jednej strane,<br>• kabína na nosníku (pohyblivá je až vo vozíku).<br>`--crane-frame`, `--crane-boom` na nosníky. **Stred priehľadný**, aby bolo vidno stohy a kamión pod ním. | Rám sa posúva pozdĺž Y; 0,0 = ľavý horný roh |
| `entities/rtg_trolley.svg` | 1×1, 64×64 | Vozík s kabínou a spreaderom: obdĺžnik 40×56 px s kladkami, pod ním obrys spreadera 30×56 px (tmavý). | Pivot (32, 32); pohyb po osi X v rozsahu 32–224 px rámu |
| `entities/reach_stacker.svg` | 1×2, 64×128 | Čelný prekladač: telo 45×100 px, kabína vľavo, mohutné predné kolesá, protizávažie vzadu. Bez ramena. | — |
| `entities/reach_stacker_boom.svg` | 1×2, 64×128 | Teleskopické rameno zhora: lúč 14 px široký od zadného čapu dopredu. | Pivot (32, 116) = čap na tele; render ho vysúva posunom |
| `entities/reach_stacker_spreader_20.svg` | 1×1, 64×64 | Priečny spreader 20′ (64×10 px) s kĺbom v strede. | Pivot (32, 5) |
| `entities/reach_stacker_spreader_40.svg` | 2×1, 128×64 | Spreader 40′ (128×10 px). | Pivot (64, 5) |
| `modules/berth_standard.svg` (nová verzia) | 8×4, 512×256 | Kotvisko 8×4:<br>• horný rad = hrana mola a koľajnice STS (2 súbežné čiary),<br>• 2 pruhy pod žeriavom (biele prerušované deliace čiary, šípky smeru → vpravo),<br>• obchádzkový pruh pri pevnine (plná čiara + šípky),<br>• žlté značky TP (ich miesta určí manifest, kresli 1 vzorový rám na pozícii x 3–4).<br>Betón `--module-base`. | Voda na severe; konektory: pruhy vchádzajú zľava, vychádzajú vpravo |

### R4: landside bez rampy
| Súbor | Plátno | Obsah | Pivot / pozn. |
|---|---|---|---|
| `modules/gate_in.svg` | 4×3, 256×192 | Vstupná brána, 4 pruhy (jazda zdola nahor):<br>• ostrovčeky s búdkami (malé štvorce 14×20 so strieškou) medzi pruhmi,<br>• OCR portál = tenký priečny nosník cez všetky pruhy v hornej tretine s 4 kamerovými bodmi,<br>• striecha brány len ako obrys a priečne väzníky (vozidlá pod ňou musia byť vidieť),<br>• čiary pruhov a šípky. | Závory = existujúci `truck_gate_barrier` (1 na pruh), pozície dodá manifest |
| `modules/gate_out.svg` | 3×3, 192×192 | Výstupná brána, 3 pruhy (jazda zhora nadol):<br>• v každom pruhu **váha** (oceľová plošina 40×150 px s rámom a 3 priečnymi spojmi),<br>• **skenerový portál** (U rám cez pruh) pri výjazde,<br>• búdka na ostrovčeku. | Závory ako pri `gate_in` |
| `overlay/tp_marker.svg` | 1×1, 64×64 | Odovzdávacie miesto: žltý obdĺžnikový rám 2 px (`#F4D03F`) s rohmi v tvare „L" a malou šípkou smeru jazdy. | Kreslí sa na zem pod vozidlo |
| `overlay/safe_zone.svg` | 1×1, 64×64 | Bezpečná zóna šoféra: zelený šrafovaný obdĺžnik 40×24 px (`#3FA34D`, šrafy 45°, 1 px) s glyfom chodca (krúžok + telo). | Vedľa TP |
| `overlay/driver.svg` | 16×16 px | Postavička zhora: prilba (krúžok 6 px, biela), ramená v reflexnej veste (žltá). | Animuje ju render |
| `overlay/inspection_bay.svg` | 1×3, 64×192 | Odstavný pruh kontroly: oranžové šrafy pozdĺž okrajov a ikona lupy v strede (glyf). | Pri výstupnej bráne |

### R5: reefery a špeciálne kontajnery
| Súbor | Plátno (px) | Obsah |
|---|---|---|
| `cargo/container_20_reefer.svg` | 64×26 | Biela strecha (`#ECEFF3`), na čelnej strane tmavý pás agregátu 8 px s mriežkou (3 zvislé čiary) a malý glyf snehovej vločky v rohu strechy. |
| `cargo/container_40_reefer.svg` | 128×26 | To isté pre 40′. |
| `cargo/container_20_open_top.svg` | 64×26 | Plachta namiesto strechy: modrosivá (`#5D7A8C`) s 3 priečnymi lanami a zvlnením okrajov. |
| `cargo/container_40_open_top.svg` | 128×26 | |
| `cargo/container_40_open_top_oog.svg` | 128×34 | Ako vyššie s vydutím plachty, ktoré presahuje okraj o 4 px na každú stranu (nadrozmer). |
| `cargo/container_20_flat_rack.svg` | 64×26 | Prázdna plošina: tmavý rám, priečne podlahové doštičky, **vysoké čelné steny** na oboch koncoch (hrubšie tmavé pásy 6 px). |
| `cargo/container_40_flat_rack.svg` | 128×26 | |
| `cargo/container_40_flat_rack_oog.svg` | 128×40 | Flat rack s nákladom (stroj alebo bedňa sivozelenej farby), ktorý presahuje bočné okraje o 7 px; viditeľné laná upevnenia. |
| `cargo/container_20_tank.svg` | 64×26 | Rámová konštrukcia (rohové stĺpiky) a vo vnútri zaoblený valec cisterny (`#B8BEC7`) s kruhovým poklopom navrchu a lávkou. |
| `modules/reefer_rack.svg` | 1×1, 64×64 | Segment reefer stojana: oceľová lávka pozdĺž (12 px pás `--module-roof`), 2 stĺpiky zásuviek s káblami. Opakuje sa po bays. |
| `overlay/reefer_plug_on.svg` | 16×16 | Zelený krúžok s bleskom (zapojený). |
| `overlay/reefer_plug_alarm.svg` | 16×16 | Červený trojuholník s výkričníkom. |
| `overlay/reefer_plug_off.svg` | 16×16 | Sivý krúžok s prečiarknutou zástrčkou. |

### R6: železnica
| Súbor | Plátno | Obsah | Pivot / pozn. |
|---|---|---|---|
| `entities/rmg_frame.svg` | 6×2, 384×128 | Koľajový RMG: ako RTG, ale koľajnicové podvozky (bez pneumatík), širšie rozpätie (koľaje + buffer), konzola presahujúca o 1 bunku na jednej strane. Stred priehľadný. | Pohyb pozdĺž Y |
| `entities/rmg_trolley.svg` | 1×1, 64×64 | Vozík RMG so spreaderom. | Pohyb po osi X 32–352 px |
| `entities/locomotive.svg` (nová verzia) | 1×3, 64×192 | Lokomotíva v reálnej mierke (≈ 19 m), `--train-loco`, kabíny na oboch koncoch. | — |
| `entities/wagon_container_60.svg` | 1×3, 64×192 | 60′ kontajnerový vagón bez kontajnerov: rám s kolíkmi pre 3× 20′ alebo 1× 40′ + 1× 20′, podvozky na koncoch. `--train-wagon`. | Kontajnery skladá render |

### R7 (voliteľná): automatizácia
| Súbor | Plátno | Obsah |
|---|---|---|
| `entities/agv.svg` (nová verzia) | 1×3, 64×192 | AGV bez kabíny: plochá plošina 32×160 px, zelené a modré pásy senzorov na oboch koncoch, kontajnerové kužele. Nahrádza zastaraný `agv_*`. |
| `modules/automation_fence.svg` | 1×1, 64×64 | Dlaždica plota zóny automatizácie (pre autotile, ako cesty): oceľový plot s piliermi. Varianty `_straight`, `_corner`, `_t` (3 súbory). |

### Ikony (všetky fázy): symboly do `icons/icons.svg`
Mriežka 24 px, ťah 2 px, okrúhle konce, `currentColor`, `<symbol id="ic_…">`.

| Fáza | Symboly |
|---|---|
| R1 | `ic_traffic_jam` |
| R2 | `ic_container_20`, `ic_container_40`, `ic_rehandle` (dva kontajnery so šípkou), `ic_stack_height`, `ic_ech`, `ic_appointment` (kalendár s hodinami) |
| R3 | `ic_tractor`, `ic_rtg`, `ic_reach_stacker`, `ic_tp` |
| R4 | `ic_gate_in`, `ic_gate_out`, `ic_weighbridge`, `ic_ocr`, `ic_seal`, `ic_twistlock`, `ic_safe_zone` |
| R5 | `ic_reefer` (vločka), `ic_plug`, `ic_open_top`, `ic_flat_rack`, `ic_tank` |
| R6 | `ic_rmg`, `ic_train` |
| R7 | `ic_agv` |

## 4. Čo sa NEkreslí (urobí to render procedurálne)
- **Plochy blokov** (`rtg_block`, `straddle_block`, `rs_area`, `oog_area`, depo, železničný terminál): asfalt, biele čiary pozícií, pruh a značky. Rozmery blokov sa líšia, preto ich kreslí render z geometrie bloku tokenmi (ako dnešnú dekoráciu RTG).
- **Výška stohu:** tieň a odznak s číslom (BitmapText).
- **Zvýraznenie zápchy:** červené bunky.

## 5. Prompt pre Claude Code (skopíruj a doplň fázu)
```
Si grafik hry Modular Harbor. Prečítaj docs/DESIGN_BRIEF.md (§2–§5, §7), design/tokens.css
a docs/ASSETS_TERMINAL_2.md. Pozri si štýl existujúcich SVG: assets/entities/straddle_carrier_loaded.svg,
assets/entities/truck_container_loaded.svg, assets/modules/crane_container_gantry_base.svg,
assets/modules/truck_gate.svg, assets/cargo/container_teu.svg.

Nakresli VŠETKY súbory zo sekcie „R<N>" v docs/ASSETS_TERMINAL_2.md §3. Ukladaj ich do design/assets-t2/<priečinok>/
(NIE do assets/). Dodrž presne plátno, viewBox, orientáciu (nos hore), obrys 2 px tmavší ako base, max 3 tóny,
tieňový filter z §2, farby len z tokens.css, žiadny text ani gradient. Pri pohyblivých častiach daj na začiatok
súboru komentár <!-- pivot: x,y --> podľa tabuľky.

Potom vytvor design/assets-t2/preview.html, ktorý ukáže každý nový súbor pri 64 px aj 32 px na bunku na pozadí
cesty (#4B5058) aj betónu (#9DA3AC), vedľa existujúceho straddle_carrier a container_teu pre porovnanie mierky.
Skladaj aj kombinácie: ťahač + náves + kontajner 40′, RTG rám nad blokom so 6 radmi kontajnerov a kamiónom v pruhu.
Spusti Playwright screenshot preview.html (chromium je predinštalovaný) a pozri si PNG. Oprav, čo nesedí s pravidlami.
Nemeň nič mimo design/assets-t2/.
```

## 6. Farby z `design/tokens.css` (hex)
| Token | Hex | Kde |
|---|---|---|
| `--vehicle-body` | `#F4D03F` | telo internej techniky (obrys `#AA8A0A`) |
| `--vehicle-dark` | `#2B2B2B` | pneumatiky, podvozok |
| `--truck-cab` | `#3A6EA5` | kabína externého kamióna |
| `--truck-trailer` | `#C9CDD3` | náves |
| `--train-loco` | `#2F5D8A` | lokomotíva |
| `--train-wagon` | `#7A7F87` | vagón |
| `--crane-frame` | `#E3B23C` | rám STS, RTG, RMG |
| `--crane-boom` | `#C88B1F` | nosníky (obrys `#5A3E0E`) |
| `--module-base` | `#9DA3AC` | betón |
| `--module-roof` | `#B8BEC7` | strechy, lávky |
| `--module-outline` | `#5C626B` | obrysy modulov |
| `--road-base` | `#4B5058` | asfalt |
| `--cargo-container` | `#F28C28` (light `#F6B06B`, dark `#C7680C`) | doterajší kontajner |
| `--cargo-empty` | `#6E7783` (light `#98A1AD`, dark `#4A525C`) | prázdne |

Nové farby z tohto zoznamu pridám do `tokens.css` v príslušnej fáze:
- reefer biela `#ECEFF3`,
- plachta `#5D7A8C`,
- bezpečná zóna `#3FA34D`,
- TP žltá `#F4D03F`,
- neutrálna base kontajnera `#D9DDE2`.

## 7. Kontrola pred odovzdaním
- [ ] Plátno a viewBox presne podľa tabuľky; súradnice celé čísla.
- [ ] Nos hore; vozidlo bez kontajnera (okrem prázdneho stredu straddle).
- [ ] Obrys 2 px, max 3 tóny, svetlo zľava zhora, tieň len nad terénom.
- [ ] Žiadny text ani gradient; typ kontajnera rozpoznateľný aj bez farby (tvar alebo glyf).
- [ ] Pri 32 px na bunku je objekt čitateľný (preview).
- [ ] Pivot je v komentári pri každej pohyblivej časti.
- [ ] Všetko je v `design/assets-t2/`, nič v `assets/`.
