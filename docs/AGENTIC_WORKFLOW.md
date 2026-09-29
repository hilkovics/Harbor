# AGENTIC_WORKFLOW.md — Modular Harbor (roly agentov a smerovanie modelov)

> Ako Claude Code na tomto projekte deleguje prácu medzi modely. Cieľ: **Opus premýšľa, Sonnet stavia, Haiku overuje a upratuje.**
> Aliasy `opus`, `sonnet`, `haiku` v Claude Code ukazujú vždy na aktuálnu generáciu (dnes Opus 5.5, Sonnet 5.5, Haiku 4.5) — používaj aliasy, nie pinované ID, aby projekt nezostarol. Alias `fable` (Fable 5.1) je voliteľný „upgrade" pre plan mode v najťažších fázach, ak ho máš v pláne dostupný.

---

## 1. Prečo takto

| Model | Silná stránka | Na projekte robí | Nerobí |
|---|---|---|---|
| **Opus** (`opus`) | dlhé uvažovanie, architektúra, nájdenie neočividných chýb | plán fázy, dekompozícia na task karty, návrh a implementácia simulačného jadra (`src/sim/systems/**`, FSM, dispatcher, A*, `CargoLedger`, vzorce), ADR, review pred merge, debugging nedeterminizmu / straty nákladu | nespúšťa testy a nečíta ich výstup (plytvá kontextom) — dostane 10-riadkové zhrnutie od Haiku |
| **Sonnet** (`sonnet`) | rýchla, spoľahlivá implementácia podľa jasného zadania | všetko s hotovým návrhom: render view, React komponenty z HTML prototypov, JSON defy + schémy, autotile, tooling (`simrun`, `gen-atlas`), scenárové a invariantové testy, refactoring pod testami, balans batch | nemení poradie `World.tick()`, tabuľku prechodov `CargoLedger`, ani nezakladá nový systém bez task karty od Opusu |
| **Haiku** (`haiku`) | lacný, rýchly, dobrý na mechanické a čítacie úlohy | beh `typecheck/lint/test/validate:defs/simrun` + **triáž** (čo padlo, prvý stack frame, pravdepodobný súbor), aktualizácia `PROGRESS.md`/`BACKLOG.md`/checklistov, generovanie boilerplate a barrel súborov, tabuľkové unit testy z presne zadanej tabuľky vstup→výstup, prieskum kódu (vstavaný `Explore` agent už beží na Haiku) | neopravuje logiku; ak test padá kvôli správaniu, vráti report a eskaluje |

Testovanie má dve polovice: **navrhnúť** test, ktorý odhalí skutočnú chybu (Sonnet, pri invariantoch/scenároch aj Opus), a **spustiť a vyhodnotiť** (Haiku). Preto „Haiku na testovanie" znamená test-runner a triáž, nie autor scenárových testov.

---

## 2. Hlavná relácia (orchestrátor)

- Nastavenie v `.claude/settings.json`: `"model": "opusplan"` → v plan mode beží Opus, po schválení plánu prepne na Sonnet. Toto je predvolený režim pre väčšinu fáz.
- Pre fázy s ťažkým simulačným jadrom (2, 3, 5, 9, 12) spusti reláciu `claude --model opus` (alebo `/model opus`), alebo nechaj `opusplan` a deleguj jadro na `sim-architect` (Opus subagent). Druhá možnosť je lacnejšia, lebo Opus dostane len úzky kontext.
- Orchestrátor **nikdy nekóduje sám dlhšie ako jednu task kartu**. Jeho práca je: prečítať fázu → rozložiť na karty → delegovať → zlúčiť → dať zreviewovať → uzavrieť.
- Kontext orchestrátora obsahuje len: `CLAUDE.md`, sekciu fázy, task karty a **zhrnutia** od subagentov. Nikdy plné výstupy testov, nikdy celé súbory, ktoré netreba meniť. Pri ~50 % kontextu `/compact` so zhrnutím stavu kariet.

---

## 3. Task karta — jednotka delegovania

Orchestrátor zapíše karty do `docs/tasks/phase-NN.md` **pred** prvou delegáciou. Každá karta:

