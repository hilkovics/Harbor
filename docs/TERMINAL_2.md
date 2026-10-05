# Terminál 2.0: návrh prestavby prevádzky prístavu

> **Stav:** návrh na schválenie (2026-10-05). Kód sa zatiaľ nemení.
> **Zdroj:** popis prevádzky od používateľa (typy kontajnerov, technika, vykládka krok za krokom, život kontajnera na ploche, kamión a vlak) a dve doplňujúce požiadavky:
> - vozidlá cez seba neprechádzajú,
> - rampa na nakladanie kamiónov ide preč, kamióny nakladajú priamo žeriavy.
>
> **Nadväzuje na:** `docs/PORT_OPERATIONS.md`, ktorého §2.4, §2.5 a §3 tento návrh nahrádza; ARCHITECTURE §5–§7 a §14; ADR-017 až ADR-035.
> **Zoznam nových SVG a usmernenie ku generovaniu:** `docs/ASSETS_TERMINAL_2.md`.
> **Po schválení:**
> - ADR-036 až ADR-043 (rozdelenie v §12),
> - prepis `IMPLEMENTATION_PLAN.md`: fázy R1–R7 pred dnešnou F7,
> - úprava CLAUDE.md: sekcia „Čo NEROBIŤ", bod o kolíziách vozidiel.

## 0. Zhrnutie

**Čo sa zmení:**
1. **Kontajnery** budú mať veľkosť (20′ = 1 TEU, 40′ = 2 TEU) a typ: suchý, chladiarenský (reefer), open top, flat rack, tank. „Prázdny" je stav kontajnera, nie typ: aj prázdny reefer je stále reefer.
2. **Sklad** sa skladá z **blokov so stohmi**, kde má každý kontajner presnú polohu `bay / row / tier`.
   - Vybrať sa dá len vrchný kontajner. Ak je potrebný kontajner zavalený, stroj musí najprv preložiť tie nad ním (rehandling). Stojí to čas a peniaze.
   - **Plánovač skladu (TOS)** ukladá kontajnery tak, aby ten, ktorý odchádza skôr, ležal vyššie.
3. **Technika podľa tvojho popisu:**
   - STS žeriav na nábreží,
   - terminálové ťahače (TT) a AGV,
   - straddle carriery,
   - mostové žeriavy RTG a RMG,
   - čelné prekladače (reach stacker),
   - manipulátory prázdnych kontajnerov (ECH).

   Každý stroj má vlastné miesto pôsobenia, výkon a obmedzenia.
4. **Vykládka cez ťahač a RTG:**
   - STS položí kontajner priamo na terminálový ťahač, ktorý stojí pod ním.
   - Ťahač ide po jednosmerných trasách k bloku.
   - RTG z neho kontajner zdvihne a uloží do stohu.

   Nakládka lode prebieha opačne.
5. **Rampa zanikne a s ňou aj stojisko:**
   - Kamión prejde vstupnou bránou (OCR a kontrola) a dostane lístok s blokom a pozíciou.
   - Ide vyznačeným koridorom k **odovzdávaciemu miestu (TP) pri bloku**. Šofér medzitým čaká v **bezpečnej zóne**.
   - RTG (alebo reach stacker či ECH) naloží kontajner priamo na náves a šofér zaistí twistlocky.
   - Na výstupnej bráne kamión prejde vážením, skenom a kontrolou plomby.
6. **Vozidlá cez seba neprechádzajú:**
   - Každý pruh cesty pojme len toľko vozidiel, koľko sa doň fyzicky zmestí.
   - Vozidlá majú dĺžku: kamión a ťahač s návesom zaberú 3 bunky, straddle carrier 2.
   - Na križovatky sa vchádza, len keď je voľný výjazd.
   - Fronty pred bránou, pod žeriavom a pri bloku sú fyzické a vidno ich na ceste.
7. **Reefery** patria do reefer zóny so zásuvkami. Elektrina stojí peniaze a odpojený reefer sa po limite pokazí (reklamácia).
   **Prázdne** idú do depa, kde ich ECH stohuje 7–8 na seba.
8. **Vlak:**
   - Železničná stanica na okraji terminálu.
   - Ťahače vozia kontajnery k jej bufferu.
   - RMG nakladá vagóny po celých blokoch.

