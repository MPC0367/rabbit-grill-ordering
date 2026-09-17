// Row actions shared by the menu page and its dish rows (kept apart from the
// components so Fast Refresh can update them in place).
import { createContext } from 'react';
import type { MenuItemDTO } from '../../../../shared/dto.ts';

export interface MenuRowActions {
  /** Quick add; true when the draft changed. */
  quickAdd: (item: MenuItemDTO) => boolean;
  setQty: (item: MenuItemDTO, uid: string, next: number) => void;
  removeLine: (item: MenuItemDTO, uid: string) => void;
  open: (item: MenuItemDTO, position: number) => void;
  weigh: (item: MenuItemDTO) => void;
  /** Tell a visitor without access how to join. */
  explain: () => void;
  /** Access is not known yet (session still loading). */
  notReady: () => void;
}

export const RowActionsContext = createContext<MenuRowActions | null>(null);

/** order: joined · explain: public or ended · loading: session not known yet */
export type RowAccess = 'loading' | 'order' | 'explain';
