// Charges (list editor with a live example worked out by shared/money
// computeBill) and payment methods. Charges apply only to visits seated after
// saving; payment method changes apply at the next payment.
import { useState } from 'react';
import { computeBill, formatMoney, type ChargeRule } from '../../../../shared/money.ts';
import type { PaymentMethod, Settings } from '../../../../shared/settings.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Checkbox, EmptyState, IconButton, SegmentedControl, Switch, Tag, TextField } from '../../ui/index.ts';
import { KeyValue } from '../../ui/admin/index.ts';
import { NumberField, numberProblem, usePlural } from './shared.tsx';
import { FieldRow, SettingsSection, SwitchRow } from './settingsParts.tsx';

const MAX_CHARGES = 6;
const MAX_METHODS = 10;

/** Editable form of a charge: percent and baht as typed numbers. */
interface ChargeDraft {
  id: string;
  label_th: string;
  label_en: string;
  kind: 'percent' | 'fixed';
  percent: number | null;
  baht: number | null;
  inclusive: boolean;
  enabled: boolean;
}

function toDraft(r: ChargeRule): ChargeDraft {
  return {
    id: r.id,
    label_th: r.label_th,
    label_en: r.label_en,
    kind: r.kind,
    percent: r.kind === 'percent' ? (r.basis_points ?? 0) / 100 : null,
    baht: r.kind === 'fixed' ? (r.amount_minor ?? 0) / 100 : null,
    inclusive: r.kind === 'percent' ? r.inclusive : false,
    enabled: r.enabled,
  };
}

function toRule(c: ChargeDraft, sort: number): ChargeRule {
  // Labels are kept exactly as typed while editing (trimmed only when saving).
  const base = { id: c.id, label_th: c.label_th, label_en: c.label_en, enabled: c.enabled, sort };
  return c.kind === 'percent'
    ? { ...base, kind: 'percent', basis_points: Math.round((c.percent ?? 0) * 100), inclusive: c.inclusive }
    : { ...base, kind: 'fixed', amount_minor: Math.round((c.baht ?? 0) * 100), inclusive: false };
}

function ruleValid(c: ChargeDraft): boolean {
  if (!c.label_th.trim() || !c.label_en.trim()) return false;
  return c.kind === 'percent' ? numberProblem(c.percent, 0.01, 30) === null : numberProblem(c.baht, 0.01, 10000) === null;
}

function newChargeId(existing: string[]): string {
  for (;;) {
    const id = `charge-${Math.random().toString(36).slice(2, 8)}`;
    if (!existing.includes(id)) return id;
  }
}

