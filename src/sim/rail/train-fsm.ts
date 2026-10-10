/**
 * Stavy vlaku (R6, ADR-043) a explicitná tabuľka prechodov (CLAUDE.md: stavové automaty, žiadne skryté prechody).
 *
 * - `arriving` — vlak jazdí z portálu k zastávke v termináli (jediný pohyblivý vlak na koľajisku, rozhodnutie ADR-043 bod 3),
 * - `dwelling` — stojí na koľaji terminálu: RMG nakladá a vykladá vagóny (TR6-02), odíde v plánovanom čase alebo keď je plný,
 * - `departing` — ide späť k portálu; pri prechode portálom zmizne (jeho jednotky `in_train → exported`).
 */
export const TRAIN_STATES = ['arriving', 'dwelling', 'departing'] as const;
export type TrainState = (typeof TRAIN_STATES)[number];

/** Povolené prechody; `departing` nemá výstup — vlak po odchode zaniká. */
export const TRAIN_TRANSITIONS: { readonly [S in TrainState]: readonly TrainState[] } = Object.freeze({
  arriving: Object.freeze(['dwelling'] as const),
  dwelling: Object.freeze(['departing'] as const),
  departing: Object.freeze([] as const),
});

/** Je `value` stav vlaku? (vstup zo save) */
export function isTrainState(value: unknown): value is TrainState {
  return typeof value === 'string' && (TRAIN_STATES as readonly string[]).includes(value);
}

/** Smie vlak prejsť zo `from` do `to`? */
export function isTrainTransitionAllowed(from: TrainState, to: TrainState): boolean {
  return TRAIN_TRANSITIONS[from].includes(to);
}

/** Vlak v pohybe (drží „žetón pohybu“ koľajiska: naraz jazdí najviac jeden). */
export const TRAIN_MOVING: { readonly [S in TrainState]: boolean } = Object.freeze({ arriving: true, dwelling: false, departing: true });
