# Fáza 0 — Bootstrap · task karty

> Zdroj: `docs/IMPLEMENTATION_PLAN.md` „Fáza 0", formát karty `docs/AGENTIC_WORKFLOW.md` §3, smerovanie §4.
> Vetva: `claude/laughing-galileo-2ctnlq` (pridelená relácii; nahrádza `phase/00-bootstrap` z §6).
> Bootstrap výnimka: agenti z `.claude/agents/` sa načítajú až pri štarte relácie, preto sa karty tejto fázy delegujú cez vstavaného `general-purpose` agenta s explicitným `model:` a telom príslušného agenta z §7 v zadaní.

## Checklist

- [x] T00-01 · Import dokumentácie, `.gitignore`, prvý commit
- [x] T00-02 · Scaffold: Vite react-ts, TS strict, aliasy, závislosti, skripty, ESLint
- [x] T00-03 · Claude Code konfigurácia: settings, agenti, commands, šablóna karty
- [x] T00-04 · `design/tokens.css` z DESIGN_BRIEF §3
- [x] T00-05 · `docs/DECISIONS.md` s ADR-001..006
- [x] T00-06 · Adresáre, barrel `index.ts`, `BACKLOG.md`, `PROGRESS.md`
- [x] T00-07 · Defy `time` + `economy`, JSON schémy, `validate-defs`
- [x] T00-08 · Playwright + boot screenshot
- [x] T00-09 · Sim core: rng, sim-clock, entity-id, event-bus, ring-buffer
- [x] T00-10 · DefRegistry
- [x] T00-11 · `simrun` kostra
- [x] T00-12 · Review `src/sim/**`
- [x] T00-13 · Plná pipeline + triáž
- [x] T00-14 · Uzavretie fázy (PROGRESS, BACKLOG)
- [ ] T00-15 · Hranica `src/sim`: vlastný tsconfig + ESLint allowlist (nález T00-12 #1)
- [ ] T00-16 · `tickGameSeconds` len delitele 60 v schéme aj DefRegistry (nález T00-12 #2)
- [ ] T00-17 · Hranica `src/sim`: zatvoriť obchvaty z re-review T00-15 (triple-slash/declare, eval/Function, aliasy Math/Date)
- [ ] T00-18 · Hranica `src/sim`: zákaz inline `eslint-disable` a `@ts-expect-error` (re-review T00-17)

Vlny: 01 → {02 ‖ 03 ‖ 04 ‖ 05} → {06 ‖ 07 ‖ 08} → 09 → 10 → 11 → 12 → 13 → 14 → {15 ‖ 16} → 17 → 18 (dodatočné karty z review T00-12 a re-review).

---

### T00-01 · Import dokumentácie, `.gitignore`, prvý commit
- model: sonnet
- agent: orchestrátor
- parallel: no
- depends_on: –
- inputs: nahrané súbory CLAUDE1.md, AGENTIC_WORKFLOW.md, IMPLEMENTATION_PLAN.md, ARCHITECTURE.md, DESIGN_BRIEF.md, GDD_2D_Port_Tycoon.pdf
- outputs: CLAUDE.md; docs/{AGENTIC_WORKFLOW,IMPLEMENTATION_PLAN,ARCHITECTURE,DESIGN_BRIEF}.md; docs/GDD_2D_Port_Tycoon.pdf; .gitignore; docs/tasks/phase-00.md
- acceptance:
  - `test -f CLAUDE.md -a -f docs/ARCHITECTURE.md -a -f docs/DESIGN_BRIEF.md -a -f docs/tasks/phase-00.md && git rev-parse HEAD`
- do_not_touch: obsah importovaných dokumentov (kópie 1:1)
- estimate: S

### T00-02 · Scaffold: Vite react-ts, TS strict, aliasy, závislosti, skripty, ESLint
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T00-01
- inputs: IMPLEMENTATION_PLAN „Fáza 0" úlohy 1–2; CLAUDE.md „Stack", „Príkazy", „Tvrdé pravidlá" 1 a 3; ARCHITECTURE §2
- outputs: package.json; pnpm-lock.yaml; tsconfig.json (+ prípadne tsconfig.node.json); vite.config.ts; index.html; src/main.tsx; src/app/app.tsx; eslint.config.js
- požiadavky:
  - `strict: true`; path aliasy `@sim/*`, `@render/*`, `@ui/*`, `@app/*`, `@data/*` v tsconfig aj vo Vite/Vitest; `resolveJsonModule: true`.
  - Vitest `include: ['tests/**/*.test.ts']` (nikdy nie `tests/e2e/**`), `environment: 'node'`.
  - Skripty (všetky naraz, ďalšie karty `package.json` nemenia): `dev`, `build`, `typecheck`, `lint`, `test` (`vitest run`), `test:e2e` (`playwright test`), `validate:defs` (`tsx tools/validate-defs.ts`), `simrun` (`tsx tools/simrun.ts`).
  - Závislosti (všetky naraz): `react@18`, `react-dom@18`, `pixi.js@8`; dev: `typescript@5`, `vite`, `@vitejs/plugin-react`, `vitest`, `@playwright/test@1.56.1` (zhoda s predinštalovaným chromium-1194 v `/opt/pw-browsers`, nič sa nesťahuje), `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `globals`, `ajv`, `tsx`, `@types/node`, `@types/react@18`, `@types/react-dom@18`.
  - `src/app/app.tsx` vykreslí nadpis „Modular Harbor".
  - ESLint pre `src/sim/**`: `no-restricted-imports` (pixi.js, react, react-dom, `@render/*`, `@ui/*`, `@app/*`, relatívne cesty do `src/render|ui|app`); `no-restricted-globals` (window, document); `no-restricted-properties` (Math.random, Date.now, performance.now).
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm build`
  - `echo "import 'pixi.js'; export {}" | pnpm exec eslint --stdin --stdin-filename src/sim/probe.ts` → exit ≠ 0
  - `echo "export const x = Math.random();" | pnpm exec eslint --stdin --stdin-filename src/sim/probe.ts` → exit ≠ 0
  - `echo "export const x = document.title;" | pnpm exec eslint --stdin --stdin-filename src/sim/probe.ts` → exit ≠ 0
- do_not_touch: .claude/**, docs/**, CLAUDE.md
- estimate: M

### T00-03 · Claude Code konfigurácia: settings, agenti, commands, šablóna karty
- model: haiku
- agent: docs-keeper
- parallel: yes
- depends_on: T00-01
- inputs: AGENTIC_WORKFLOW §3, §5, §7, §8; IMPLEMENTATION_PLAN „Šablóny `.claude/commands/`"
- outputs: .claude/settings.json; .claude/agents/{sim-architect,sim-reviewer,implementer,ui-builder,test-writer,test-runner,docs-keeper}.md; .claude/commands/{phase,delegate,review-sim,sim-check,adr,new-cargo,ui-from-design}.md; docs/tasks/_template.md
- požiadavky: obsah agentov, commands a settings **doslova** z fenced blokov zdroja (bez fence riadkov); `balance-analyst.md` sa NEvytvára (až F13). `_template.md` = formát karty §3 s placeholdermi namiesto príkladových hodnôt, pod ním pravidlá kariet 1–4 a vzor bloku „## Výsledok" z §5.
- acceptance (spúšťa test-runner, bash):
  ```bash
  for a in sim-architect sim-reviewer implementer ui-builder test-writer test-runner docs-keeper; do
    diff <(awk -v h="### \`$a.md\`" 'index($0,h)==1{f=1;next} f&&/^```markdown/{p=1;next} p&&/^```$/{exit} p' docs/AGENTIC_WORKFLOW.md) .claude/agents/$a.md || exit 1
  done
  for c in phase delegate review-sim sim-check adr new-cargo ui-from-design; do
    diff <(awk -v h="\`.claude/commands/$c.md\`" 'index($0,h)==1{f=1;next} f&&/^```markdown/{p=1;next} p&&/^```$/{exit} p' docs/IMPLEMENTATION_PLAN.md) .claude/commands/$c.md || exit 1
  done
  diff <(awk '/^## 8\./{f=1} f&&/^```json/{p=1;next} p&&/^```$/{exit} p' docs/AGENTIC_WORKFLOW.md | jq -S .) <(jq -S . .claude/settings.json)
  test ! -f .claude/agents/balance-analyst.md
  for k in model agent parallel depends_on inputs outputs acceptance do_not_touch estimate; do grep -q "^- $k:" docs/tasks/_template.md || exit 1; done
  ```
- do_not_touch: všetko mimo outputs
- estimate: M

### T00-04 · `design/tokens.css` z DESIGN_BRIEF §3
- model: haiku
- agent: docs-keeper
- parallel: yes
- depends_on: T00-01
- inputs: DESIGN_BRIEF §3 (blok ```css, 94 riadkov)
- outputs: design/tokens.css
- acceptance:
  ```bash
  diff <(awk '/^## 3\./{f=1} f&&/^```css/{p=1;next} p&&/^```$/{exit} p' docs/DESIGN_BRIEF.md) design/tokens.css
  ```
- do_not_touch: všetko mimo outputs
- estimate: S

### T00-05 · `docs/DECISIONS.md` s ADR-001..006
- model: opus
- agent: sim-architect
- parallel: yes
- depends_on: T00-01
- inputs: ARCHITECTURE §18 + odkazované §3 (tick), §4.1 (batche), §7.3 (`internalTicks`), §7.6 (soft kongescia), §5.1 (cesty ako vrstva bunky); CLAUDE.md „Stack"; formát `/adr` (IMPLEMENTATION_PLAN „Šablóny")
- outputs: docs/DECISIONS.md
- požiadavky: každý záznam `## ADR-00N: <názov>`, riadok `Stav: prijaté (F0) · Zdroj: ARCHITECTURE §…`, potom `**Kontext:**`, `**Rozhodnutie:**`, `**Alternatívy:**`, `**Dôsledky:**` (každá 1–3 vety, slovensky). Otvorené body §18 (Web Worker, export kontrakty, pôžičky, level crossing, 3D stacky) NIE sú ADR — uveď ich v `adr_candidates` zhrnutia (presunú sa do BACKLOG).
- acceptance:
  - `test "$(grep -c '^## ADR-00[1-6]:' docs/DECISIONS.md)" -eq 6`
  - `for k in Kontext Rozhodnutie Alternatívy Dôsledky; do test "$(grep -c "^\*\*$k:\*\*" docs/DECISIONS.md)" -eq 6 || exit 1; done`
- do_not_touch: docs/ARCHITECTURE.md, všetko mimo outputs
- estimate: S

### T00-06 · Adresáre, barrel `index.ts`, `BACKLOG.md`, `PROGRESS.md`
- model: haiku
- agent: docs-keeper
- parallel: yes (jediný zapisovateľ `src/sim/**` vo svojej vlne)
- depends_on: T00-02
- inputs: CLAUDE.md „Štruktúra repozitára"; IMPLEMENTATION_PLAN „Fáza 0" (checklist); tento súbor
- outputs: src/sim/{core,defs,grid,modules,cargo,logistics,ships,contracts,economy,tech,metrics,commands,events,systems}/index.ts; src/{render,ui,app}/index.ts; data/maps/.gitkeep; data/scenarios/.gitkeep; assets/.gitkeep; design/ui/.gitkeep; tests/sim/.gitkeep; docs/BACKLOG.md; docs/PROGRESS.md
- požiadavky: každý `index.ts` = jednoriadkový hlavičkový komentár (slovensky, čo modul bude obsahovať) + `export {};` — žiadna logika. `PROGRESS.md`: sekcia „Fáza 0" s checklistom úloh z IMPLEMENTATION_PLAN + odkaz na `docs/tasks/phase-00.md`. `BACKLOG.md`: hlavička + prázdne sekcie `P0`, `P1`, `P2`, `Nápady`.
- acceptance:
  - `for d in core defs grid modules cargo logistics ships contracts economy tech metrics commands events systems; do test -f src/sim/$d/index.ts || exit 1; done && for d in render ui app; do test -f src/$d/index.ts || exit 1; done`
  - `test -f docs/BACKLOG.md -a -f docs/PROGRESS.md`
  - `pnpm typecheck && pnpm lint`
- do_not_touch: package.json, src/main.tsx, src/app/app.tsx, .claude/**
- estimate: S

### T00-07 · Defy `time` + `economy`, JSON schémy, `validate-defs`
- model: sonnet
- agent: implementer
- parallel: yes
- depends_on: T00-02
- inputs: ARCHITECTURE §3 (time: `tickGameSeconds` 10, `ticksPerRealSecond` 10, `speeds` [0,1,2,4,8]), §4 (`schemaVersion`, schémy v `data/schemas/*.schema.json`, `pnpm validate:defs`), §4.6 + §9.2 (economy: `startingCashCents` 120000000, `demurrageRateOfRewardPerHour` 0.005, `latePenaltyRateOfRewardPerDay` 0.05, `failAfterDaysLate` 3, `leaseMonthlyRateOfPrice` 0.015, `bankruptcyDays` 30, `offersPerDay` 6, `offerExpiryDays` 2)
- outputs: data/defs/time.json; data/defs/economy.json; data/schemas/time.schema.json; data/schemas/economy.schema.json; tools/validate-defs.ts; tests/tools/validate-defs.test.ts
- požiadavky: `time`/`economy` sú singleton objekty so `schemaVersion: 1` (bez `items[]`); schémy draft 2020-12, `additionalProperties: false`, všetky polia `required`. `validate-defs.ts`: pre každý `data/defs/*.json` nájde `data/schemas/<name>.schema.json` (chýbajúca schéma = chyba), vypíše `OK <súbor>` alebo chyby s JSON pointer cestou, exit 1 pri akejkoľvek chybe. Validačná logika exportovaná ako funkcia (testovateľná bez procesu).
- acceptance:
  - `pnpm validate:defs`
  - `pnpm vitest run tests/tools/validate-defs.test.ts` (vrátane testov „neplatný def → chyba s cestou k poľu" a „def bez schémy → chyba")
- do_not_touch: src/sim/**, package.json, .claude/**
- estimate: M

### T00-08 · Playwright + boot screenshot
- model: sonnet
- agent: implementer
- parallel: yes
- depends_on: T00-02
- inputs: IMPLEMENTATION_PLAN „Fáza 0" posledná úloha + akceptácia; ARCHITECTURE §16 (E2E)
- outputs: playwright.config.ts; tests/e2e/boot.spec.ts
- požiadavky: iba chromium; `webServer` spustí `pnpm dev` (port 5173, `reuseExistingServer: !process.env.CI`); test počká na text „Modular Harbor" a uloží `tests/e2e/__screenshots__/boot.png`.
- acceptance:
  - `pnpm test:e2e && test -s tests/e2e/__screenshots__/boot.png`
  - `pnpm test` (vitest nesmie zachytiť e2e súbory)
- do_not_touch: src/**, package.json, .claude/**
- estimate: S

### T00-09 · Sim core: rng, sim-clock, entity-id, event-bus, ring-buffer
- model: sonnet
- agent: implementer
- parallel: no (single writer `src/sim/**`)
- depends_on: T00-06
- inputs: ARCHITECTURE §3 (`SimClock { tick, speed }`, odvodené minute/hour/day/month, hranice `HourClosed`/`DayClosed`/`MonthClosed`), §5 (World drží `clock`, `events`, `rng`), §12.1 (`EventBus` zbiera readonly DTO za tick, `flush()`), §9.2 (`RingBuffer<T>(capacity)`), §14 (seed v save); CLAUDE.md „Tvrdé pravidlá" 3–4, „Konvencie" (branded ID)
- outputs: src/sim/core/{rng,sim-clock,entity-id,event-bus,ring-buffer}.ts; src/sim/core/index.ts; tests/sim/core/{rng,sim-clock,entity-id,event-bus,ring-buffer}.test.ts
- požiadavky:
  - `Rng`: xoshiro128** (32-bit, `Math.imul`), seed cez splitmix32; `nextU32()`, `next()` ∈ [0,1), `range(min,max)`, `int(min,max)`, `pick(arr)`, `weighted(items, weightOf)`; `getState()`/`setState()` (serializovateľné pre save).
  - `SimClock`: konštanty (ticky/min/hod/deň/mesiac) sa odvodia z `time` defu odovzdaného v konštruktore — žiadne magické čísla; `advance()` vráti/emituje uzavreté hranice hodina/deň/mesiac.
  - `EntityId` branded typ + deterministický `EntityIdAllocator` (serializovateľný stav).
  - `EventBus<E>`: `emit`, `flush(): readonly E[]` (vyprázdni tickový buffer).
  - `RingBuffer<T>`: pevná kapacita, `push`, `toArray` (od najstaršieho), `size`, prepisovanie najstarších.
- acceptance:
  - `pnpm vitest run tests/sim/core`
  - testy „rovnaký seed → rovnakých 1 000 čísel", „rôzne seedy → rôzne sekvencie", referenčný vektor xoshiro128** pre pevný stav, „getState/setState pokračuje identicky", hranice `range`/`int`/`pick`/`weighted`
  - `! grep -rnE 'Math\.random|Date\.now|performance\.now' src/sim`
  - `pnpm typecheck && pnpm lint`
- do_not_touch: src/sim/defs/**, tools/**, package.json, .claude/**
- estimate: M

### T00-10 · DefRegistry
- model: sonnet
- agent: implementer
- parallel: no (single writer `src/sim/**`)
- depends_on: T00-07, T00-09
- inputs: ARCHITECTURE §4 („typované gettery, fail-fast"), §2 (sim importuje len `src/sim` a `data/`); data/defs/{time,economy}.json; data/schemas/*.schema.json
- outputs: src/sim/defs/{def-registry,types}.ts; src/sim/defs/index.ts; tests/sim/defs/def-registry.test.ts
- požiadavky: `TimeDef`, `EconomyDef` typy; `DefRegistry.fromRaw({ time, economy })` validuje štruktúru (povinné polia, typy, `schemaVersion`) a pri chybe vyhodí `DefError` s názvom defu a cestou poľa; typované gettery `time`, `economy`; bez `fs` (prenositeľné do Workera). Pomocná `loadBundledDefs()` cez `@data/defs/*.json` JSON importy.
- acceptance:
  - `pnpm vitest run tests/sim/defs` (vrátane „chýbajúci def → DefError s názvom", „zlý typ poľa → DefError s cestou", „bundled defy sa načítajú")
  - `pnpm typecheck && pnpm lint`
- do_not_touch: src/sim/core/**, tools/**, data/**, package.json, .claude/**
- estimate: M

### T00-11 · `simrun` kostra
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T00-10
- inputs: IMPLEMENTATION_PLAN „Fáza 0" (simrun kostra); ARCHITECTURE §12.2 (scenár = `{ atTick, command }[]`), §16; AGENTIC_WORKFLOW §7 `test-runner` (kľúče reportu)
- outputs: tools/simrun.ts; data/scenarios/smoke.json; tests/tools/simrun.test.ts
- požiadavky: CLI `pnpm simrun <scenario.json> --ticks N [--report]`; scenár `{ id, seed, map?: string, commands: [] }` — mapa sa načíta, ak je uvedená (vo F0 žiadna). `World` vzniká až vo F1 → zatiaľ úzke rozhranie `Tickable { tick(): void }` so stubom nad `SimClock` + `Rng` + `DefRegistry`. Report JSON s finálnymi kľúčmi: `scenario, seed, ticks, cashEnd, exportedUnits, lostUnits, onTimeRate, craneBlockedPct` (neimplementované metriky `null`, `lostUnits` 0). Chýbajúci/nečitateľný scenár → exit 1 so správou.
- acceptance:
  - `pnpm -s simrun data/scenarios/smoke.json --ticks 1000 --report | jq -e '.ticks==1000 and .lostUnits==0'` (`-s` potlačí hlavičku pnpm na stdout, aby výstup bol čistý JSON)
  - `! pnpm simrun data/scenarios/nope.json --ticks 1`
  - `pnpm vitest run tests/tools/simrun.test.ts`
- do_not_touch: src/sim/**, package.json, .claude/**
- estimate: S

### T00-12 · Review `src/sim/**`
- model: opus
- agent: sim-reviewer
- parallel: no
- depends_on: T00-09, T00-10, T00-11
- inputs: celý `src/sim/**`, `tests/sim/**`, `data/defs/**`, `eslint.config.js`
- outputs: tabuľka nálezov + verdikt MERGE / FIX FIRST (bez zmien súborov)
- acceptance:
  - verdikt `MERGE` (0 blocking); blocking → nové karty T00-1x (opus, sim-architect)
- do_not_touch: všetko (read-only)
- estimate: S

### T00-13 · Plná pipeline + triáž
- model: haiku
- agent: test-runner
- parallel: no
- depends_on: T00-03, T00-04, T00-05, T00-06, T00-07, T00-08, T00-09, T00-10, T00-11, T00-12
- inputs: acceptance fázy (IMPLEMENTATION_PLAN „Fáza 0")
- outputs: triáž report (max 20 riadkov)
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs`
  - `pnpm test:e2e && test -s tests/e2e/__screenshots__/boot.png`
  - `pnpm -s simrun data/scenarios/smoke.json --ticks 1000 --report | jq -e .lostUnits==0` → `lostUnits = 0` (namiesto `vertical_slice`, ktorý vznikne vo F5)
  - diff-loopy z T00-03 a T00-04 bez rozdielov
- do_not_touch: všetko (neopravuje)
- estimate: S

### T00-14 · Uzavretie fázy (PROGRESS, BACKLOG)
- model: haiku
- agent: docs-keeper
- parallel: no
- depends_on: T00-13
- inputs: zhrnutia „## Výsledok" všetkých kariet
- outputs: docs/tasks/phase-00.md (checklist); docs/PROGRESS.md; docs/BACKLOG.md
- acceptance:
  - `! grep -n '^- \[ \] T00-' docs/tasks/phase-00.md`
  - `grep -q 'vertical_slice' docs/BACKLOG.md`
- do_not_touch: všetko mimo outputs
- estimate: S

---

## Dodatočné karty z review T00-12 (major nálezy, pred F1)

### T00-15 · Hranica `src/sim`: vlastný tsconfig + ESLint allowlist (nález T00-12 #1)
- model: sonnet
- agent: implementer
- parallel: yes (nemení kód v `src/sim/**/*.ts`; ak by bolo treba, `needs_escalation`)
- depends_on: T00-14
- inputs: BACKLOG P1 „Vynútenie pravidiel 1/3 je denylist…"; ARCHITECTURE §2 („src/sim nesmie importovať nič mimo src/sim a data/"); CLAUDE.md „Tvrdé pravidlá" 1 a 3; eslint.config.js; tsconfig.json; package.json (skripty)
- outputs: src/sim/tsconfig.json; tsconfig.json (ak treba vylúčiť/odkázať); eslint.config.js; package.json (iba skripty `typecheck`, `build`); tests/tools/sim-boundary.test.ts
- požiadavky:
  - Vrstva 1 — kompilátor: `src/sim/tsconfig.json` (extends root) s `lib: ["ES2023"]` a `types: []`, include `src/sim/**/*` (+ JSON z `data/` cez `resolveJsonModule`). Každý DOM/Node globál (`window`, `document`, `self`, `localStorage`, `navigator`, `setTimeout`, `process`, `crypto`, `console`, `structuredClone`…) je v `src/sim` chyba kompilácie. `pnpm typecheck` a `pnpm build` kontrolujú aj tento projekt.
  - Vrstva 2 — ESLint pre `src/sim/**/*.{ts,tsx,mts,cts,js,mjs}`: importy ako **allowlist** (len `@sim/…`, `@data/…` a relatívne cesty, ktoré neopustia `src/sim`; zakázané aj `node:*`, akýkoľvek npm balík a traverzia typu `@sim/../render/x`); `no-restricted-syntax` na `new Date(...)`, `Date(...)` a prístup cez `globalThis.*`; existujúce `no-restricted-properties` (Math.random, Date.now, performance.now) ostávajú.
  - Regresný test `tests/tools/sim-boundary.test.ts` cez ESLint Node API (`new ESLint().lintText(code, { filePath: 'src/sim/core/probe.ts' })`): každý obchvat z nálezu hlási ≥ 1 chybu; legitímne importy (`./x`, `../defs`, `@sim/core`, `@data/defs/time.json`) a bežný kód 0 chýb; mimo `src/sim` (napr. `src/ui/probe.tsx` s `document`) 0 chýb z týchto pravidiel.
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `pnpm vitest run tests/tools/sim-boundary.test.ts`
  - tsc sonda (bash, musí skončiť exit 0 a súbor po sebe zmazať):
    ```bash
    for g in "window" "document.title" "self" "localStorage" "navigator.userAgent" "setTimeout(() => 0, 1)" "process.hrtime()" "crypto.randomUUID()" "structuredClone({})"; do
      printf 'export const x = %s;\n' "$g" > src/sim/__probe__.ts
      if pnpm exec tsc --noEmit -p src/sim/tsconfig.json >/dev/null 2>&1; then echo "LEAK: $g"; rm -f src/sim/__probe__.ts; exit 1; fi
    done; rm -f src/sim/__probe__.ts; echo "tsc boundary OK"
    ```
  - ESLint sondy (každá exit ≠ 0): `new Date()`, `Date()`, `globalThis.Math.random()`, `import 'node:fs'`, `import x from 'lodash'`, `import '@sim/../render/x'`, `import '../../render/x'` cez `pnpm exec eslint --stdin --stdin-filename src/sim/core/probe.ts`
- do_not_touch: src/sim/**/*.ts, tools/**, data/**, tests/sim/**, .claude/**
- estimate: M

### T00-16 · `tickGameSeconds` len delitele 60 v schéme aj DefRegistry (nález T00-12 #2)
- model: sonnet
- agent: implementer
- parallel: yes (disjunktné súbory s T00-15)
- depends_on: T00-14
- inputs: BACKLOG P1 „tickGameSeconds 7/120…"; ARCHITECTURE §3; ADR-002; data/schemas/time.schema.json; src/sim/defs/def-registry.ts; src/sim/core/sim-clock.ts
- outputs: data/schemas/time.schema.json; src/sim/core/sim-clock.ts (iba `export` konštanty `SECONDS_PER_MINUTE`); src/sim/defs/def-registry.ts; tests/sim/defs/def-registry.test.ts; tests/tools/validate-defs.test.ts
- požiadavky:
  - Schéma: `tickGameSeconds` → `enum: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]` (delitele 60; `description` to vysvetlí s odkazom na §3).
  - DefRegistry: rovnaké pravidlo odvodené z exportovanej `SECONDS_PER_MINUTE` (`SECONDS_PER_MINUTE % v === 0`), nie druhý literálny zoznam; chyba = `DefError('time', '/tickGameSeconds', …)`.
  - Test konzistencie: pre každé n ∈ 1..120 platí schema-valid ⇔ registry-valid ⇔ `new SimClock({ tickGameSeconds: n })` nehodí.
- acceptance:
  - `pnpm vitest run tests/sim/defs tests/tools/validate-defs.test.ts` (vrátane „7 → DefError /tickGameSeconds", „120 → DefError", „validate-defs: 7 → chyba s /tickGameSeconds", test konzistencie 1..120)
  - `pnpm validate:defs && pnpm typecheck && pnpm lint && pnpm test`
- do_not_touch: eslint.config.js, tsconfig.json, package.json, src/sim/tsconfig.json, tools/**, data/defs/**, .claude/**
- estimate: S

### T00-17 · Hranica `src/sim`: zatvoriť obchvaty z re-review T00-15
- model: sonnet
- agent: implementer
- parallel: no
- depends_on: T00-15, T00-16
- inputs: re-review T00-15 (sim-reviewer, verdikt FIX FIRST — 3 major + minor rovnakej triedy); eslint.config.js; src/sim/tsconfig.json; tests/tools/sim-boundary.test.ts; CLAUDE.md „Tvrdé pravidlá" 1 a 3
- outputs: eslint.config.js; src/sim/tsconfig.json; tests/tools/sim-boundary.test.ts; (nový) tests/tools/sim-tsconfig.test.ts
- požiadavky (selektory overené reviewerom sondou):
  1. Triple-slash a ambientné deklarácie (major): pre sim súbory `@typescript-eslint/triple-slash-reference: ['error', { lib: 'never', path: 'never', types: 'never' }]`; do `no-restricted-syntax` `TSModuleDeclaration[global=true]`, `TSModuleDeclaration[declare=true]`, `VariableDeclaration[declare=true]`, `TSDeclareFunction`, `ClassDeclaration[declare=true]`.
  2. Vyhodnotenie kódu (major): `no-eval`, `no-new-func`, `no-implied-eval`; `eval` a `Function` medzi zakázané globály; selektor `MemberExpression[property.name='constructor']`.
  3. Aliasy (major): `Identifier[name='Math']:not(MemberExpression > Identifier.object)` a `Identifier[name='Date']:not(TSTypeReference > Identifier, MemberExpression[property.name='UTC'] > Identifier.object, MemberExpression > Identifier.property, Property > Identifier.key)` — `Date` ako typ, `Date.UTC`, `Math.max`/`Math.imul` ostávajú povolené; pokryť aj `Reflect.construct(Date, …)`, `Object(Date)` a `Object.getOwnPropertyDescriptor(Math, …)` (vyplynie z pravidla na holý identifikátor).
  4. Nedeterministické API (minor): `Intl`, `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`, `Atomics` medzi zakázané globály; `localeCompare` a `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString` do `no-restricted-properties` (akýkoľvek objekt).
  5. Typy súborov (minor): v `src/sim` len `.ts` — zo sim globov vyradiť `tsx`/`js`/`mjs`/`cts`/`mts` a pridať test, ktorý zlyhá, ak v `src/sim/**` existuje iný než `.ts` súbor (okrem `tsconfig.json`).
  6. Regresný test vrstvy 1 (minor): `tests/tools/sim-tsconfig.test.ts` overí, že `src/sim/tsconfig.json` má `lib` bez `DOM*` a `types: []`, a spustí `tsc --noEmit -p` nad dočasnou fixtúrou s `window` (očakáva chybu) — dočasné súbory mimo `src/sim` alebo vždy zmazané v `afterAll`.
  7. Do tabuľky VIOLATIONS v `sim-boundary.test.ts` doplniť všetky sondy z bodov 1–4 a do povolených `Date` ako typ, `Date.UTC(…)`, `Math.max(…)`, `Math.imul(…)`.
- acceptance:
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `pnpm vitest run tests/tools/sim-boundary.test.ts tests/tools/sim-tsconfig.test.ts`
  - ESLint sondy (každá exit ≠ 0) cez `pnpm exec eslint --stdin --stdin-filename src/sim/core/probe.ts`: `/// <reference lib="dom" />`, `declare global { var x: number }`, `declare const fetch: any;`, `eval('1')`, `Function('return this')()`, `(() => 0).constructor('return this')()`, `const m = Math; m.random();`, `const D = Date; new D();`, `new Intl.DateTimeFormat()`, `'a'.localeCompare('b')`
  - ESLint (exit 0): `export const t: Date | null = null;`, `export const u = Date.UTC(2020, 0, 1);`, `export const m = Math.max(1, 2);`
- do_not_touch: src/sim/**/*.ts, tools/**, data/**, package.json, .claude/**
- estimate: S

### T00-18 · Hranica `src/sim`: zákaz inline `eslint-disable` a `@ts-expect-error` (re-review T00-17)
- model: sonnet
- agent: orchestrátor (S karta)
- parallel: no
- depends_on: T00-17
- inputs: re-review T00-17 (sim-reviewer, verdikt FIX FIRST — 1 major: inline `eslint-disable` vypne vrstvu 2; minor: `@ts-expect-error` + neznámy globál prejde oboma vrstvami, `declare enum`); eslint.config.js; tests/tools/sim-boundary.test.ts
- outputs: eslint.config.js; tests/tools/sim-boundary.test.ts
- požiadavky: v sim bloku `linterOptions: { noInlineConfig: true }`; `@typescript-eslint/ban-ts-comment` s `'ts-expect-error': true` (len src/sim); selektor `TSEnumDeclaration[declare=true]`; do zakázaných globálov `fetch`, `queueMicrotask`, `setImmediate`, `clearTimeout`, `clearInterval`, `global`, `Buffer`; sondy do testu.
- acceptance:
  - `pnpm vitest run tests/tools/sim-boundary.test.ts && pnpm typecheck && pnpm lint && pnpm test`
  - ESLint sondy (exit ≠ 0) cez `--stdin-filename src/sim/core/probe.ts`: `// eslint-disable-next-line` + `Math.random()`, `/* eslint-disable */` + `Math.random()`, `/* eslint no-restricted-syntax: off */` + `new Date()`, `// @ts-expect-error` + `fetch('x')`, `declare enum E { A }`
  - ESLint (exit 0): `export enum E { A }`, `export const enum F { B }`
- do_not_touch: src/sim/**/*.ts, všetko mimo outputs
- estimate: S
