// Section 04: most and least ordered items, measured-weight cuts, category
// totals and the full ranking (every eligible item, including zero orders).
import type { RankRow, ReportSnapshot } from '../export/types.ts';
import { biName, dateShort, esc, grams, money, num, oneName, pct } from './format.ts';
import { h3, rowsChunked, sectionHead, type Col, table, tableClass, thead, tr } from './parts.ts';

const AVAIL_LABEL: Record<RankRow['availability'], string> = {
  full: 'Every day', partial: 'Some days', insufficient: 'Rarely', unknown: 'Not logged', never: 'Never',
};

function context(r: RankRow): string {
  const tags: string[] = [];
  if (r.quality === 'never_ordered_despite_availability') tags.push('<span class="tag warn">Never ordered despite availability</span>');
  if (r.quality === 'insufficient_availability') tags.push('<span class="tag warn">Insufficient availability</span>');
  if (r.quality === 'availability_unknown') tags.push('<span class="tag dim">No orders · availability not logged</span>');
  if (r.measured) tags.push('<span class="tag ok">Priced by weight</span>');
  if (r.archived) tags.push('<span class="tag dim">Archived</span>');
  if (r.status === 'draft') tags.push('<span class="tag dim">Draft now</span>');
  if (r.sold_out_now) tags.push('<span class="tag dim">Sold out now</span>');
  if (r.review_status !== 'verified') tags.push('<span class="tag dim">Unverified record</span>');
  if (r.former_names.length) tags.push(`<span class="sub">Ordered as: ${esc(r.former_names.join(', '))}</span>`);
  return tags.join(' ');
}

function variants(r: RankRow, locale: 'th' | 'en'): string {
  if (!r.variants.length) return '';
  return r.variants.map((v) => `${oneName(v.name, locale)} <b>${num(v.net_qty)}</b>`).join(' · ');
}

export function menuSection(s: ReportSnapshot): string {
  const rk = s.ranking;
  const loc = s.default_locale;
  const byQty = rk.rows;
  const top = byQty.slice(0, 10);
  const least = [...byQty].sort((a, b) => a.net_qty - b.net_qty || a.submitted_qty - b.submitted_qty || a.category_sort - b.category_sort).slice(0, 10);
  const measured = byQty.filter((r) => r.measured);
  const fin = Boolean(s.payments);
  const shortCols: Col<RankRow>[] = [
    { head: 'Rank', cell: (r) => `<span class="rank">${r.rank}</span>`, width: '10mm' },
    { head: 'Item', cell: (r) => biName(r.name, loc) },
    { head: 'Category', cell: (r) => oneName(r.category, 'en'), width: '27mm' },
    { head: 'Net servings', num: true, cell: (r) => num(r.net_qty), width: '19mm' },
    { head: 'Orders', num: true, cell: (r) => num(r.orders), width: '13mm' },
    { head: 'Share', num: true, cell: (r) => pct(r.share), width: '13mm' },
    {
      head: 'Available and context',
      cell: (r) => `${AVAIL_LABEL[r.availability]}${r.available_days !== null ? ` <span class="muted nowrap">${num(r.available_days)}/${num(r.period_days)} days</span>` : ''}${context(r) ? `<br>${context(r)}` : ''}`,
      width: '48mm',
    },
  ];
  const cats = new Map<string, { name: RankRow['category']; sort: number; items: number; zero: number; net: number; submitted: number }>();
  for (const r of byQty) {
    const c = cats.get(r.category_id) ?? { name: r.category, sort: r.category_sort, items: 0, zero: 0, net: 0, submitted: 0 };
    c.items++;
    if (r.net_qty === 0) c.zero++;
    c.net += r.net_qty;
    c.submitted += r.submitted_qty;
    cats.set(r.category_id, c);
  }
  const catRows = [...cats.values()].sort((a, b) => b.net - a.net || a.sort - b.sort);
  return `<section class="section">
  ${sectionHead('04', 'Menu ranking', 'อันดับเมนู', `${num(byQty.length)} items ranked`)}
  <p class="lead">Popularity is the net number of servings accepted and not cancelled. A weight-priced cut counts as one serving per confirmed portion,
    with its grams shown separately; a gram is never ranked like a plate. Variants roll up to their dish. ${esc(rk.tie_policy)}</p>
  ${h3('Most ordered', 'สั่งมากที่สุด')}${table(shortCols, top, { empty: 'No accepted items this year.' })}
  ${h3('Least ordered', 'สั่งน้อยที่สุด')}
  ${table(shortCols, least, { empty: 'No eligible items.' })}
  <p class="caption">Least ordered includes items with no orders when they were published, priced and verified for ordering, in season, and logged as
    available at some point. Items without orders were left out as: not published ${num(rk.excluded.unpublished)}, archived ${num(rk.excluded.archived)},
    not orderable ${num(rk.excluded.not_orderable)}, out of season ${num(rk.excluded.out_of_season)}, no logged availability ${num(rk.excluded.not_available)}.
    Low numbers describe ordering only; they say nothing about taste, quality or price.</p>

  <div class="two">
    <div class="block">${h3('Priced by weight', 'เมนูคิดราคาตามน้ำหนัก')}
    ${table<RankRow>([
      { head: 'Cut', cell: (r) => biName(r.name, loc) },
      { head: 'Servings', num: true, cell: (r) => num(r.net_qty), width: '15mm' },
      { head: 'Weight', num: true, cell: (r) => grams(r.grams), width: '15mm' },
      { head: 'Avg', num: true, cell: (r) => (r.net_qty ? grams(Math.round(r.grams / r.net_qty)) : '–'), width: '12mm' },
      ...(fin ? [{ head: 'Accepted value', num: true, cell: (r: RankRow) => money(r.accepted_minor), width: '20mm' }] : []),
    ], measured, { cls: 'compact', empty: 'No weight-priced items on the menu.' })}
    <p class="caption">Grams are the measured weights staff quoted and the guest confirmed. Unconfirmed quotes never count.</p></div>
    <div class="block">${h3('By category', 'ตามหมวดหมู่')}
    ${table<(typeof catRows)[number]>([
      { head: 'Category', cell: (c) => `${oneName(c.name, 'en')}${c.name.th ? ` <span class="muted" lang="th">${esc(c.name.th)}</span>` : ''}` },
      { head: 'Items', num: true, cell: (c) => `${num(c.items)}${c.zero ? ` <span class="muted">(${num(c.zero)} at 0)</span>` : ''}`, width: '20mm' },
      { head: 'Net servings', num: true, cell: (c) => num(c.net), width: '19mm' },
      { head: 'Share', num: true, cell: (c) => pct(rk.total_net ? c.net / rk.total_net : null), width: '13mm' },
    ], catRows, { cls: 'compact' })}</div>
  </div>
</section>`;
}

