// Identifier helpers shared by server and browser (both expose Web Crypto).

// Crockford-style alphabet without I, L, O, U: no ambiguity when read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// For human references we also drop 0/1 so "RG-4K7P" never looks like O/I.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number, alphabet: string): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Opaque database id, e.g. `ord_7F3K9Q2M8XW4TB1R`. Not a secret. */
export function newId(prefix: string): string {
  return `${prefix}_${randomString(16, ALPHABET)}`;
}

/** Human order reference, e.g. `RG-4K7P`. Uniqueness is enforced by the database. */
export function newOrderReference(length = 4): string {
  return `RG-${randomString(length, REF_ALPHABET)}`;
}

/** High-entropy URL-safe secret (QR tokens, session tokens). 32 bytes by default. */
export function newSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Client-generated idempotency key for a submission attempt. */
export function newIdempotencyKey(): string {
  return `att_${randomString(24, ALPHABET)}`;
}

/** Short numeric joining PIN for a dining visit. */
export function newJoinPin(digits = 4): string {
  const buf = new Uint32Array(1);
  let pin = '';
  while (pin.length < digits) {
    globalThis.crypto.getRandomValues(buf);
    pin += String(buf[0] % 10);
  }
  return pin;
}
