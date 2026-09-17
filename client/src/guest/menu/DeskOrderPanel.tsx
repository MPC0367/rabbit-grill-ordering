// Desktop (≥ 1080) persistent order panel beside the menu (DESIGN §8.1):
// "รายการของฉัน · ร่างในเครื่องนี้", the draft lines, the food total, the
// unsent warning and one primary action that opens the review-and-send page
// (the submission flow itself lives on /menu/cart).
import { useI18n } from '../../lib/i18n.tsx';
import { Card, Icon, LinkButton, OrderLine, RunningTotal, Tag } from '../../ui/index.ts';
import { useCart } from '../cart/store.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { useGuestSession } from '../shell/session.tsx';

const MAX_LINES = 5;

export function DeskOrderPanel() {
  const { t } = useI18n();
  const { mode } = useGuestSession();

  if (mode === 'loading') return null;
  if (mode !== 'joined') {
    return (
      <div className="cartpanel">
        <Card padded className="mpanel mpanel--quiet">
          <h2 className="cartpanel__t">{t('menu.panel.public.title')}</h2>
          <p className="support mpanel__body">
            {t(mode === 'ended' ? 'menu.panel.ended.body' : 'menu.panel.public.body')}
          </p>
        </Card>
      </div>
    );
  }
  return <JoinedPanel />;
}

function JoinedPanel() {
  const { t, pick } = useI18n();
  const { item: catalogItem } = useCatalog();
  const cart = useCart();
  const views = cart.views;
  const shown = views.slice(0, MAX_LINES);
  const hidden = views.length - shown.length;

  return (
    <div className="cartpanel">
      <Card as="section" padded className="mpanel" aria-labelledby="mpanel-title">
        <h2 className="cartpanel__t" id="mpanel-title">
          {t('common.nav.order')} <span className="meta">· {t('menu.panel.draft')}</span>
        </h2>
        {views.length === 0 ? (
          <div className="mpanel__empty">
            <p className="mpanel__empty-t">{t('menu.panel.empty.title')}</p>
            <p className="support">{t('menu.panel.empty.body')}</p>
          </div>
        ) : (
          <>
            <ul className="cartpanel__list">
              {shown.map((v) => {
                const live = catalogItem(v.line.item_id);
                const name = pick(live?.name ?? v.line.name);
                const variant = v.line.variant_name ? pick(v.line.variant_name) : null;
                const options = v.line.option_names.flatMap((g) => g.options.map((o) => pick(o)));
                const bits = [variant, ...options].filter((b): b is NonNullable<typeof b> => Boolean(b && b.text));
                return (
                  <OrderLine
                    key={v.line.uid}
                    name={name.text}
                    nameLang={name.lang}
                    image={live?.image ?? v.line.image}
                    quantity={v.line.quantity}
                    totalMinor={v.totalMinor}
                    options={bits.length ? (
                      <span className="mpanel__opts">
                        {bits.map((b, i) => <span key={i} lang={b.lang}>{b.text}</span>)}
                      </span>
                    ) : undefined}
                    note={v.line.note}
                    issue={v.issues.length ? t('common.reviewNeeded') : undefined}
                  />
                );
              })}
            </ul>
            {hidden > 0 ? <p className="meta mpanel__more">{t('menu.panel.more', { n: hidden })}</p> : null}
            <RunningTotal
              label={t('menu.panel.total', { n: cart.count })}
              totalMinor={cart.subtotalMinor}
              size="total"
              note={(
                <>
                  {cart.reviewNeeded ? <Tag tone="alert" icon="alert">{t('common.reviewNeeded')}</Tag> : null}
                  <span className="mpanel__note">{t('menu.panel.note')}</span>
                </>
              )}
            />
            <LinkButton
              href="/menu/cart"
              variant="primary"
              size="lg"
              block
              className="cartpanel__send"
              priceMinor={cart.subtotalMinor}
            >
              {t('menu.panel.review')}
            </LinkButton>
          </>
        )}
      </Card>
      <p className="support cartpanel__foot"><Icon name="info" size="sm" />{t('menu.panel.foot')}</p>
    </div>
  );
}
