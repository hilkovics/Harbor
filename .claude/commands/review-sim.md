---
description: Read-only review simulačného jadra pred merge (Opus)
---
Spusti subagenta sim-reviewer nad `git diff main...HEAD -- src/sim tests/sim data/defs`.
Výsledok (tabuľka nálezov + verdikt MERGE / FIX FIRST) zobraz celý. Pre každý blocking nález navrhni novú task kartu (model: opus, agent: sim-architect) a pridaj ju do docs/tasks/phase-NN.md; nič neopravuj sám.