function Example({ charges }: { charges: ChargeDraft[] }) {
  const { t, lang } = useI18n();
  const plural = usePlural();
  const [subtotal, setSubtotal] = useState<number | null>(1000);
  const valid = charges.filter(ruleValid);
  const rules = valid.map((c, i) => toRule(c, i));
  const sub = subtotal !== null && Number.isFinite(subtotal) && subtotal >= 0 ? Math.round(subtotal * 100) : 0;
  const bill = computeBill({ lineTotals: [sub], adjustments: [], charges: rules });
  const skipped = charges.length - valid.length;
  const pctText = (bp?: number) => (bp === undefined ? '' : ` ${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
  return (
    <aside className="charge-ex" aria-labelledby="charge-ex-h">
      <h3 id="charge-ex-h" className="charge-ex__h">{t('settings.charges.example')}</h3>
      <NumberField label={t('settings.charges.exampleSub')} value={subtotal} onChange={setSubtotal} min={0} max={1000000} decimals={2} prefix="฿" />
      <div aria-live="polite">
        <KeyValue
          items={[
            { key: 'sub', term: t('settings.charges.exFood'), value: formatMoney(bill.subtotal_minor) },
            ...bill.charges.map((c) => ({
              key: c.id,
              term: <span lang={lang === 'th' ? 'th' : 'en'}>{(lang === 'th' ? c.label_th : c.label_en) + pctText(c.basis_points)}</span>,
              value: c.inclusive ? t('settings.charges.exIncluded', { amount: formatMoney(c.amount_minor) }) : formatMoney(c.amount_minor, { sign: true }),
              muted: c.inclusive,
            })),
            { key: 'total', term: t('settings.charges.exTotal'), value: formatMoney(bill.total_minor), strong: true },
          ]}
        />
      </div>
      {rules.filter((r) => r.enabled).length === 0 ? <p className="mp-meta">{t('settings.charges.exNone')}</p> : null}
      {skipped > 0 ? <p className="mp-meta">{plural('settings.charges.exSkipped', skipped)}</p> : null}
      <p className="mp-meta">{t('settings.charges.exRule')}</p>
    </aside>
  );
}

export function ChargesSection() {
  const { t } = useI18n();
  // Charges are kept in their editable form in a local list mirrored into the draft on every change.
  return (
    <SettingsSection
      id="charges"
      keys={['charges', 'charges_confirmed'] as const}
      title={t('settings.charges.title')}
      description={t('settings.charges.d')}
      scopeNote={t('settings.charges.scope')}
      toPatch={(d) => ({
        charges_confirmed: d.charges_confirmed,
        charges: d.charges.map((r, i) => ({ ...r, label_th: r.label_th.trim(), label_en: r.label_en.trim(), sort: i })),
      })}
      validate={(d) => {
        const e: Record<string, string> = {};
        d.charges.forEach((r, i) => {
          if (!r.label_th.trim()) e[`charges.${i}.label_th`] = t('settings.err.required');
          if (!r.label_en.trim()) e[`charges.${i}.label_en`] = t('settings.err.required');
          if (r.kind === 'percent' && (!Number.isInteger(r.basis_points) || (r.basis_points ?? 0) < 1 || (r.basis_points ?? 0) > 3000)) e[`charges.${i}.basis_points`] = t('settings.err.percent');
          if (r.kind === 'fixed' && (!Number.isInteger(r.amount_minor) || (r.amount_minor ?? 0) < 1 || (r.amount_minor ?? 0) > 1_000_000)) e[`charges.${i}.amount_minor`] = t('settings.err.amount');
        });
        return e;
      }}
      confirm={(d, b) => {
        const before = b.charges.filter((c) => c.enabled).length;
        const after = d.charges.filter((c) => c.enabled).length;
        if (before === 0 && after === 0) return null;
        return {
          title: t('settings.charges.confirmTitle'),
          body: (
            <>
              <p>{t('settings.charges.confirmBody')}</p>
              {!d.charges_confirmed && after > 0 ? <p className="mp-warn">{t('settings.charges.unconfirmedWarn')}</p> : null}
            </>
          ),
          confirmLabel: t('settings.charges.confirmSave'),
        };
      }}
    >
      {({ draft, set, err }) => {
        const list = draft.charges.map(toDraft);
        const commit = (next: ChargeDraft[]) => set('charges', next.map((c, i) => {
          // keep in-progress numbers as NaN-safe integers; validation reports them
          const rule = toRule(c, i);
          if (c.kind === 'percent' && (c.percent === null || Number.isNaN(c.percent))) rule.basis_points = Number.NaN;
          if (c.kind === 'fixed' && (c.baht === null || Number.isNaN(c.baht))) rule.amount_minor = Number.NaN;
          return rule;
        }) as Settings['charges']);
        const update = (i: number, patch: Partial<ChargeDraft>) => commit(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
        const move = (i: number, dir: -1 | 1) => {
          const next = [...list];
          const [x] = next.splice(i, 1);
          next.splice(i + dir, 0, x);
          commit(next);
        };
        return (
          <div className="charges">
            <div className="charges__list">
              {list.length === 0 ? (
                <EmptyState compact icon="receipt" headingLevel={3} title={t('settings.charges.none')}>{t('settings.charges.noneD')}</EmptyState>
              ) : (
                <ol className="charge-list">
                  {list.map((c, i) => {
                    const name = c.label_en || c.label_th || t('settings.charges.untitled', { n: i + 1 });
                    return (
                      <li key={c.id} className={c.enabled ? 'charge' : 'charge is-off'}>
                        <div className="charge__head">
                          <span className="charge__n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                          <Switch density="staff" checked={c.enabled} onChange={(v) => update(i, { enabled: v })} label={t('settings.charges.enabled')} />
                          <span className="charge__tools">
                            <IconButton icon="chev-d" className="charge__up" size="staff" label={t('settings.charges.up', { name })} disabled={i === 0} onClick={() => move(i, -1)} />
                            <IconButton icon="chev-d" size="staff" label={t('settings.charges.down', { name })} disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                            <IconButton icon="x" size="staff" label={t('settings.charges.remove', { name })} onClick={() => commit(list.filter((_, j) => j !== i))} />
                          </span>
                        </div>
                        <FieldRow>
                          <TextField density="staff" label={t('settings.charges.labelTh')} value={c.label_th} maxLength={60} onChange={(e) => update(i, { label_th: e.target.value })} error={err(`charges.${i}.label_th`)} />
                          <TextField density="staff" lang="en" label={t('settings.charges.labelEn')} value={c.label_en} maxLength={60} onChange={(e) => update(i, { label_en: e.target.value })} error={err(`charges.${i}.label_en`)} />
                        </FieldRow>
                        <div className="charge__kind">
                          <span className="charge__k" id={`charge-kind-${c.id}`}>{t('settings.charges.kind')}</span>
                          <SegmentedControl<'percent' | 'fixed'>
                            size="staff"
                            label={t('settings.charges.kindOf', { name })}
                            value={c.kind}
                            onChange={(k) => update(i, k === 'percent' ? { kind: k, percent: c.percent ?? 10, baht: null } : { kind: k, baht: c.baht ?? 100, percent: null, inclusive: false })}
                            options={[{ value: 'percent', label: t('settings.charges.percent') }, { value: 'fixed', label: t('settings.charges.fixed') }]}
                          />
                        </div>
                        <FieldRow>
                          {c.kind === 'percent' ? (
                            <NumberField label={t('settings.charges.rate')} value={c.percent} onChange={(v) => update(i, { percent: v })} min={0.01} max={30} decimals={2} suffix="%" help={t('settings.charges.rateHelp')} error={err(`charges.${i}.basis_points`)} />
                          ) : (
                            <NumberField label={t('settings.charges.amount')} value={c.baht} onChange={(v) => update(i, { baht: v })} min={0.01} max={10000} decimals={2} prefix="฿" help={t('settings.charges.amountHelp')} error={err(`charges.${i}.amount_minor`)} />
                          )}
                          <div className="charge__incl">
                            <Checkbox
                              checked={c.kind === 'percent' && c.inclusive}
                              disabled={c.kind === 'fixed'}
                              onChange={(e) => update(i, { inclusive: e.target.checked })}
                              label={t('settings.charges.inclusive')}
                              description={c.kind === 'fixed' ? t('settings.charges.fixedAdded') : c.inclusive ? t('settings.charges.inclusiveD') : t('settings.charges.exclusiveD')}
                            />
                          </div>
                        </FieldRow>
                        {err(`charges.${i}`) ? <p className="field__error">{err(`charges.${i}`)}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="charges__add">
                <Button
                  variant="outline"
                  size="staff"
                  icon="plus"
                  disabled={list.length >= MAX_CHARGES}
                  onClick={() => commit([...list, { id: newChargeId(list.map((c) => c.id)), label_th: '', label_en: '', kind: 'percent', percent: 10, baht: null, inclusive: false, enabled: false }])}
                >
                  {t('settings.charges.add')}
                </Button>
                <span className="mp-meta">{t('settings.charges.max', { n: MAX_CHARGES })}</span>
              </div>
              <div className="setswitch">
                <Checkbox
                  checked={draft.charges_confirmed}
                  onChange={(e) => set('charges_confirmed', e.target.checked)}
                  label={t('settings.charges.confirmed')}
                  description={draft.charges_confirmed ? t('settings.charges.confirmedOn') : t('settings.charges.confirmedOff')}
                />
                {!draft.charges_confirmed ? <Tag tone="example">{t('settings.charges.notConfirmedTag')}</Tag> : null}
              </div>
            </div>
            <Example charges={list} />
          </div>
        );
      }}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ payment methods
export function PaymentMethodsSection() {
  const { t, lang } = useI18n();
  return (
    <SettingsSection
      id="payments"
      keys={['payment_methods'] as const}
      title={t('settings.pay.title')}
      description={t('settings.pay.d')}
      validate={(d) => {
        const e: Record<string, string> = {};
        d.payment_methods.forEach((m, i) => {
          if (!m.label_th.trim()) e[`payment_methods.${i}.label_th`] = t('settings.err.required');
          if (!m.label_en.trim()) e[`payment_methods.${i}.label_en`] = t('settings.err.required');
        });
        if (!d.payment_methods.some((m) => m.enabled)) e.payment_methods = t('settings.err.oneMethod');
        return e;
      }}
      toPatch={(d) => ({ payment_methods: d.payment_methods.map((m) => ({ ...m, label_th: m.label_th.trim(), label_en: m.label_en.trim() })) })}
    >
      {({ draft, base, set, err }) => {
        const list = draft.payment_methods;
        const saved = new Set(base.payment_methods.map((m) => m.id));
        const update = (i: number, patch: Partial<PaymentMethod>) => set('payment_methods', list.map((m, j) => (j === i ? { ...m, ...patch } : m)));
        const nameOf = (m: PaymentMethod) => (lang === 'th' ? m.label_th || m.label_en : m.label_en || m.label_th) || m.id;
        return (
          <>
            <ul className="paylist">
              {list.map((m, i) => (
                <li key={m.id} className={m.enabled ? 'paym' : 'paym is-off'}>
                  <div className="paym__head">
                    <Switch density="staff" checked={m.enabled} onChange={(v) => update(i, { enabled: v })} label={t('settings.pay.enabled', { name: nameOf(m) })} />
                    <span className="paym__id" lang="en">{m.id}</span>
                    {!saved.has(m.id) ? (
                      <IconButton icon="x" size="staff" label={t('settings.pay.remove', { name: nameOf(m) })} onClick={() => set('payment_methods', list.filter((_, j) => j !== i))} />
                    ) : null}
                  </div>
                  <FieldRow>
                    <TextField density="staff" label={t('settings.pay.labelTh')} value={m.label_th} maxLength={40} onChange={(e) => update(i, { label_th: e.target.value })} error={err(`payment_methods.${i}.label_th`)} />
                    <TextField density="staff" lang="en" label={t('settings.pay.labelEn')} value={m.label_en} maxLength={40} onChange={(e) => update(i, { label_en: e.target.value })} error={err(`payment_methods.${i}.label_en`)} />
                  </FieldRow>
                  <SwitchRow help={m.tendered ? t('settings.pay.tenderedOn') : t('settings.pay.tenderedOff')}>
                    <Checkbox checked={m.tendered} onChange={(e) => update(i, { tendered: e.target.checked })} label={t('settings.pay.tendered')} />
                  </SwitchRow>
                  {m.payment_qr_image ? <p className="mp-meta">{t('settings.pay.qr', { name: m.payment_qr_image })}</p> : null}
                </li>
              ))}
            </ul>
            {err('payment_methods') && !list.some((m) => m.enabled) ? <p className="field__error">{err('payment_methods')}</p> : null}
            <div className="charges__add">
              <Button
                variant="outline"
                size="staff"
                icon="plus"
                disabled={list.length >= MAX_METHODS}
                onClick={() => set('payment_methods', [...list, { id: `method-${Math.random().toString(36).slice(2, 7)}`, label_th: '', label_en: '', enabled: false, tendered: false }])}
              >
                {t('settings.pay.add')}
              </Button>
              <span className="mp-meta">{t('settings.pay.addHelp')}</span>
            </div>
          </>
        );
      }}
    </SettingsSection>
  );
}