export async function rankingAppendix(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const loc = s.default_locale;
  const fin = Boolean(s.payments);
  // Landscape content width is 269 mm; the last column takes what is left.
  const cols: Col<RankRow>[] = [
    { head: 'Rank', cell: (r) => `<span class="rank">${r.rank}</span>`, width: '9mm' },
    { head: 'Item', cell: (r) => biName(r.name, loc), width: fin ? '46mm' : '54mm' },
    { head: 'Category', cell: (r) => oneName(r.category, 'en'), width: '24mm' },
    { head: 'Net', num: true, cell: (r) => num(r.net_qty), width: '10mm' },
    { head: 'Subm.', num: true, cell: (r) => num(r.submitted_qty), width: '11mm' },
    { head: 'Rej. / canc.', num: true, cell: (r) => `${num(r.rejected_qty)} / ${num(r.cancelled_qty)}`, width: '16mm' },
    { head: 'Orders', num: true, cell: (r) => num(r.orders), width: '12mm' },
    { head: 'Visits', num: true, cell: (r) => num(r.visits), width: '11mm' },
    { head: 'Share', num: true, cell: (r) => pct(r.share), width: '11mm' },
    { head: 'In cat.', num: true, cell: (r) => pct(r.category_share), width: '12mm' },
    { head: 'Avail. days', num: true, cell: (r) => (r.available_days === null ? 'not logged' : `${num(r.available_days)}/${num(r.period_days)}`), width: '16mm' },
    { head: 'Per day', num: true, cell: (r) => (r.per_available_day === null ? '–' : num(r.per_available_day, 2)), width: '11mm' },
    ...(fin ? [{ head: 'Accepted value', num: true, cell: (r: RankRow) => money(r.accepted_minor), width: '19mm' }] : []),
    { head: 'Ordered', cell: (r) => (r.first_ordered ? `<span class="nowrap">${dateShort(r.first_ordered)} – ${dateShort(r.last_ordered!)}</span>` : '–'), width: '22mm' },
    { head: 'Variants (net) and context', cell: (r) => [variants(r, loc), context(r)].filter(Boolean).join('<br>') },
  ];
  const body = await rowsChunked(s.ranking.rows, (r) => tr(cols, r), tick);
  return `<section class="wide">
  ${sectionHead('04b', 'Full item ranking', 'อันดับเมนูทั้งหมด', `${num(s.ranking.rows.length)} items · ${num(s.ranking.zero_order_items)} with zero orders`)}
  <p class="small muted">Share = item's net servings / all net servings. In category = share of its category. Available days = business days, from the later of
    1 January and the first operating day up to ${s.year_state === 'current' ? 'today' : '31 December'}, on which the item was logged as available at any moment
    (${num(s.ranking.rows[0]?.period_days ?? 0)} days in scope). Rarely available = under 2 days or under 25% of those days; "not logged" means the menu history
    has no availability record, which is not the same as unavailable. Per available day = net servings / available days. Subm. = submitted quantity, including lines later rejected or cancelled. Ordered = first and last day with an
    accepted serving. Grams for weight-priced cuts are on the previous page.</p>
  <table${tableClass(cols, 'dense')}>${thead(cols)}<tbody>${body}</tbody></table>
</section>`;
}
