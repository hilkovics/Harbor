# DESIGN_BRIEF.md — Modular Harbor (pokyny pre Claude Design)

> Tento dokument slúži ako **kontext pre Claude Design** (claude.ai/design) a zároveň ako referencia pre Claude Code pri integrácii assetov.
> Claude Design vytvára vektorové assety (SVG), design systém (CSS tokeny) a HTML prototypy UI. Výstupy idú do `assets/` a `design/` v repozitári.

---

## 1. Workflow (ako to použiť)

1. **Onboarding design systému v Claude Design:** nahraj tento súbor + `design/tokens.css` (sekcia §3, ulož ju ako samostatný súbor). Claude Design z toho postaví design systém, ktorý potom aplikuje na všetko.
2. **Relácie (session) v poradí:** §8 obsahuje hotové prompty. Každá relácia = jedna kategória výstupov. Po každej relácii exportuj (SVG / standalone HTML) a ulož podľa §7.
3. **Iteruj na canvase**, nie v kóde: požiadaj o 2–3 varianty, vyber, nechaj aplikovať zmenu naprieč sadou („uprav všetky sklady…").
4. **Handoff do Claude Code:** UI prototypy exportuj ako standalone HTML do `design/ui/*.html`; sprity ako SVG do `assets/<kategória>/`. Claude Code ich prevedie príkazom `/ui-from-design` a `tools/gen-atlas.ts`.
5. Čo Claude Design **nerobí**: herný kód, animácie za behu (rieši engine), pixel-art rastre. Všetko je vektor + CSS.

---

## 2. Art direction

**Jedna veta:** *Schematický, čistý top-down „operátorský" pohľad — ako prehľadná dispečerská mapa, nie realistická fotografia prístavu.*

Pravidlá vizuálnej hierarchie (od najvýraznejšieho k najmenej):
1. **Náklad a pohyb** (kontajnery, vozidlá, lode) — najsýtejšie farby, najostrejšie hrany.
2. **Moduly** (sklady, žeriavy, rampy) — stredná sýtosť, jasné obrysy, čitateľné zaplnenie.
3. **Infraštruktúra** (cesty, koľaje, potrubia) — neutrálne, tmavšie, s jemným značením.
4. **Terén a voda** — najtlmenejšie, nízky kontrast, aby nesúťažili s hrou.

Štýl:
- Ortografický top-down, **bez perspektívy**, bez šikmých stien. Objekty sú pôdorysy s náznakom výšky cez svetlo/tieň.
- Svetlo zhora-zľava: ľavý/horný okraj svetlejší (+8 % L), pravý/dolný tmavší (−8 % L). Tieň: 2 px offset dole-vpravo, `rgba(0,0,0,.2)`, len pre objekty nad terénom (vozidlá, lode, žeriavy, kontajnery).
- **Max 3 tonálne stupne na objekt** (base, light, dark) + 1 obrys `2 px` v tmavšej variante base (nie čierny).
- Žiadne gradienty okrem vody (jemný) a heatmapy. Žiadny text v spritoch. Žiadne fotografické textúry.
- **Test čitateľnosti:** každý sprite musí byť rozpoznateľný pri 32 px na bunku (zoom 0,5×) podľa siluety a farby — nie podľa detailov.
- Nepoužívať cudzie logá, značky lodí ani reálne firmy. Kontajnery sú jednofarebné podľa tokenu, bez nápisov.
- Farba **nikdy nie je jediný nositeľ informácie**: každá kategória nákladu má aj vlastný glyf (§5.7) a sklady majú aj gauge/segmenty zaplnenia, nie iba farbu.

---

## 3. Design tokeny — `design/tokens.css`

```css
:root {
  /* ===== Herný svet (terén) ===== */
  --terrain-water-deep: #0E3A5B;
  --terrain-water-shallow: #1F6F8B;
  --terrain-water-foam: #7FC2D6;      /* jemná linka pri pobreží */
  --terrain-quay: #B7B2A6;            /* betón kotviska */
  --terrain-quay-edge: #7D786E;       /* hrana k vode, 4 px */
  --terrain-land: #D8D2C4;
  --terrain-land-alt: #CFC8B8;        /* šachovnica 2×2 buniek pre orientáciu */
  --terrain-blocked: #6E6A66;
  --parcel-for-sale: #F2B233;         /* prerušovaný obrys 2 px */
  --parcel-owned: #35C27A;
  --parcel-leased: #3AA0FF;

  /* ===== Infraštruktúra ===== */
  --road-base: #4B5058;
  --road-marking: #E9E4D6;
  --rail-base: #3B3B3B;
  --rail-tie: #6B5A45;
  --pipe-base: #8A8F98;
  --pipe-valve: #E5484D;

  /* ===== Kategórie nákladu (sémantické) ===== */
  --cargo-container: #F28C28;   /* glyf: obdĺžnik s dvomi pruhmi */
  --cargo-bulk: #C9A227;        /* glyf: kopa / tri kruhy */
  --cargo-liquid: #7B4FA0;      /* glyf: kvapka */
  --cargo-gas: #2BB3A3;         /* glyf: valec s hrdlom */
  --cargo-roro: #D64545;        /* glyf: auto zhora */
  /* svetlý / tmavý variant (base ±14 % L; 3 tonálne stupne, §2) — doplnené z Claude Design, relácia 1 */
  --cargo-container-light: #F6B06B; --cargo-container-dark: #C7680C;
  --cargo-bulk-light: #DFBE59;      --cargo-bulk-dark: #8D721B;
  --cargo-liquid-light: #9E79BD;    --cargo-liquid-dark: #563770;
  --cargo-gas-light: #50D5C5;       --cargo-gas-dark: #1D796F;
  --cargo-roro-light: #E38080;      --cargo-roro-dark: #AD2626;
  /* svetlé/tmavé varianty: +14 % L / −14 % L od base */

  /* ===== Moduly ===== */
  --module-base: #9DA3AC;       /* neutrálny betón/oceľ modulu */
  --module-roof: #B8BEC7;
  --module-outline: #5C626B;
  --module-connector: #3AA0FF;  /* bunka konektora v build mode */
  --module-disconnected: #F2B233;

  /* ===== Entity ===== */
  --vehicle-body: #F4D03F;      /* straddle carrier / AGV: žltá "industrial" */
  --vehicle-dark: #2B2B2B;
  --truck-cab: #3A6EA5;
  --truck-trailer: #C9CDD3;
  --train-loco: #2F5D8A;
  --train-wagon: #7A7F87;
  --ship-hull: #2C3E50;
  --ship-deck: #8E9AA7;
  --ship-superstructure: #ECEFF3;
  --crane-frame: #E3B23C;       /* portálový žeriav: žlto-oranžová */
  --crane-boom: #C88B1F;

  /* ===== Stavy na mape ===== */
  --ghost-valid: rgba(53,194,122,.55);
  --ghost-invalid: rgba(229,72,77,.55);  /* + diagonálny hatch 45°, 6 px */
  --outline-hover: #FFFFFF;              /* 2 px */
  --outline-selected: #3AA0FF;           /* 3 px */
  --heat-0: rgba(58,160,255,0);
  --heat-1: rgba(58,160,255,.65);
  --heat-2: rgba(242,178,51,.8);
  --heat-3: rgba(229,72,77,.9);

  /* ===== UI (tmavá, poloprehľadná nad mapou) ===== */
  --ui-bg: rgba(15,27,39,.92);
  --ui-surface: #172736;
  --ui-surface-2: #1F334A;
  --ui-border: #2E4760;
  --ui-text: #EEF3F7;
  --ui-text-2: #9FB2C4;
  --ui-text-3: #6E8299;
  --ui-accent: #3AA0FF;
  --ui-accent-hover: #63B5FF;
  --ui-success: #35C27A;
  --ui-warning: #F2B233;
  --ui-danger: #E5484D;
  --ui-info: #6FB7FF;
  --ui-money-pos: #35C27A;
  --ui-money-neg: #E5484D;
  --ui-xp: #B58CFF;

  /* ===== Typografia ===== */
  --font-ui: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --fs-xs: 12px; --fs-sm: 13px; --fs-md: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px;
  --fw-regular: 400; --fw-semibold: 600; --fw-bold: 700;
  --lh-tight: 1.2; --lh-normal: 1.45;
  /* čísla v UI vždy `font-variant-numeric: tabular-nums` */

  /* ===== Rozmery ===== */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --shadow-panel: 0 8px 24px rgba(0,0,0,.35);
  --icon-sm: 16px; --icon-md: 24px; --icon-lg: 32px;
  --hud-top-h: 48px; --build-bar-h: 96px; --side-panel-w: 360px;
  --cell: 64px;   /* 1 bunka gridu pri zoom 1 */
}
```

---

## 4. Technické parametre assetov

| Parameter | Hodnota |
|---|---|
| Jednotka | 1 bunka = **64 × 64 px** (zoom 1). Footprint `w×h` → SVG `viewBox="0 0 {w*64} {h*64}"` |
| Formát | SVG (zdroj) + PNG export @1× (64 px/bunka) a @2× (128 px/bunka), priehľadné pozadie |
| Pivot | ľavý horný roh footprintu (engine rotuje okolo stredu, sprite sa nekreslí otočený) |
| Orientácia | rotácia 0 = „sever hore". Kotvisko: voda **na severe**. Vozidlá a lode: **predok hore** |
| Obrys | 2 px, farba = tmavší base (−25 % L), zaoblené rohy `2 px`; vnútorné linky 1 px |
| Mriežka | všetky súradnice na celé px; hrany objektov min. 4 px od okraja footprintu (medzera medzi modulmi) |
| Stavy | ako **samostatné SVG súbory** (nie CSS triedy) — engine prepína textúry |
| Zaplnenie skladov | 5 súborov: `fill00`, `fill25`, `fill50`, `fill75`, `fill100` — vizuálne pribúdajú kontajnery / stúpa hladina gauge / pribúdajú autá |
| Konektory | v build mode kreslí engine; v sprite len jemná „vjazdová" značka (šípka 1 px) na bunkách konektora |
| Animácie | nie. Rotujúce/pohyblivé časti (boom žeriava, trolley, závory) sú **oddelené sprity** s vlastným pivotom uvedeným v `manifest.json` |
| Zákaz | text, logá, rastrové textúry, viac ako 3 tonálne stupne, farebné gradienty (okrem vody/heatmapy) |

---

## 5. Zoznam assetov

### 5.1 Terén (1×1, `assets/terrain/`)
| id | popis |
|---|---|
| `water_deep`, `water_shallow` | plná bunka, jemný svetlý gradient/2 vlnky 1 px |
| `water_edge_{n,e,s,w}`, `water_corner_{ne,nw,se,sw}`, `water_inner_{ne,nw,se,sw}` | prechod voda→pevnina s penou `--terrain-water-foam` (12 tiles) |
| `quay`, `quay_edge_n` | betón; hrana k vode s tmavou linkou 4 px + 3 „fendre" |
| `land`, `land_alt` | 2 varianty pre šachovnicu 2×2 |
| `blocked` | tmavý s jemným diagonálnym hatchom |
| `parcel_outline_{for_sale,owned,leased}` | 9-slice rám 2 px (prerušovaný pre for_sale) |
| `portal_road`, `portal_rail` | značka na okraji mapy: šípka + ikona |

### 5.2 Infraštruktúra (1×1, `assets/infra/`)
`road_{straight,corner,t,cross,end}`, `rail_{straight,corner,t,cross,end}`, `pipe_{straight,corner,t,end,valve}` — engine ich rotuje; kresli iba jednu orientáciu (straight zvislá, corner N→E, T bez juhu, end otvorený na sever).

### 5.3 Moduly — terminál (`assets/modules/`)
| id | footprint | poznámka |
|---|---|---|
| `berth_standard` | 8×3 | quay s kotviacimi bitvami, 4 apron sloty vyznačené obdĺžnikmi 1×1 v strednom riadku |
| `berth_deepwater` | 8×3 | tmavšia hrana, 6 apron slotov, dve žlté výstražné línie |
| `crane_container_gantry_base` | 2×3 | portál (4 nohy) — statický |
| `crane_container_gantry_boom` | 1×5 (pivot v strede dolného konca) | výložník + `crane_container_gantry_trolley` 1×1 so spreaderom |
| `crane_bulk_grab_base`, `crane_bulk_grab_boom`, `crane_bulk_grab_bucket` | 2×3, 1×5, 1×1 | drapák |
| `crane_liquid_arm`, `crane_gas_arm` | 1×2 | nakladacie rameno, farba kategórie na prírube |
| `roro_ramp` | 3×3 | sklápacia rampa s prerušovanou vodiacou čiarou |

### 5.4 Moduly — sklady (každý ×5 stavov zaplnenia)
| id | footprint | vizualizácia zaplnenia |
|---|---|---|
| `container_yard_small` | 4×4 | rastúce rady kontajnerov (`--cargo-container`), max 2 vrstvy naznačené tmavším vrchom |
| `container_yard_medium` | 6×6 | 3 vrstvy |
| `container_yard_large` | 8×8 | 3 vrstvy + 2 uličky |
| `silo_small` | 3×3 | 4 kruhové silá, zaplnenie = výsek kruhu (`--cargo-bulk`) |
| `tank_farm_small` | 4×4 | 4 nádrže, zaplnenie = prstenec gauge (`--cargo-liquid`) |
| `gas_holder_small` | 3×3 | 2 guľové zásobníky, gauge (`--cargo-gas`) |
| `vehicle_lot_small` | 6×6 | parkovacie boxy, pribúdajúce autá (`--cargo-roro`) |

### 5.5 Moduly — landside
| id | footprint | poznámka |
|---|---|---|
| `truck_gate` | 2×2 | závora (samostatný sprite `truck_gate_barrier` 1×1, pivot vľavo), búdka, STOP linka |
| `truck_waiting_area` | 4×3 | 6 stojísk s číselnými boxmi (bez textu — len obdĺžniky) |
| `loading_ramp_container`, `_bulk`, `_liquid`, `_gas`, `_roro` | 4×2 | 2 doky; farebný pás kategórie na hrane |
| `vehicle_depot` | 3×3 | garáž so 6 stojiskami |
| `rail_station_small` | 12×4 | 1 koľaj v strede, nakladacia plocha po stranách, staging boxy |

### 5.6 Entity (`assets/entities/`, predok hore, varianty `empty` / `loaded`)
| id | footprint | poznámka |
|---|---|---|
| `straddle_carrier` | 1×1 | žltý rám, kontajner v `loaded` medzi nohami |
| `agv` | 1×1 | nižší, modrý pás |
| `forklift`, `bulk_shuttle`, `tanker_shuttle` | 1×1 | podľa kategórie |
| `car` (RoRo, aj náklad aj vozidlo) | 1×1 | `--cargo-roro`, 3 farebné variácie L ±10 % |
| `truck_container`, `truck_bulk`, `truck_tanker`, `truck_car_transporter` | 2×1 | kabína `--truck-cab`, náves svetlý; loaded ukazuje náklad |
| `locomotive` | 2×1 | `--train-loco` |
| `wagon_container`, `wagon_hopper`, `wagon_tank`, `wagon_car` | 2×1 | empty/loaded |
| `ship_feeder` | 6×2 | 4 varianty paluby: `container`, `bulk`, `tanker`, `roro`; `loaded`/`empty` |
| `ship_handy` | 10×2 | + `gas` variant (guľové domy) |
| `ship_panamax` | 14×3 | |
| `ship_mega` | 20×3 | výrazná nadstavba vzadu |

### 5.7 Náklad (1×1 alebo menšie, `assets/cargo/`)
`container_teu` (1×0,5 bunky, 2 pruhy), `bulk_pile`, `liquid_batch` (kvapka v kruhu), `gas_batch` (valec), `car` — používajú sa na palube, aprone, vozidle. Plus **glyfy kategórií** ako 24 px ikony (§5.9) — rovnaká geometria.

### 5.8 Overlays a efekty (`assets/overlay/`)
`ghost_hatch` (pattern), `selection_ring` (9-slice), `hover_outline` (9-slice), `path_arrow` (1×1), `connector_marker`, `warning_badge` (24 px), `blocked_badge`, `heatmap_legend` (horizontálny gradient `--heat-0 → --heat-3` 200×12 px), `queue_badge` (kruh pre číslo fronty).

### 5.9 Ikony (24 px grid, 2 px stroke, zaoblené konce, `assets/icons/icons.svg` ako `<symbol id="ic_…">`)
- Kategórie: `ic_container, ic_bulk, ic_liquid, ic_gas, ic_roro`
- Moduly: `ic_berth, ic_crane, ic_yard, ic_silo, ic_tank, ic_gasholder, ic_lot, ic_gate, ic_waiting, ic_ramp, ic_depot, ic_rail_station, ic_road, ic_rail, ic_pipe, ic_parcel`
- Akcie: `ic_build, ic_demolish, ic_rotate, ic_inspect, ic_close, ic_pause, ic_play, ic_speed2, ic_speed4, ic_speed8, ic_save, ic_load, ic_settings`
- Stavy/štatistiky: `ic_cash, ic_xp, ic_clock, ic_calendar, ic_contract, ic_ship, ic_truck, ic_train, ic_vehicle, ic_heatmap, ic_utilization, ic_warning, ic_lock, ic_check, ic_reputation, ic_idle, ic_busy, ic_blocked`

---

## 6. UI obrazovky a komponenty

### 6.1 Layout (primárne 1920×1080, minimum 1280×720, škálovanie cez `rem`)
```
┌─────────────────────────────── TopHUD 48 px ───────────────────────────────┐
│ [ic_cash] $1,234,560  ▲+$12,300/deň │ [ic_xp] 340 XP │ Deň 12 · 14:20 │ ⏸ 1× 2× 4× 8× │ ⚙ │
├──────────────────────────────────────────────────────────────┬──────────────┤
│                                                              │ SidePanel    │
│                  MAPA (PixiJS canvas)                        │ 360 px       │
│                                                              │ (kontextový) │
│  Toasts (vpravo dole nad BuildBar, max 4, auto-hide 6 s)     │              │
├──────────────────────────────────────────────────────────────┴──────────────┤
│ BuildBar 96 px: [Terminál][Sklady][Logistika][Landside][Železnica][Potrubia] → položky s cenou │
└────────────────────────────────────────────────────────────────────────────┘
```
- Panely sú `--ui-bg` poloprehľadné, aby mapa zostala viditeľná. Radius `--radius-lg`, border `1px --ui-border`, `--shadow-panel`.
- Všetky peniaze: `tabular-nums`, kladné `--ui-money-pos`, záporné `--ui-money-neg`, formát `$1,234,560`.
- Mapa nikdy nie je prekrytá viac ako z 40 % plochy.

### 6.2 Obrazovky (každá ako standalone HTML prototyp s reálnymi tokenmi, statické dáta)
1. **TopHUD** — hore; stavy: normálny, varovanie (cash < 0 → červený pulz), pauza.
2. **BuildBar** — kategórie ako taby; položka = ikona + názov + cena; stavy: dostupné / nedostatok peňazí (cena červená) / zamknuté techom (ikona zámku + názov uzla v tooltipe).
3. **ContractsPanel** — zoznam kariet: glyf kategórie, typ, objem, odmena, SLA (dni, farba podľa naliehavosti), trieda lode, stav; progres bar `unloaded/exported`; tlačidlá Prijať/Odmietnuť; sekcie „Ponuky" / „Aktívne" / „História".
4. **ModuleInspector** — hlavička (ikona, názov, stav), kľúčové čísla (zaplnenie %, vyťaženosť %, fronta), mini graf vyťaženosti 24 h, akcie (Odstrániť, Politika skladu, Kúpiť vozidlo v depe), stav „nepripojené k ceste" (`--module-disconnected`).
5. **FinancePanel** — prepínač Denne/Mesačne; `StackedBars` príjmy vs. výdaje po kategóriách; `LineChart` cash; tabuľka kategórií s deltou; legenda s farbami kategórií (odvodené z `--ui-*`, nie z cargo farieb).
6. **TechTree** — 3 vertikálne vetvy (Náklad / Efektivita / Infraštruktúra), uzly `locked` (šedé, zámok) / `available` (accent border, cena XP) / `researched` (success check); spojnice; tooltip s efektmi.
7. **StatsPanel** — KPI karty (on-time %, avg berth time, avg dwell), utilization bary žeriavov/vozidiel/brán, top 5 hot-spots, „bottleneck hint" box; prepínač heatmapy + legenda.
8. **ParcelPanel** — cena kúpy vs. mesačný prenájom, plocha, tlačidlá Kúpiť / Prenajať / Uvoľniť.
9. **MonthlyReport modal** — súhrn mesiaca (príjmy, výdaje, čistý zisk, dokončené/zlyhané kontrakty, 3 odporúčania).
10. **Toasts** — 4 typy (info/success/warning/danger) s ikonou a akciou „Zobraziť".
11. **Settings modal**, **GameOver / Bankrot** obrazovka, **Empty states** (žiadne kontrakty, nič nevybrané).

### 6.3 Komponentová knižnica (`design/ui/components.html`)
Button (primary/secondary/ghost/danger; sizes sm/md), IconButton, Tab, Card, StatTile (label + veľké číslo + delta), ProgressBar (s kategóriovou farbou), Badge (stav), Tooltip, Table (kompaktná, zebra), Chart wrappers (`StackedBars`, `LineChart`, `Donut`, `MiniSparkline`), Modal, Toast, KeyHint (klávesová skratka), SpeedControl.

### 6.4 Pravidlá UI
- Kontrast textu ≥ 4.5:1 voči `--ui-surface`. Stavové farby vždy s ikonou/textom (nie len farba).
- Maximálna šírka textu v paneli 60 znakov; čísla zarovnané vpravo.
- Hover/focus stavy pre všetko klikateľné; focus ring `2px --ui-accent`.
- Grafy: bez 3D, bez tieňov; osi `--ui-text-3`; tooltip pri hoveri s presnou hodnotou.
- Žiadne animácie dlhšie ako 200 ms; toasty sa nesmú prekrývať s BuildBar.

---

## 7. Pomenovanie a odovzdanie

```
assets/
  terrain/  infra/  modules/  entities/  cargo/  overlay/  icons/icons.svg
  manifest.json
design/
  tokens.css
  design-system.html          (relácia 1 — referenčná stránka design systému)
  terrain-infra.html          (relácia 2 — referenčný hárok terénu a infraštruktúry; SVG sú v assets/terrain, assets/infra)
  modules.html                (relácia 3 — referenčný hárok modulov s konektormi a pivotmi; SVG sú v assets/modules)
  entities.html               (relácia 4 — referenčný hárok entít a nákladu; SVG sú v assets/entities, assets/cargo)
  ui/game-ui.html             (relácia 5 — jeden interaktívny prototyp všetkých obrazoviek so prepínačom stavov; nahrádza samostatné ui/*.html)
  ui/game-ui.source.html      (čitateľný zdroj šablóny game-ui.html pre ui-builder)
  icons-manifest.html         (relácia 6 — referenčný hárok ikon, overlayov a manifestu; kanonický manifest je assets/manifest.json)
  ui/{top-hud,build-bar,contracts-panel,module-inspector,finance-panel,tech-tree,stats-panel,parcel-panel,monthly-report,toasts,settings,game-over,components}.html
```
Názvy súborov: `{id}[_{variant}][_{state}].svg` — napr. `container_yard_small_fill50.svg`, `straddle_carrier_loaded.svg`, `ship_feeder_container_loaded.svg`, `crane_container_gantry_boom.svg`.

`assets/manifest.json` (vytvára Claude Design, číta engine):
```json
{
  "schemaVersion": 1,
  "cellPx": 64,
  "sprites": {
    "container_yard_small": {
      "footprint": { "w": 4, "h": 4 },
      "states": { "fill00": "modules/container_yard_small_fill00.svg", "fill25": "…", "fill50": "…", "fill75": "…", "fill100": "…" }
    },
    "crane_container_gantry": {
      "footprint": { "w": 2, "h": 3 },
      "parts": {
        "base":    { "file": "modules/crane_container_gantry_base.svg" },
        "boom":    { "file": "modules/crane_container_gantry_boom.svg", "pivot": { "x": 32, "y": 300 } },
        "trolley": { "file": "modules/crane_container_gantry_trolley.svg", "pivot": { "x": 32, "y": 32 } }
      }
    },
    "straddle_carrier": { "footprint": { "w": 1, "h": 1 }, "states": { "empty": "entities/straddle_carrier_empty.svg", "loaded": "entities/straddle_carrier_loaded.svg" } }
  }
}
```

---

## 8. Vzorové prompty pre Claude Design (kopíruj po reláciách)

**Relácia 1 — Design systém**
> Vytvor design systém pre 2D top-down tycoon hru „Modular Harbor" podľa priloženého DESIGN_BRIEF.md a tokens.css. Použi presne tieto tokeny (nemeň hodnoty). Vygeneruj stránku „Design System" s: paletou (terén, infraštruktúra, 5 kategórií nákladu so svetlým/tmavým variantom a glyfom, UI), typografickou škálou (Inter, tabular-nums; JetBrains Mono pre ID), spacing/radius/shadow, a ukážkami stavov (ghost valid/invalid s hatchom, hover, selected, heatmap gradient). Tmavé UI nad mapou, schematický štýl bez gradientov.

**Relácia 2 — Terén a infraštruktúra**
> Podľa §4 a §5.1–5.2 briefu vytvor SVG tiles 64×64 px: voda (deep, shallow), 12 prechodových tiles voda→pevnina s penou, quay + quay_edge_n, land + land_alt, blocked, portály. Potom road/rail/pipe sady (straight, corner, t, cross, end) v jednej orientácii. Ortografický top-down, max 3 tóny na objekt, obrys 2 px, žiadny text. Ukáž ich zložené do ukážkovej mapy 16×10 buniek, aby som overil, že na seba nadväzujú.

**Relácia 3 — Moduly**
> Podľa §5.3–5.5 vytvor SVG sprity modulov s footprintmi presne podľa tabuľky (viewBox = footprint × 64). Kotvisko má vodu na severe. Sklady vytvor v 5 stavoch zaplnenia (fill00…fill100) tak, aby bol rozdiel čitateľný aj pri 50 % zoome — kontajnerový dvor pribúdajúcimi radmi kontajnerov, silá/nádrže gauge výsekom, parkovisko autami. Žeriavy rozdeľ na base / boom / trolley (bucket) ako samostatné súbory a napíš pivot boomu. Ukáž všetky moduly vedľa seba na mriežke s vyznačenými bunkami konektorov.

**Relácia 4 — Entity**
> Podľa §5.6–5.7 vytvor vozidlá (1×1, predok hore, empty/loaded), kamióny a vagóny (2×1), lokomotívu, a lode 4 tried (6×2, 10×2, 14×3, 20×3) s palubnými variantmi podľa kategórie nákladu (container/bulk/tanker/gas/roro) a stavmi loaded/empty. Náklad ako samostatné mini-sprity (kontajner 64×32 s dvomi pruhmi, bulk pile, liquid batch, gas batch, car). Vozidlá musia byť rozpoznateľné siluetou pri 32 px. Tieň 2 px dole-vpravo, 20 %.

**Relácia 5 — UI obrazovky**
> Podľa §6 vytvor standalone HTML prototypy (len tokeny z tokens.css, žiadne hardcoded farby) pre: TopHUD, BuildBar (3 stavy položiek), ContractsPanel (ponuky/aktívne/história), ModuleInspector (sklad + depo + brána varianty), FinancePanel s StackedBars a LineChart zo statických dát, TechTree (3 vetvy, 3 stavy uzlov), StatsPanel s utilization barmi a heatmap legendou, ParcelPanel, MonthlyReport modal, Toasts, Settings, GameOver, empty states. Rozloženie 1920×1080 s overlay nad tmavo-modrým placeholderom mapy; over aj 1280×720. Priprav aj components.html so všetkými komponentmi a ich stavmi.

**Relácia 6 — Ikony a manifest**
> Vytvor ikonovú sadu z §5.9 ako jeden SVG sprite so `<symbol id="ic_…">`, 24 px grid, 2 px stroke, zaoblené konce, jednofarebné (currentColor). Glyfy kategórií nákladu musia geometricky zodpovedať mini-spritom nákladu z relácie 4. Nakoniec vygeneruj `assets/manifest.json` podľa §7 pre všetky doteraz vytvorené assety (footprint, stavy, parts s pivotmi) a zoznam súborov na export do adresárovej štruktúry z §7.

**Iteračné prompty (príklady)**
> „Uprav všetky sklady tak, aby stav fill100 mal na okraji 2 px varovný pruh `--ui-warning`."
> „Zvýš kontrast siluety AGV voči straddle carrieru — pri 32 px sa pletú."
> „Sprav 3 varianty ContractsPanel karty: kompaktná, štandardná, s rozbaleným detailom lode."
