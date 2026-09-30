# Fáza 5b — Spätná väzba z hrania (vložená pred Fázu 6) · task karty

> Zdroj: spätná väzba používateľa po zahraní M1 (2026-09-30), 11 bodov. Rozhodnutia používateľa:
> opravy **teraz pred F6**; mapu **harbor_01 prerobiť**; úprava pobrežia hráčom **áno, ako drahé stavanie móla/zásypu, až po F12** (ADR-028, zmena princípu GDD).
> Vetva: `phase/05b-playtest-feedback` (stacked nad `phase/05-contracts-vertical-slice`, PR hilkovics/Harbor#6).
> Úsporný režim platí: plná e2e raz za fázu (T5B-06), ostatné karty len dotknuté špecifikácie.

**Cieľ:** hra sa hrá plynulo — kamióny stíhajú odvážať, lode sa neprekrývajú, mierka a pohyby pôsobia reálne, mapa má viac mora a móla.

## Body spätnej väzby → karty
| # | Pripomienka | Karta |
|---|---|---|
| 1 | Viac slotov na kontajnery na móle pod žeriavom | T5B-01 (def + manifest sloty) |
| 2 | Sklady sa zapĺňajú, málo kamiónov | T5B-02 (tok kamiónov) + T5B-01 (balans rampy) |
| 3 | Cesta sa nenapája na bránu/stojisko (medzera) | T5B-03 (autotile ciest pozná konektory modulov) |
| 4 | Lode sa plavia cez seba | T5B-02 (trasy lodí, kotvisko/ankoráž bez prekryvu) |
| 5, 6 | Členité pobrežie s mólami, viac mora | T5B-01 (prerobená `harbor_01`) |
| 7 | Úprava pobrežia hráčom | ADR-028 + BACKLOG (fáza po F12) |
| 8 | Animácia portálového žeriavu na skladoch kontajnerov | T5B-03 |
| 9 | Garáž aspoň na 10 vozíkov | T5B-01 (def + manifest stalls) |
| 10 | Vozík sa po naložení „scvrkne" — mierka celej hry | T5B-03 (audit mierky) |
| 11 | Kamión na rampe sa otočí na mieste — reálny pohyb | T5B-03 (manéver cúvania do docku) |
| — | Vzdialený prečerpávací terminál (bója pre tankery) | BACKLOG (F9/F12) |

## Checklist
- [ ] T5B-01 · Dáta: `harbor_01` s viac morom a mólami, sloty apronu (≥ 8), depo 10 vozidiel, balans rampy; manifest
- [ ] T5B-02 · Sim: tok kamiónov (rezervácia docku až pri odchode zo stojiska, fronta na dock) + lode bez prekryvu (trasy, ankoráž)
- [ ] T5B-03 · Render: napojenie ciest na konektory, mierka (audit + oprava vozíka), animácia žeriavu na dvore, manéver kamióna na rampe
- [ ] T5B-04 · Review `src/sim/**` + opravy
- [ ] T5B-05 · ADR-028 (pobrežie), BACKLOG, CLAUDE.md „Čo NEROBIŤ" zosúladiť
- [ ] T5B-06 · Plná pipeline + e2e + screenshoty; uzavretie, PR popis

Vlny: {T5B-01 (worktree) ‖ T5B-02 (hlavný checkout, jediný writer `src/sim`) ‖ T5B-03 (worktree)} → T5B-04 → T5B-05 → T5B-06.

## Zásady
- Starter oblasť mapy (parcela `starter` x 30–57, y 14–33, štartová cesta x=44 y 34..63, road portál (44,63), Root berth a jeho vodná plocha) ostáva **na rovnakých súradniciach**, aby scenáre F1–F5 a e2e ostali platné. Zmeny terénu mimo nej.
- Nové hodnoty balansu v defoch, nie v kóde (pravidlo 4). Golden `vertical_slice` sa môže zmeniť → prepísať so zdôvodnením.
- Determinizmus a konzervácia nákladu platia; každá zmena v sime má test.
