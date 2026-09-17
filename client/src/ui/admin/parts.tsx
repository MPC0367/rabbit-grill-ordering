// Internal helpers for the staff & data kit. Not exported from the barrel.
import type { FocusEvent, KeyboardEvent } from 'react';
import { Icon, type IconName } from '../Icon.tsx';

/** Class-name join that drops falsy parts. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}

/** Icon ids from the design-system set (docs/DESIGN.md §6). */
export type AdminIconName = IconName;

const ROVE_CURRENT = '[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"], [aria-current]:not([aria-current="false"])';

/**
 * Roving focus inside a group of buttons marked `data-rove`: arrow keys and
 * Home/End move focus; Enter/Space activate the focused button natively.
 * The focused item takes the one tab stop, so Tab leaves the group from where
 * focus is. Pair with `roveIndex()` for the initial tab stop and `roveBlur`
 * on the group, which hands the tab stop back to the chosen item on the way out.
 */
export function roveKeys(e: KeyboardEvent<HTMLElement>, orientation: 'horizontal' | 'vertical' | 'both' = 'horizontal'): void {
  const next = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'both' ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];
  const prev = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'both' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-rove]')).filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  let to = at;
  if (next.includes(e.key)) to = (at + 1) % items.length;
  else if (prev.includes(e.key)) to = (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = items.length - 1;
  else return;
  e.preventDefault();
  if (items.some((el) => el.tabIndex === 0)) {
    for (const el of items) el.tabIndex = el === items[to] ? 0 : -1;
  }
  items[to].focus();
}

/**
 * Focus left a `roveKeys` group: the chosen item (pressed / checked /
 * selected / current, else the first) takes the tab stop again, matching
 * what `roveIndex()` renders, so the group never keeps two tab stops.
 */
export function roveBlur(e: FocusEvent<HTMLElement>): void {
  const group = e.currentTarget;
  if (e.relatedTarget instanceof Node && group.contains(e.relatedTarget)) return;
  const items = Array.from(group.querySelectorAll<HTMLElement>('[data-rove]'));
  // Groups whose items are all out of the tab order (a read-only chart) stay so.
  if (!items.some((el) => el.tabIndex === 0)) return;
  const chosen = items.find((el) => el.matches(ROVE_CURRENT)) ?? items[0];
  for (const el of items) el.tabIndex = el === chosen ? 0 : -1;
}

/** tabIndex for item `i` of a roving group whose active item is `active` (-1 = none → first). */
export function roveIndex(i: number, active: number): 0 | -1 {
  return i === (active < 0 ? 0 : active) ? 0 : -1;
}

/** Initials for the avatar: first letters of the first two words (Latin), or the first character (Thai). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (/^[A-Za-z]/.test(words[0])) {
    const w = words[0];
    // "Nok" → NK, "Kitchen 1" → K1, "Ploy Sri" → PS
    const two = words.length > 1 ? w[0] + words[1][0] : w.length > 2 ? w[0] + w[w.length - 1] : w;
    return two.toUpperCase();
  }
  return Array.from(words[0])[0] ?? '';
}

/** useId() output made safe for SVG `url(#…)` references and CSS selectors. */
export function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Decorative icon (aria-hidden). Words beside it carry the meaning. */
export function Ico({ name, size, className }: { name: AdminIconName; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  return <Icon name={name} size={size} className={className} />;
}
