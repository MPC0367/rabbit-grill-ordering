// Banner (DESIGN §10.26): full width under the header, pushes content down.
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';

export type BannerVariant = 'demo' | 'offline' | 'paused' | 'billing' | 'info' | 'warning';

const ICON: Record<BannerVariant, IconName> = {
  demo: 'info',
  offline: 'wifi-off',
  paused: 'pause',
  billing: 'receipt',
  info: 'info',
  warning: 'alert',
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant: BannerVariant;
  /** Bold lead words ("ขาดการเชื่อมต่อ"). */
  title?: ReactNode;
  /** Right-aligned 44px action (a Button). */
  action?: ReactNode;
  /** Override or hide (null) the icon. */
  icon?: IconName | null;
  /** Admin padding and type. */
  staff?: boolean;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { variant, title, action, icon, staff, className, children, role, ...rest },
  ref,
) {
  const iconName = icon === undefined ? ICON[variant] : icon;
  const live = variant === 'offline' || variant === 'paused' || variant === 'warning';
  return (
    <div
      ref={ref}
      role={role ?? (live ? 'status' : undefined)}
      className={cx('banner', `banner--${variant}`, staff && 'banner--staff', className)}
      {...rest}
    >
      {iconName ? <Icon name={iconName} /> : null}
      <p className="banner__body">
        {title ? <span className="banner__t">{title}</span> : null}
        {title && children ? ' · ' : null}
        {children}
      </p>
      {action}
    </div>
  );
});
