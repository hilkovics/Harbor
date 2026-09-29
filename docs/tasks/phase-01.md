# Fáza 1 — Grid, mapa, kamera, príkazy, cesty · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 1" (+ riadok Model mix), ARCHITECTURE §3, §4, §4.6, §4.7, §5.1, §5.2, §6, §8, §12, §13, §15; ADR-002, ADR-006..011.
> Vetva: `phase/01-grid-roads` (stacked nad PR hilkovics/Harbor#1, fáza 0). Používateľ delegoval plánovanie aj rozhodnutia na orchestrátora („postupuj úplne samostatne").
> Grafika: assety z Claude Design (DESIGN_BRIEF §8, relácie 1, 2, 5-TopHUD, 6) zatiaľ nie sú. Karty T01-08 a T01-10 použijú `assets/**` a `design/ui/top-hud.html`, ak v čase štartu existujú; inak dočasné token farby (plán F1 to predpokladá) a výmena za sprity príde samostatnou kartou.

**Cieľ:** vidím mapu s pobrežím, môžem panovať/zoomovať a stavať cesty s validáciou.
**Akceptácia fázy:** screenshot ukazuje pobrežie + nakreslenú cestu; `SetGameSpeed(4)` zrýchli hodiny v HUD; testy rotácie footprintu, `PlaceRoad` (voda / obsadená bunka / cudzia parcela), autotile, GameLoop (presne `n` tickov pri `dt`).

## Checklist

- [ ] T01-01 · Defy: `infrastructure.json`, `time.maxTicksPerFrame`, `economy.removalRefundRate`, mapa `harbor_01` + schéma, validate-defs pre mapy, DefRegistry
- [ ] T01-02 · Sim: Grid, Cell, TerrainType, `rotate`, MapDef loader + invarianty mapy
- [ ] T01-03 · Sim: World kostra (tick kroky 1 + 13, `applyPending`, parcely, cash, serialize v1) + kalendár SimClock + Rng uint32
- [ ] T01-04 · Sim: Command infra + `PlaceRoad` / `RemoveRoad` / `SetGameSpeed` + ADR-012
- [ ] T01-05 · Testy: scenár `f1_roads` + determinizmus / roundtrip (TDD)
- [ ] T01-06 · Tooling: `simrun` nad skutočným World + replay príkazov
- [ ] T01-07 · App: GameLoop + SimBridge + `useSimSnapshot` + `window.__sim` (dev)
- [ ] T01-08 · Render: WorldRenderer, TerrainLayer, RoadLayer (autotile), Camera
- [ ] T01-09 · Tabuľkové testy (scaffold): `rotate`, `autotileShape`, `formatMoney`, `formatGameTime`
- [ ] T01-10 · UI: TopHUD + SpeedControl + formátovače
- [ ] T01-11 · App: InputController + bootstrap (Pixi + HUD)
- [ ] T01-12 · E2E: cesta ťahom myši + rýchlosť 4× + screenshot
- [ ] T01-13 · Review `src/sim/**`
- [ ] T01-14 · Plná pipeline + triáž
- [ ] T01-15 · Uzavretie fázy (PROGRESS, BACKLOG)
- [ ] T01-16 · Sprity terénu a infraštruktúry (Claude Design relácia 2) + prechody pobrežia

Vlny: 01 → 02 → {03 ‖ 08 ‖ 05*} → 04 → {06 ‖ 07 ‖ 13} → {10 ‖ 11} → 16 → 09 → 12 → 14 → 15.
\* T01-05 píše testy vopred vo worktree; zlúčia sa až po T01-04, keď sú zelené (pravidlo „pnpm test zelené pred commitom").
Single writer `src/sim/**`: do `src/sim` píšu len T01-01 až T01-04, a to sériovo.

## Spoločné rozhrania (záväzné pre paralelné karty)

```ts
// src/sim/grid
type TerrainType = 'deep_water' | 'shallow_water' | 'quay' | 'land' | 'blocked';   // ARCHITECTURE §5.1
type RoadLayer = 'none' | 'road' | 'rail';
interface CellCoord { readonly x: number; readonly y: number; }
interface Cell { terrain: TerrainType; depthClass: 0|1|2|3; parcelId: string | null;
                 moduleId: EntityId | null; road: RoadLayer; traffic: number; }
class Grid { readonly width: number; readonly height: number;
  inBounds(x, y): boolean; index(x, y): number; at(x, y): Cell; neighbors4(x, y): CellCoord[]; }
type Rotation = 0 | 90 | 180 | 270;          // v smere hodinových ručičiek
rotateFootprint(w, h, r): { w: number; h: number }          // 90/270 prehodí w a h
rotateLocalCell(x, y, w, h, r): CellCoord                    // lokálna bunka footprintu w×h pri rot 0 → po rotácii
```
Tabuľka `rotateLocalCell` (footprint `w×h`, lokálna bunka `(x, y)`):

| r | výsledok | rozmery |
|---|---|---|
| 0 | `(x, y)` | `w×h` |
| 90 | `(h−1−y, x)` | `h×w` |
| 180 | `(w−1−x, h−1−y)` | `w×h` |
| 270 | `(y, w−1−x)` | `h×w` |

```ts
// src/sim/world
class World {
  readonly clock: SimClock; readonly grid: Grid; readonly parcels: ReadonlyMap<string, Parcel>;
  readonly defs: DefRegistry; readonly map: LoadedMap; cashCents: number;
  enqueue(cmd: Command): void;
  tick(): readonly SimEvent[];          // pending príkazy → clock.advance() → flush udalostí (§6 kroky 1, 13)
  applyPending(): readonly SimEvent[];  // len pending príkazy, bez posunu času (stavba počas pauzy); replay ekvivalentný
  serialize(): WorldState;              // { version: 1, mapId, seed, rng, clock, ids, cashCents, roads, parcels }
  static create(defs, map, seed): World;
  static deserialize(defs, map, state: WorldState): World;
}
interface Parcel { id; rect: { x; y; w; h }; priceCents; leasable; ownership: 'none' | 'owned' | 'leased' }

// src/sim/commands
interface ValidationResult { ok: boolean; reasons: ValidationReason[]; cells: CellCoord[]; costCents: number }
type ValidationReason = 'out_of_bounds' | 'terrain' | 'occupied' | 'parcel_not_owned' | 'insufficient_funds'
                      | 'no_road' | 'invalid_speed' | 'empty';
interface Command { readonly type: string; validate(world): ValidationResult; apply(world): void; toJSON(): SerializedCommand }
interface SerializedCommand { type: string; [k: string]: unknown }
commandFromJSON(json: SerializedCommand): Command    // registry typ → factory (nie switch, pravidlo 7)
// PlaceRoadCommand { cells }, RemoveRoadCommand { cells }, SetGameSpeedCommand { speed }

// src/sim/events — SimEvent (readonly DTO, §12.1 výber pre F1)
| { type: 'TickAdvanced'; tick } | { type: 'HourClosed'; tick } | { type: 'DayClosed'; tick } | { type: 'MonthClosed'; tick }
| { type: 'RoadChanged'; cells: CellCoord[] } | { type: 'MoneyChanged'; cashCents; deltaCents; reason }
| { type: 'GameSpeedChanged'; speed } | { type: 'CommandRejected'; commandType; reasons: ValidationReason[] }
```

Scenár (replay, §12.2): `{ "id", "seed", "map": "data/maps/harbor_01.json", "commands": [{ "atTick": 0, "command": { "type": "PlaceRoad", "cells": [{ "x": 30, "y": 30 }] } }] }` — príkaz s `atTick = T` sa aplikuje cez `applyPending()` keď `clock.tick === T`, pred ďalším `tick()`.

---

### T01-01 · Defy: `infrastructure.json`, `time.maxTicksPerFrame`, `economy.removalRefundRate`, mapa `harbor_01` + schéma, validate-defs pre mapy, DefRegistry
- model: sonnet
- agent: implementer
- parallel: no (mení aj `src/sim/defs` — single writer)
- depends_on: –
- inputs: ARCHITECTURE §3 (max 64 tickov/frame), §4, §4.6 (infrastructure), §4.7 (MapDef), §5.2, §8 bod 8 (vrátenie 50 %); ADR-008, ADR-009, ADR-010; data/defs/*.json; data/schemas/*.json; tools/validate-defs.ts; src/sim/defs/**
- outputs: data/defs/infrastructure.json; data/schemas/infrastructure.schema.json; data/defs/time.json + schéma (`maxTicksPerFrame: 64`); data/defs/economy.json + schéma (`removalRefundRate: 0.5`); data/schemas/map.schema.json; data/maps/harbor_01.json; tools/validate-defs.ts (validuje aj `data/maps/*.json` voči `map.schema.json`); src/sim/defs/{types,def-registry}.ts (InfrastructureDef + nové polia); príslušné testy v tests/tools a tests/sim/defs
- požiadavky:
  - `infrastructure.json` (konfiguračný def, ADR-009/010): `{ schemaVersion: 1, road: { costPerCellCents: 200000, maintenancePerDayCents: 0 }, rail: { costPerCellCents: 600000, maintenancePerDayCents: 0 } }`.
  - Mapa `harbor_01` 96×64 (§4.7), znaky terénu `~ = Q . #`: sever = voda (hlboká ~10 riadkov, plytká ~4), súvislý úsek `Q` (nábrežie) min. 24 buniek pri vode, zvyšok pevnina s niekoľkými `#` plochami. 3 parcely bez prekryvu: `starter` (`startOwned: true`, obsahuje časť nábrežia), 2 na predaj (`leasable: true`), verejné bunky mimo parciel. `roadPortals` 1× a `railPortals` 1× na okraji mapy na pevnine mimo parciel. `seaLane` polyline od severného okraja cez vodu k `anchorage` (bunky hlbokej vody). `depth`: kľúč = obdĺžnik `"x,y,w,h"` → depthClass 1|2|3 (default 1). `starter.modules: []` (Root modul vo F2), `starter.roads`: cesta po verejných bunkách od road portálu k hranici starter parcely (ADR-008).
  - `map.schema.json` popisuje štruktúru (typy, rozsahy, `terrain` riadky dĺžky `width`, počet riadkov = `height` overí loader v T01-02).
  - DefRegistry: `InfrastructureDef` v rovnakej tabuľkovej validácii; `time.maxTicksPerFrame` (int ≥ 1), `economy.removalRefundRate` (0..1); `loadBundledDefs()` načíta aj infrastructure. BACKLOG P2 „divisorOf prijme záporného deliteľa" → pridaj `value > 0` pre `divisorOf`.
- acceptance:
  - `pnpm validate:defs` (vypíše OK aj pre `maps/harbor_01.json`)
  - `pnpm vitest run tests/sim/defs tests/tools/validate-defs.test.ts`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/core/**, src/sim/{grid,world,commands,events}/**, src/render/**, src/ui/**, src/app/**, eslint.config.js, .claude/**
- estimate: M

### T01-02 · Sim: Grid, Cell, TerrainType, `rotate`, MapDef loader + invarianty mapy
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T01-01
- inputs: ARCHITECTURE §4.7, §5.1, §5.2, §8 bod 7; ADR-006, ADR-008; „Spoločné rozhrania" vyššie; data/maps/harbor_01.json
- outputs: src/sim/grid/{terrain,grid,rotation,index}.ts; src/sim/grid/map-loader.ts (alebo src/sim/map/**); tests/sim/grid/{grid,rotation,map-loader}.test.ts
- požiadavky: `loadMap(def): LoadedMap` = `{ id, grid, parcels (Parcel[] s ownership z startOwned), roadPortals, railPortals, seaLane, anchorage, starter }`, starter cesty zapísané do `grid` (road='road'). Fail-fast `MapError(path, dôvod)` pri: zlá dĺžka/počet riadkov terénu, neznámy znak, parcela mimo mapy alebo prekryv parciel, portál nie na okraji / nie na pevnine / v parcele, seaLane/anchorage nie na vode, starter cesta na vode alebo na parcele na predaj. `parcelId` buniek podľa parciel. `depthClass` quay buniek z `depth` (default 1), vodné/pevninské bunky 0. Rotácia presne podľa tabuľky v „Spoločné rozhrania".
- acceptance:
  - `pnpm vitest run tests/sim/grid` (vrátane rotácie 0/90/180/270 pre footprint 2×3 a 8×3; `harbor_01` sa načíta; každé porušenie invariantu → MapError s cestou)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/core/**, src/sim/defs/**, data/**, src/render/**, src/ui/**, src/app/**, tools/**
- estimate: M

### T01-03 · Sim: World kostra + kalendár SimClock + Rng uint32
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T01-02
- inputs: ARCHITECTURE §3, §5 (World), §6 (kroky 1 a 13, príkazy pred krokom 1), §12.1, §14; ADR-002; „Spoločné rozhrania"; BACKLOG P2 (kalendár SimClock, INITIAL_SPEED ∈ speeds, Rng seed uint32, Rng.range/int JSDoc)
- outputs: src/sim/world/{world,world-state,index}.ts; src/sim/events/{sim-event,index}.ts; src/sim/core/sim-clock.ts (gettery `hourOfDay`, `minuteOfHour`, `dayOfMonth`, `monthOfYear`?—len ak treba; 0-based dokumentované); src/sim/core/rng.ts (seed len uint32 → RangeError; JSDoc range/int); tests/sim/world/*.test.ts, tests/sim/core/* doplnky
- požiadavky: `World.create(defs, map, seed)` — `cashCents = economy.startingCashCents`, počiatočná rýchlosť musí byť v `time.speeds` (inak chyba), EventBus, Rng, EntityIdAllocator. `tick()` a `applyPending()` presne podľa rozhrania (príkazy z fronty v poradí vloženia; neplatný príkaz → `CommandRejected`, nič nemení). Clock hranice → `HourClosed`/`DayClosed`/`MonthClosed` + `TickAdvanced`. `serialize()/deserialize()` v1 (terén z mapy sa neserializuje, cesty ako zoznam indexov buniek + typ). Command rozhranie z „Spoločné rozhrania" zadefinuj tu (len typy; implementácie príkazov T01-04).
- acceptance:
  - `pnpm vitest run tests/sim/world tests/sim/core`
  - test „deserialize(serialize(w)) po 1000 tickoch ≡ w po 1000 tickoch" (hash serialize)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/defs/**, src/sim/grid/** (okrem čítania), data/**, src/render/**, src/ui/**, src/app/**, tools/**
- estimate: M

### T01-04 · Sim: Command infra + `PlaceRoad` / `RemoveRoad` / `SetGameSpeed` + ADR-012
- model: opus
- agent: sim-architect
- parallel: no
- depends_on: T01-03
- inputs: ARCHITECTURE §5.1, §5.2, §8, §12.2; ADR-006, ADR-008, ADR-010; „Spoločné rozhrania"; data/defs/{infrastructure,economy,time}.json
- outputs: src/sim/commands/{command,validation,command-registry,place-road,remove-road,set-game-speed,index}.ts; tests/sim/commands/*.test.ts; docs/DECISIONS.md (ADR-012)
- požiadavky:
  - `PlaceRoad { cells }`: každá bunka `inBounds`, terén `land|quay` (nie voda, nie `blocked`), `moduleId === null`, `road !== 'rail'`; parcela podľa ADR-008 (verejná alebo owned/leased; na predaj → `parcel_not_owned`); bunky už s cestou sa preskočia (nie chyba, bez ceny); prázdny zoznam alebo žiadna nová bunka → `empty`; cena = nové bunky × `infrastructure.road.costPerCellCents` ≤ `cashCents`, inak `insufficient_funds`. `apply`: road='road', `cashCents -= cena`, `RoadChanged` + `MoneyChanged`. Duplicitné bunky v zozname sa počítajú raz.
  - `RemoveRoad { cells }`: bunky musia mať `road === 'road'` (inak `no_road`), parcela ako pri stavbe; refundácia `floor(bunky × costPerCellCents × economy.removalRefundRate)`; `RoadChanged` + `MoneyChanged`.
  - `SetGameSpeed { speed }`: `speed ∈ time.speeds`, inak `invalid_speed`; `GameSpeedChanged`.
  - `commandFromJSON` + `toJSON` roundtrip pre všetky tri; neznámy typ → chyba. Registry mapa `type → factory`, žiadny switch.
  - ADR-012 do DECISIONS.md: odstránenie cesty/koľaje vracia `economy.removalRefundRate` (50 %, rovnako ako moduly §8 bod 8).
- acceptance:
  - `pnpm vitest run tests/sim/commands` (vrátane: PlaceRoad odmietne vodu, `blocked`, obsadenú bunku, parcelu na predaj, nedostatok peňazí; povolí verejnú bunku a starter parcelu; RemoveRoad refunduje 50 %; SetGameSpeed(4) OK, SetGameSpeed(3) → invalid_speed)
  - `test "$(grep -c '^## ADR-0[01][0-9]:' docs/DECISIONS.md)" -eq 12`
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/defs/**, src/sim/grid/**, data/**, src/render/**, src/ui/**, src/app/**, tools/**
- estimate: M

### T01-05 · Testy: scenár `f1_roads` + determinizmus / roundtrip (TDD)
- model: sonnet
- agent: test-writer
- parallel: yes (worktree; zlúči sa po T01-04)
- depends_on: T01-02
- inputs: ARCHITECTURE §12.2, §14, §16; „Spoločné rozhrania" (formát scenára, World API, commandFromJSON)
- outputs: data/scenarios/f1_roads.json; tests/sim/scenarios/f1-roads.test.ts; tests/sim/world/determinism.test.ts
- požiadavky: scenár postaví cestu po starter parcele a verejných bunkách (≥ 20 buniek, 3 príkazy v rôznych tickoch vrátane RemoveRoad a SetGameSpeed), beh 20 000 tickov. Asercie: počet ciest, cash = štart − cena + refundácia, rýchlosť. Determinizmus: dva svety s rovnakým seedom a scenárom → identický `serialize()` hash po N tickoch; roundtrip serialize/deserialize uprostred behu. Testy musia pred T01-04 červeno zlyhať kvôli chýbajúcej implementácii (nie syntax) — uveď v zhrnutí.
- acceptance:
  - (po T01-04) `pnpm vitest run tests/sim/scenarios tests/sim/world/determinism.test.ts`
- do_not_touch: src/**, tools/**
- estimate: S

### T01-06 · Tooling: `simrun` nad skutočným World + replay príkazov
- model: sonnet
- agent: implementer
- parallel: yes
- depends_on: T01-04
- inputs: tools/simrun.ts; „Spoločné rozhrania"; ARCHITECTURE §12.2
- outputs: tools/simrun.ts; tests/tools/simrun.test.ts; data/scenarios/smoke.json (pridať `map`)
- požiadavky: odstrániť stub `Tickable`; `World.create(loadBundledDefs(), loadMap(map), seed)`; príkazy cez `commandFromJSON` a `applyPending()` pri `atTick`; neplatný príkaz v scenári → exit 1 so správou (vrátane dôvodov). Report kľúče nezmenené + `cashEnd` = `world.cashCents`, `roads` (počet buniek s cestou).
- acceptance:
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e '.lostUnits==0 and .roads>0'` (po zlúčení T01-05)
  - `pnpm -s simrun data/scenarios/smoke.json --ticks 1000 --report | jq -e '.ticks==1000'`
  - `pnpm vitest run tests/tools/simrun.test.ts && pnpm typecheck && pnpm lint`
- do_not_touch: src/sim/**, data/defs/**, data/maps/**
- estimate: S

### T01-07 · App: GameLoop + SimBridge + `useSimSnapshot` + `window.__sim`
- model: sonnet
- agent: implementer
- parallel: yes
- depends_on: T01-04
- inputs: ARCHITECTURE §3 (akumulátor, max `time.maxTicksPerFrame`, alpha), §13 (snapshot, `useSimSnapshot(selector, 100)`), §16 (`window.__sim` v dev); CLAUDE.md konvencie React
- outputs: src/app/{game-loop,sim-bridge,use-sim-snapshot,dev-hook}.ts(x); tests/app/{game-loop,sim-bridge}.test.ts
- požiadavky: `GameLoop.frame(dtMs)`: `acc += dtMs × speed`; `n = min(floor(acc / tickMs), maxTicksPerFrame)`; `tickMs = 1000 / ticksPerRealSecond`; pri dosiahnutí limitu sa prebytok zahodí (acc ≤ tickMs); speed 0 → iba `applyPending()`; `alpha = acc / tickMs`. Čas sa injektuje (žiadne `performance.now` v logike — len v tenkom `requestAnimationFrame` wrapperi). `SimBridge`: `dispatch(cmd)` (UI volá `validate` pre ghost a `dispatch` až po OK), `snapshot()` plytký read-only view (clock, cashCents, grid, parcels), `subscribe`, udalosti za frame. `useSimSnapshot(selector, throttleMs = 100)` cez `useSyncExternalStore`. `window.__sim` len v `import.meta.env.DEV`: `{ world, bridge, cellToScreen(x,y)? }` (cellToScreen doplní T01-11).
- acceptance:
  - `pnpm vitest run tests/app` (vrátane: dt = 1000 ms pri 1× → presne 10 tickov; 4× → 40; 10 s pri 8× → max 64/frame; speed 0 → 0 tickov, pending príkaz sa aplikuje)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/**, src/render/**, src/ui/**, data/**
- estimate: M

### T01-08 · Render: WorldRenderer, TerrainLayer, RoadLayer (autotile), Camera
- model: sonnet
- agent: implementer
- parallel: yes (worktree; číta Grid API z T01-02)
- depends_on: T01-02
- inputs: ARCHITECTURE §15.1; DESIGN_BRIEF §2, §3 (tokeny `--terrain-*`, `--road-*`, `--rail-*`, `--cell`), §4, §5.1, §5.2; „Spoločné rozhrania"
- outputs: src/render/{world-renderer,terrain-layer,road-layer,camera,autotile,tokens,index}.ts; tests/render/{camera,autotile}.test.ts
- požiadavky:
  - Farby výlučne z CSS tokenov (`readColorToken('--terrain-land')` cez `getComputedStyle`, nie literály). Ak existujú `assets/terrain/*.svg` a `assets/infra/road_*.svg` + `assets/manifest.json`, použi ich; inak dočasné plné bunky podľa tokenov (šachovnica `land`/`land-alt` 2×2) a cesty kreslené `Graphics` (`--road-base`, stredová čiara `--road-marking`).
  - Autotile — maska susedov N=1, E=2, S=4, W=8 → tvar + rotácia (základné orientácie: straight zvislá, corner N→E, t bez juhu, end otvorený na sever; rotácia v smere hodinových ručičiek):

    | maska | tvar | rot | | maska | tvar | rot |
    |---|---|---|---|---|---|---|
    | 0 | end | 0 | | 8 | end | 270 |
    | 1 | end | 0 | | 9 | corner | 270 |
    | 2 | end | 90 | | 10 | straight | 90 |
    | 3 | corner | 0 | | 11 | t | 0 |
    | 4 | end | 180 | | 12 | corner | 180 |
    | 5 | straight | 0 | | 13 | t | 270 |
    | 6 | corner | 90 | | 14 | t | 180 |
    | 7 | t | 90 | | 15 | cross | 0 |

    `autotileMask(grid, x, y, layer)` a `autotileShape(mask): { shape, rotation }` ako čisté funkcie.
  - Camera (čistá matematika, bez Pixi v jadre): 1 bunka = `--cell` px pri zoom 1; zoom 0,25–2,0; `zoomAt(factor, screenX, screenY)` drží bod pod kurzorom; `pan(dx, dy)`; clamp na hranice mapy; `screenToCell`, `cellToScreen`. Úvodná pozícia: stred starter parcely, zoom 0,5.
  - RoadLayer prekreslí len dotknuté bunky a ich susedov pri `RoadChanged`.
- acceptance:
  - `pnpm vitest run tests/render` (autotile všetkých 16 masiek podľa tabuľky; camera: zoomAt drží bod pod kurzorom, clamp, screen↔cell roundtrip)
  - `pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: src/sim/**, src/ui/**, src/app/** (okrem čítania), data/**
- estimate: M

### T01-09 · Tabuľkové testy (scaffold): `rotate`, `autotileShape`, `formatMoney`, `formatGameTime`
- model: haiku
- agent: test-runner (režim „scaffold")
- parallel: no
- depends_on: T01-02, T01-08, T01-10
- inputs: tabuľky v tomto súbore („Spoločné rozhrania" rotácia, T01-08 autotile, T01-10 formátovače)
- outputs: tests/tables/{rotation,autotile,format}.table.test.ts
- acceptance:
  - `pnpm vitest run tests/tables`
- do_not_touch: src/**
- estimate: S

### T01-10 · UI: TopHUD + SpeedControl + formátovače
- model: sonnet
- agent: ui-builder
- parallel: yes
- depends_on: T01-07
- inputs: DESIGN_BRIEF §6.1, §6.2 (TopHUD), §6.3 (SpeedControl), §6.4; design/tokens.css; design/design-system.html (relácia 1: typografia `--fs-*`, farby čísel, rozmery); `design/ui/top-hud.html` ak existuje (inak rozloženie podľa §6.1 len z tokenov); ARCHITECTURE §13, §15.2
- outputs: src/ui/{top-hud,speed-control,format}.ts(x); src/ui/top-hud.css (len tokeny); src/ui/__demo__/top-hud.demo.tsx; tests/ui/format.test.ts
- požiadavky: TopHUD 48 px (`--hud-top-h`): cash (`formatMoney`, `tabular-nums`, farba `--ui-money-pos/neg`), „Deň N · HH:MM" (`formatGameTime`), SpeedControl ⏸ 1× 2× 4× 8× (aktívny stav, `dispatch(SetGameSpeedCommand)`), stav pauza. Čítanie cez `useSimSnapshot(selector, 100)`, zápis len `dispatch`. `design/tokens.css` importovaný v `src/main.tsx`. Fonty `Inter` a `JetBrains Mono` (tokeny `--font-ui`, `--font-mono`) self-hosted cez `@fontsource/inter` a `@fontsource/jetbrains-mono` (v tejto karte povolené pridať tieto dve závislosti; žiadne CDN).
  - `formatMoney(cents)`: zaokrúhlenie na celé doláre, polovica od nuly; oddeľovač tisícov čiarka; záporné s U+2212: 0→`$0`, 49→`$0`, 99→`$1`, 149→`$1`, 150→`$2`, −49→`$0`, −150→`−$2`, 120000000→`$1,200,000`, 123456000→`$1,234,560`, −250000→`−$2,500`.
  - `formatGameTime({ day, hour, minute })` (day 0-based z SimClock): (0,0,0)→`Deň 1 · 00:00`, (0,0,1)→`Deň 1 · 00:01`, (0,1,0)→`Deň 1 · 01:00`, (0,23,59)→`Deň 1 · 23:59`, (1,0,0)→`Deň 2 · 00:00`, (11,14,20)→`Deň 12 · 14:20`.
- acceptance:
  - `pnpm vitest run tests/ui && pnpm typecheck && pnpm lint`
  - demo screenshot pozretý a porovnaný s DESIGN_BRIEF §6.1 (rozdiely v zhrnutí)
- do_not_touch: src/sim/**, src/render/**, data/**
- estimate: M

### T01-11 · App: InputController + bootstrap (Pixi + HUD)
- model: sonnet
- agent: implementer
- parallel: yes
- depends_on: T01-07, T01-08
- inputs: ARCHITECTURE §15.1 (Camera), §15.2 (klávesy B, Esc, Space, 1–4); DESIGN_BRIEF §3 (`--ghost-valid/invalid`); „Spoločné rozhrania"
- outputs: src/app/{input-controller,bootstrap}.ts; src/app/app.tsx; src/render/build-layer.ts (ghost); tests/app/input-controller.test.ts
- požiadavky: pan (drag stredným/ľavým tlačidlom mimo build módu, WASD), zoom kolieskom s pivotom pod kurzorom; `B` prepne build mód „cesta"; ťah myšou zbiera bunky (4-súvislá interpolácia medzi po sebe idúcimi bunkami, aby rýchly ťah nepreskočil bunky); ghost farbí podľa `PlaceRoadCommand.validate` (`--ghost-valid/invalid`); pustenie → `dispatch`; pravé tlačidlo v build móde = `RemoveRoad`; `Esc` zruší ťah/mód; `Space` pauza/obnova (predošlá rýchlosť); `1–4` → rýchlosti 1/2/4/8. InputController rozhoduje, či udalosť patrí UI (DOM) alebo canvasu. Bootstrap: `World.create` (seed konštanta v configu app, nie v sim), SimBridge, GameLoop cez rAF, WorldRenderer, React HUD nad canvasom. `window.__sim.cellToScreen(x, y)` pre e2e.
- acceptance:
  - `pnpm vitest run tests/app && pnpm typecheck && pnpm lint && pnpm build`
- do_not_touch: src/sim/**, src/ui/** (okrem montovania HUD v app.tsx), data/**
- estimate: M

### T01-12 · E2E: cesta ťahom myši + rýchlosť 4× + screenshot
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T01-10, T01-11, T01-16
- inputs: ARCHITECTURE §16 (E2E, `window.__sim`); IMPLEMENTATION_PLAN akceptácia F1
- outputs: tests/e2e/f1-roads.spec.ts; (boot.spec.ts upraviť, ak treba)
- požiadavky: načítanie → canvas + HUD viditeľné; `B`, ťah myšou cez ≥ 8 buniek starter parcely (súradnice z `window.__sim.cellToScreen`) → počet ciest vo `window.__sim.world` vzrástol; screenshot `tests/e2e/__screenshots__/f1-road.png` (pobrežie + cesta viditeľné); klik 4× → za ~2 s tick narástol ≥ 3× viac ako pri 1× za rovnaký čas a text času v HUD sa zmenil.
- acceptance:
  - `pnpm test:e2e && test -s tests/e2e/__screenshots__/f1-road.png` + orchestrátor si screenshot pozrie
- do_not_touch: src/**
- estimate: S

### T01-13 · Review `src/sim/**`
- model: opus
- agent: sim-reviewer
- parallel: yes (read-only)
- depends_on: T01-04, T01-06
- inputs: `git diff 65f2ac6..HEAD -- src/sim tests/sim data` (65f2ac6 = hlava fázy 0)
- outputs: tabuľka nálezov + verdikt
- acceptance: verdikt MERGE (0 blocking); blocking → nové karty (opus)
- do_not_touch: všetko
- estimate: S

### T01-14 · Plná pipeline + triáž
- model: haiku
- agent: test-runner
- parallel: no
- depends_on: T01-01..T01-13
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs && pnpm build`
  - `pnpm -s simrun data/scenarios/f1_roads.json --ticks 20000 --report | jq -e .lostUnits==0` (namiesto `vertical_slice` do F5)
  - `pnpm test:e2e` + screenshoty `boot.png`, `f1-road.png`
- do_not_touch: všetko
- estimate: S

### T01-15 · Uzavretie fázy (PROGRESS, BACKLOG)
- model: haiku
- agent: docs-keeper
- parallel: no
- depends_on: T01-14
- outputs: docs/tasks/phase-01.md (checklist); docs/PROGRESS.md; docs/BACKLOG.md
- acceptance:
  - `! grep -n '^- \[ \] T01-' docs/tasks/phase-01.md`
- do_not_touch: všetko mimo outputs
- estimate: S

### T01-16 · Sprity terénu a infraštruktúry (Claude Design relácia 2) + prechody pobrežia
- model: sonnet
- agent: implementer
- parallel: no (mení src/render po T01-08 a vizuálne sa overuje v appke z T01-11)
- depends_on: T01-08, T01-11
- inputs: assets/manifest.json (čiastočný, relácie 1–2); assets/terrain/*.svg (24), assets/infra/*.svg (15); design/terrain-infra.html (referenčný hárok); DESIGN_BRIEF §4, §5.1, §5.2, §7; src/render/** z T01-08
- outputs: src/render/{sprite-atlas,coast,terrain-layer,road-layer}.ts (+ úpravy); data/schemas/asset-manifest.schema.json; tests/render/coast.test.ts; tests/tools/asset-manifest.test.ts
- požiadavky:
  - Sprity načítať z `assets/manifest.json` cez Vite (`import.meta.glob('/assets/**/*.svg', { query: '?url', import: 'default', eager: true })`) a PixiJS `Assets` s rozlíšením pre zoom do 2,0 (SVG rasterizovať na 128 px). Autotile tvary `road/rail` z manifestu + rotácia z tabuľky T01-08. Dočasné `Graphics` kreslenie ostáva ako fallback pre chýbajúci sprite (budúce moduly).
  - Portály: sprite `portal_road` / `portal_rail` na bunke portálu.
  - Obrysy parciel (len vizuál, bez interakcie — ParcelPanel ostáva vo F7): sprity `parcel_outline_{for_sale|owned|leased}` po obvode každej parcely podľa `ownership`. Dôvod: F1 zavádza pravidlo stavby ciest podľa parciel (ADR-008), hráč musí vidieť, kde parcela na predaj začína.
  - Prechody pobrežia — čistá funkcia `coastTile(grid, x, y)` pre nevodnú bunku (vodné bunky = `water_deep` / `water_shallow`):
    - `blocked` → `blocked`.
    - `quay`: sever je voda → `quay_edge_n`, inak `quay`.
    - `land` — maska vody v 4-susedoch N=1, E=2, S=4, W=8: jedna strana → `water_edge_{n|e|s|w}`; dve susedné strany N+E / E+S / S+W / W+N → `water_inner_{ne|se|sw|nw}`; protiľahlé strany alebo ≥ 3 strany → `water_edge_*` prvej strany v poradí N, E, S, W; žiadna strana, ale voda na diagonále → `water_corner_{ne|nw|se|sw}` (prvá v poradí NE, NW, SE, SW); inak šachovnica 2×2: `(⌊x/2⌋ + ⌊y/2⌋) mod 2 = 0 → land`, inak `land_alt`.
    - Bunky mimo mapy sa nepočítajú ako voda.
  - Schéma `asset-manifest.schema.json` + test, že manifest je platný a každý odkazovaný súbor existuje.
- acceptance:
  - `pnpm vitest run tests/render tests/tools/asset-manifest.test.ts` (vrátane tabuľky `coastTile`: všetky vetvy + harbor_01 bunky (0,11) → `water_edge_n`, (5,11) → `water_inner_ne`, (9,12) → `water_inner_ne`, (5,12) → `water_corner_ne`, (9,13) → `water_edge_e`, (86,13) → `water_edge_w`, (90,11) → `water_inner_nw`, (10,14) → `quay_edge_n`, (10,15) → `quay`, (80,28) → `blocked`, (0,12) → `land`, (2,12) → `land_alt`)
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - screenshot appky (`pnpm dev` + Playwright, dočasný skript mimo commitu) so starter parcelou a pobrežím — pozretý, popis v zhrnutí
- do_not_touch: src/sim/**, src/ui/**, data/defs/**, data/maps/**, assets/** (len čítať)
- estimate: M