```markdown
### T03-04 · Dispatcher: inbound joby apron → sklad
- model: opus            # opus | sonnet | haiku
- agent: sim-architect   # kto to vykoná
- parallel: no           # yes = môže bežať súbežne s inými kartami (worktree)
- depends_on: T03-02, T03-03
- inputs: ARCHITECTURE §7.3 kroky 1 a 3, §7.7; src/sim/logistics/{transport-job,storage-allocator}.ts
- outputs: src/sim/systems/dispatcher.ts; tests/sim/dispatcher.test.ts
- acceptance:
  - `pnpm vitest run tests/sim/dispatcher.test.ts` zelené
  - test „nepriradí job nekompatibilnému vozidlu" a „vyberie bližší sklad"
  - `pnpm simrun data/scenarios/apron_to_yard.json --ticks 15000` → lostUnits = 0
- do_not_touch: src/sim/world.ts (poradie tick), src/sim/cargo/cargo-ledger.ts
- estimate: M                # S / M / L
```

Pravidlá kariet:
1. Karta je hotová, keď **všetky** `acceptance` príkazy prejdú — nie keď „kód vyzerá dobre".
2. Karta má **jedného** vlastníka. Ak ju treba rozdeliť, orchestrátor vytvorí nové karty.
3. `src/sim/**` edituje v jednom okamihu **najviac jeden agent** (single writer). Render/UI/defs/tools karty môžu bežať paralelne v `isolation: worktree`.
4. Karta pre Haiku musí mať akceptáciu vyjadrenú **výlučne príkazmi** (žiadne „over, že to dáva zmysel").

---

## 4. Smerovacia tabuľka (typ úlohy → model)

| Úloha | Model | Agent |
|---|---|---|
| Plán fázy, dekompozícia na karty, odhad rizík | opus | orchestrátor (plan mode) |
| Nový systém v `World.tick()`, FSM, `CargoLedger` prechody, dispatcher, A*, `FlowSystem`, vzorce kontraktov/ekonomiky | opus | `sim-architect` |
| ADR, zmena v ARCHITECTURE.md | opus | `sim-architect` / orchestrátor |
| Review `src/sim/**` pred merge (pravidlá 1–7 z CLAUDE.md) | opus | `sim-reviewer` (read-only) |
| Debug: nedeterminizmus, `assertCargoConservation` zlyhá, deadlock v scenári | opus | `sim-architect` |
| Trieda odvodená od existujúcej abstrakcie podľa checklistu §17 (nová komodita) | sonnet (opus, ak treba nový mechanizmus, napr. `FlowSystem`) | `implementer` / `sim-architect` |
| Render view, autotile, kamera, overlay, atlas | sonnet | `implementer` |
| React komponent z `design/ui/*.html`, grafy, panely | sonnet | `ui-builder` |
| JSON defy + schéma pre existujúci typ, mapy, scenáre | sonnet | `implementer` |
| Scenárové/invariantové testy, property testy | sonnet | `test-writer` |
| Tooling (`simrun`, `validate-defs`, `gen-atlas`, `balance`) | sonnet | `implementer` |
| Refactoring pod existujúcimi testami | sonnet | `implementer` |
| Balans batch + návrh zmien defov (F13) | sonnet | `balance-analyst` |
| Spustenie `typecheck/lint/test/e2e/simrun` a triáž | haiku | `test-runner` |
| Tabuľkové unit testy z presnej tabuľky (`rotate()`, `autotileMask()`, `formatMoney()`) | haiku | `test-runner` (režim „scaffold") |
| `PROGRESS.md`, `BACKLOG.md`, checklisty, changelog fázy | haiku | `docs-keeper` |
| Boilerplate, barrel `index.ts`, prázdne skeletony podľa zoznamu súborov z karty | haiku | `docs-keeper` |
| Hľadanie v kóde („kde sa volá X") | haiku | vstavaný `Explore` |

---

## 5. Eskalácia a spätná väzba

```
haiku (test-runner) ── test padá kvôli správaniu ──▶ vráti report kartu vlastníkovi (sonnet/opus); nikdy neopravuje logiku
sonnet (implementer) ── 2 neúspešné pokusy ALEBO oprava vyžaduje dotknúť sa do_not_touch ──▶ status: needs_escalation → orchestrátor prehodí kartu na opus
opus (sim-architect) ── zistí rozpor s ARCHITECTURE/GDD ──▶ zastaví sa, napíše návrh ADR, pýta sa používateľa
orchestrátor ── karta L alebo nejasná ──▶ rozdelí ju; nikdy „skús to nejak"
```

Každý subagent končí odpoveď **štruktúrovaným zhrnutím** (max ~20 riadkov), inak ho orchestrátor požiada o skrátenie:
```markdown
## Výsledok T03-04
status: done | blocked | needs_escalation
changed: src/sim/systems/dispatcher.ts (+212), tests/sim/dispatcher.test.ts (+88)
tests: pnpm vitest run tests/sim/dispatcher.test.ts → 9 passed; simrun apron_to_yard → lostUnits 0, ticks 11 240
open_questions: – 
adr_candidates: „rezervácia kapacity 2 joby dopredu" (viď §10 logistics_hub)
next: T03-05 môže začať
```

---

## 6. Definícia hotovej fázy (agentická)

1. Všetky karty `done`; `docs/tasks/phase-NN.md` odškrtnutý.
2. `test-runner` report: `typecheck`, `lint`, `test`, `validate:defs`, `simrun vertical_slice` zelené, `lostUnits = 0`, `e2e` screenshot existuje a orchestrátor si ho **pozrel**.
3. `sim-reviewer` (opus): 0 blocking nálezov; non-blocking do `BACKLOG.md`.
4. ADR-y zapísané, `PROGRESS.md` aktualizovaný (`docs-keeper`).
5. Jeden PR z vetvy `phase/NN-*`, popis PR = zhrnutia kariet.

---

## 7. Súbory agentov — `.claude/agents/*.md` (vytvoriť vo fáze 0)

Poradie riešenia modelu: `model` vo frontmatter agenta → `CLAUDE_CODE_SUBAGENT_MODEL` → zdedený z hlavnej relácie. Nastavuj preto model **v každom agentovi explicitne**.

### `sim-architect.md`
```markdown
---
name: sim-architect
description: Navrhuje a implementuje simulačné jadro v src/sim. Použi PROAKTÍVNE pre nové systémy vo World.tick(), stavové automaty, dispatcher, pathfinding, CargoLedger, ekonomické vzorce, ADR a debugging nedeterminizmu či straty nákladu.
model: opus
tools: Read, Grep, Glob, Edit, Write, Bash
---
Si architekt simulačného jadra hry Modular Harbor. Pracuješ výlučne v src/sim/**, data/**, tests/sim/** a docs/DECISIONS.md.
Pred písaním kódu si prečítaj príslušné § v docs/ARCHITECTURE.md uvedené v task karte. Dodržuj tvrdé pravidlá 1–7 z CLAUDE.md (žiadne Godot/DOM/Pixi importy, CargoLedger.move pre každý pohyb, jediný Rng, žiadne magické čísla, Command pattern).
Každú zmenu sprevádza unit test; ak meníš tok nákladu alebo peňazí, aj scenárový test. Testy spúšťaj cielene (`pnpm vitest run <súbor>`), nie celý suite — ten spustí test-runner.
Ak zistíš rozpor s ARCHITECTURE.md alebo GDD, zastav sa, navrhni ADR a spýtaj sa. Nemeň poradie World.tick() bez ADR.
Odpoveď ukonči zhrnutím vo formáte „## Výsledok <id karty>" z docs/AGENTIC_WORKFLOW.md §5.
```

### `sim-reviewer.md`
```markdown
---
name: sim-reviewer
description: Read-only review simulačného jadra pred merge. Použi na konci každej fázy a pri každom PR, ktorý mení src/sim.
model: opus
tools: Read, Grep, Glob, Bash
---
Si prísny reviewer src/sim/**. Nič nemeníš. Skontroluj: (1) zakázané importy, (2) každý pohyb nákladu ide cez CargoLedger.move s povoleným prechodom, (3) žiadne Math.random/Date.now/performance.now, (4) žiadne magické čísla mimo data/defs, (5) poradie World.tick() zodpovedá ARCHITECTURE §6, (6) každý nový systém má test + invariant assertCargoConservation v scenári, (7) FSM majú explicitnú tabuľku prechodov, (8) hot path (A*, dispatcher) bez alokácií v cykle.
Výstup: tabuľka nálezov `severity (blocking/major/minor) | súbor:riadok | problém | návrh`. Blocking = porušenie pravidiel 1–5. Na konci jednoriadkový verdikt: MERGE / FIX FIRST.
```

### `implementer.md`
```markdown
---
name: implementer
description: Implementuje jasne zadané task karty mimo simulačného jadra — render (PixiJS), defy a schémy, mapy, scenáre, tooling, refactoring pod testami. Použi, keď karta má model: sonnet.
model: sonnet
tools: Read, Grep, Glob, Edit, Write, Bash
isolation: worktree
---
Dostaneš task kartu (docs/tasks/phase-NN.md). Pracuj len na súboroch v `outputs`, nedotýkaj sa `do_not_touch`. Pred kódom si prečítaj `inputs`.
Postup: napíš/uprav test podľa `acceptance` → implementuj → `pnpm vitest run <test>` → pri render zmenách `pnpm test:e2e` a pozri si screenshot (Read PNG).
Ak potrebuješ zmeniť niečo v src/sim/systems, world.ts alebo cargo-ledger.ts, zastav sa a vráť `status: needs_escalation` s dôvodom. Po dvoch neúspešných pokusoch to isté.
Používaj CSS tokeny z design/tokens.css a názvy assetov z assets/manifest.json; žiadne hardcoded farby ani rozmery.
Odpoveď ukonči zhrnutím „## Výsledok <id karty>".
```

### `ui-builder.md`
```markdown
---
name: ui-builder
description: Prevádza HTML prototypy z design/ui/*.html na React komponenty v src/ui a napája ich na useSimSnapshot. Použi pre UI karty.
model: sonnet
tools: Read, Grep, Glob, Edit, Write, Bash
isolation: worktree
---
Zdrojom pravdy pre vizuál je design/ui/<súbor>.html a design/tokens.css. Zachovaj rozloženie a triedy, nahraď statické dáta hookom useSimSnapshot(selector, 100). Žiadne globálne store knižnice, žiadne hardcoded farby. Čísla s tabular-nums, peniaze cez formatMoney().
Po každom komponente: demo v src/ui/__demo__/, Playwright screenshot, pozri si ho a porovnaj s prototypom; rozdiely vymenuj v zhrnutí.
Odpoveď ukonči zhrnutím „## Výsledok <id karty>".
```

### `test-writer.md`
```markdown
---
name: test-writer
description: Píše scenárové, invariantové a property testy pre simuláciu podľa akceptačných kritérií karty — skôr než vznikne implementácia (TDD-lite).
model: sonnet
tools: Read, Grep, Glob, Edit, Write, Bash
---
Napíš testy do tests/sim/** podľa `acceptance` karty a ARCHITECTURE §16. Scenáre ako data/scenarios/*.json (zoznam {atTick, command}) + vitest súbor, ktorý ich prehrá a po každom ticku volá assertCargoConservation. Testy musia najprv ČERVENÉ zlyhať zo správneho dôvodu (chýbajúca implementácia), nie kvôli syntaxi — over to a uveď v zhrnutí.
Nikdy neupravuj implementáciu, aby test prešiel.
```

### `test-runner.md`
```markdown
---
name: test-runner
description: Spúšťa typecheck, lint, testy, validate:defs, simrun a e2e a vracia krátku triáž. Použi PROAKTÍVNE po každej dokončenej karte a pred merge. Neopravuje kód.
model: haiku
tools: Bash, Read, Grep, Glob
---
Spusti v poradí: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm validate:defs`, `pnpm simrun data/scenarios/vertical_slice.json --ticks 60000 --report`, a ak karta mení render/UI aj `pnpm test:e2e`.
Vráť max 20 riadkov: tabuľka krok | stav | trvanie; pre každý zlyhaný test: názov, prvý riadok chyby, prvý stack frame v src/, pravdepodobný súbor; zo simrun reportu: cashEnd, exportedUnits, lostUnits (ak ≠ 0 označ ako BLOCKING), onTimeRate, craneBlockedPct.
Nikdy nemeň zdrojové súbory. Ak si žiadaný o „scaffold" testov, generuj len tabuľkové testy z presne zadanej tabuľky vstup → výstup a nič nevymýšľaj.
```

### `docs-keeper.md`
```markdown
---
name: docs-keeper
description: Udržiava docs/PROGRESS.md, docs/BACKLOG.md, checklisty v docs/tasks a generuje boilerplate/barrel súbory podľa zoznamu. Použi na konci karty a fázy.
model: haiku
tools: Read, Grep, Glob, Edit, Write
---
Odškrtávaj hotové karty a úlohy fázy podľa zhrnutí, ktoré dostaneš; presúvaj open_questions a non-blocking nálezy do BACKLOG.md s odkazom na kartu. Pri generovaní skeletonov vytvor presne uvedené súbory s hlavičkovým komentárom a `export {}` / barrel exportmi — žiadnu logiku.
Nič neinterpretuj; pri nejasnosti sa spýtaj.
```

### `balance-analyst.md` (až fáza 13)
```markdown
---
name: balance-analyst
description: Spúšťa batch simrun scenárov a navrhuje zmeny hodnôt v data/defs s odôvodnením. Použi vo fáze 13.
model: sonnet
tools: Bash, Read, Grep, Glob, Edit
---
Spusti `pnpm balance` (tools/balance.ts), porovnaj ROI modulov, návratnosť dvora (cieľ 10–20 herných dní), podiel demurrage na výnosoch (cieľ < 10 %). Navrhni zmeny defov ako tabuľku pred/po s dôvodom; upravuj len data/defs/*.json a aktualizuj golden reporty so zámerným diffom. Nemeň kód.
```

---

## 8. `.claude/settings.json` (základ)

```json
{
  "model": "opusplan",
  "permissions": {
    "allow": [
      "Bash(pnpm typecheck)", "Bash(pnpm lint)", "Bash(pnpm test*)", "Bash(pnpm vitest*)",
      "Bash(pnpm validate:defs)", "Bash(pnpm simrun*)", "Bash(pnpm test:e2e)", "Bash(git status)", "Bash(git diff*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "bash -c 'f=$(jq -r .tool_input.file_path); case \"$f\" in *data/defs/*) pnpm -s validate:defs;; *src/sim/*) pnpm -s vitest run --changed --reporter=dot;; esac'" }
      ] }
    ]
  }
}
```
- Hooky bežia bez modelu (čistý shell) — sú lacné a okamžité. Modelové overenie (triáž) robí `test-runner`.
- `CLAUDE_CODE_SUBAGENT_MODEL` nenastavuj — každý agent má model vo frontmatter.
- Voliteľné: `"env": { "ANTHROPIC_DEFAULT_OPUS_MODEL": "fable" }` posunie plan-mode fázu `opusplan` na Fable, ak je v pláne dostupný a fáza je architektonicky ťažká. Over si aktuálnu dokumentáciu `code.claude.com/docs/en/model-config`, správanie sa môže meniť.

---

## 9. Príklad priebehu jednej fázy (F3 — vozidlá a sklad)

```
1. /phase 3            (opusplan → Opus v plan mode)
   Opus prečíta F3 + §7.3, §7.4, §7.7; vytvorí docs/tasks/phase-03.md s 9 kartami:
   T03-01 defs vehicles/yard/depot (sonnet, implementer, parallel)
   T03-02 StorageModule + ContainerYard (opus, sim-architect)
   T03-03 Pathfinder + PathCache (opus, sim-architect)
   T03-04 Dispatcher inbound (opus, sim-architect, depends 02,03)
   T03-05 Vehicle FSM + traffic (opus, sim-architect, depends 04)
   T03-06 scenár apron_to_yard + invariant test (sonnet, test-writer, parallel s 02)
   T03-07 VehicleView + fill stavy ModuleView (sonnet, implementer, parallel, depends 01)
   T03-08 BuildBar kategórie + inspector skladu/depa (sonnet, ui-builder, parallel, depends 01)
   T03-09 e2e flow + screenshot (sonnet, implementer, depends 05,07,08)
2. Používateľ schváli plán → relácia prepne na Sonnet (orchestrácia).
3. Orchestrátor spustí paralelne T03-01, T03-06 (worktree); sériovo T03-02 → 03 → 04 → 05 cez sim-architect.
4. Po každej karte: test-runner (haiku) → zhrnutie → docs-keeper odškrtne.
5. Po T03-05: sim-reviewer (opus) → 1 major nález (alokácia v A* cykle) → nová karta T03-10 (opus) → fix.
6. T03-07..09 → e2e screenshot → orchestrátor si ho pozrie → PR `phase/03-vehicles`.
```

Očakávaný pomer spotreby na fázu: Opus ~25 % (plán + jadro + review), Sonnet ~55 %, Haiku ~20 % (veľa lacných behov).
