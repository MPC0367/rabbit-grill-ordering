// EmptyState (DESIGN §10.25) and Skeleton (§10.30).
import { createElement, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 56px ringed icon */
  icon?: IconName;
  title: ReactNode;
  /** One sentence (max 34ch). */
  children?: ReactNode;
  /** One action (a Button or LinkButton). */
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  compact?: boolean;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon = 'info', title, children, action, headingLevel = 3, compact, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('empty', compact && 'empty--compact', className)} {...rest}>
      <span className="empty__mark" aria-hidden="true"><Icon name={icon} /></span>
      {createElement(`h${headingLevel}`, null, title)}
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty__act">{action}</div> : null}
    </div>
  );
});

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** text (one line) · block · plate (4:3 with the mat margin) · circle */
  shape?: 'text' | 'block' | 'plate' | 'circle';
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  /** Several text lines; the last is shorter. */
  lines?: number;
}

/** Sunken placeholder at the real dimensions. Shimmer is off under reduced motion. */
export function Skeleton({ shape = 'text', width, height, lines, className, style, ...rest }: SkeletonProps) {
  if (shape === 'text' && lines && lines > 1) {
    return (
      <span aria-hidden="true" style={{ display: 'block', width, ...style }} className={className}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="skel skel--text" style={{ width: i === lines - 1 ? '62%' : '100%' }} />
        ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx('skel', `skel--${shape}`, className)}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}

/** Loading placeholder shaped like a photo DishRow. */
export function SkeletonDishRow({ label }: { label?: string }) {
  return (
    <div className="dish skel-dish" role={label ? 'status' : undefined} aria-label={label}>
      <div className="dish__plate" aria-hidden="true"><Skeleton shape="plate" /></div>
      <div className="dish__body" aria-hidden="true">
        <span className="lead">
          <Skeleton width="58%" height={18} />
          <span style={{ flex: 1 }} />
          <Skeleton width={52} height={20} />
        </span>
        <Skeleton width="44%" height={14} />
        <div className="dish__foot">
          <span />
          <Skeleton shape="block" width={88} height={44} />
        </div>
      </div>
    </div>
  );
}
