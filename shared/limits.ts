// Numeric bounds the API enforces, without importing zod.
//
// `shared/schemas.ts` builds the real validation from these, so a screen can
// shape its field (min, max, step, help text) from the same numbers without
// pulling the whole validation library into a guest page's start-up bundle
// (D-G-07; guest review finding 54).

/** Weight a guest may ask for on a measured-weight cut ("about 300 g"). */
export const PREFERRED_GRAMS = { min: 50, max: 5000 } as const;

/** Weight staff may record for one cut: a quote, or a paper ticket being recovered. */
export const MEASURED_GRAMS = { min: 1, max: 10_000 } as const;

/** Search aliases per dish, and the length of one (never printed on the menu). */
export const ALIASES = { perItem: 12, maxLength: 60 } as const;
