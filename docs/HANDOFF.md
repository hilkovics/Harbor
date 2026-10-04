# Handoff: Modular Harbor (2D port tycoon), stav k 2026-10-01

> Report pre agenta, ktorý preberá prácu bez kontextu predchádzajúcich relácií.

## 1. Projekt a kde začať
- **Repo:** `hilkovics/Harbor`, lokálne `/home/user/Harbor`.
- **Čo to je:** 2D top-down tycoon kontajnerového prístavu. TypeScript strict, PixiJS 8 (render), React 18 (UI), Vite, Vitest, Playwright, pnpm.
- **Čítaj v tomto poradí:**
  1. `CLAUDE.md` (tvrdé pravidlá a workflow, záväzné),
  2. `docs/ARCHITECTURE.md`,
  3. `docs/IMPLEMENTATION_PLAN.md` (fázy),
  4. `docs/DECISIONS.md` (ADR-001 až 032),
  5. `docs/AGENTIC_WORKFLOW.md`,
  6. `docs/PORT_OPERATIONS.md` (doménový model terminálu: import, export, prázdne kontajnery, prekládka),
  7. `docs/PROGRESS.md`, `docs/BACKLOG.md`, `docs/tasks/phase-NN.md`.
- **Jazyk:** dokumenty, komentáre aj komunikácia s používateľom sú po slovensky, kód je po anglicky.

## 2. Čo je hotové (fázy 0–6 vrátane vloženej 5b)
**Herná slučka importu:**
1. Hráč prijme kontrakt z denného poolu.
2. V stanovenom čase pripláva loď.
3. STS žeriav kladie kontajnery na apron (8 slotov).
4. Straddle carrier ich vozí do skladu, potom na rampu.
5. Kamión prejde bránou (fronta) a stojiskom, zacúva k docku rampy, naloží kontajner a odíde z mapy (`exported`).

**Ďalšie hotové časti:**
- **Ekonomika:** `Economy.post`, ledger, denné a mesačné súhrny, údržba, mzdy, demurrage, penalizácia za meškanie, fail, XP, bankrot.
- **Lode:** bez prekrývania, s rezerváciou trás, A* po vode, stavmi `arriving` a anchorage a kontrolou dosiahnuteľnosti kotviska pri prijatí kontraktu.
- **Mapa** `harbor_01` má móla, mierka je 1 bunka = 64 px ≈ 6 m.
- **Ukladanie:** obálka SaveGame v1 v app vrstve, sloty v localStorage, autosave po `DayClosed`, export/import JSON, Ctrl+S, overlay Nastavenia.
- **Formát savu:** WorldState je teraz **v7** s migráciami v1→v7.
- **Nástroje:**
  - `pnpm simrun <scenár> --ticks N --report [--hash] [--roundtrip-at N]`,
  - `pnpm bench`,
  - `pnpm validate:defs` (vrátane krížovej kontroly voči `assets/manifest.json`).
- **Referenčné metriky** (`simrun data/scenarios/vertical_slice.json --ticks 30000`): cash 41 790 000, exported 78, lost 0, onTime 1, `stateHash` **6ead4b16**. Hash sa zmenil v T6A-01 iba kvôli tvaru v7, metriky ostali rovnaké.
- **Testy:** `pnpm test` 7439 zelených, `pnpm test:e2e` 37/37 (~9,4 min).
- **Hrateľná verzia:** artefakt https://claude.ai/artifact/8BD3ERiicsfCngnbZHc2qw.
  - Build: `pnpm exec vite build --base ./ --outDir <dir>`.
  - Stránka `harbor.html` je `index.html` bez `<!doctype>`, `<html>`, `<head>` a `<meta>`, s vloženým `<style>` a `<div id="root">`. Súbory `assets/*` idú cez `files` s `root`.
  - V novej relácii najprv urob `Artifact read` s touto URL, potom publikuj s parametrom `url`.

## 3. Vetvy a PR (stack, zlučuje výhradne používateľ)
| PR | head → base |
|---|---|
| hilkovics/Harbor#1 | `claude/laughing-galileo-2ctnlq` → `main` (F0) |
| #2, #3, #4 | `phase/01-grid-roads`, `phase/02-berth-ship-crane`, `phase/03-vehicles-yard` (reťaz) |
| #5 | `phase/04-export-trucks` → `main` (súhrn F0–4) |
| #6 | `phase/05-contracts-vertical-slice` (F5, míľnik M1) |
| #7 | `phase/05b-playtest-feedback` → `phase/05-…` |
| #8 | `phase/06-save-load` → `phase/05b-…` |
| #9 | **`phase/06a-export-booking`** → `phase/06-…` ← aktuálna práca (PR vytvorený z UI) |

Nikdy PR neschvaľuj ani nezlučuj, nerob force-push ani rebase na cudzích vetvách a nerob prázdne commity. Na PR #7 a #8 je zapnutý odber udalostí; hodinové self check-iny sú zrušené.

