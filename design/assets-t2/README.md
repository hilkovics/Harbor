# Terminál 2.0 — assets (Claude Design)

Odovzdanie podľa CLAUDE_DESIGN_TERMINAL_2.md §6. Súradnice v px v rámci súboru; pivoty, kotvy a rozsahy pohybu sú v `<desc>` každého SVG a v `manifest-fragment.json`.

| priečinok | SVG |
|---|---|
| cargo/ | 13 |
| entities/ | 20 |
| modules/ | 18 |
| overlay/ | 6 |
| icons/icons.svg | 82 symbolov |

`tokens.css` = aktuálne tokeny vrátane blokov „Terminál 2.0" a „STS žeriav".

## Zmeny oproti manuálu

### STS žeriav (nový, nahrádza crane_container_gantry_base / _boom / _trolley)
- `modules/sts_frame.svg` — **3×10 buniek (192×640)**, nos k vode. Červená konštrukcia, nosníky s bielymi panelmi, červeno-biele ťahadlá z apexu A-rámu, biela a sivá strojovňa na konci backreachu, sivé podvozky, káblový bubon.
  - umiestnenie: rám o **256 px nad** kotviskom (quayEdgeY 256 v rámci rámu)
  - koľajnice y 282 (voda) a 448 (hranica pruh 2 / obchádzka); rozchod nôh 168 px, svetlá šírka 152 px
  - pivot 128,369 → **96,369**; žeriav jazdí po X, **výložník nerotuje**
- `modules/sts_trolley.svg` — 3×1, pivot 96,32, v ráme **x = 0**, travel y **30–560** (zasahuje za pevninské nohy)
- `modules/sts_spreader_40.svg` / `_20.svg` — pivot = pivot vozíka
- **Backreach**: odkladacia zóna za pevninskými nohami y 480–570 (pred strojovňou)
- Poradie kreslenia: kontajner → spreader → rám → vozík

### Kotvisko
- `modules/berth_standard.svg` v2.1 (8×4): STS koľajnice y 24–28 a **198–202**; pruhy pod žeriavom y 64–192 (rady 1–2), obchádzka y 212–256 za plnou čiarou.

### RTG
- `entities/rtg_frame.svg` — **5×2 (320×128)** namiesto 4×2, aby sa kamión zmestil do pruhu. Pivot **160,64**. V súradniciach rámu: 6 radov x 36–216, pruh kamióna x 236–300. Rám sa kladie 12 px vľavo od okraja bloku.
- `entities/rtg_trolley.svg` — travel x **32–288**.

### Ostatné odchýlky
- Komentáre `<!-- pivot -->` sa pri ukladaní strácajú, preto sú údaje v `<desc>` a v manifest-fragment.json.
- Ikona `ic_tank` = tank kontajner; pôvodná ikona nádrží je premenovaná na **`ic_tank_farm`**.
- Straddle blok: rozstup radov 42 px (miesto pre nohy).
- Kontajnery nemajú zapečený tieň (telo vypĺňa plátno).
- Výška stohu: dva režimy, hráč vyberá v nastaveniach — **Tieň** (rgba(0,0,0,.32), dĺžka 3 px × výška) a **Odznak** (kontaktný tieň 2 px + kruh 16 px s číslom). Kreslí engine.
- Lokomotíva a vagón 60′ v mierke 1×3; sloty vagóna v manifest-fragment.json.

## Referenčné hárky a UI (v projekte Claude Design)
Cargo Sheet, Vehicles Sheet, Machines Sheet, STS Sheet, Gates Sheet, Yard Reference, Rail Terminal Reference, Icons T2, Game UI T2.

### Integrácia R6 (TR6-03)
`rmg_frame` (6×2, pivot 160,64, jazdí po Y), `rmg_trolley` (pivot 32,32, travel x 32–352), `locomotive` (1×3, pivot 32,96, spriahlo y 4/188) a `wagon_container_60` (1×3, pivot 32,96, `slots20` [2,66] [64,128] [126,190], `slot40` [2,128]) sú v `assets/entities/` a `assets/manifest.json` (`entities.rmg.parts`, `entities.locomotive`, `entities.wagon_container_60`). Koľaje: existujúce `infra.rail.*` cez `WorldRenderer.rails`.
