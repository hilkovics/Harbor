# Fáza R5: reefery a špeciálne kontajnery · task karty

> **Zdroj:** `docs/TERMINAL_2.md` §3 (typy), §4 (bloky `reefer_block_8`, `oog_area`, `rs_area`), §6.7 (reefery), §6.8 (špeciálne kontajnery).
> **ADR:** ADR-042 (reefery a špeciály).
> **Vetva:** `phase/r5-reefer-special`, nadväzuje na `phase/r4-gates` (PR hilkovics/Harbor#15).
> **Režim:** najšetrnejší, report agenta má najviac 10 riadkov.

**Grafika** (`design/assets-t2/`):
- kontajnery `container_{20,40}_{reefer,open_top,flat_rack,tank}`, `*_oog`;
- reach stacker: `reach_stacker`, `_boom`, `_spreader_20`, `_spreader_40`;
- reefer zóna: `reefer_rack`, `reefer_plug_{on,off,alarm}`.

**Cieľ:**
- **Reefery** stoja len na pozíciách so zásuvkou. Elektrina stojí peniaze. Ak je reefer dlho bez napájania alebo nikto nevybaví alarm, prichádza reklamácia.
- **OOG** (open top a flat rack s nadrozmerom) ide na OOG plochu s reach stackerom.
- **Flat rack** smie ísť len navrch stohu. **Tank** sa stohuje bežne.
- **Kontrakty** obsahujú zmes typov kontajnerov.

**Akceptácia:**
1. Scenár `reefer_flow`:
   - 0 reklamácií, keď je dosť zásuviek;
   - reklamácie vzniknú, keď zásuvky chýbajú, a STS reefer preskočí s upozornením;
   - `lostUnits` 0, `stuckAtEnd` 0.
2. Scenár `oog_flow`:
   - OOG prejde cez STS (dlhší cyklus) na `oog_area` k reach stackeru a ďalej na kamión (dlhšie zaistenie);
   - nič neleží na OOG;
   - flat rack je len navrch.
3. Energia je nová kategória ledgera `energy` a zobrazuje sa vo financiách.
4. Render kreslí:
   - typy kontajnerov a OOG náklad;
   - reefer rack so stavom zásuviek (zapojená, odpojená, alarm);
   - reach stacker s výložníkom.
5. Celé `pnpm test` a plná e2e sú zelené. Pri 100 000 tickoch `live_terminal` so zmesou typov nemá zápchu.

## Rozhodnutia (ADR-042)
1. **`container_types.json`** dostane typy podľa §3:
   - `reefer`, `open_top`, `flat_rack`, `tank`;
   - polia `stacking` (`normal` | `top_only`), `needsPower`, `oogChance`, `rateMultiplier`.
   - Šablóny kontraktov majú `typeMix`. Typ určí `Rng` pri vzniku ponuky.
2. **Stav reeferu na `CargoUnit`:** `reefer?: { plugged, unpluggedSinceTick, alarmUntilTick }`. Patrí do save, stav sa zmení na v14.
3. **Blok `reefer_block_8`** (RTG, 8×4, všetky pozície majú zásuvku).
   - **Plánovač pri vykládke:** reefer dostane voľnú zásuvku. Ak žiadna nie je, STS ho preskočí, kým sa neuvoľní, a hráč dostane toast.
   - **Napájanie:** po uložení beží `plugTicks`, pred zdvihom `unplugTicks`.
   - **Čas bez napájania:** počíta sa od zdvihu z lode alebo od odpojenia. Po `maxUnpluggedHours` vzniká reklamácia (`reeferClaimCents`).
   - **Elektrina:** za zapojený reefer sa platí `reeferPowerCentsPerHour`, kategória `energy`.
   - **Alarm:** vzniká so šancou `reeferAlarmChancePerDay`. Technik je len čas, nekreslí sa. Ak nepríde do `alarmResponseHours`, vznikne reklamácia.
4. **OOG:**
   - STS potrebuje navyše `oogExtraCycleTicks`.
   - V sklade ide len na `oog_area` (6×3, 1 rad, len na zem), kde ho obsluhuje reach stacker.
   - Na kamióne trvá zaistenie `oogLashTicks`.
5. **Stohovanie:**
   - `flat_rack` ide len navrch alebo na zem;
   - na OOG nesmie nič ležať;
   - reefer stojí len na pozícii so zásuvkou.
   - **Kontrola:** pravidlá sa rozšíria v `StorageGuard` a invariant ich kontroluje v kroku 12.
6. **Reach stacker** (`reach_stacker`) je `YardMachine` viazaný na `oog_area` / `rs_area`:
   - FSM ako RTG, ale mobilný v uličke plochy;
   - časy sú z `equipment.json`;
   - `rs_area` (8×4, 3 rady × 5/4/3 kontajnerov) je voliteľná, ak ju dovolí čas.
7. **Kapacita odovzdávacích miest** (R4 backlog): pri špičke 100 kamiónov za hodinu stačí zväčšiť počet státí, ak je to lacné. Inak ostáva v BACKLOG.

## Karty
| id | názov | agent | depends |
|---|---|---|---|
| TR5-01 | ADR-042 + defy (typy, `typeMix`, reefer, OOG a RS parametre, energia) + `CargoUnit.reefer` + pravidlá stohu + `reefer_block_8` + napájanie, alarmy, reklamácie, energia v ledgeri + scenár `reefer_flow`; save v14 | sim-architect (sonnet) | – |
| TR5-02 | `oog_area` + reach stacker (`YardMachine`) + OOG cesta STS → TT → RS → kamión + scenár `oog_flow` + 100k `live_terminal` so zmesou | sim-architect (sonnet) | 01 |
| TR5-03 | Render: kontajnery podľa typu a OOG, reefer rack a stav zásuviek, reach stacker (telo, výložník, spreader), OOG plocha; demo | implementer (sonnet, worktree) | VM kontrakt |
| TR5-04 | UI: inšpektor reefer bloku (zásuvky, alarmy, odpojené), energia vo financiách, toasty reklamácií, typy v karte kontraktu | ui-builder (haiku, worktree) | VM kontrakt |
| TR5-05 | Napojenie VM, `simrun` (`reeferClaims`, `energyCents`, `oogMoves`), e2e | implementer (sonnet) | 02, 03, 04 |
| TR5-06 | Review + opravy | sim-reviewer → sim-architect | 05 |
| TR5-07 | Pipeline, artefakt, docs, PR | orchestrátor + haiku | 06 |

**VM kontrakt** (voliteľné):
- `ContainerVM.containerType` (už existuje) a `ContainerVM.oog?: boolean`;
- `StackVM.top.reefer?: 'on' | 'off' | 'alarm'`;
- `ModuleVM.plugs?: { x, y, state: 'on' | 'off' | 'alarm' | 'empty' }[]`;
- `MachineVM.defId` `reach_stacker` s poľom `boom` (0..1);
- `FinanceVM.energyCents`.

## Checklist
- [ ] TR5-01 · [ ] TR5-02 · [ ] TR5-03 · [ ] TR5-04 · [ ] TR5-05 · [ ] TR5-06 · [ ] TR5-07

## Výsledok fázy
_(doplní orchestrátor)_
