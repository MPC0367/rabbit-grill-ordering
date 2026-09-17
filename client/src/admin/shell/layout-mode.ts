// Staff layout modes (DESIGN §8.2): full rail from 1200px, compact rail from
// 768px, bottom bar below that.
import { useMedia } from '../../lib/store.ts';

export type LayoutMode = 'full' | 'compact' | 'bar';

export function useLayoutMode(): LayoutMode {
  const wide = useMedia('(min-width: 1200px)');
  const tablet = useMedia('(min-width: 768px)');
  return wide ? 'full' : tablet ? 'compact' : 'bar';
}