**Čo ostáva:**
- mriežka, mapa a cesty (rozšírené o pruhy),
- lode, ich plavba a kotvenie,
- cyklus STS žeriavu,
- kontrakty, bookingy, voyage, stowage, prekládka a tok prázdnych (návrat, M&R, výdaj, repositioning),
- ekonomika, ukladanie hry (obálka), UI a render pipeline,
- determinizmus a `CargoLedger` („nič sa neteleportuje").

**Rozsah:** ide o prestavbu jadra, nie o úpravu. Odhad je ≈ 20 SD v siedmich fázach R1–R7. Po každej fáze vznikne hrateľná verzia.

Zmizne alebo sa prepíše:
- pozemná strana: rampa, stojisko, `DockIntake`, väčšina FSM kamióna,
- sklad (počet bez poradia → stohy),
- dispatcher (→ TOS),
- pohyb vozidiel (→ pruhy so slotmi),
- zhruba štvrtina testov.

**Rozhodnutia, ktoré potrebujem od teba, sú v §13.** Na každé mám odporúčanie.

---

## 1. Realita, súčasná hra a návrh

| Realita (z tvojho popisu) | Hra dnes (po F6d) | Návrh |
|---|---|---|
| 20′ a 40′ kontajnery; Dry, Reefer, Empty, Open Top, Flat Rack, Tank | Jediný typ `container_teu`, 1 jednotka = 1 TEU | Veľkosť 20/40 a typ v defe `container_types.json` (§3) |
| Reefery v reefer zóne, zapojené do siete | Nie | Reefer bloky so zásuvkami, elektrina, limit odpojenia, alarmy (§6.7) |
| Prázdne oddelene v Empty Depot, 7–8 na seba | Depo prázdnych s kapacitou (počet) a empty handler | Depo ako blok s výškou 7–8 a strojom ECH (§4, §6.6) |
| STS zdvihne kontajner z bunky lode a položí ho na mólo | Áno (cyklus žeriavu) | Bez zmeny; pribudnú pruhy pod žeriavom (§6.1) |
| Pod žeriavom čaká ťahač alebo AGV, žeriav kladie priamo naň | Straddle carrier pod hákom (F6d) | Ťahač a AGV pod hákom; pruhy pod žeriavom s frontou (§6.1, §7.7) |
| Ťahač jazdí po jednosmerných trasách k bloku | Vozidlá jazdia po ľubovoľných cestách, cez seba | Pruhy, jednosmerky odporúčané, fyzické fronty (§7) |
| Na dvore RTG alebo reach stacker zdvihne kontajner z ťahača do stohu | Vozidlo samo „vyloží" do skladu (počet) | RTG, RS a ECH ako stroje so stavmi a časmi (§5, §6.1) |
| Straddle carrier stohuje 3–4 na seba | Straddle vozí, sklad nemá stohy | Straddle bloky s výškou 3 (1 nad 2) (§4.1) |
| Ukladanie podľa času odchodu (žiadne zavalenie) | Najbližší sklad, zoskupenie podľa voyage | Plánovač polohy podľa času odchodu, hmotnosti a linky (§4.4) |
| Brána: OCR, kontroly, digitálny lístok s blokom | Jedna brána s FIFO frontou a časom prechodu | Vstupná brána s pruhmi, lístok = TP pri bloku (§8) |
| Koridory, do 30 km/h, zastavenie pri bloku | Kamión ide na rampu | Prístup ciest pre externé kamióny, TP v pruhu bloku (§7.10, §6.4) |
| Šofér v bezpečnej zóne, RTG nakladá na náves, šofér zaistí twistlocky | Rampa, dock a cúvanie | TP + bezpečná zóna + RTG + lashing; rampa zaniká (§6.4) |
| Výstupná brána: váženie, sken, plomba | Brána bez kontrol pri výjazde | Výstupná brána s váhou, skenom a plombou (§8) |
| Vlak: stanica, ťahače, RMG nakladá vagóny po blokoch | Nič (len sprity) | Železničný terminál s RMG (§6.9, fáza R6) |
| Vozidlá cez seba neprechádzajú | „Soft" kongescia (v skutočnosti vozidlá cez seba prechádzajú) | Pruhy so slotmi, dĺžka vozidiel, pravidlá križovatiek, detekcia zápchy (§7) |

---

## 2. Cieľový obraz terminálu

```
  more ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  loď  [=======================]           rejda (lode čakajú, T6D-03)
  ─────────── nábrežie (kotvisko) ─────────────────────────────────────
   STS#1        STS#2          ← koľajnice STS
   [TP]========[TP]=========►  pruh pod žeriavom 1 (jednosmerný)
   [TP]========[TP]=========►  pruh pod žeriavom 2
   ════════════════════════►  obchádzkový pruh (nikto tu nestojí)
  ───────────────────────────────────────────────────────────────────────
   ▲ interný jednosmerný okruh (ťahače, AGV, straddle)                   ▼
   ┌RTG blok A────────────┐  ┌RTG blok B────────────┐  ┌Reefer blok────┐
   │▓▓▓▓▓▓▓▓▓▓▓ 6 radov   │  │▓▓▓▓▓▓▓▓▓▓▓           │  │▓▓ zásuvky ▓▓▓│
   │==TP==TP==TP== pruh ═►│  │==TP==TP==TP== pruh ═►│  │==TP==TP====►│
   └──────────────────────┘  └──────────────────────┘  └───────────────┘
   ┌Empty depot (ECH, 8 výška)┐  ┌OOG plocha (RS)┐  ┌Žel. terminál (RMG)┐
  ───────────────────────────────────────────────────────────────────────
   koridor externých kamiónov (do 30 km/h)  ◄═══ výstupná brána (váha, sken)
                                            ═══► vstupná brána (OCR, lístok)
                                     portál (verejná cesta) ↕
```

Hráč stavia **bloky** (typ bloku určuje stroj), **cesty s pruhmi a smermi**, **brány** a **kotviská so žeriavmi** a kupuje **stroje**.

TOS (simulácia) rozhoduje, kam ide ktorý kontajner a ktorý stroj ho vezme. Hráč vidí metriky a zápchy a podľa nich upravuje rozloženie a počty strojov.

---

## 3. Kontajnery

### 3.1 Veľkosti a typy

| Typ (`containerType`) | Veľkosti | Stohovanie | Zvláštnosti | Manipulácia |
|---|---|---|---|---|
| `dry` (Dry Van) | 20, 40 | bežné | — | všetky stroje |
| `reefer` | 20, 40 | bežné, **len na pozícii so zásuvkou** | príkon, limit odpojenia, alarmy | všetky; pred zdvihom odpojiť, po uložení zapojiť |
| `open_top` | 20, 40 | bežné; **s nadrozmerom (OOG) nič naň** | nadrozmerný náklad podľa šance v kontrakte | OOG: STS s rámom (dlhší cyklus), v sklade OOG plocha (RS) |
| `flat_rack` | 20, 40 | **len navrch alebo na zem**; s OOG len na zem | prázdne flat racky sa skladajú do balíkov (neskôr) | ako `open_top` |
| `tank` | 20 | bežné | voliteľne nebezpečný tovar (zóna IMO, neskôr) | všetky stroje |

- **Prázdny** = `direction: 'empty'` (už existuje). Platí pre každý typ, takže aj prázdny reefer či flat rack môže byť v depe. Depo ho stohuje vyššie, lebo je ľahký.
- **Veľkosť sa ráta v TEU:**
  - 20′ = 1 TEU, 40′ = 2 TEU;
  - kontrakty a kapacity lodí ostávajú v TEU;
  - počet kontajnerov = TEU podľa zmesi veľkostí v šablóne kontraktu (napr. 40 % 20′, 60 % 40′).
- **Stohovanie podľa veľkosti:** na 20′ smie ísť len 20′ a na 40′ len 40′. Je to zjednodušenie: v realite možno 40′ položiť na dva 20′, ale nie naopak. Tak sa vyhneme miešaným stohom.

### 3.2 Dátový model

```ts
// cargo/cargo-unit.ts — nové nemenné štítky (ako direction, lineId)
type ContainerSize = 20 | 40;
interface CargoLabels {
  // … doterajšie: direction, voyageId, lineId, destinationPort, weightClass
  readonly sizeFt: ContainerSize;
  readonly containerType: string;   // id z container_types.json
  readonly oog: boolean;            // nadrozmer (len open_top / flat_rack)
}
// meniteľný stav jednotky (v ledgeri, v save)
interface CargoUnitRuntime {
  // … doterajšie: hold, status, repairUntilTick
  reefer?: { plugged: boolean; unpluggedSinceTick: number | null; alarmUntilTick: number | null };
  seal?: 'ok' | 'mismatch';         // výsledok kontroly plomby na výstupnej bráne
}
```

```jsonc
// data/defs/container_types.json (nový súbor + schéma)
{ "schemaVersion": 1, "items": [
  { "id": "dry",       "sizes": [20, 40], "stacking": "normal",      "needsPower": false, "oogChance": 0,    "rateMultiplier": 1.0 },
  { "id": "reefer",    "sizes": [20, 40], "stacking": "normal",      "needsPower": true,  "oogChance": 0,    "rateMultiplier": 1.6 },
  { "id": "open_top",  "sizes": [20, 40], "stacking": "normal",      "needsPower": false, "oogChance": 0.5,  "rateMultiplier": 1.4 },
  { "id": "flat_rack", "sizes": [20, 40], "stacking": "top_only",    "needsPower": false, "oogChance": 0.8,  "rateMultiplier": 1.8 },
  { "id": "tank",      "sizes": [20],     "stacking": "normal",      "needsPower": false, "oogChance": 0,    "rateMultiplier": 1.3 }
]}
```

Šablóny kontraktov dostanú `sizeMix` (podiel 20′/40′) a `typeMix` (podiel typov). Rozdelenie urobí `Rng` pri vzniku ponuky, ako dnes hmotnostné triedy.

---

## 4. Sklad: bloky, stohy, plánovanie polohy

### 4.1 Bloky

Blok je modul (nová trieda `YardBlock extends StorageModule`, pravidlo 7) s vnútornou mriežkou **bay × row × tier**. Typ bloku určuje, ktorý stroj ho obsluhuje, aké vysoké sú stohy a odkiaľ sa k nim dostane vozidlo.

| Def (príklad) | Stroj | Rady × výška | Prístup vozidiel | Rozmer (bunky) | Poznámka |
|---|---|---|---|---|---|
| `rtg_block_12` | RTG (1–2 na blok) | 6 radov × 5 (1 nad 4) | **pruh pre kamióny a ťahače** po dĺžke bloku, vjazd z jedného konca a výjazd z druhého, TP v pruhu | 12 dĺžka × 4 šírka (6 radov × 0,5 bunky + pruh 1 bunka) | Vysoká hustota, RTG je úzke hrdlo |
| `straddle_block_8` | straddle carrier | 8 radov × 3 (1 nad 2) | straddle jazdí nad radom (každý rad je jeho pruh) | 8 × 8 | Nízka hustota, rýchle, drahá údržba; kamióny obsluhuje SC na TP pri bloku |
| `rs_area` | reach stacker | 3 rady od uličky × 5/4/3 | ulička pozdĺž, TP v uličke | 8 × 4 | Malé terminály, OOG plocha |
| `empty_depot` (prestavba) | ECH | 2 rady od uličky × 8 | ulička, TP pri vjazde | 6 × 6 | Len prázdne, oprava M&R v jednom rade |
| `reefer_block_8` | RTG | 4 rady so zásuvkami × 4 | ako `rtg_block` | 8 × 4 | Pozície bez zásuvky nemá; príkon za hodinu |
| `oog_area` | reach stacker (mobilný žeriav neskôr) | 1 rad × 1 (len na zem) | ulička | 6 × 3 | OOG open top a flat rack |
| `rmg_rail_block` (R6) | RMG | buffer 4 rady × 4 + koľaje | koľaj + pruh pre ťahače | 16 × 6 | Železničný terminál |

**Mierka:** bay = 1 bunka (6 m ≈ 20′), 40′ zaberie 2 susedné bays. Rad v RTG bloku má šírku 0,5 bunky (kontajner 2,44 m + medzera). Poloha v rámci bloku je abstraktná, `(bay, row)`; na pixely ju prepočíta až render. Mriežka mapy sa preto nemení.

### 4.2 Poloha kontajnera

```ts
// cargo/cargo-location.ts — in_storage dostane polohu v stohu (namiesto plochého slotu)
| { kind: 'in_storage'; moduleId: EntityId; bay: number; row: number; tier: number }  // 40′: bay = prvá z dvoch
```

Blok drží `StackGrid`: `Int32Array(bays × rows × maxTier)` s id jednotiek. Je to odvodená cache, zdrojom pravdy ostáva ledger. Pre 40′ zapíše obe bays.

`CargoLedger.move` overí:
- uloženie len na zem alebo na vrchol stohu rovnakej veľkosti, do výšky `maxTier` bloku a stroja;
- výber len vrchného kontajnera;
- reefer len na pozíciu so zásuvkou;
- `top_only` / OOG navrch, nič na OOG.

Porušenie znamená chybu (invariant), nie tichú opravu.

### 4.3 Prístup a rehandling

Ak potrebný kontajner nie je navrchu, stroj najprv preloží kontajnery nad ním. Ide o **rehandle** (presun `shift`):
1. Ciele hľadá `YardPlanner` v dosahu stroja; pri RTG je to rovnaký bay, iný rad. Prednosť má stoh, ktorého vrch odchádza neskôr než preložený kontajner.
2. Každý shift trvá celý cyklus stroja (zdvih, prejazd vozíka, spustenie). Ledger: `in_storage → in_handler → in_storage`.
3. Metrika `rehandlesPerMove`. V inšpektore bloku je vidno „zavalené" kontajnery.

### 4.4 Plánovač polohy (`YardPlanner`, súčasť TOS)

Volá sa, keď sa rozhoduje, kam kontajner pôjde: pri pláne vykládky, pri vstupnej bráne (lístok) a pri presune do depa. Postup je deterministický, s poradím `(skóre, id bloku, bay, row)`:
1. **Filter zóny:**
   - reefer len na pozíciu so zásuvkou,
   - prázdny len do depa (fallback ako dnes),
   - OOG len na OOG plochu,
   - veľkosť stohu musí sedieť,
   - blok musí byť dosiahnuteľný po cestách od zdroja.
2. **Segregácia:**
   - export podľa kľúča `voyage → destinationPort → weightClass → veľkosť`; ťažké sa nakladajú prvé, preto ležia navrchu alebo v samostatných stohoch;
   - import podľa termínu odvozu (§4.5);
   - prekládka podľa lode B;
   - prázdne podľa linky, veľkosti a typu.
3. **Bez zavalenia:** stoh je vhodný, keď jeho vrchný kontajner odchádza **neskôr alebo v rovnakom čase**. Inak sa vezme prázdny stoh. Ak nie je ani taký, vyberie sa stoh s najmenšou „budúcou" penalizáciou.
4. **Vzdialenosť a vyťaženie:** export bližšie k nábrežiu, import bližšie k bráne; menej vyťažený RTG má prednosť.
5. **Rezervácia:** pozícia sa rezervuje hneď (ako dnes slot), aby dve úlohy nemierili na rovnaké miesto.

### 4.5 Čas odchodu: odkiaľ ho hra pozná

| Smer | Plánovaný odchod | Stav dnes |
|---|---|---|
| export | príchod lode voyage (`shipArrivalTick`), poradie podľa stowage | existuje |
| tranship | príchod lode B (`outArrivalTick`) | existuje |
| import | **termín odvozu kamiónom** (Truck Appointment System) | **nové**: pri vykládke `Rng` určí termín v okne `importDwellHoursRange` pred SLA. Kamión príde na termín (vnútrozemie ADR-035 už to vie), nie „keď je náklad na rampe". |
| prázdny | neznámy, FIFO podľa linky | existuje (plán výdajov dáva `dueTick`, ak je) |

Termíny odvozu sú zároveň realistickejšie. Kamióny prídu rozložene a dá sa merať, či terminál stihol pripraviť kontajner načas.

### 4.6 Housekeeping a pre-marshalling (neskôr, R7)

V nečinnom čase RTG preskupí exporty ďalšej lode do poradia nakládky. Netreba to hneď, pretože dobrý plánovač z §4.4 väčšinu rehandlingu predíde.

---

## 5. Technika

### 5.1 Stroje

| Stroj | Druh v sime | Kde jazdí | Čo vie | Stoh | Dĺžka (bunky) |
|---|---|---|---|---|---|
| STS žeriav | modul na kotvisku (existuje) | koľajnice kotviska | loď ↔ ťahač, AGV, straddle (alebo zem pod žeriavom pre straddle) | — | — |
| Terminálový ťahač (TT) | vozidlo `TerminalTractor` | len interné cesty (nie verejné) | vezie 1× 40′ alebo 2× 20′, **sám nezdvihne** | — | 3 (ťahač + podvozok) |
| AGV | vozidlo `Agv extends TerminalTractor` | len zóna automatizácie (R7) | ako TT, bez mzdy, drahšie, pomalšie zrýchlenie | — | 3 |
| Straddle carrier (SC) | vozidlo `StraddleCarrier` | interné cesty a straddle bloky | zdvihne sám, vezie pod sebou, stohuje, nakladá kamión na TP straddle bloku | 3 (1 nad 2) | 2 |
| RTG | stroj `RtgCrane extends GantryCrane` | pozdĺž svojho bloku; pomalý presun do susedného bloku (otočenie kolies) | stoh ↔ ťahač, kamión, rehandle | 5 (1 nad 4) | — |
| RMG | stroj `RmgCrane extends GantryCrane` | koľajnice bloku (železničný terminál R6, automatizovaný blok R7) | stoh ↔ vagón, ťahač, kamión | 5 | — |
| Reach stacker (RS) | stroj `ReachStacker extends AreaHandler` | vo svojej ploche (`rs_area`, `oog_area`) | zdvihne, prenesie v ploche, 3 rady do hĺbky | 5/4/3 | — |
| ECH | stroj `EmptyContainerHandler extends AreaHandler` | v depe prázdnych | len prázdne, bočný úchop, rýchly | 8 | — |

- **RS a ECH v simulácii nejazdia po cestách.** Nesú kontajner naprieč pred sebou, teda 12 m na šírku, takže na cesty sa nehodia. Pracujú vo svojej ploche a kontajnery im dovezú ťahače a kamióny na TP plochy. RTG je rovnako viazaný na blok.
- **Straddle carrier zostáva ako alternatívny systém.** Dnešné hry a scenáre ho používajú a je to realistická voľba (Rotterdam či Hamburg ho majú).

### 5.2 Systémy terminálu (hráč volí stavbou)
- **Straddle:** STS → zem pod žeriavom → SC → straddle blok. Kamión obsluhuje SC na TP pri bloku. Je jednoduchý a rýchly na štart (dnešný stav s pridanými stohmi).
- **Ťahač + RTG:** STS → TT → RTG blok. Kamión obsluhuje RTG v pruhu bloku. Je to predvolený realistický systém z tvojho popisu.
- **Automat:** STS → AGV → RMG blok. Má vysoký capex a nízky opex (R7).
- **Malý terminál:** reach stackery a ťahače, lacné, nízka hustota.

Systémy sa smú kombinovať. TOS vyberie reťazec podľa typu cieľového bloku (tabuľka `HANDLING_CHAINS`, nie switch).

### 5.3 Model strojov v kóde

```
Carrier (pohyb po pruhoch, §7)                     YardMachine (viazaný na modul)
 ├─ Vehicle (interná technika)                      ├─ GantryCrane (os pozdĺž bloku + vozík naprieč)
 │   ├─ StraddleCarrier (canLift, stackTiers 3)      │   ├─ RtgCrane (blockChangeTicks)
 │   ├─ TerminalTractor (canLift = false)            │   └─ RmgCrane (koľaj, bez zmeny bloku)
 │   │   └─ Agv (zóna automatizácie, bez mzdy)       └─ AreaHandler (pohyb v ploche)
 │   └─ … (shuttle carrier, neskôr)                      ├─ ReachStacker (dosah po radoch)
 └─ Truck (externý kamión: návšteva s lístkom)           └─ EmptyContainerHandler (len prázdne)
```

**FSM yard stroja** (tabuľka prechodov podľa CLAUDE.md):

`idle → travel` (pojazd pozdĺž bloku k bay) `→ (shift)* → lower → lock → hoist → trolley → lower → unlock → hoist → idle`

Časy sú v defoch v tikoch: `gantryCellsPerTick`, `trolleyTicksPerRow`, `hoistTicksPerTier`, `lockTicks`, `blockChangeTicks`. Stroj drží najviac 1 kontajner. Ledger: `in_handler{machineId}`.

### 5.4 TOS: úlohy a ich nohy

Dnešný `TransportJob` (1 vozidlo, odkiaľ → kam) nahradí **`Move`** s reťazcom **nôh**. Každú nohu robí iný stroj a stretávajú sa na **odovzdávacích miestach (TP)**:

```ts
type MoveKind = 'discharge' | 'load' | 'receive' | 'deliver' | 'shift' | 'rail_in' | 'rail_out' | 'housekeeping';
interface Move { id; kind: MoveKind; unitId; priority; createdTick; legs: Leg[] }
interface Leg  { role: 'quay' | 'carrier' | 'yard' | 'truck'; machineId: EntityId | null; from: Place; to: Place; state: LegState }
// Place = poloha v ledgeri + TP, kde sa odovzdá (pod STS, v pruhu bloku, na koľaji…)
```

- **Odovzdanie:** stroj, ktorý zdvíha, a vozidlo, ktoré vezie, musia byť naraz na TP. Kto príde skôr, čaká. Meria sa to (`craneWaitForVehicleTicks`, `rtgWaitForTruckTicks`, `truckWaitForRtgTicks`).
- **Priority v RTG fronte** (def `yardPriorities`, hráč ich môže zmeniť v inšpektore bloku): **loď > vlak > kamión > housekeeping**. Pri prílišnom čakaní kamiónov sa kamión posunie vyššie (`truckMaxWaitTicks`), aby sa nezhoršil čas obratu kamiónu (TTT).
- **Prideľovanie ťahačov:** pool pre celý terminál (TOS pošle najbližší voľný) alebo „gang" na žeriav (`tractorsPerSts`). Prepínač v inšpektore žeriavu.
- **Postupnosť pri lodi:** STS pracuje podľa stowage poradia. TOS vytvára nohy vopred na `lookaheadMoves` dopredu, aby ťahač dorazil, kým žeriav dokončí predchádzajúci cyklus. Dnešný „dispatch vopred" (ADR-033) sa tým zovšeobecní.

---

## 6. Procesy krok za krokom

Všetky časy sú v defoch (pravidlo 4). Všetky presuny idú cez `CargoLedger.move` (pravidlo 2).

### 6.1 Vykládka v systéme ťahač + RTG
1. Loď zakotví (bez zmeny). TOS z plánu vykládky vytvorí `Move(discharge)` a hneď cez `YardPlanner` určí cieľovú pozíciu v bloku (rezervácia).
2. TT dostane nohu `carrier` a ide po interných cestách do **pruhu pod žeriavom**.
   - Stáva sa do fronty; ak je TP obsadené, stojí za ním.
   - Keď je TP voľné, zastaví presne pod žeriavom.
3. STS zdvihne kontajner (`on_ship → in_crane`) a položí ho na podvozok TT (`in_crane → in_vehicle`, čas `chassisLockTicks`).
4. TT ide po jednosmerných trasách k cieľovému bloku, do jeho pruhu. Zastaví na TP pri cieľovom bay alebo za predchádzajúcim vozidlom.
5. RTG prejde k bay, zdvihne kontajner z TT (`in_vehicle → in_handler`) a uloží ho do stohu (`in_handler → in_storage{bay,row,tier}`). TT je voľný hneď po zdvihu.

**Ledger:** `on_ship → in_crane → in_vehicle(TT) → in_handler(RTG) → in_storage`.

### 6.2 Vykládka v systéme straddle
STS položí kontajner na **zem pod žeriavom** (`on_quay_tp`, nástupca apronu; 1–2 miesta na žeriav). Žeriav tak nečaká na vozidlo. SC kontajner zdvihne a uloží do straddle bloku, najviac 1 nad 2.

Dnešný režim `under_hook` (SC čaká pod hákom) ostáva ako voľba v defe kotviska.

**Ledger:** `on_ship → in_crane → on_quay_tp → in_vehicle(SC) → in_storage`.

### 6.3 Nakládka lode
Proces je opačný:
1. TOS určí poradie podľa stowage (bez zmeny, ADR-032).
2. RTG kontajner vyberie, aj s prípadným rehandlingom, a položí ho na TT.
3. TT ho dovezie pod STS a žeriav ho naloží na loď.

Dual cycling (ADR-032) ostáva: TT, ktorý priviezol export, odvezie hneď import z toho istého žeriavu.

### 6.4 Kamión: odvoz importu (cez žeriav, bez rampy)
1. **Termín:** pri vykládke importu vznikne termín odvozu (§4.5). V jeho čase kamión čaká vo vnútrozemí (ADR-035) a vojde, keď je miesto na príjazdovej ceste.
2. **Vstupná brána (in-gate):** kamión zastaví v jednom z pruhov brány.
   - Prebehne **OCR** (`ocrTicks`) a **kontrola šoféra a dokladov** (`checkTicks`).
   - S malou šancou `gateIssueChance` vznikne problém. Kamión vtedy ide do „trouble" pruhu a čaká `troubleTicks`.
   - TOS vydá **lístok**: blok, bay a TP (pozícia v pruhu bloku).
3. **Koridor:** kamión ide len po cestách s prístupom pre externé kamióny (§7.10), rýchlosťou `truckSpeedFactorInTerminal` (do 30 km/h).
4. **TP pri bloku:** zastaví na TP svojho lístka (alebo za vozidlom pred ním). Šofér vystúpi do **bezpečnej zóny** (`driverToSafeZoneTicks`); v renderi ho vidno pri TP.
5. **Naloženie:** RTG prejde nad stoh, preloží zavaľujúce kontajnery, zdvihne cieľový, prejde nad kamión a pomaly ho spustí na náves. Ledger: `in_storage → in_handler → in_truck`.
6. **Lashing:** šofér sa vráti a zaistí 4 twistlocky (`twistlockTicks × 4`).
7. **Výstupná brána (out-gate):** váženie na nápravy (`weighTicks`), sken stavu kontajnera (`scanTicks`) a kontrola plomby.
   - S malou šancou `sealIssueChance` ide kamión na kontrolu do odstavného pruhu (`inspectionTicks`).
   - Potom sa otvorí závora a kamión opustí mapu (`in_truck → exported`).

**Metrika TTT (truck turnaround time):** čas od vstupnej brány po výstupnú. Hlavný ukazovateľ landside, zobrazený v HUD alebo štatistikách.

### 6.5 Kamión s exportom a dual transaction
Postup je ako v §6.4, s týmito rozdielmi:
- na vstupnej bráne sa navyše kontroluje VGM a booking (existuje, ADR-032; cut-off a rolled ostávajú);
- pri TP šofér najprv **odistí twistlocky** (`unlashTicks`) a až potom RTG kontajner zdvihne (`in_truck → in_handler → in_storage`).

**Dual transaction:** lístok má 2 zastávky. Kamión po vyložení exportu ide na TP iného bloku pre import alebo prázdny a až potom na výstupnú bránu. Plánovač termínov spáruje export a import tej istej firmy (`dualTransactionShare` v defe).

### 6.6 Prázdne kontajnery
- **Návrat z vnútrozemia:** kamión s prázdnym ide na TP depa. ECH kontajner zdvihne a uloží až do výšky 8. Kontrola a M&R (F6c) ostávajú; poškodený ide do radu opráv.
- **Výdaj exportérovi:** kamión `collect` ide na TP depa a ECH naloží prázdny kontajner jeho linky, typu a veľkosti.
- **Repositioning na loď:** ECH položí prázdny na TT, TT ho vezie pod STS.
- **Vyprázdnený import v termináli (CFS):** voliteľne neskôr. Import určený na „stripping" by šiel do skladu CFS a odtiaľ prázdny do depa (čelný prekladač → ECH na vrchol veže). Mimo prvej vlny.

### 6.7 Reefery
1. Pri vykládke `YardPlanner` vyhradí pozíciu so zásuvkou. Ak žiadna voľná nie je, reefer sa nevyloží: STS ho preskočí, kým sa zásuvka neuvoľní, a hráč dostane upozornenie.
2. Od zdvihu z lode beží čas **bez napájania**. Po uložení technik reefer zapojí (`plugTicks`) a čas sa zastaví. Ak bez napájania presiahne `maxUnpluggedHours`, vznikne **reklamácia** (`reeferClaimCents` a reputácia, F12).
3. Kým je reefer zapojený, platí sa elektrina (`reeferPowerCentsPerHour`, nová kategória ledgera `energy`).
4. Občas vznikne **alarm** (`reeferAlarmChancePerDay`). Technik musí prísť do `alarmResponseHours`, inak hrozí reklamácia.
5. Pred odvozom alebo nakládkou sa reefer odpojí (`unplugTicks`) a čas bez napájania beží znova.

Lode s reefer slotmi prídu až s plným stowage plánom (F12). Dovtedy reefery smú na každú loď.

### 6.8 Špeciálne kontajnery
- **OOG** (open top alebo flat rack s nadrozmerom):
  - STS použije OOG rám (`oogExtraCycleTicks`);
  - v sklade ide len na `oog_area` (na zem), kde ho obsluhuje reach stacker;
  - na kamióne trvá zaistenie dlhšie (`oogLashTicks`).
- **Flat rack bez nákladu** smie ísť len navrch stohu.
- **Tank** sa stohuje bežne. Neskôr dostane voliteľný príznak nebezpečného tovaru so zónou IMO.

### 6.9 Vlak (R6)
- **Infraštruktúra:** železničný terminál na okraji mapy (`rail_portal` existuje). Tvoria ho koľaje pod RMG a buffer stoh pod tým istým RMG.
- **Príjazd do bufferu:** TT vozia kontajnery zo skladu do bufferu.
- **Vlak:**
  - príde podľa cestovného poriadku (rail podiel importov a exportov v kontrakte);
  - RMG nakladá vagóny po blokoch (najprv celý vagón, potom ďalší);
  - vlak odíde v plánovanom čase alebo keď je plný.
- **Ledger:** `in_storage(buffer) → in_handler(RMG) → in_train → exported` a opačne pri príjme.

### 6.10 Nové prechody v `CargoLedger` (ARCHITECTURE §7.1)

| Z | Do |
|---|---|
| `on_ship` | `in_crane`, `shipped` |
| `in_crane` | `in_vehicle` (TT, AGV, SC pod hákom), `on_quay_tp`, `on_ship` |
| `on_quay_tp` | `in_vehicle` (SC), `in_crane` |
| `in_vehicle` | `in_handler` (RTG, RMG, RS, ECH zdvihne z TT), `in_storage` (SC stohuje sám), `in_crane`, `on_quay_tp`, `in_truck` (SC na kamión) |
| `in_handler` | `in_storage`, `in_vehicle`, `in_truck`, `in_train` |
| `in_storage` | `in_handler`, `in_vehicle` (SC) |
| `in_truck` | `in_handler`, `in_vehicle` (SC), `exported` |
| `in_train` | `in_handler`, `exported` |

Zaniká `at_ramp`. `on_apron` sa premenuje na `on_quay_tp`. `in_pipeline` ostáva pre neskoršie komodity.

Konzervácia `created = živé + exported + shipped` platí bez zmeny.

---

## 7. Doprava: vozidlá cez seba neprechádzajú

### 7.1 Princíp
Nejde o fyziku (zrážky, hmotnosti). Ide o **diskrétne obsadenie pruhov**:
- každá bunka cesty má podľa typu 1–2 **pruhové sloty**;
- vozidlo smie vojsť do slotu, len keď je voľný;
- dlhé vozidlo drží niekoľko slotov za sebou.

Model je deterministický, lacný (pole `Int32Array`) a vizuálne presvedčivý: fronty, zápchy, čakanie na križovatke.

> Ruší sa ADR-005 a ARCHITECTURE §7.6 („soft kongescia"), ako aj bod v CLAUDE.md „Čo NEROBIŤ: Fyzikálne kolízie vozidiel". Nahradí ich ADR-037. Dnešné meranie: v `stress_f6` sa vozidlá prekrývajú v 29 992 z 30 000 tickov.

### 7.2 Pruhy podľa typu cesty

| Bunka | Sloty | Pravidlo |
|---|---|---|
| `two_lane`, rovná alebo zákruta | 2 (jeden na každý smer jazdy) | protismery sa nikdy neblokujú (pravostranná premávka) |
| `one_way` | 1 | len v smere `roadDir` (existuje) |
| `one_lane` (obojsmerná jednopruhová) | 1 spoločný | **úsek** medzi križovatkami sa obsadí smerom: vojde sa, len keď v ňom nejde nikto oproti (ako jednokoľajka) |
| **križovatka** (bunka s ≥ 3 susedmi) | 1 spoločný („box") | pravidlo voľného výjazdu (§7.5) |
| bunka nábrežia, pruh bloku, pruh brány | 1 (jednosmerný pruh modulu) | definuje modul (manifest + def), TP sú v ňom |

Pruh je **simulačný údaj**, už nielen render. Odsadenie vpravo, ktoré dnes počíta len render (`laneOffset`), sa odvodí zo slotu.

### 7.3 Dĺžka vozidiel
Nové pole `lengthCells` vo `vehicles.json` a `trucks.json`, v mierke 1 bunka = 6 m:

| Vozidlo | Dĺžka |
|---|---|
| externý kamión s 40′ návesom | 3 |
| TT s podvozkom | 3 |
| AGV | 3 |
| straddle carrier | 2 |
| vlak | dĺžka podľa súpravy (R6) |

Vozidlo drží slot bunky, v ktorej je hlava, a slotov `lengthCells − 1` za ňou, teda svoju **stopu**. Pri prejazde do ďalšej bunky si najprv vezme jej slot a až potom uvoľní posledný slot stopy.

Render kreslí návesy kĺbovo po stope, takže v zákrute sa náves „láme" ako skutočný.

### 7.4 Pohyb v ticku (algoritmus)
Kroky 6 a 8 sa zlúčia do jedného kroku **`TrafficSystem`**. Dnes sa hýbu všetky vozidlá pred všetkými kamiónmi, čo by v novom modeli zvýhodňovalo vozidlá. Postup:
1. **Poradie:** pohybujúce sa nosiče (vozidlá aj kamióny) sa zoradia podľa `(čakanie zostupne, id)`. Najdlhšie čakajúci ide prvý, takže nikto nehladuje. Poradie je deterministické.
2. **Zámer:** každý nosič chce prejsť `speed × speedFactor` buniek. Na prechod do ďalšej bunky potrebuje jej slot.
3. **Rozhodnutie:**
   - Slot je voľný: nosič ho obsadí a pohne sa.
   - Slot drží nosič, ktorý sa v tomto ticku ešte nehýbal: najprv sa vyrieši ten, rekurzívne s množinou „na zásobníku".
   - Slot je stále obsadený: nosič zastaví na hranici svojej bunky a `waitTicks += 1`.
4. **Cyklus** (A čaká na B a B na A) sa zistí v rekurzii. Nikto z cyklu sa nepohne a cyklus sa zapíše ako **kandidát zápchy** (§7.9).

Zložitosť je O(nosiče) na tick. Rezerva výkonu je dnes 40× (priemer 0,05 ms/tick pri `stress_f6`).

### 7.5 Križovatky: pravidlo voľného výjazdu
Do slotu križovatky sa smie vojsť, len keď sa **naraz** obsadí aj slot za ňou na trase, prípadne celý reťazec, ak za križovatkou nasleduje ďalšia. Nikto tak nezostane stáť uprostred križovatky a neblokuje ostatných.

Pri súbehoch rozhoduje poradie z §7.4, teda kto čaká najdlhšie.

### 7.6 Fyzické fronty
Virtuálne fronty a teleporty (`jumpTo`) zaniknú:
- **Vstupná a výstupná brána:** majú pruhy. Kamión stojí v pruhu pri búdke a ďalšie stoja za ním na príjazdovej ceste. Front je vidno.
- **Pod žeriavom:** TT stojí na TP v pruhu pod žeriavom a ďalšie za ním v tom istom pruhu.
  - Kotvisko dostane **obchádzkový pruh**, aby ťahač pre druhý žeriav nemusel stáť za prvým.
  - Odporúčam rozšíriť kotvisko o 1 rad na 8 × 4: 2 pruhy pod žeriavom + obchádzka.
- **Pruh bloku:** kamióny a TT stoja za sebou. RTG obsluhuje TP v poradí priorít. Vozidlo, ktoré je hotové, môže odísť len dopredu, pretože pruh je jednosmerný.
- **Portál mapy:** kamión vojde z vnútrozemia, len keď sú voľné sloty pri portáli (ADR-035 už vie čakať vo vnútrozemí).

### 7.7 Parkovanie nečinných vozidiel
Nečinné vozidlo nesmie stáť na ceste. TOS ho pošle do najbližšieho **depa** alebo na **parkovisko vozidiel**: miesta mimo pruhov, `capacity` v defe. Ak je všetko plné, zostane na poslednom TP, kým sa niekde neuvoľní miesto.

Tým sa vyrieši aj starý bod v BACKLOG, že nečinné vozidlo sa nevracia do depa.

### 7.8 Zápchy: prevencia, detekcia, riešenie
**Prevencia:**
- pravidlo voľného výjazdu,
- jednosmerné pruhy v moduloch,
- úseky `one_lane` sa obsadzujú smerom,
- validácia rozloženia pri stavbe s **upozorneniami**, nie zákazmi. Príklady: „slepá cesta bez otočky", „obojsmerná jednopruhová cesta medzi blokmi", „pruh bloku nemá výjazd".

**Detekcia:** cyklus čakania (§7.4), ktorý trvá ≥ `gridlockTicks`, alebo nosič, ktorý čaká ≥ `stuckTicks`.

**Riešenie** (deterministicky, v tomto poradí):
1. Najnižší v cykle (podľa id) si **preplánuje trasu** a dočasne sa vyhne obsadenej bunke. Pomôže to pri križovatkách s alternatívou.
2. Ak trasa neexistuje a cesta to dovolí, nosič sa **otočí** (`turnAround` existuje).
3. Inak ide hráčovi **upozornenie „Zápcha"** (toast a červené zvýraznenie buniek). Hráč upraví cesty, napríklad pridá jednosmerku alebo otočku.

Metriky: `gridlockEvents`, `junctionWaitTicks`, mapa čakania (heatmapa F11 dostane zmysel).

### 7.9 Prístup na cesty a rýchlosti
Cesta dostane **prístup** (`access`), ktorý hráč nastaví nástrojom ako dnes typ cesty:

| Prístup | Kto smie |
|---|---|
| `all` | všetci (predvolené) |
| `terminal_only` | len interná technika (TT, AGV, SC) |
| `trucks_only` | koridor externých kamiónov, voliteľný |

Ďalšie pravidlá:
- Cesta mimo brány (medzi portálom a bránou) je verejná. Interná technika na ňu nesmie, externý kamión len smerom k bráne a od nej.
- Rýchlosť kamióna v termináli určuje `truckSpeedFactorInTerminal` (30 km/h).
- AGV smie len do zóny automatizácie (R7).

### 7.10 Render
- Poloha prichádza zo simulácie (slot a priebeh), takže sa vozidlá neprekrývajú ani v renderi.
- Kĺbový náves sa kreslí po stope.
- Čakajúce vozidlá majú brzdové svetlá (malý prvok spritu) a nad zápchou je ikonka.
- Šofér v bezpečnej zóne je malá postavička pri TP.

### 7.11 Determinizmus, save, výkon
- **Obsadenie slotov** je odvodené z polôh a stôp nosičov a do savu nejde. Do savu pribudne `trail` (stopa) a `waitTicks`.
- **Invariant `carrierOverlapProblem`:**
  - každý slot má najviac 1 držiteľa,
  - stopa každého nosiča je súvislá,
  - križovatka má najviac 1 nosiča,
  - zložitosť O(n).
- **Výkon:** očakávam < 0,2 ms/tick pri 50 nosičoch. Bench sa rozšíri o scenár s 80 nosičmi.

---

## 8. Brány

| Modul | Pruhy | Kroky v pruhu | Defy |
|---|---|---|---|
| `gate_in` (napr. 4 pruhy, 4 × 3 bunky) | jednosmerné, každý s búdkou a OCR portálom | stoj → OCR → kontrola (VGM, booking, termín) → lístok → závora | `lanes`, `ocrTicks`, `checkTicks`, `gateIssueChance`, `troubleTicks` |
| `gate_out` (napr. 3 pruhy) | jednosmerné, každý s váhou a skenerom | stoj na váhe → váženie → sken → plomba → závora | `weighTicks`, `scanTicks`, `sealIssueChance`, `inspectionTicks` |

- Vstupná a výstupná brána sú **samostatné moduly**. Nahradia `truck_gate`, ktorá dnes rieši obe strany jednou frontou.
- Kamión bez termínu alebo s chybou (napr. booking po cut-off a loď už lashuje) **brána odmietne**. Kamión sa otočí cez trouble pruh a vráti sa do vnútrozemia. Ide o udalosť, nie o stratu nákladu: jednotka je stále `in_truck`.
- Hráč volí počet pruhov a rozšírenia (tech F8: „gate_fast_lane" skráti `checkTicks`).

---

## 9. Čo sa z dnešného kódu zruší, prepíše a zachová

| Oblasť | Osud | Pozn. |
|---|---|---|
| `LoadingRamp`, `DockStaging`, `DockIntake`, `ramp-allocator`, `dock-cargo`, dual transaction na rampe | **zruší sa** | „ramp" je v `src/sim` v 69 súboroch (942 riadkov); render 25, UI 8, app 9 súborov; testy 136 súborov |
| `WaitingArea` (stojisko), `pickupReservedBays` | **zruší sa** | nahradia ho fyzické fronty a vnútrozemie |
| `TruckGate` (jedna brána, FIFO) | **prepíše sa** na `GateIn` a `GateOut` s pruhmi | hook registrácie exportu (`onGatePassed`) ostáva |
| FSM kamióna (12 stavov) | **prepíše sa** na návštevu s lístkom | `to_gate_in → gate_in → to_tp → at_tp (safe_zone, handling, lashing) → (ďalšie TP) → to_gate_out → gate_out → to_portal` |
| `StorageModule` (počet a ploché sloty), `SlotReservations` | **prepíše sa** na `YardBlock` + `StackGrid` + rezervácie pozícií | `ContainerYard` a `EmptyDepot` sa stanú defmi blokov |
| `Dispatcher` + `TransportJob` | **prepíše sa** na TOS (`Move` + nohy, plánovač polohy, fronty strojov) | zachová sa poradie stowage, dual cycling, priority |
| `Carrier` (pohyb), `Pathfinder` (A*) | **rozšíri sa** o pruhy, sloty, stopu a `TrafficSystem` | A*, PathCache a jednosmerky ostávajú |
| `CraneModule` (STS), cyklus, stowage, lashing lode | **zachová sa** | odovzdávanie na TT/SC a pruhy pod žeriavom |
| Lode, rejda, `ShipTraffic`, kontrakty, bookingy, voyage, prekládka, tok prázdnych, M&R, ekonomika, vnútrozemie (ADR-035) | **zachová sa** | vnútrozemie sa napojí na termíny odvozu |
| Render: rampa, dock, cúvanie, stojisko | **zruší sa** | nové: bloky so stohmi, RTG, TT, brány s pruhmi, TP |
| UI: inšpektory rampy a stojiska | **zruší sa** | nové: inšpektor bloku (pohľad na bay), stroja, brány; KPI landside |
| Migrácie savov v1–v9 (≈ 2 580 riadkov testov, 12 fixtures) | **zruší sa** (clean break, §10.3) | |
| Scenáre (`vertical_slice`, `live_terminal`, …) a goldeny | **prepíšu sa** | rovnaké toky na novom rozložení |

---

## 10. Simulácia: zmeny architektúry

### 10.1 Nové adresáre v `src/sim`
- `containers/`: `ContainerTypeRegistry`, pravidlá stohovania podľa typu.
- `yard/`: `YardBlock` (geometria, `StackGrid`), `YardPlanner`, `RehandlePlanner`, `ReeferPower`.
- `equipment/`: `YardMachine`, `GantryCrane`, `RtgCrane`, `RmgCrane`, `AreaHandler`, `ReachStacker`, `EmptyContainerHandler`; FSM tabuľky a fronty práce.
- `tos/`: `Move`, `Leg`, `TransferPoint`, prideľovanie (nahradí `logistics/dispatcher.ts`).
- `traffic/`: `LaneSlots` (obsadenie), `TrafficSystem`, `JunctionRule`, `GridlockDetector`, `RoadAccess`.
- `landside/`: `GateIn`, `GateOut`, `TruckVisit` (lístok, zastávky), `AppointmentPlan` (termíny odvozu importu, nadväzuje na `trucks/hinterland*`).
- `rail/` (R6): `RailTerminal`, `Train`, `TrainSchedule`.

### 10.2 Tick pipeline v2 (ARCHITECTURE §6, ADR-038)
```
1. clock
2. contracts (+ termíny odvozu, plán vlakov, opravy v depe)
3. ships
4. quay cranes (STS)
5. TOS: nové moves, YardPlanner, priradenie TT/SC a yard strojov, fronty TP
6. yard machines (RTG, RMG, RS, ECH): pojazd, shift, zdvih, uloženie
7. traffic: všetky nosiče na cestách (vozidlá, TT, AGV, SC, kamióny) jedným prechodom + ich FSM na zastávkach
8. landside: brány (pruhy, kontroly), vjazd z vnútrozemia, odchod kamiónov
9. reefers: napájanie, čas bez napájania, alarmy
10. economy (+ energia)
11. tech
12. metrics (TTT, rehandles, čakanie na križovatkách, zápchy)
13. invariants
14. flush
```

### 10.3 Save: `WorldState` v10 a staré savy
**Odporúčam clean break:**
- savy v1–v9 sa nenačítajú; hra zobrazí hlášku „Uložená hra je zo staršej verzie a s novým terminálom sa nedá načítať";
- počas prestavby (R1–R6) každá fáza zvýši verziu **bez migrácie**;
- migrácie sa obnovia od vydania (F13).

Dôvody:
- hra nie je vydaná;
- migrácia rampy, stojiska a plochých slotov na bloky so stohmi by bola umelá a nikomu by neslúžila;
- odpadne ≈ 2 580 riadkov testov migrácií a 229 KB fixtures.

Formát obálky `SaveGame` v1 (ADR-030) ostáva.

### 10.4 Invarianty (krok 13)

**Doterajšie, ktoré ostávajú:**
- konzervácia nákladu,
- kontrakty a lode.

**Nové:**
- **stohy:** súvislé od zeme, bez „visiacich" kontajnerov, rovnaká veľkosť v stohu, 40′ v oboch bays, `tier < maxTier`, OOG navrchu, reefer len na zásuvke;
- **stroje:** stroj drží najviac 1 kontajner, RTG na jednom bloku sa nekrížia (poradie pozdĺž bloku), nohy `Move` sú v súlade so stavmi strojov;
- **doprava:** `carrierOverlapProblem`, TP drží najviac 1 vozidlo, front brány tvoria presne kamióny v jej pruhoch;
- **reefery:** zapojený reefer je len na zásuvke a čas bez napájania sa počíta len odpojenému.

### 10.5 Defy a schémy (pravidlo 4)

**Nové súbory defov:**
- `container_types.json`,
- `equipment.json` (yard stroje).

**Rozšírenia existujúcich defov:**
- `modules.json`: nové druhy `yard_block`, `area`, `gate_in`, `gate_out`, `rail_terminal`, `vehicle_parking`; kotvisko dostane pruhy pod žeriavom;
- `vehicles.json` a `trucks.json`: `lengthCells`, `canLift`, `stackTiers`, `access`;
- `logistics.json`: sekcie `traffic`, `gate`, `landside`, `tos`, `reefer`;
- `infrastructure.json`: `access` ciest, `truckSpeedFactorInTerminal`;
- `economy.json`: energia, reklamácie;
- `contract_templates.json`: `sizeMix`, `typeMix`, `importDwellHoursRange`, `railShare`.

Manifest dostane:
- geometriu blokov (bays, rows, poloha pruhu a TP);
- pruhy brán a kotviska;
- časti strojov (rám, vozík) s pivotmi.

### 10.6 Metriky (krok 12; `simrun` a štatistiky)

| Oblasť | Metriky |
|---|---|
| nábrežie | STS moves/h (GMPH), čakanie STS na vozidlo |
| sklad | RTG moves/h, `rehandlesPerMove`, obsadenosť blokov a rozdelenie výšok stohov, dwell time |
| landside | **TTT** (priemer, p95), čakanie pred bránou, čakanie na TP |
| reefery | obsadenosť zásuviek, reklamácie |
| doprava | `gridlockEvents`, čakanie na križovatkách |

`simrun` dostane rovnaké kľúče. Goldeny sa prepočítajú.

---

## 11. Render a UI

**Render:**
- **Bloky so stohmi.** Pri bežnom priblížení je zhora vidno vrchný kontajner každého stohu vo farbe linky a typu. Výšku stohu naznačí tieň a odtieň, pri priblížení aj malý odznak s číslom (BitmapText, nie text v SVG).
- **Stroje:**
  - RTG s rámom, ktorý sa posúva pozdĺž bloku, a vozíkom, ktorý ide naprieč; spreader spúšťa kontajner;
  - TT s kĺbovým podvozkom;
  - SC (prekreslený na reálny rozmer);
  - RS a ECH s kontajnerom naprieč pred sebou.
- **Kontajnery sa skladajú** (sprite vozidla + sprite kontajnera) namiesto stavov `loaded` v každom sprite vozidla. Pri 6 typoch × 2 veľkostiach by inak vznikla explózia súborov.
- **Brány:** pruhy, búdky, OCR portál, váha, závory a front kamiónov na ceste.
- **TP a bezpečná zóna:** značky na zemi a postavička šoféra počas nakládky.
- **Reefer:** rady so stĺpikmi zásuviek a stav zásuvky (zapojený, alarm).
- **Zápcha:** ikona a červené bunky, ktoré po kliknutí vedú na miesto.

**UI:**
- **Inšpektor bloku:** pohľad na bay zboku (rady × výšky) so zvýraznenými zavalenými kontajnermi, priority RTG a obsadenosť.
- **Inšpektor stroja:** fronta úloh, výkon za hodinu, čakanie.
- **Inšpektor brány:** pruhy, front, priemerný čas prechodu.
- **Panel landside KPI:** TTT, termíny včas alebo neskoro.
- **Panel reeferov.**
- **BuildBar:** kategórie Nábrežie, Sklad (bloky), Landside (brány, parkovisko), Technika (stroje), Cesty (typ + prístup).

---

## 12. Fázy implementácie

Každá fáza končí hrateľnou verziou (artefakt), review simulácie, plnou e2e a PR. Vo všetkých scenároch platia `lostUnits = 0` a nulový prekryv vozidiel.

| Fáza | Obsah | ADR | Odhad | Akceptácia (výber) |
|---|---|---|---|---|
| **R0 Rozhodnutia** | ADR, prepis PORT_OPERATIONS a IMPLEMENTATION_PLAN, CLAUDE.md, zoznam SVG | 036 (Terminál 2.0, clean break) | 0,5 SD | schválené rozhodnutia z §13 |
| **R1 Doprava bez prekrývania** | pruhové sloty, dĺžka vozidiel, stopa, `TrafficSystem` (zlúčené kroky 6+8), pravidlo voľného výjazdu, úseky `one_lane`, parkovanie nečinných, detekcia a riešenie zápch, fyzické fronty pred bránou a modulmi (rampa ešte existuje), render kĺbového návesu | 037 (doprava), 038 (pipeline) | 3 SD | `carrierOverlapProblem` nikdy vo všetkých scenároch; `stress_f6` bez trvalej zápchy; bench < 2 ms; e2e screenshot frontu |
| **R2 Kontajnery a stohy** | veľkosti a typy (dry, empty; reefer zatiaľ ako dry), `YardBlock` + `StackGrid`, straddle blok (SC stohuje 1 nad 2), depo s ECH (8 výška), rehandling, `YardPlanner` s časom odchodu, termíny odvozu importu, inšpektor bloku | 039 (sklad a plánovač) | 3,5 SD | 0 porušení stohov; `rehandlesPerMove` < 0,3 v `vertical_slice` s plánovačom a > 1 s náhodným ukladaním (dôkaz, že plánovač funguje) |
| **R3 Ťahače, RTG a TOS** | `TerminalTractor`, `RtgCrane`, pruhy pod STS + obchádzka (kotvisko 8 × 4), `Move` + nohy, fronty a priority RTG, gang/pool, reach stacker plocha | 040 (TOS a stroje) | 3,5 SD | scenár „ťahač + RTG": vykládka a nakládka 120 TEU bez zápchy; STS čaká < X % cyklu pri 4 TT na žeriav |
| **R4 Landside bez rampy** | `gate_in` a `gate_out` s pruhmi a kontrolami, lístok, TP pri blokoch, bezpečná zóna, lashing a unlashing, prístup ciest (`access`), dual transaction s 2 zastávkami, **zrušenie rampy a stojiska** | 041 (landside) | 3 SD | `live_terminal` na novom rozložení: import, export, prázdne a prekládka; TTT meraný; e2e: kamión na TP, šofér v zóne, RTG nakladá |
| **R5 Reefery a špeciály** | reefer blok a zásuvky, energia, limit odpojenia, alarmy, reklamácie; OOG plocha a RS, flat rack navrch, tank; zmesi typov v kontraktoch | 042 (reefery a špeciály) | 2 SD | scenár `reefer_flow`: 0 reklamácií pri dosť zásuvkách, reklamácie pri nedostatku |
| **R6 Železnica s RMG** | koľaje (`PlaceRail`), železničný terminál s RMG a bufferom, vlaky podľa cestovného poriadku, ťahače do bufferu, rail podiel v kontraktoch | 043 (železnica) | 2,5 SD | scenár `rail_flow`: > 50 % importu vlakom; vagóny sa nakladajú po blokoch |
| **R7 (voliteľná) Automatizácia a housekeeping** | AGV + automatizovaný RMG blok, pre-marshalling v nečinnosti, CFS (stripping) | — | 2 SD | scenár s AGV bez zápchy; pokles rehandlingu po pre-marshallingu |

Spolu je to ≈ 20 SD (R0–R6 ≈ 18 SD).

**Pôvodné fázy po R6:**
- F7 Parcely a OPEX,
- F8 Tech tree (odomyká RTG, RMG, AGV, rýchle pruhy brány),
- F11 Analytika (heatmapa čakania má teraz dáta),
- F12 Lode naplno (reefer sloty na lodiach, 40′/20′ stowage),
- F13 Balans a release.

F9 (bulk, kvapaliny, plyn, RoRo) odporúčam **odsunúť za F13**, aby hra najprv vynikla ako kontajnerový terminál (§13, bod 6). Pôvodná F14 (stohy) a F10a (RTG/ťahače) sa rozpustia v R2 a R3.

**Poradie R1 → R2 → R3 → R4:**
- Doprava ide prvá, lebo na nej stoja všetky ďalšie toky (fronty pod žeriavom, v bloku aj pri bráne). Ak by prišla posledná, všetko predtým by sa testovalo bez nej a potom by sa to rozbilo.
- R1 ešte funguje s rampou, kým ju R4 neodstráni. Zahodí sa len malý kúsok práce: fyzická fronta pred rampou.

---

## 13. Rozhodnutia pre teba (s mojím odporúčaním)

1. **Staré uložené hry:** clean break, savy pred Terminálom 2.0 sa nenačítajú. **Odporúčam áno** (§10.3).
2. **Dĺžky vozidiel podľa reálnej mierky** (kamión a TT = 3 bunky, SC = 2): cesty a fronty potrebujú viac miesta, mapa 96 × 64 (576 × 384 m) to unesie. **Odporúčam áno.** Alternatíva: všetko 2 bunky (menej realistické, kompaktnejšie).
3. **Systémy techniky v prvej vlne:** straddle (R2) + ťahač s RTG (R3) + reach stacker a ECH. AGV a automatizovaný RMG blok až v R7. **Odporúčam toto poradie.**
4. **Typy kontajnerov v prvej vlne:** dry a prázdne (R2), reefer, open top, flat rack a tank v R5. **Odporúčam.**
5. **Riadenie hráčom:** TOS rozhoduje automaticky; hráč mení priority RTG (loď a kamión), gang alebo pool ťahačov a pridelenie RTG k blokom. Žiadne ručné posielanie kontajnerov. **Odporúčam.**
6. **Fáza 9 (bulk, kvapaliny, plyn, RoRo)** sa odsunie za release. **Odporúčam**, aby sa sústredenie nerozdrobilo.
7. **Kotvisko 8 × 4** (pruhy pod žeriavom + obchádzka) namiesto 8 × 3. Starter na `harbor_01` sa posunie o 1 rad na pevninu. **Odporúčam.**
8. **Termíny odvozu importu** (Truck Appointment System) namiesto kamiónov „na požiadanie". **Odporúčam**, je to realistické a nutné pre plánovač polohy.

---

## 14. Riziká

| Riziko | Dopad | Opatrenie |
|---|---|---|
| Zápchy sa stanú hlavnou frustráciou hráča | vysoký | pravidlo voľného výjazdu, jednosmerné pruhy modulov, varovania pri stavbe, automatické riešenie zápchy (§7.8), tutoriál rozloženia |
| RTG ako úzke hrdlo zablokuje loď aj kamióny | stredný | priority, limit čakania kamiónu, 2 RTG na dlhý blok, metriky a nápovedy |
| Prepis testov (≈ ¼ sady) spomalí fázy | stredný | testy rampy a stojiska sa zmažú spolu s kódom; nové testy sa píšu TDD po tokoch |
| Výkon pri väčšom počte nosičov a strojov | nízky | rezerva 40×; bench so scenárom 80 nosičov v R1 |
| Rozsah narastie (CFS, IMO, twin-lift, viac pruhov) | stredný | len to, čo je v tabuľke fáz; ostatné do BACKLOG |
| Grafika nebude stíhať simuláciu | stredný | zoznam SVG po fázach (`ASSETS_TERMINAL_2.md`); dovtedy procedurálne náhrady (Graphics s tokenmi), ako je dnes RTG dekorácia |
