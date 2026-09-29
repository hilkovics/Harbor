---
description: Naplánuje fázu N ako sadu task kariet a spustí orchestráciu
---
Pracujeme na fáze $ARGUMENTS projektu Modular Harbor. Si ORCHESTRÁTOR (docs/AGENTIC_WORKFLOW.md §2).
1. Prečítaj docs/IMPLEMENTATION_PLAN.md — iba sekciu „Fáza $ARGUMENTS" vrátane riadku Model mix — a súvisiace § v docs/ARCHITECTURE.md. Skontroluj docs/PROGRESS.md.
2. Zapni plan mode. Rozlož fázu na task karty podľa šablóny docs/tasks/_template.md a smerovacej tabuľky AGENTIC_WORKFLOW §4:
   každá karta má model (opus/sonnet/haiku), agenta, inputs (§), outputs (súbory), acceptance (iba príkazy), do_not_touch, depends_on, parallel.
   Karty v src/sim sú sériové (single writer); ostatné označ parallel: yes.
3. Ulož karty do docs/tasks/phase-NN.md a ukáž mi tabuľku: id | názov | model | agent | parallel | závislosti. Počkaj na schválenie.
4. Po schválení deleguj karty v topologickom poradí cez /delegate; paralelné karty spúšťaj naraz. Sám nekóduj viac ako jednu kartu S.
5. Po poslednej sim karte spusti /review-sim; blocking nálezy → nové karty (opus). Na konci /sim-check, ADR-y, zhrnutie čo funguje / čo nie.
Nerozširuj scope fázy; nápady zapíš do docs/BACKLOG.md. Do svojho kontextu neťahaj surové výstupy testov — len zhrnutia agentov.
