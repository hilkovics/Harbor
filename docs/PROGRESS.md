# PROGRESS.md — Modular Harbor

Stav fáz a checklist medzi reláciami. Detail kariet: `docs/tasks/phase-NN.md`.

## Fáza 0 — Bootstrap
Karty: `docs/tasks/phase-00.md`

- [x] `pnpm create vite` (react-ts), `strict: true`, path aliasy `@sim/*`, `@render/*`, `@ui/*`, `@app/*`, `@data/*`.
- [x] Nainštalovať `pixi.js@8`, `vitest`, `@playwright/test`, `eslint` + `no-restricted-imports` pravidlo pre `src/sim/**` (zákaz `pixi.js`, `react`, `@render`, `@ui`, `window`, `document`).
- [x] Adresáre podľa `CLAUDE.md`; prázdne `index.ts` barrel súbory; `docs/DECISIONS.md` (ADR-001..006 z §18), `docs/BACKLOG.md`, `docs/PROGRESS.md`.
- [x] `data/defs/time.json`, `economy.json` + JSON schémy + `tools/validate-defs.ts` (`ajv`).
- [x] `src/sim/core/rng.ts` (xoshiro128**, `range`, `pick`, `weighted`), `sim-clock.ts`, `entity-id.ts`, `event-bus.ts`, `ring-buffer.ts`.
- [x] `src/sim/defs/def-registry.ts` — typované načítanie všetkých defov, fail-fast.
- [x] `tools/simrun.ts` kostra (načíta mapu + scenár, `world.tick()` N×, vypíše JSON report).
- [x] `.claude/commands/{phase,delegate,review-sim,sim-check,adr,new-cargo,ui-from-design}.md` (šablóny nižšie), `.claude/settings.json` (`"model": "opusplan"`, permissions allowlist, hooky — presné znenie v AGENTIC_WORKFLOW §8).
- [x] `.claude/agents/{sim-architect,sim-reviewer,implementer,ui-builder,test-writer,test-runner,docs-keeper}.md` — obsah **doslova** z AGENTIC_WORKFLOW §7 (každý s explicitným `model:`). `balance-analyst` až vo F13.
- [x] `docs/tasks/` adresár + `docs/tasks/_template.md` (formát task karty z AGENTIC_WORKFLOW §3); prvá reálna sada kariet vznikne až vo F1.
- [x] Playwright config so screenshotom `tests/e2e/__screenshots__/boot.png`.

Akceptácia: `pnpm typecheck && pnpm lint && pnpm test && pnpm validate:defs` zelené; `pnpm test:e2e` uloží screenshot prázdnej stránky s textom „Modular Harbor"; Rng test: rovnaký seed → rovnaká sekvencia 1 000 čísel.

Stav: **hotová** · vetva `claude/laughing-galileo-2ctnlq`
- typecheck, lint, test (205 testov), validate:defs, simrun smoke (lostUnits 0), test:e2e — zelené (T00-13)
- sim-reviewer: MERGE, 0 blocking, 2 major + 10 minor → BACKLOG (T00-12)
- boot.png prezretý orchestrátorom
- Odchýlky od plánu: simrun používa `data/scenarios/smoke.json` namiesto `vertical_slice` (vznikne vo F5); `World` je zatiaľ stub v tools/simrun.ts (F1).
