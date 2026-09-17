// Small shared helpers for the ui kit.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref, type RefCallback } from 'react';

type ClassValue = string | false | null | undefined | 0;

/** Join class names, skipping falsy values. */
export function cx(...values: ClassValue[]): string {
  let out = '';
  for (const v of values) if (v) out = out ? `${out} ${v}` : v;
  return out;
}

/** Merge several refs (object or callback) into one callback ref. */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node: T | null) => {
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === 'function') r(node);
      else (r as { current: T | null }).current = node;
    }
  };
}

/** Keep the latest value in a ref (for event handlers inside effects). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useIsoLayoutEffect(() => { ref.current = value; });
  return ref;
}

export const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Brief confirmation hold (DESIGN §7: "เพิ่มแล้ว ✓" stays 1.2s; a hold, not an animation).
 * Call `flash()` only after the draft mutation succeeded.
 */
export function useConfirmFlash(ms = 1200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

/** True when the user (OS or the staff setting) asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'reduce') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// ---------------------------------------------------------------- text length
type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;
function getSegmenter(): Segmenter | null {
  if (segmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: 'grapheme' }) => Segmenter }).Segmenter;
    segmenter = Ctor ? new Ctor('th', { granularity: 'grapheme' }) : null;
  }
  return segmenter;
}

/** Split into user-perceived characters (Thai vowel and tone marks stay with their consonant). */
export function graphemes(text: string): string[] {
  const seg = getSegmenter();
  if (!seg) return Array.from(text);
  return Array.from(seg.segment(text), (s) => s.segment);
}

export type LengthMeasure = 'codepoint' | 'grapheme';

/**
 * Length of a note as the limit counts it. `codepoint` matches the server's
 * `[...note].length` check (server/domain/pricing.ts); `grapheme` counts what
 * a reader sees.
 */
export function textLength(text: string, measure: LengthMeasure = 'codepoint'): number {
  return measure === 'grapheme' ? graphemes(text).length : Array.from(text).length;
}

/** Cut text to a limit without ever splitting a grapheme cluster. */
export function clampText(text: string, max: number, measure: LengthMeasure = 'codepoint'): string {
  if (textLength(text, measure) <= max) return text;
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const cost = measure === 'grapheme' ? 1 : Array.from(g).length;
    if (used + cost > max) break;
    out += g;
    used += cost;
  }
  return out;
}

/** Search normalisation (DESIGN §10.5): trim, collapse whitespace, case-fold Latin, never alter Thai. */
export function normalizeSearch(text: string): string {
  // Thai has no case, so lower-casing folds Latin (including accented Latin) and leaves Thai untouched.
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Bangkok wall-clock time with seconds, for "synced 19:52:04". */
export function clockSeconds(at: number | string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
}
