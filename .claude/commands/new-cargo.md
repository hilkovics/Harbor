Pridávame nový typ nákladu: $ARGUMENTS. Vytvor task karty podľa checklistu docs/ARCHITECTURE.md §17:
body 1–4, 6, 7, 9 → sonnet (implementer), bod 5 → sonnet ak stačí odvodená trieda + def, opus (sim-architect) ak treba nový mechanizmus; bod 8 → test-writer.
Dispatcher a CraneSystem sa NESMÚ meniť — ak to agent hlási ako nutné, zastav sa a vysvetli prečo.
Na konci: scenár data/scenarios/<id>_flow.json končí v 'exported' s konzerváciou; sim-reviewer potvrdí prázdny diff dispatcher.ts.
