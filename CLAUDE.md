# Modular Harbor — 2D Port Tycoon

Tento súbor čítaš na začiatku každej relácie. Je zámerne krátky; detaily sú v `docs/`.

## Čo staviame
2D top-down tycoon/management simulátor prístavu. Hráč prijíma kontrakty na prekládku, lode sa
vykladajú žeriavmi, tovar **fyzicky** putuje vozidlami do skladov a odchádza kamiónmi/vlakmi
z mapy. Zisk a XP → expanzia, prenájmy, výskum. Zdroj pravdy pre dizajn: `docs/GDD_2D_Port_Tycoon.pdf`.

Tri neporušiteľné princípy z GDD:
1. **Nič sa neteleportuje** — každá jednotka nákladu má vždy presne jednu fyzickú polohu.
2. **Grid + moduly** — všetko sa stavia na mriežke; pobrežie je statické (od F12 len drahé mólo/zásyp, ADR-028).
3. **Jedna mena (USD), rozhodovanie nad dátami** — hra meria a zobrazuje metriky.

## Dokumenty (čítaj v tomto poradí pri začiatku fázy)
1. `docs/ARCHITECTURE.md` — vrstvy, doménový model, tick pipeline, algoritmy, pravidlá, vzorce.
2. `docs/IMPLEMENTATION_PLAN.md` — fázy 0–13 s úlohami a akceptačnými kritériami. Pracuj **len na aktuálnej fáze**.
3. `docs/DECISIONS.md` — ADR log (jeden odsek na rozhodnutie). Založ ho vo fáze 0.
4. `docs/DESIGN_BRIEF.md` — vizuálny jazyk, tokeny, názvy assetov (pri integrácii grafiky/UI).
5. `docs/AGENTIC_WORKFLOW.md` — roly agentov, smerovanie modelov, task karty, eskalácia. **Záväzné pre každú delegáciu.**
6. `docs/TERMINAL_2.md` — prestavba prevádzky prístavu (fázy R1–R7, ADR-036). **Záväzná od R1**; grafika podľa `docs/CLAUDE_DESIGN_TERMINAL_2.md`.

## Stack (rozhodnuté, nemeň bez ADR)
| Vrstva | Voľba | Prečo |
|---|---|---|
| Jazyk | TypeScript 5.x, `strict: true` | typová bezpečnosť simulácie, najlepšia podpora v Claude Code |
| Sim core | čistý TS v `src/sim/` — **žiadne DOM/Pixi/React importy** | testovateľné v Node, deterministické, prenositeľné (Worker, Godot) |
| Render sveta | PixiJS v8 (WebGL/WebGPU) v `src/render/` | tisíce spritov, kamera, zoom, vrstvy |
| UI | React 18 + CSS custom properties z `design/tokens.css` v `src/ui/` | dátovo bohaté panely, grafy (vlastné SVG), priama reuse návrhov z Claude Design |
| Build | Vite | rýchly dev loop, jeden `index.html` |
| Testy | Vitest (unit + scenáre), Playwright (smoke + screenshoty) | Claude Code si vie výsledok **sám overiť** |
| Desktop | Tauri (až fáza 13) | voliteľné balenie |

## Štruktúra repozitára
```
src/sim/        core: world, grid, modules, cargo, logistics, ships, contracts, economy, tech, metrics, commands, events
src/render/     PixiJS: WorldRenderer, vrstvy, view-classes (ModuleView, ShipView, VehicleView…), kamera, overlays
src/ui/         React: HUD, BuildBar, ContractsPanel, ModuleInspector, FinancePanel, TechTree, StatsPanel, Toasts
src/app/        bootstrap: GameLoop (fixed tick), SimBridge (snapshot/events → render+UI), InputController, Save/Load
data/defs/      JSON definície: cargo_types, modules, ships, vehicles, tech_tree, contract_templates, time, economy, infrastructure, logistics
data/maps/      mapy (terén, parcely, portály, sea lane)
data/scenarios/ skriptované scenáre pre `simrun` a testy
assets/         SVG/PNG z Claude Design + assets/manifest.json
design/         tokens.css, HTML prototypy UI z Claude Design (referencia, nie runtime)
tools/          simrun.ts (headless scenario runner), validate-defs.ts (JSON schéma), gen-atlas.ts
tests/          vitest scenáre (tests/sim/**), Playwright (tests/e2e/**)
docs/           GDD, ARCHITECTURE, IMPLEMENTATION_PLAN, DESIGN_BRIEF, AGENTIC_WORKFLOW, DECISIONS, BACKLOG, PROGRESS, tasks/phase-NN.md
.claude/        commands/ (slash príkazy), agents/ (subagenti s explicitným model:), settings.json (opusplan, hooky, permissions)
```

