---
description: Kompletná kontrola cez test-runner (Haiku)
---
Spusti subagenta test-runner v plnom režime (typecheck, lint, test, validate:defs, simrun vertical_slice 60000 tickov, e2e ak sa menil render/UI).
Zobraz jeho tabuľku a metriky: cashEnd, exportedUnits, lostUnits (MUSÍ byť 0), onTimeRate, craneBlockedPct.
Ak niečo zlyhá, navrhni kartu na opravu (model podľa smerovacej tabuľky) a nič neopravuj bez potvrdenia.
