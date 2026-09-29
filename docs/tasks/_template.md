# Šablóna task karty

Karty fázy NN sa zapisujú do `docs/tasks/phase-NN.md` pred prvou delegáciou (AGENTIC_WORKFLOW §3).

```markdown
### TNN-MM · <názov karty>
- model: <opus|sonnet|haiku>      # opus | sonnet | haiku
- agent: <meno agenta>            # kto to vykoná
- parallel: <yes|no>              # yes = môže bežať súbežne s inými kartami (worktree)
- depends_on: <TNN-MM, … alebo –>
- inputs: <§ z ARCHITECTURE / IMPLEMENTATION_PLAN; súbory na prečítanie>
- outputs: <súbory, ktoré karta vytvorí/zmení>
- acceptance:
  - `<príkaz>` <očakávaný výsledok>
- do_not_touch: <súbory/adresáre>
- estimate: <S|M|L>              # S / M / L
```

## Pravidlá kariet

1. Karta je hotová, keď **všetky** `acceptance` príkazy prejdú — nie keď „kód vyzerá dobre".
2. Karta má **jedného** vlastníka. Ak ju treba rozdeliť, orchestrátor vytvorí nové karty.
3. `src/sim/**` edituje v jednom okamihu **najviac jeden agent** (single writer). Render/UI/defs/tools karty môžu bežať paralelne v `isolation: worktree`.
4. Karta pre Haiku musí mať akceptáciu vyjadrenú **výlučne príkazmi** (žiadne „over, že to dáva zmysel").

## Zhrnutie po dokončení

Každý subagent končí odpoveď týmto blokom (AGENTIC_WORKFLOW §5):

```markdown
## Výsledok TNN-MM
status: done | blocked | needs_escalation
changed: <súbory>
tests: <čo si skontroloval>
open_questions: <alebo –>
adr_candidates: <alebo –>
next: <ďalšia karta>
```