## Príkazy
```bash
pnpm install
pnpm dev                      # Vite dev server (http://localhost:5173)
pnpm test                     # vitest — MUSÍ byť zelené pred každým commitom
pnpm test:e2e                 # playwright smoke: načíta hru, spraví screenshot do tests/e2e/__screenshots__/
pnpm simrun data/scenarios/vertical_slice.json --ticks 30000 --report   # headless beh, vypíše metriky
pnpm validate:defs            # JSON schémy pre data/defs/*.json
pnpm lint && pnpm typecheck
```
Po vizuálnych zmenách spusti `pnpm test:e2e` a **pozri si screenshot** (Read na PNG) — nespoliehaj sa len na to, že build prešiel.

## Tvrdé pravidlá
1. **Sim/Presentation split.** Hranica `src/sim/` má tri vrstvy (ADR-007): `src/sim/tsconfig.json` bez DOM/Node typov; ESLint allowlist importov (len `@sim/…`, `@data/…` a relatívne v rámci `src/sim`) + zákazy obchvatov (DOM/Node globály, `eval`, inline `eslint-disable`, `@ts-*` komentáre); v `src/sim` len `.ts`. Lint chybu v `src/sim` oprav v kóde, nikdy ju neumlčuj. Prezentácia sim iba číta (snapshot + events) a posiela `Command`.
2. **Žiadna teleportácia.** Poloha nákladu sa mení výhradne cez `CargoLedger.move(unitId, newLocation)`, ktorý overí povolený prechod (ARCHITECTURE §7.1) a emitne `CargoMoved`. Invariant `assertCargoConservation(world)` beží v každom scenárovom teste.
3. **Determinizmus.** Fixný tick, jediný `Rng` (xoshiro128**, seed v save). Zakázané: `Math.random`, `Date.now`, `performance.now` v `src/sim/`.
4. **Data-driven.** Žiadne magické čísla v kóde; všetko z `data/defs/*.json` cez typované `Def` rozhrania + JSON schéma. Nová hodnota = def + schéma + default.
5. **Command pattern.** Hráčov vstup = `Command` → `validate(world): ValidationResult` → `apply(world)`. UI volá `validate` na živý ghost, `apply` iba po úspešnej validácii. Príkazy sú serializovateľné (replay).
6. **Každá zmena v sime = test** (unit + scenár, ak mení tok nákladu/peňazí).
7. **Rozšírenia cez triedy a defy, nie switch-e.** Nový náklad/modul = nová trieda (`extends StorageModule` / `CraneModule` / `LandExportModule`) + JSON def + registrácia v `ModuleRegistry`. Checklist: ARCHITECTURE §17.
8. **Nerozširuj scope fázy.** Nápady/problémy mimo fázy → `docs/BACKLOG.md`.

## Konvencie
- Súbory `kebab-case.ts`, typy/triedy `PascalCase`, funkcie/premenné `camelCase`, konstanty `UPPER_SNAKE` len pre skutočné konstanty.
- ID: branded typy (`type EntityId = number & { __brand: 'EntityId' }`), def id sú `snake_case` stringy (`container_yard_small`).
- Jeden systém = jeden súbor v `src/sim/systems/`; poradie volania je v `World.tick()` (ARCHITECTURE §6) — nemeň bez ADR.
- Stavové automaty ako `type State = 'idle' | 'to_pickup' | …` + explicitná `transition()` tabuľka; žiadne skryté prechody.
- React: funkčné komponenty, žiadne globálne store knižnice — UI číta `useSimSnapshot()` (SimBridge), zapisuje `dispatch(command)`.
- Commity: `feat(sim): …`, `feat(render): …`, `feat(ui): …`, `data: …`, `test: …`, `docs: …`. Malé, po každom zelenom `pnpm test`.
- Jazyk: kód a identifikátory anglicky, komentáre a dokumenty slovensky.

