// What still needs work on an item (brief 34: missing content surfaced in admin).
// Mirrors the server's review-queue rules (docs/DECISIONS.md D-S1.3).
import type { AdminItemDTO } from '../../../../shared/dto.ts';

const TRUSTED_THAI_SOURCES = ['menu_scan'];

export interface Attention {
  openFlags: number;
  missingPhoto: boolean;
  missingDescription: boolean;
  /** No Thai name at all. */
  noThai: boolean;
  /** A Thai name exists but has not been approved (translation). */
  thaiUnapproved: boolean;
  unpublished: boolean;
  blockers: string[];
  /** Anything at all to look at. */
  any: boolean;
}

export function thaiNeedsReview(item: Pick<AdminItemDTO, 'name' | 'name_th_source' | 'translation_status'>): boolean {
  if (!item.name.th) return true;
  if (TRUSTED_THAI_SOURCES.includes(item.name_th_source ?? '')) return false;
  return item.translation_status !== 'verified';
}

export function missingDescription(item: Pick<AdminItemDTO, 'desc_verified' | 'description_admin'>): boolean {
  return !item.desc_verified || !(item.description_admin.th || item.description_admin.en);
}

export function attentionOf(item: AdminItemDTO): Attention {
  const openFlags = item.flags.filter((f) => !f.resolved_at).length;
  const noThai = !item.name.th;
  const a: Attention = {
    openFlags,
    missingPhoto: item.image === null,
    missingDescription: missingDescription(item),
    noThai,
    thaiUnapproved: !noThai && thaiNeedsReview(item),
    unpublished: item.status === 'published' && item.unpublished_changes,
    blockers: item.status === 'archived' ? [] : item.publish_blockers,
    any: false,
  };
  a.any = a.openFlags > 0 || a.missingPhoto || a.missingDescription || a.noThai || a.thaiUnapproved || a.unpublished || a.blockers.length > 0
    || item.review_status !== 'verified';
  return a;
}

/** Guest-orderable today but not owner-verified: these would leave the menu in live mode. */
export function wouldDisappearInLive(item: AdminItemDTO): boolean {
  return item.status === 'published' && item.orderable && item.review_status !== 'verified';
}
