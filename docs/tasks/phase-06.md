# Fáza 6 — Save/Load, čas, nastavenia, stabilizácia · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 6", ARCHITECTURE §3 (čas), §14 (save), §16 (testy); BACKLOG položky s fázou F6.
> Vetva: `phase/06-save-load` (stacked nad `phase/05b-playtest-feedback`, PR hilkovics/Harbor#7). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora; úsporný režim (plná e2e raz za fázu — T06-09).
> UI prototyp: `design/ui/game-ui.source.html` (overlay `settings`).

**Cieľ:** hra sa dá uložiť a načítať, ovládanie času je kompletné, technický dlh z M1 a F5b je vyčistený.

**Stav na vstupe:** `World.serialize()` / `World.deserialize()` s migráciami v1→v6 a validáciou pri obnove už existujú (F1–F5b); determinism test beží len nad `f1_roads`. Chýba: obálka savu, ukladanie v aplikácii (sloty, autosave, export/import), Settings, roundtrip uprostred F2–F5 tokov, meranie výkonu, P1 bugy.

**Akceptácia fázy:**
- uloženie počas vykládky a načítanie → loď pokračuje presne tam, kde bola (hash stavu po N tickoch zhodný s nepretržitým behom);
- Playwright: uloženie → reload stránky → načítanie → HUD ukazuje uložený cash a deň;
- `pnpm bench`: priemer `world.tick()` < 2 ms nad `vertical_slice`;
- všetky testy zelené, `/sim-check` zelený, `lostUnits = 0`.

## Rozhodnutia orchestrátora (zapíšu sa do ADR-030 v T06-01)
1. **SaveGame v1 = obálka v app vrstve** (`src/app/save/`), sim o nej nevie: `{ format: 'modular-harbor-save', saveVersion: 1, gameVersion, savedAtIso, label, preview: { day, timeLabel, cashCents, xp }, world: WorldState }`. `version`, `seed`, `tick` žijú **len** vo `world` (rieši BACKLOG P1 „§14 duplikuje version/seed/tick"). `preview` je odvodený len pre zoznam slotov, pri načítaní sa ignoruje. `savedAtIso` a `gameVersion` dopĺňa app (sim nesmie čítať reálny čas).
2. **Nastavenia sa do savu neukladajú** (per-zariadenie): `localStorage['mh.settings']` = `{ settingsVersion: 1, defaultSpeed, autosaveEveryDays, sound: false }`.
3. **Úložisko:** `localStorage` kľúče `mh.save.auto`, `mh.save.1..3`. Každý prístup v try/catch → pri zlyhaní toast, hra beží ďalej. **Export** = stiahnutie `.json` (Blob + `<a download>`), **import** = `<input type=file>` → `decodeSave` → `World.deserialize`; pri chybe toast s dôvodom (`WorldStateError` cesta) a aktuálny svet sa nezmení.
4. **Autosave:** pri `DayClosed` každých `autosaveEveryDays` dní (predvolene 1, 0 = vypnuté) do `mh.save.auto`. Spúšťa SimBridge po flushi udalostí, mimo `world.tick()`.
5. **Načítanie** = `World.deserialize(...)` → reštart cez existujúci `runGame.start(world)` (rovnako ako „Nová hra"); po načítaní je hra **pozastavená**.
6. **Ovládanie času:** existuje (pauza, 1×–8×, klávesy Space a číslice). Doplní sa: `Ctrl+S` = rýchle uloženie do slotu 1 (preventDefault), predvolená rýchlosť z nastavení pri štarte a po načítaní (po načítaní pauza má prednosť). F5 sa nepoužíva (reload v prehliadači).
7. **Hash stavu:** `stateHash(world)` = FNV-1a 32-bit nad `JSON.stringify(world.serialize())` (čistý TS, `src/sim/world/state-hash.ts`). Používa ho test, `simrun --hash` a `simrun --roundtrip-at N`; UI nie.
8. **Výkon:** `tools/bench.ts` (`pnpm bench <scenario> --ticks N`) — priemer, p95, max `world.tick()` a počet ticku nad 2 ms; scenáre `vertical_slice` a nový `stress_f6` (2 kotviská, 4 žeriavy, 3 dvory, 2 rampy, 16 vozidiel, nepretržitý prísun kontraktov). Meranie času je **len v tools/** (`performance.now` v src/sim zakázaný).

## Karty
| id | názov | model | agent | parallel | depends_on | est |
|---|---|---|---|---|---|---|
| T06-01 | ADR-030 SaveGame + `state-hash.ts` + audit úplnosti `serialize` + `simrun --hash/--roundtrip-at` | opus | sim-architect | no | – | M |
| T06-02 | TDD: roundtrip uprostred vykládky, toku kamiónov a kontraktu; determinizmus 2 svetov nad `vertical_slice` a `full_import_chain`; savy v1…v5 → v6 | sonnet | test-writer | yes (worktree) | 01 | M |
| T06-03 | App: `src/app/save/` (encode/decode, sloty, autosave, export/import, Ctrl+S), Load → reštart, Settings úložisko | sonnet | implementer | yes (worktree) | 01 | M |
| T06-04 | UI: Settings + Save/Load overlay z prototypu, TopHUD ikona, toasty | sonnet | ui-builder | yes (worktree) | 01 | M |
| T06-05 | Bench: `tools/bench.ts`, `pnpm bench`, `stress_f6.json`, report hot path | sonnet | implementer | yes (worktree) | – | S |
| T06-06 | Data/tooling: validate-defs krížová kontrola manifestu (apronSlots, stalls, docks, bays) | sonnet | implementer | yes (worktree) | – | S |
| T06-07 | Sim: P1 z BACKLOG + hot-path opravy z T06-05 | opus | sim-architect | no | 01, 05 | M |
| T06-08 | Review `src/sim/**` + opravy | opus | sim-reviewer → sim-architect | no | 07 | S |
| T06-09 | e2e save/load + plná e2e + screenshoty + `/sim-check` | sonnet / haiku | implementer / test-runner | no | 02–08 | S |
| T06-10 | Docs: ARCHITECTURE §14, PROGRESS, BACKLOG, PR | haiku | docs-keeper | no | 09 | S |

Vlny: T06-01 ‖ T06-05 ‖ T06-06 → {T06-02 ‖ T06-03 ‖ T06-04} → T06-07 → T06-08 → T06-09 → T06-10.
Worktree karty začínajú `git reset --hard <HEAD phase/06-save-load>` (worktree sa zakladá z `main`).

## Checklist
- [ ] T06-01 · ADR-030, state-hash, audit serialize, simrun --hash/--roundtrip-at
- [ ] T06-02 · TDD roundtrip + determinizmus + migrácie
- [ ] T06-03 · App save/load/autosave/export/import/Ctrl+S
- [ ] T06-04 · UI Settings + Save/Load overlay
- [ ] T06-05 · Bench + stress scenár
- [ ] T06-06 · validate-defs krížová kontrola manifestu
- [ ] T06-07 · Sim P1 + hot path
- [ ] T06-08 · Review src/sim + opravy
- [ ] T06-09 · e2e + plná pipeline
- [ ] T06-10 · Docs + PR

## Spoločné rozhrania (záväzné pre paralelné karty)
```ts
// src/sim/world/state-hash.ts (T06-01)
export function stateHash(world: World): string;            // 8 hex znakov, FNV-1a 32 nad JSON.stringify(world.serialize())
export function hashWorldState(state: WorldState): string;  // to isté nad hotovým stavom

// src/app/save/save-game.ts (T06-03; T06-04 len importuje typy a funkcie)
export const SAVE_FORMAT = 'modular-harbor-save';
export const SAVE_VERSION = 1;
export type SaveSlotId = 'auto' | '1' | '2' | '3';
export interface SavePreview { readonly day: number; readonly timeLabel: string; readonly cashCents: number; readonly xp: number }
export interface SaveGame { readonly format: typeof SAVE_FORMAT; readonly saveVersion: 1; readonly gameVersion: string; readonly savedAtIso: string; readonly label: string; readonly preview: SavePreview; readonly world: WorldState }
export function encodeSave(world: World, label: string, nowIso: string): SaveGame;
export function decodeSave(raw: unknown): SaveGame;          // hodí SaveError s dôvodom (format, verzia, chýbajúci world)
// src/app/save/save-store.ts
export interface SaveSlotInfo { readonly slot: SaveSlotId; readonly label: string; readonly savedAtIso: string; readonly preview: SavePreview }
export interface SaveStore { list(): SaveSlotInfo[]; save(slot: SaveSlotId, save: SaveGame): void; load(slot: SaveSlotId): SaveGame | null; remove(slot: SaveSlotId): void }
// src/app/settings.ts
export interface Settings { readonly settingsVersion: 1; readonly defaultSpeed: 0 | 1 | 2 | 4 | 8; readonly autosaveEveryDays: number; readonly sound: false }
```
UI (T06-04) dostane cez props/kontext: `slots: SaveSlotInfo[]`, `onSave(slot)`, `onLoad(slot)`, `onExport()`, `onImport(file)`, `settings`, `onSettingsChange(settings)`. Napojenie robí T06-03.

### T06-01 · ADR-030, state-hash, audit serialize, simrun --hash/--roundtrip-at
- model: opus · agent: sim-architect · parallel: no · depends_on: –
- inputs: rozhodnutia 1, 2, 7; ARCHITECTURE §14; `src/sim/world/**`; `tools/simrun.ts`; `tests/sim/world/determinism.test.ts`
- outputs: `docs/DECISIONS.md` (ADR-030), `src/sim/world/state-hash.ts` (+ export), `tools/simrun.ts`, testy
- požiadavky: ADR-030 podľa rozhodnutí 1–5; audit, že `serialize()` pokrýva všetok stav, ktorý ovplyvní budúce ticky (Rng, pool kontraktov, ekonomika, lode/trasy, rezervácie, joby, kamióny, počítadlá metrík) — chýbajúce doplniť ako WorldState v7 len ak treba (inak bez zmeny verzie); `simrun --hash` vypíše hash na konci; `simrun --roundtrip-at N` v ticku N spraví `deserialize(serialize())` a pokračuje — report musí byť zhodný s behom bez roundtripu.
- acceptance: `pnpm vitest run tests/sim/world tests/tools`; `pnpm simrun data/scenarios/vertical_slice.json --ticks 30000 --hash` = `... --roundtrip-at 9000 --hash`; `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/render/**, src/ui/**, src/app/**

### T06-02 · TDD roundtrip + determinizmus + migrácie
- model: sonnet · agent: test-writer · parallel: yes (worktree) · depends_on: T06-01
- outputs: `tests/sim/world/save-roundtrip.test.ts`, `tests/sim/world/determinism-f5.test.ts`, fixtures savov v1…v5 (`tests/sim/__fixtures__/saves/`)
- požiadavky: roundtrip v ticku, keď loď vykladá (žeriav v `lifting`/`lowering`), keď kamión cúva/nakladá na rampe, keď je kontrakt v `unloading` aj `exporting`, keď loď čaká v `arriving` a na anchorage → hash po ďalších 5 000 tickoch = nepretržitý beh; dva svety s rovnakým seedom nad `vertical_slice` a `full_import_chain` → rovnaký hash v 5 kontrolných bodoch; pre každú verziu v1…v5 malý uložený save → `deserialize` prejde a 2 000 tickov bez porušenia invariantov; poškodený save → `WorldStateError` s cestou.
- acceptance: `pnpm vitest run tests/sim/world`; `pnpm test`
- do_not_touch: src/**

### T06-03 · App save/load/autosave/export/import/Ctrl+S
- model: sonnet · agent: implementer · parallel: yes (worktree) · depends_on: T06-01
- outputs: `src/app/save/**`, `src/app/settings.ts`, úpravy `src/app/{run-game,sim-bridge,input-controller,bootstrap}.ts`, napojenie UI z T06-04 (`src/app/connected-*.tsx`), testy `tests/app/save/**`
- požiadavky: rozhodnutia 1–6; `gameVersion` z `package.json`; autosave nespomalí tick (test: autosave sa volá raz za deň po `DayClosed`, nie v `world.tick()`); load → pauza; import chybného súboru → toast, svet nezmenený; localStorage nedostupné/plné → toast.
- acceptance: `pnpm vitest run tests/app`; `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/**, src/render/**

### T06-04 · UI Settings + Save/Load overlay
- model: sonnet · agent: ui-builder · parallel: yes (worktree) · depends_on: T06-01 (len typy z „Spoločných rozhraní")
- inputs: `design/ui/game-ui.source.html` (overlay `settings`, ikona `#ic_settings`), `design/tokens.css`
- outputs: `src/ui/settings-panel.tsx`, `src/ui/save-load-panel.tsx` (sloty s preview, export/import, mazanie slotu s potvrdením), TopHUD ikona, testy `tests/ui/**`
- požiadavky: čisté komponenty (props, bez `useSimSnapshot`), tokeny namiesto farieb, prístupnosť (role dialog, focus trap, Esc zatvára).
- acceptance: `pnpm vitest run tests/ui`; `pnpm typecheck && pnpm lint`
- do_not_touch: src/sim/**, src/render/**, src/app/** (napojenie robí T06-03)

### T06-05 · Bench + stress scenár
- model: sonnet · agent: implementer · parallel: yes (worktree) · depends_on: –
- outputs: `tools/bench.ts`, `package.json` skript `bench`, `data/scenarios/stress_f6.json`, `tests/tools/bench.test.ts`, report v `docs/tasks/phase-06.md` (sekcia „Výsledok T06-05")
- požiadavky: rozhodnutie 8; report: priemer/p95/max a top 5 systémov podľa času (meranie po krokoch `World.tick()` cez voliteľný profiler hook v tools — ak hook vyžaduje zmenu src/sim, eskaluj a meraj len celkový tick).
- acceptance: `pnpm bench data/scenarios/vertical_slice.json --ticks 30000`; `pnpm bench data/scenarios/stress_f6.json --ticks 30000`; `pnpm vitest run tests/tools`
- do_not_touch: src/**

### T06-06 · validate-defs krížová kontrola manifestu
- model: sonnet · agent: implementer · parallel: yes (worktree) · depends_on: –
- outputs: `tools/validate-defs.ts`, `tests/tools/validate-defs.test.ts`
- požiadavky: `berth.apronSlots` = počet slotov v `assets/manifest.json`, `vehicle_depot.capacity` = stalls, `loading_ramp_*.docks` = docks, `truck_waiting_area.bays` = stalls; chyba s cestou k poľu.
- acceptance: `pnpm validate:defs`; `pnpm vitest run tests/tools`
- do_not_touch: src/**, data/**

### T06-07 · Sim P1 + hot path
- model: opus · agent: sim-architect · parallel: no · depends_on: T06-01, T06-05
- požiadavky (BACKLOG): `AcceptContract` overí pripravenosť prístavu (žeriav kategórie, kotvisko s hĺbkou pre triedu lode) → `CommandRejected` s dôvodom; restore validácia brán/stojísk/rámp/kamiónov (v4+); `gate_queue_out` dvojité `trucksProcessed`; pool po migrácii v4→v5 doplniť; cache prevádzkovosti rampy v dispatcheri; hot-path nálezy z T06-05 (cieľ priemer < 2 ms); konštanty `water-navigator.ts` do defu, ak to nezmení golden. Každá oprava s testom; zmeny goldenov zdôvodniť.
- acceptance: `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs`; `pnpm bench data/scenarios/vertical_slice.json --ticks 30000` priemer < 2 ms
- do_not_touch: src/render/**, src/ui/**, src/app/**

### T06-08 · Review `src/sim/**` + opravy
- sim-reviewer nad `git diff <základ F6>..HEAD -- src/sim`; MERGE / FIX FIRST; opravy sim-architect.

### T06-09 · e2e + plná pipeline
- `tests/e2e/f6-save-load.spec.ts`: nová hra → prijatie kontraktu → zrýchlenie → `Ctrl+S` → reload stránky → načítanie slotu 1 → HUD cash a deň zhodné, loď na rovnakom mieste (screenshot `f6-loaded.png`); export → import súboru → rovnaký HUD. Potom plná e2e sada + `/sim-check` (test-runner).

### T06-10 · Docs + PR
- ARCHITECTURE §14 (SaveGame v1, nastavenia, autosave), PROGRESS, BACKLOG (odškrtnuté P1), PR popis.