## Agentický režim a modely (detail: `docs/AGENTIC_WORKFLOW.md`)
Hlavná relácia beží na `opusplan` (Opus plánuje, Sonnet vykonáva) a správa sa ako **orchestrátor**: rozloží fázu na task karty v `docs/tasks/phase-NN.md` a deleguje ich subagentom z `.claude/agents/`. Smerovanie:
- **Opus** → plán fázy, dekompozícia, ADR, simulačné jadro (`src/sim/systems/**`, FSM, dispatcher, A*, `CargoLedger`, vzorce), review pred merge, debugging nedeterminizmu/straty nákladu. Agenti: `sim-architect`, `sim-reviewer`.
- **Sonnet** → implementácia podľa hotového návrhu: render, React z prototypov, defy/schémy/mapy/scenáre, tooling, scenárové testy, refactoring pod testami. Agenti: `implementer`, `ui-builder`, `test-writer`, `balance-analyst`.
- **Haiku** → beh a triáž testov/lintu/`simrun`, `PROGRESS.md`/`BACKLOG.md`, boilerplate, tabuľkové testy z presnej tabuľky, prieskum kódu. Agenti: `test-runner`, `docs-keeper`, vstavaný `Explore`.
Pravidlá: `src/sim/**` edituje naraz len jeden agent; karta je hotová len po prejdení všetkých `acceptance` príkazov; Haiku logiku neopravuje — reportuje; Sonnet po 2 neúspechoch alebo pri dotyku `do_not_touch` eskaluje na Opus; Opus nečíta surové výstupy testov — dostáva zhrnutie od `test-runner`.

## Pracovný postup pre fázu
1. `/phase N` → prečítaj fázu v pláne, zapni **plan mode**, rozlož ju na task karty (model + agent + acceptance pre každú), počkaj na schválenie.
2. Poradie kariet: defs (JSON + schéma) → sim (triedy + unit testy, `sim-architect`) → scenárový test (`test-writer`) → render → UI → `simrun` + e2e screenshot. Nezávislé karty mimo `src/sim` bež paralelne (worktree).
3. Po každej karte `test-runner` → zhrnutie → `docs-keeper` odškrtne. Na konci fázy `sim-reviewer` (0 blocking), ADR-y, `/sim-check`, krátke zhrnutie čo funguje / čo nie.
4. Ak plán odporuje GDD alebo je nejasný, **spýtaj sa** — nehádaj.

## Slash príkazy projektu (`.claude/commands/`, vytvor vo fáze 0)
- `/phase N` — načíta fázu N, spustí plan mode, vytvorí task karty v `docs/tasks/phase-NN.md` a checklist v `docs/PROGRESS.md`.
- `/delegate T03-04` — pošle kartu jej agentovi/modelu podľa karty, po návrate spustí `test-runner` a `docs-keeper`.
- `/review-sim` — spustí `sim-reviewer` (Opus, read-only) nad `src/sim/**`; verdikt MERGE / FIX FIRST.
- `/sim-check` — cez `test-runner` (Haiku): `typecheck` + `lint` + `test` + `validate:defs` + `simrun vertical_slice`; zhrnie metriky (peniaze, exportované jednotky, stratené jednotky = musí byť 0).
- `/adr "názov"` — pridá ADR do `docs/DECISIONS.md` (kontext, rozhodnutie, dôsledky).
- `/new-cargo <id>` — prevedie checklistom z ARCHITECTURE §17 pre nový typ nákladu.
- `/ui-from-design <súbor>` — prevedie HTML prototyp z `design/` na React komponent s tokenmi.

## Čo NEROBIŤ
- Premium meny, loot boxy, duálne meny (GDD: jedna mena).
- Úprava terénu/pobrežia hráčom mimo mola/zásypu z ADR-028 (a tie až od F12).
- Fyzikálne kolízie (hmotnosti, odrazy) — doprava je diskrétne obsadenie pruhových slotov, vozidlá cez seba **neprechádzajú** (ADR-037).
- Kreslenie ľudí (šoféri, technici, chodci) — ich činnosť je len čas a stav, v UI text (ADR-036).
- Multiplayer, modding API, lokalizácia, Steam — nič z toho pred fázou 13.
