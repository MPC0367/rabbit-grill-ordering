// Request limits the guest screens check before sending (the server validates
// every request again). Kept free of zod so the guest bundle never downloads
// the schema library just to read two numbers; test/unit/guest-limits.test.ts
// fails if these drift from shared/schemas.ts (PortionRequestBody).

/** A preferred weight for a weighed cut, in grams (validation only, never a suggestion). */
export const PREFERRED_GRAMS = { min: 50, max: 5000 } as const;