## 4. Aktuálna práca: Fáza 6a (export a booking)
- **Karty:** `docs/tasks/phase-06a.md`. Obsahuje rozhodnutia orchestrátora 1–15 a sekciu „Spoločné rozhrania“, ktorú doplnil T6A-01.
- **Hotové T6A-01** (commity 6c703bc, 8748b36, 1c15f2c, pushnuté):
  - ADR-032 s modelom exportu;
  - kostra v `src/sim`: polia `CargoUnit` (`direction`, `voyageId`, `weightClass`, `hold`), konečný stav `shipped`, reverzný reťazec ledgera, misia kamióna, `crane.cycle`, `ship.lashingTicksLeft`, 12 nových udalostí;
  - WorldState v7 a migrácia v6→v7.
  - Export zatiaľ **nemá správanie**: kroky `lashing` a `unloading` zámerne vyhodia chybu.
- **Odchýlky T6A-01 od kariet** (sú v ADR-032):
  - voyage je iba kľúč `VoyageId` s odvodeným pohľadom, nie samostatný záznam;
  - stowage plán sa neukladá, počíta sa podľa (váha, id);
  - výplata exportu je pomerná k počtu naložených jednotiek;
  - pre penalizácie je nová udalosť `BookingPenaltyApplied`;
  - `ContractState` ani `CraneState` sa nerozšírili.
- **Ďalší krok:**
  - paralelne vo worktree **T6A-02** (defy a schémy), **T6A-03** (TDD scenár `export_roundtrip`), **T6A-06** (render), **T6A-07** (UI a app), **T6A-08** (simrun metriky);
  - potom sekvenčne **T6A-04** a **T6A-05** (správanie exportu v sime, agent sim-architect);
  - **T6A-09** review, **T6A-10** e2e + plná pipeline + artefakt, **T6A-11** dokumentácia a PR.
- **Riziká, ktoré T6A-01 pomenoval:**
  - booking šablóny zmenia obsah import ponúk (zmení sa `stress_f6`);
  - invariant ponúk treba rozdeliť na import a booking;
  - počty na palube a na stagingu musia brať do úvahy smer;
  - `removeShip` vyžaduje najprv presun jednotiek do `shipped`.
- **Po 6a:** 6c (prázdne kontajnery a prekládka; spolu so 6a míľnik M2), potom 7, 8, 9, 10, 10a, 11, 12, 13 a voliteľná 14 (stohy a rehandling na úplný koniec, rozhodol používateľ).

## 5. Pracovný režim (dohoda s používateľom)
- **Autonómny orchestrátor:** pokračuj bez čakania, overuj, commituj, pushuj, otváraj PR pre každú fázu. Plánovanie a rozhodnutia sú delegované, plan mode sa neschvaľuje.
- **Úsporný režim:** používateľ je na **95 % týždenného limitu** a požiadal o zastavenie. **Nespúšťaj prácu, kým nenapíše „pokračuj“.**
  - Málo priebežných správ, plná e2e iba raz za fázu.
  - Behy testov a triáž: Haiku `test-runner`. Odškrtávanie: `docs-keeper`.
  - Opus iba na simuláciu, ADR a review. Render, UI, defy a testy robí Sonnet.
- **Každý commit končí riadkami:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HBsgKtcN59gNaF76NLvHNz
  ```
- **Telo PR končí:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, prázdny riadok, URL relácie.
- **GitHub komentáre končia:** `---\n_Generated by [Claude Code](https://claude.ai/code)_`.
- **Rozpracovanú prácu agentov necommituj.** Stop hook hlási necommitnuté zmeny, odpovedz bez commitu. Commituje sa až po zelenom `pnpm test`.

## 6. Známe pasce
- **Worktree agenti** (`implementer` a `ui-builder` majú `isolation: worktree`) dostanú worktree zo starého `main` (b60e4b9). Prvý krok v prompte musí byť `git reset --hard <aktuálny HEAD fázovej vetvy>`.
- **Agent bez izolácie** (napríklad `general-purpose` s `model: sonnet`) smie pracovať v hlavnom checkoute alebo v ručne založenom worktree.
- **V `src/sim` smie naraz písať iba jeden agent.** Worktree karty doň nesiahajú.
- **Playwright** si spúšťa vlastný dev server. Obsadený port 5173 znamená chybu, s `PW_REUSE_SERVER=1` sa server zdieľa.
  - Nespúšťaj e2e súbežne s `pnpm test`.
  - Nezabíjaj ho cez `timeout`, zostane osirotený server.
  - Na skrátenie čakania v e2e existuje `window.__sim.advance(ticks)`.
- **Pri chybe 529 (Overloaded)** agent spadne; obnov ho cez `SendMessage` na jeho id.
- **Testy závislé od balansu** si pripínajú staré hodnoty cez `LEGACY_CAPACITY_DEFS` (apron 4, staging 2). Očakávania neprepisuj.
- **Otvorené P1** (`docs/BACKLOG.md`, návrh v ADR-031):
  - vozidlo v `no_path` sa nevráti do depa;
  - kamión v `no_path` drží stojisko.
