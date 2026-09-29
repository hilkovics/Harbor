---
description: Deleguje task kartu jej agentovi a modelu, potom overí a odškrtne
---
Karta $ARGUMENTS z aktuálneho docs/tasks/phase-NN.md.
1. Načítaj kartu; over, že depends_on sú done. Ak nie, zastav sa.
2. Spusti subagenta uvedeného v `agent:` (model určuje jeho frontmatter) a odovzdaj mu: celú kartu, odkazy na § z inputs, do_not_touch, a požiadavku ukončiť odpoveď blokom „## Výsledok <id>" (AGENTIC_WORKFLOW §5). Pri parallel: yes použi worktree izoláciu.
3. Po návrate spusti subagenta test-runner s príkazmi z acceptance karty. Ak report obsahuje BLOCKING alebo padnutý acceptance test → vráť kartu vlastníkovi s triážou (max 2 kolá), potom eskaluj podľa §5.
4. Pri status: done spusti docs-keeper: odškrtni kartu, prenes open_questions/adr_candidates do BACKLOG.md alebo DECISIONS.md.
5. Vráť mi 5-riadkové zhrnutie: karta, status, zmenené súbory, testy, ďalšia karta na rade.
