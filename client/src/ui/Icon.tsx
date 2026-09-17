// Inline SVG icon set (DESIGN §6). 24-unit grid, stroke 1.5 (2 inside
// controls via `bold`), round caps and joins, currentColor. Mirrors
// design-lab/final/sprite.js one to one; ids drop the "i-" prefix.
import { forwardRef, useId, type SVGProps } from 'react';
import { cx } from './cx.ts';

const ICONS = {
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4 20 20"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  bell: '<path d="M4 17.5h16"/><path d="M5.8 17.5a6.2 6.2 0 0 1 12.4 0"/><path d="M12 11.3V9.4M10.4 9.4h3.2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-8.9"/>',
  'check-c': '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l2.9 1.9"/>',
  scale: '<path d="M12 4v16M7.5 20h9M5 7h14"/><path d="M5 7 2.8 12.6a2.4 2.4 0 0 0 4.4 0zM19 7l-2.2 5.6a2.4 2.4 0 0 0 4.4 0z"/>',
  slash: '<circle cx="12" cy="12" r="8.2"/><path d="M6.2 17.8 17.8 6.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.7v.1"/>',
  'chev-r': '<path d="m9.5 6 6 6-6 6"/>',
  'chev-l': '<path d="m14.5 6-6 6 6 6"/>',
  'chev-d': '<path d="m6 9.5 6 6 6-6"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  alert: '<path d="M10.6 4.6a1.6 1.6 0 0 1 2.8 0l7.4 13.2a1.6 1.6 0 0 1-1.4 2.4H4.6a1.6 1.6 0 0 1-1.4-2.4z"/><path d="M12 9.6v4.2M12 16.9v.1"/>',
  book: '<path d="M3.8 5.6c3-1 5.6-.8 8.2 1 2.6-1.8 5.2-2 8.2-1v12.9c-3-1-5.6-.8-8.2 1-2.6-1.8-5.2-2-8.2-1z"/><path d="M12 6.6v12.9"/>',
  pad: '<rect x="5" y="4" width="14" height="16.5" rx="1.5"/><path d="M9 2.8v2.6M15 2.8v2.6M8.5 10h7M8.5 13.5h7M8.5 17h4"/>',
  track: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="12" r="2"/><circle cx="6.5" cy="18.5" r="2"/><path d="M6.5 7.5v2.5M6.5 14v2.5M11.5 5.5H20M11.5 12H20M11.5 18.5h5"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
  hand: '<path d="M8.2 12.2V6.6a1.5 1.5 0 0 1 3 0v4.6"/><path d="M11.2 10.6V5a1.5 1.5 0 0 1 3 0v5.6"/><path d="M14.2 10.6V6.7a1.5 1.5 0 0 1 3 0V13c0 4.1-2.6 7.2-6.2 7.2-2.6 0-4-1.3-5.3-3.4l-1.6-3.2a1.5 1.5 0 0 1 2.6-1.5l1.5 2.1"/>',
  pan: '<path d="M3 12.5h13.5a5.5 5.5 0 0 1-5.5 5.5H8.5A5.5 5.5 0 0 1 3 12.5z"/><path d="M16.5 13.5H21"/><path d="M8 9.2c0-1 .9-1.3.9-2.3M11.5 9.2c0-1 .9-1.3.9-2.3"/>',
  half: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor"/>',
  cloche: '<path d="M3 18h18M4.8 18a7.2 7.2 0 0 1 14.4 0M12 10.8V9M10.5 9h3"/>',
  orders: '<path d="M3 4.5h18"/><path d="M5.5 4.5v10.3l1.5-1 1.5 1 1.5-1 1.5 1V4.5"/><path d="M13 4.5v7.3l1.5-1 1.5 1 1.5-1 1.5 1V4.5"/>',
  tables: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  cutlery: '<path d="M7 3.5v17M4.5 3.5v5a2.5 2.5 0 0 0 5 0v-5M17 20.5v-17c-2.2 1-3.5 3.5-3.5 7v3.5H17"/>',
  bars: '<path d="M3.5 20.5h17M6.5 16.5v-5M11 16.5V7M15.5 16.5v-7M20 16.5V4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
  note: '<path d="M5 4.5h14v10l-5 5H5z"/><path d="M14 19.5v-5h5M8.5 9h7M8.5 12h4"/>',
  glass: '<path d="M8 3.5h8l-.5 5a3.5 3.5 0 0 1-7 0z"/><path d="M12 12v8M8.5 20.5h7"/>',
  'arrow-r': '<path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.2 8.6-8.7M16.5 6.5l2.5 2.5M14.3 8.7l1.8 1.8"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  'table-view': '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  'wifi-off': '<path d="M3.5 3.5l17 17M8.8 15.6a4.6 4.6 0 0 1 6.4 0M5.6 12.4a9.2 9.2 0 0 1 4.3-2.3M18.4 12.4a9 9 0 0 0-2.1-1.6M2.5 9.2a13.6 13.6 0 0 1 4.2-2.6M21.5 9.2A13.6 13.6 0 0 0 12 5.5"/><path d="M12 19v.1"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx=".5"/><rect x="14" y="4" width="6" height="6" rx=".5"/><rect x="4" y="14" width="6" height="6" rx=".5"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  seat: '<path d="M7 3.5v9.5h10M7 13v7.5M17 13v7.5M7 17h10"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sort: '<path d="M7.5 4.5v15M4.5 16.5l3 3 3-3M16.5 19.5v-15M13.5 7.5l3-3 3 3"/>',
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | number;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'ref'> {
  name: IconName;
  /** xs 14 · sm 16 · md 20 (default; contextual CSS may resize it) · lg 24 · or pixels */
  size?: IconSize;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string;
  /** 2px stroke, for plus/minus/check inside controls. */
  bold?: boolean;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = 'md', title, bold, className, style, ...rest },
  ref,
) {
  const titleId = useId();
  const sized = typeof size === 'number' ? { width: size, height: size, ...style } : style;
  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      className={cx('i', typeof size === 'string' && size !== 'md' && `i--${size}`, bold && 'i--bold', className)}
      style={sized}
      focusable="false"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      {...rest}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {/* Static, trusted path data from the sprite above. */}
      <g dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
    </svg>
  );
});
