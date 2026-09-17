// DishImage (brief 34): matted 4:3 plate with a reserved box, responsive
// srcset from /media/dish/<name>-<size>.webp, lazy loading, and a clean
// text-led fallback when the photo is missing or fails. Never a broken-image
// icon, never a stand-in photo.
import { forwardRef, useState, type ImgHTMLAttributes } from 'react';
import type { MenuItemDTO } from '../../../shared/dto.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';

export type DishImageSource = NonNullable<MenuItemDTO['image']>;

export type DishImageVariant = 'plate' | 'wide' | 'thumb' | 'round';

const SIZES: Record<DishImageVariant, string> = {
  plate: '(min-width: 1080px) 156px, (min-width: 720px) 128px, 28vw',
  wide: '(min-width: 720px) 552px, 100vw',
  thumb: '64px',
  round: '36px',
};

export function dishImageUrl(name: string, size: number): string {
  return `/media/dish/${encodeURIComponent(name)}-${size}.webp`;
}

export function dishSrcSet(image: Pick<DishImageSource, 'name' | 'sizes'>): string {
  return [...image.sizes].sort((a, b) => a - b).map((s) => `${dishImageUrl(image.name, s)} ${s}w`).join(', ');
}

export interface DishImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'alt' | 'width' | 'height'> {
  image: DishImageSource | null | undefined;
  /** plate 4:3 (rows) · wide 16:9 (sheet) · thumb 4:3 small · round (overlapping thumbnails) */
  variant?: DishImageVariant;
  /** Decorative when the dish name is adjacent (DishRow): alt="". */
  decorative?: boolean;
  /** none: render nothing on failure (the row goes text-led) · blank: keep a sunken mat */
  fallback?: 'none' | 'blank';
  onFallback?: () => void;
  /** Wrap in the .plate mat (default true; round thumbnails are bare). */
  framed?: boolean;
  plateClassName?: string;
}

export const DishImage = forwardRef<HTMLImageElement, DishImageProps>(function DishImage(
  { image, variant = 'plate', decorative, fallback = 'none', onFallback, framed, loading = 'lazy', sizes, className, plateClassName, onError, ...rest },
  ref,
) {
  const { pick } = useI18n();
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = !image || failedFor === image.name || image.sizes.length === 0;
  const withMat = framed ?? variant !== 'round';

  if (failed) {
    if (fallback === 'blank') {
      return <div className={cx('plate plate--blank', variant === 'wide' && 'plate--wide', plateClassName)} aria-hidden="true" />;
    }
    return null;
  }

  const sorted = [...image.sizes].sort((a, b) => a - b);
  const want = variant === 'thumb' || variant === 'round' ? 240 : 480;
  const src = sorted.find((s) => s >= want) ?? sorted[sorted.length - 1];
  const ratio = variant === 'wide' ? 9 / 16 : 3 / 4;
  const alt = decorative ? '' : pick(image.alt).text;

  const img = (
    <img
      ref={ref}
      src={dishImageUrl(image.name, src)}
      srcSet={dishSrcSet(image)}
      sizes={sizes ?? SIZES[variant]}
      width={src}
      height={Math.round(src * ratio)}
      alt={alt}
      loading={loading}
      decoding="async"
      className={cx(variant === 'round' && 'thumbs__img', className)}
      onError={(e) => {
        setFailedFor(image.name);
        onFallback?.();
        onError?.(e);
      }}
      {...rest}
    />
  );
  if (!withMat) return img;
  return (
    <div className={cx('plate', variant === 'wide' && 'plate--wide', plateClassName)} aria-hidden={decorative || undefined}>
      {img}
    </div>
  );
});
