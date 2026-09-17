// Guest kit specimens for /ui-kit (development only). Names, prices and
// photos come from data-src/catalog.json and public/media/dish; table,
// times, references and the draft are fixtures (labelled as such).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AllergenInfoDTO, Bilingual } from '../../../shared/dto.ts';
import type { JobStatus, LineStatus, OrderStatus, ServiceStatus, TableState } from '../../../shared/status.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useConfirmFlash } from './cx.ts';
import { Icon, ICON_NAMES } from './Icon.tsx';
import { Button, IconButton, LinkButton, TextLink } from './Button.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { Tabs } from './Tabs.tsx';
import { Badge, Chip, Flag, Pill, StatusPill, Tag } from './Badge.tsx';
import { Leader, Price } from './Price.tsx';
import { LangToggle, TableTag, Wordmark } from './Brand.tsx';
import { Stepper } from './Stepper.tsx';
import { Checkbox, ChoiceGroup, RadioCard, Select, Switch, TextArea, TextField } from './Field.tsx';
import { SearchField } from './SearchField.tsx';
import { Dialog, Drawer, Sheet } from './Sheet.tsx';
import { Banner } from './Banner.tsx';
import { Toast, useToast, LiveRegion } from './Toast.tsx';
import { EmptyState, Skeleton, SkeletonDishRow } from './Feedback.tsx';
import { ConnectionIndicator } from './ConnectionIndicator.tsx';
import { DishImage, type DishImageSource } from './DishImage.tsx';
import { DishRow, MenuSection, type DishRowItem, type DishRowProps } from './DishRow.tsx';
import { AllCategoriesSheet, CategoryRow, CategorySidebar, type CategoryListGroup, type CategoryTab } from './CategoryRow.tsx';
import { BottomNav, CartBar, Dock, GuestNav, ServiceKey, useGuestNavItems, type CartBarState } from './Dock.tsx';
import { DishLines, DishStatusLine, PastRound, RoundCard, Timeline, type TimelineStep } from './Timeline.tsx';
import { PortionQuote, type PortionQuoteState } from './PortionQuote.tsx';
import { AllergyNotice, Card, GuestHeader, ListRow, OrderLine, PageHead, RunningTotal, ServiceMenu, UnsentCard } from './Guest.tsx';

// ---------------------------------------------------------------- fixtures
const bi = (th: string | null, en: string | null): Bilingual => ({ th, en });
const img = (name: string, big: number, th: string, en: string): DishImageSource => ({
  name, sizes: [240, 480, big], w: big, h: Math.round(big * 0.75), alt: bi(th, en),
});
const IMG = {
  primeRib: img('primerib-full', 960, 'ไพร์มริบหั่นชิ้นบนถาดสเตนเลส', 'Sliced prime rib on a steel platter'),
  wagyu: img('wagyu-tenderloin', 788, 'เนื้อสันในวากิวสองชิ้นหนาในซอสไวน์แดง', 'Two thick slices of rare wagyu tenderloin in red wine jus'),
  striploin: img('striploin', 872, 'เนื้อสันนอกหั่นเป็นชิ้นบนจานเหล็ก', 'Sliced striploin on a steel plate'),
  tongue: img('grilled-tongue', 960, 'ลิ้นวัวย่างหั่นชิ้นบนถาดสเตนเลส', 'Sliced grilled beef tongue on a steel platter'),
  prawns: img('river-prawns', 720, 'กุ้งแม่น้ำย่างผ่าครึ่งในซอสสีส้ม', 'A halved grilled river prawn in an orange sauce'),
  chicken: img('baby-chicken', 960, 'ไก่ย่างตัวเล็กคลุกเครื่องเทศ', 'Grilled baby chicken'),
  ribs: img('pork-ribs', 868, 'ซี่โครงหมูย่าง', 'Grilled pork ribs'),
  fish: img('grilled-fish', 672, 'ปลาย่างทั้งตัว', 'Whole grilled fish'),
  calamari: img('calamari', 868, 'หมึกชุบเกล็ดขนมปังทอดพร้อมซอสทาร์ทาร์', 'Breaded fried squid with tartar sauce'),
  cornRib: img('corn-rib', 960, 'คอร์นริบ', 'Corn rib'),
  mushrooms: img('mushrooms', 624, 'เห็ดรวมผัดโรยสมุนไพร', 'Sautéed mixed mushrooms with herbs'),
  salad: img('green-salad', 760, 'ผักสลัดรวมกับมะเขือเทศเชอร์รี่', 'Mixed leaves with cherry tomatoes'),
  caesar: img('caesar', 960, 'กริลลซีซาร์สลัด', 'Grilled Caesar salad'),
  lamb: img('lamb-rack', 868, 'ซี่โครงแกะย่างตัดเป็นชิ้น', 'Grilled lamb rack cut into chops'),
  broken: img('corn-rib-missing', 960, 'ภาพที่โหลดไม่ได้', 'A photo that fails to load'),
};

function dish(p: Partial<DishRowItem> & Pick<DishRowItem, 'id' | 'name'>): DishRowItem {
  return {
    pricing_type: 'fixed', price_minor: null, rate_minor: null, rate_basis_grams: null, variants: [], image: null,
    sold_out: false, orderable: true, unavailable_reason: null, quick_add: true, portion_note: null, max_qty: 10,
    ...p,
  };
}

const D = {
  primeRib: dish({ id: 'prime-rib', name: bi('ไพร์มริบ', 'Prime Rib'), pricing_type: 'measured_weight', rate_minor: 49000, rate_basis_grams: 100, image: IMG.primeRib, quick_add: false }),
  wagyu: dish({ id: 'wagyu', name: bi('เนื้อสันในวากิวย่างซอสไวน์แดง', 'Wagyu Tenderloin MB 6–7 with Red Wine Jus'), price_minor: 199000, image: IMG.wagyu, portion_note: bi('300 กรัม', '300 g') }),
  striploin: dish({ id: 'striploin', name: bi('เนื้อสันนอกออสเตรเลีย', 'Australian Striploin'), price_minor: 59000, image: IMG.striploin, quick_add: false }),
  tongue: dish({ id: 'tongue', name: bi('ลิ้นวัวย่าง', 'Grilled Tongue'), price_minor: 59000, image: IMG.tongue, sold_out: true, orderable: false, unavailable_reason: 'sold_out' }),
  stew: dish({ id: 'stew', name: bi('สตูว์ลิ้นวัว', 'Beef Tongue Stew'), price_minor: 49000 }),
  prawns: dish({ id: 'prawns', name: bi('กุ้งแม่น้ำย่าง', 'Grilled River Prawns'), price_minor: 99000, image: IMG.prawns }),
  chicken: dish({ id: 'chicken', name: bi('ไก่ย่างตัวเล็กคลุกเครื่องเทศ', 'Grilled Baby Chicken'), price_minor: 59000, image: IMG.chicken }),
  ribs: dish({ id: 'ribs', name: bi('ซี่โครงหมูย่าง', 'Grilled Pork Ribs'), price_minor: 59000, image: IMG.ribs }),
  fish: dish({ id: 'fish', name: bi('ปลาย่าง', 'Grilled Fish'), price_minor: 49000, image: IMG.fish }),
  calamari: dish({ id: 'calamari', name: bi('หมึกชุบเกล็ดขนมปังทอดเสิร์ฟพร้อมซอสทาร์ทาร์', 'Calamari Served with Tartar Sauce'), price_minor: 39000, image: IMG.calamari }),
  lamb: dish({ id: 'lamb', name: bi('ซี่โครงแกะย่าง', 'Grilled Lamb Rack'), pricing_type: 'variant', image: IMG.lamb, orderable: false, unavailable_reason: 'price_pending', quick_add: false,
    variants: [{ id: 'a', key: 'price-a', name: bi('ราคา A', 'Price A'), price_minor: 89000, available: true }, { id: 'b', key: 'price-b', name: bi('ราคา B', 'Price B'), price_minor: 159000, available: true }] }),
  broken: dish({ id: 'broken', name: bi('คอร์นริบ', 'Corn Rib'), price_minor: 15000, image: IMG.broken }),
  hoegaarden: dish({ id: 'hoegaarden', name: bi(null, 'Hoegaarden White'), pricing_type: 'variant', quick_add: false,
    variants: [{ id: 'h1', key: '250ml', name: bi('250 มล.', '250 ml'), price_minor: 18000, available: true }, { id: 'h2', key: '500ml', name: bi('500 มล.', '500 ml'), price_minor: 29500, available: true }] }),
  latte: dish({ id: 'latte', name: bi(null, 'Latte'), pricing_type: 'variant', quick_add: false,
    variants: [{ id: 'l1', key: 'hot', name: bi('ร้อน', 'Hot'), price_minor: 8000, available: true }, { id: 'l2', key: 'iced', name: bi('เย็น', 'Iced'), price_minor: 8000, available: true }] }),
};

// Bangkok fixture times on 17 Sep 2026 (UTC+7)
const at = (hhmm: string) => `2026-09-17T${String(Number(hhmm.slice(0, 2)) - 7).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`;

const FOOD_TABS = [
  ['beef', '01', 'เนื้อ', 'Beef Selection', 6],
  ['grill', '02', 'จานหลักจากเตา', 'From the Grill', 7],
  ['appetizer', '03', 'ของเรียกน้ำย่อย', 'Appetizers', 5],
  ['salad', '04', 'สลัด', 'Salads', 5],
  ['rice', '05', 'ข้าว', 'Rice', 3],
  ['sides', '06', 'เครื่องเคียง', 'Side Dishes', 7],
  ['dessert', '07', 'ของหวาน', 'Dessert', 2],
] as const;
const DRINK_TABS = [
  ['matcha', '01', 'มัทฉะพิเศษ', 'Special Matcha', 12],
  ['coffee', '02', null, 'Coffee', 14],
  ['milky', '03', 'นม', 'Milky', 5],
  ['soda', '04', 'โซดา', 'Soda', 3],
  ['juice', '05', 'น้ำผลไม้สด', 'Fresh Juice', 4],
  ['draft', '06', 'เบียร์สด', 'Draft Beer', 3],
  ['bottled', '07', 'เบียร์ขวด', 'Bottled Beer', 3],
] as const;

const UNKNOWN_ALLERGENS: AllergenInfoDTO = { status: 'unknown', entries: [], verified_at: null };
const EXAMPLE_ALLERGENS: AllergenInfoDTO = {
  status: 'verified',
  entries: [{ allergen: 'นม', state: 'contains', note: null }, { allergen: 'ถั่ว', state: 'may_contain', note: null }],
  verified_at: '2026-09-10T03:00:00.000Z',
};

const LINE_STATUSES: LineStatus[] = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served', 'rejected', 'cancelled'];
const ORDER_STATUSES: OrderStatus[] = ['received', 'confirmed', 'preparing', 'ready', 'partially_served', 'served', 'cancelled'];
const SERVICE_STATUSES: ServiceStatus[] = ['sent', 'acknowledged', 'completed', 'cancelled'];
const TABLE_STATES: TableState[] = ['available', 'dining', 'checking_out', 'disabled'];
const JOB_STATUSES: JobStatus[] = ['queued', 'generating', 'ready', 'failed'];

type OpenKey = 'sheet' | 'service' | 'categories' | 'dialog' | 'drawer' | 'weigh' | null;

function initialOpen(): OpenKey {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('open');
  return v === 'sheet' || v === 'service' || v === 'categories' || v === 'dialog' || v === 'drawer' || v === 'weigh' ? v : null;
}

// ---------------------------------------------------------------- layout helpers
function Section({ id, n, th, en, note, children }: { id: string; n: string; th: string; en: string; note?: ReactNode; children: ReactNode }) {
  const { lang } = useI18n();
  return (
    <section className="kit-sec" id={id} aria-labelledby={`${id}-h`}>
      <p className="kit-sec__kick" lang="en" aria-hidden="true">No. {n}</p>
      <div className="kit-sec__title">
        <h3 id={`${id}-h`} lang={lang === 'th' ? 'th' : 'en'}>{lang === 'th' ? th : en}</h3>
        {lang === 'th' ? <p className="en" lang="en">{en}</p> : null}
      </div>
      {note ? <p className="kit-sec__note">{note}</p> : null}
      {children}
    </section>
  );
}

function Spec({ label, note, children, className }: { label: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `kit-spec ${className}` : 'kit-spec'}>
      <p className="kit-spec__k" lang="en">{label}</p>
      {children}
      {note ? <p className="kit-spec__note">{note}</p> : null}
    </div>
  );
}

export const GUEST_SECTIONS: Array<[string, string]> = [
  ['g-foundations', 'Foundations'],
  ['g-actions', 'Actions'],
  ['g-controls', 'Controls'],
  ['g-chrome', 'Masthead & categories'],
  ['g-menu', 'DishRow'],
  ['g-sheets', 'Sheets'],
  ['g-fields', 'Fields'],
  ['g-status', 'Status'],
  ['g-feedback', 'Feedback'],
  ['g-track', 'Track'],
  ['g-order', 'Your order'],
  ['g-dock', 'Dock'],
];

// ---------------------------------------------------------------- component
export default function GalleryGuest() {
  const { t, lang, pick, both } = useI18n();
  const toast = useToast();
  const L = (th: string, en: string) => (lang === 'th' ? th : en);

  const [open, setOpen] = useState<OpenKey>(initialOpen);
  const close = () => setOpen(null);

  // menu state
  const [group, setGroup] = useState<'food' | 'drinks'>('food');
  const [cat, setCat] = useState('beef');
  const [search, setSearch] = useState('');
  const [ribsQty, setRibsQty] = useState(1);
  const [striploinQty, setStriploinQty] = useState(1);
  const [prawnsQty, setPrawnsQty] = useState(0);
  const [prawnsConfirmed, flashPrawns] = useConfirmFlash();
  const [busyAdd, setBusyAdd] = useState(false);

  // sheet state
  const [doneness, setDoneness] = useState<string>('medium');
  const [note, setNote] = useState('ขอจานแบ่ง 2 ใบ');
  const [sheetQty, setSheetQty] = useState(1);
  const [missingChoice, setMissingChoice] = useState(false);

  // fields
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(true);
  const [alerts, setAlerts] = useState(true);
  const [sides, setSides] = useState<string[]>(['fries']);

  // controls
  const [seg, setSeg] = useState('week');
  const [tab, setTab] = useState('board');
  const [etab, setEtab] = useState('menu');
  const [nav, setNav] = useState('menu');
  const [cartState, setCartState] = useState<CartBarState>('idle');

  // track
  const [stepIdx, setStepIdx] = useState(2);
  const [quoteState, setQuoteState] = useState<PortionQuoteState>('quoted');

  const draftCount = ribsQty + striploinQty + prawnsQty;
  const draftTotal = ribsQty * 59000 + striploinQty * 59000 + prawnsQty * 99000;
  const navItems = useGuestNavItems({ draftCount, menuHref: '#g-dock', orderHref: '#g-dock', trackHref: '#g-dock' });

  const tabs: CategoryTab[] = useMemo(() => (group === 'food' ? FOOD_TABS : DRINK_TABS).map(([id, n, th, en]) => {
    const p = pick(bi(th, en));
    return { id, numeral: n, label: p.text, lang: p.lang, href: `#g-menu` };
  }), [group, pick]);

  const catGroups: CategoryListGroup[] = [
    { key: 'food', label: lang === 'th' ? 'อาหาร' : 'Food', lang, categories: FOOD_TABS.map(([id, n, th, en, count]) => {
      const b = both(bi(th, en));
      return { id, numeral: n, title: b.primary.text, titleLang: b.primary.lang, secondary: b.secondary?.text, secondaryLang: b.secondary?.lang, count };
    }) },
    { key: 'drinks', label: lang === 'th' ? 'เครื่องดื่ม' : 'Drinks', lang, categories: DRINK_TABS.map(([id, n, th, en, count]) => {
      const b = both(bi(th, en));
      return { id, numeral: n, title: b.primary.text, titleLang: b.primary.lang, secondary: b.secondary?.text, secondaryLang: b.secondary?.lang, count };
    }) },
  ];

  const stepDefs: Array<{ key: string; label: string; at: string }> = [
    { key: 'received', label: t('track.step.received'), at: at('19:42') },
    { key: 'confirmed', label: t('track.step.confirmed'), at: at('19:43') },
    { key: 'cooking', label: t('track.step.cooking'), at: at('19:46') },
    { key: 'almost', label: t('track.step.almostDone'), at: at('19:52') },
    { key: 'ready', label: t('track.step.ready'), at: at('19:55') },
    { key: 'served', label: t('status.served'), at: at('19:58') },
  ];
  const steps: TimelineStep[] = stepDefs.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: i < stepIdx ? 'done' : i === stepIdx ? 'current' : 'upcoming',
    at: i < stepIdx ? s.at : undefined,
    sub: i === stepIdx && s.key === 'cooking' ? L('เริ่ม 19:46 · เสิร์ฟแล้ว 1 จาน · กำลังปรุง 2 จาน', 'Started 19:46 · 1 served · 2 cooking') : undefined,
  }));
  const skippedSteps: TimelineStep[] = [
    { key: 'r', label: t('track.step.received'), state: 'done', at: at('19:08') },
    { key: 'c', label: t('track.step.confirmed'), state: 'done', at: at('19:09') },
    { key: 'p', label: t('track.step.cooking'), state: 'done', at: at('19:14') },
    { key: 'a', label: t('track.step.almostDone'), state: 'skipped' },
    { key: 'y', label: t('track.step.ready'), state: 'done', at: at('19:28') },
    { key: 's', label: t('status.served'), state: 'current' },
  ];

  const dishRowFor = (item: DishRowItem, extra: Partial<DishRowProps> = {}) => (
    <DishRow
      key={item.id}
      item={item}
      onOpen={() => setOpen('sheet')}
      onAdd={() => (item.quick_add ? toast.show(L(`เพิ่ม ${pick(item.name).text} แล้ว`, `Added ${pick(item.name).text}`)) : setOpen('sheet'))}
      onRequestWeigh={() => setOpen('weigh')}
      {...extra}
    />
  );

  const addPrawns = () => {
    setBusyAdd(true);
    window.setTimeout(() => {
      setBusyAdd(false);
      setPrawnsQty((q) => q + 1);
      flashPrawns();
      toast.show({ message: L('เพิ่ม กุ้งแม่น้ำย่าง แล้ว', 'Added Grilled River Prawns'), action: { label: t('common.undo'), onClick: () => setPrawnsQty((q) => Math.max(0, q - 1)) } });
    }, 500);
  };

  const striploinName = pick(D.striploin.name);
  const striploinAlt = both(D.striploin.name).secondary;

  const itemSheetBody = (group: string) => (
    <>
      <DishImage image={IMG.striploin} variant="wide" plateClassName="sheet__photo" loading="eager" />
      <h2 className="sheet__title" id={group === 'modal' ? 'kit-sheet-title' : 'kit-sheet-title-inline'} lang={striploinName.lang}>{striploinName.text}</h2>
      {striploinAlt ? <p className="en en--lg" lang={striploinAlt.lang}>{striploinAlt.text}</p> : null}
      <Leader className="sheet__price" label={<span className="sheet__price-k">{L('ราคา', 'Price')}</span>} value={<Price minor={59000} />} />
      <ChoiceGroup
        className="sheet__block"
        legend={L('ระดับความสุก', 'Doneness')}
        example
        required
        satisfied={Boolean(doneness)}
        rule={L('จำเป็น · เลือก 1 อย่าง', 'Required · choose 1')}
        error={missingChoice && !doneness ? L('เลือกระดับความสุกก่อน', 'Choose a doneness first') : undefined}
      >
        {[['mr', 'มีเดียมแรร์', 'Medium rare'], ['medium', 'มีเดียม', 'Medium'], ['mw', 'มีเดียมเวลล์', 'Medium well']].map(([v, th, en]) => (
          <RadioCard key={v} name={`kit-doneness-${group}`} value={v} checked={doneness === v} onChange={() => setDoneness(v)} label={L(th, en)} aside={t('common.included')} />
        ))}
      </ChoiceGroup>
      <TextArea
        className="sheet__block"
        label={L('หมายเหตุถึงพนักงาน', 'Note to staff')}
        optional
        value={note}
        onChange={setNote}
        limit={120}
        help={L('เป็นคำขอถึงร้าน พนักงานจะยืนยันอีกครั้ง', 'A request to the restaurant. Staff will confirm it.')}
      />
      <AllergyNotice className="sheet__block" allergens={UNKNOWN_ALLERGENS} onCallStaff={() => setOpen('service')} />
    </>
  );
  const itemSheetFoot = (
    <>
      <Stepper variant="plain" size="lg" value={sheetQty} min={1} max={10} onChange={setSheetQty} label={t('common.qtyOf', { name: striploinName.text })} />
      <Button
        variant="primary"
        size="lg"
        priceMinor={59000 * sheetQty}
        onClick={() => {
          if (!doneness) { setMissingChoice(true); return; }
          close();
          toast.show(L(`เพิ่ม ${striploinName.text} แล้ว`, `Added ${striploinName.text}`));
        }}
      >
        {doneness ? L('เพิ่มในรายการ', 'Add to order') : L('เลือกระดับความสุกก่อน', 'Choose a doneness first')}
      </Button>
    </>
  );
  const kicker = <><span lang="en">No. 01</span><span lang={lang}>{L('เนื้อ', 'Beef Selection')}</span></>;

  const serviceItems = [
    { key: 'call', icon: 'bell' as const, title: t('service.call_staff'), sub: L('ส่งแล้ว 19:52 · รอพนักงานรับทราบ', 'Sent 19:52 · waiting for staff'), trailing: <StatusPill kind="service" status="sent" /> },
    { key: 'bill', icon: 'receipt' as const, title: t('service.bill'), sub: L('พนักงานจะสรุปบิลรวมของทั้งโต๊ะ', 'Staff will total the bill for the whole table'), onClick: () => toast.show(L('ส่งคำขอเช็กบิลแล้ว', 'Bill requested')) },
    { key: 'view', icon: 'pad' as const, title: L('ดูบิลของโต๊ะ', 'View the table bill'), sub: L('ค่าอาหารที่ส่งแล้ว ฿3,630 · ยังไม่ใช่ยอดสุดท้าย', 'Sent so far ฿3,630 · not the final amount'), href: '#g-order' },
  ];

  return (
    <div className="kit-guest">
      {/* ------------------------------------------------ foundations */}
      <Section id="g-foundations" n="01" th="พื้นฐาน" en="Foundations" note={L('สีเป็นโทเคนตามบทบาทเท่านั้น ตัวอักษรไทยไม่เว้นระยะ และความสูงบรรทัดไม่ต่ำกว่า 1.55', 'Role tokens only. Thai is never tracked and never set below 1.55 line height.')}>
        <div className="kit-grid">
          <Spec label="Surfaces and roles">
            <div className="kit-swatches">
              {[['canvas', '--canvas'], ['surface', '--surface'], ['sunken', '--sunken'], ['well', '--well'], ['text', '--text'], ['text-2', '--text-2'], ['text-3', '--text-3'], ['action', '--action'], ['selected', '--selected'], ['alert', '--alert'], ['alert-tint', '--alert-tint'], ['heat-tint', '--heat-tint'], ['now (ember)', '--now'], ['inverse', '--inverse']].map(([k, v]) => (
                <span className="kit-swatch" key={k}><i style={{ background: `var(${v})` }} /><b>{k}</b></span>
              ))}
            </div>
          </Spec>
          <Spec label="Type voices">
            <div className="kit-type">
              <div className="kit-type__row"><span>page-th</span><span style={{ font: 'var(--type-page-th)' }}>ติดตามอาหาร</span></div>
              <div className="kit-type__row"><span>section-th</span><span style={{ font: 'var(--type-section-th)' }}>จานหลักจากเตา</span></div>
              <div className="kit-type__row"><span>en-section</span><span className="en" lang="en" style={{ font: 'var(--type-en-section)' }}>From the Grill</span></div>
              <div className="kit-type__row"><span>dish-th</span><span style={{ font: 'var(--type-dish-th)' }}>ไก่ย่างตัวเล็กคลุกเครื่องเทศ</span></div>
              <div className="kit-type__row"><span>en-dish</span><span className="en" lang="en">Grilled Baby Chicken</span></div>
              <div className="kit-type__row"><span>price</span><Price minor={199000} /></div>
              <div className="kit-type__row"><span>kicker</span><span className="msec__kick" lang="en" style={{ display: 'block' }}>No. 02</span></div>
              <div className="kit-type__row"><span>meta-th</span><span className="meta">ส่งเมื่อ 19:42 · 4 รายการ · โต๊ะ 07</span></div>
            </div>
          </Spec>
          <Spec label="The leader · one ember mark">
            <div className="kit-stack kit-stack--fill">
              <Leader label={<span style={{ font: 'var(--type-dish-th)' }}>เนื้อสันนอกออสเตรเลีย</span>} value={<Price minor={59000} />} />
              <Leader label={<span className="support" style={{ color: 'var(--text)' }}>{L('พนักงานชั่งแล้ว', 'Weighed by staff')}</span>} value={<span className="numeral" style={{ fontSize: 'var(--fs-17)' }}>420 {L('กรัม', 'g')}</span>} />
              <Leader label={L('ขั้นถัดไป · ไม่มีค่า ไม่มีจุด', 'Upcoming step · no value, no dots')} />
              <EmberDemo />
            </div>
          </Spec>
          <Spec label={`Icons · ${ICON_NAMES.length}`} className="kit-spec--icons">
            <div className="kit-icons">
              {ICON_NAMES.map((n) => <span className="kit-icon" key={n}><Icon name={n} size="lg" />{n}</span>)}
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ actions */}
      <Section id="g-actions" n="02" th="ปุ่ม" en="Actions" note={L('สีเขียวทึบหนึ่งปุ่มต่อหนึ่งหน้า ปุ่มเพิ่มเป็นเส้นขอบ', 'One solid forest action per view. Add is an outline.')}>
        <div className="kit-grid">
          <Spec label="Variants">
            <div className="kit-row">
              <Button variant="primary">{L('ส่งออเดอร์', 'Send order')}</Button>
              <Button variant="secondary" icon="plus" iconBold className="btn--add">{t('common.add')}</Button>
              <Button variant="outline" icon="bell">{t('service.call_staff')}</Button>
              <Button variant="ghost">{t('common.undo')}</Button>
              <Button variant="quiet">{L('ล้างคำค้นหา', 'Clear search')}</Button>
              <Button variant="danger">{L('ยกเลิกสิทธิ์เข้าร่วม…', 'Revoke access…')}</Button>
              <Button variant="danger-solid">{L('ยกเลิกสิทธิ์', 'Revoke')}</Button>
            </div>
          </Spec>
          <Spec label="Sizes · counts · prices">
            <div className="kit-stack">
              <Button variant="primary" size="lg" priceMinor={118000}>{L('ส่งออเดอร์', 'Send order')}</Button>
              <Button variant="primary" size="staff" icon="check" count={5}>Accept</Button>
              <Button variant="outline" size="lg" icon="receipt" block>{t('service.bill')}</Button>
            </div>
          </Spec>
          <Spec label="States" note={L('aria-disabled ยังโฟกัสได้ เพื่ออ่านเหตุผล', 'aria-disabled stays focusable so the reason can be read.')}>
            <div className="kit-row">
              <Button variant="primary" disabled>{L('ปิดใช้งาน', 'Disabled')}</Button>
              <Button variant="primary" aria-disabled>{L('ปิดโต๊ะ', 'Complete checkout')}</Button>
              <Button variant="primary" loading>{L('กำลังส่ง', 'Sending')}</Button>
              <Button variant="secondary" loading>{t('common.add')}</Button>
              <Button variant="secondary" confirmed>{t('common.add')}</Button>
            </div>
          </Spec>
          <Spec label="IconButton · TextLink · LinkButton">
            <div className="kit-row">
              <IconButton icon="x" iconSize="lg" label={t('common.close')} />
              <IconButton icon="more" variant="framed" size="staff" label={L('รายละเอียด', 'Details')} />
              <IconButton icon="x" variant="round" label={t('common.close')} />
              <IconButton icon="info" size="sm" label={L('คำอธิบาย', 'Definition')} />
              <IconButton icon="pad" label={t('common.nav.order')} badge={2} badgeLabel={t('common.items', { n: 2 })} />
              <TextLink href="#g-order">{L('ดูบิลของโต๊ะ', 'View the table bill')}</TextLink>
              <LinkButton href="#g-track" variant="outline" iconEnd="chev-r">{t('common.nav.track')}</LinkButton>
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ controls */}
      <Section id="g-controls" n="03" th="ตัวเลือกและแท็บ" en="Controls" note={L('ใช้ปุ่มลูกศรเลื่อนระหว่างตัวเลือกได้ (roving tabindex)', 'Arrow keys move between segments and tabs (roving tabindex).')}>
        <div className="kit-grid">
          <Spec label="SegmentedControl · paper">
            <div className="kit-stack">
              <SegmentedControl label={t('common.menuGroups')} value={group} onChange={(v) => { setGroup(v); setCat(v === 'food' ? 'beef' : 'matcha'); }}
                options={[{ value: 'food', label: L('อาหาร', 'Food') }, { value: 'drinks', label: L('เครื่องดื่ม', 'Drinks') }]} />
              <SegmentedControl size="staff" label="Period" value={seg} onChange={setSeg}
                options={[{ value: 'week', label: 'Week', lang: 'en' }, { value: 'month', label: 'Month', lang: 'en' }, { value: 'year', label: 'Year', lang: 'en' }]} />
              <SegmentedControl size="staff" label="Board status" value="new" onChange={() => {}}
                options={[{ value: 'new', label: 'New', count: 2, lang: 'en' }, { value: 'acc', label: 'Accepted', count: 1, lang: 'en' }, { value: 'prep', label: 'Preparing', count: 2, lang: 'en' }]} />
            </div>
          </Spec>
          <Spec label="SegmentedControl · box (LangToggle)" note={L('ต่ำกว่า 360px เหลือปุ่มเดียวคือภาษาที่สลับไปได้', 'Below 360px only the language you can switch to remains.')}>
            <div className="kit-row"><LangToggle /></div>
          </Spec>
          <Spec label="Tabs · underline (buttons)">
            <Tabs label="Orders" value={tab} onChange={setTab} bar
              items={[{ value: 'board', label: 'Board', lang: 'en' }, { value: 'requests', label: 'Requests', badge: 2, lang: 'en', badgeLabel: '2 open' }, { value: 'history', label: 'History', lang: 'en' }]} />
          </Spec>
          <Spec label="Tabs · ember glide · routed">
            <Tabs label={t('common.nav.label')} variant="ember" value={etab} onChange={setEtab} bar
              items={[
                { value: 'menu', label: t('common.nav.menu'), href: '#g-controls' },
                { value: 'order', label: t('common.nav.order'), href: '#g-controls', badge: 2, badgeTone: 'ink' },
                { value: 'track', label: t('common.nav.track'), href: '#g-controls' },
              ]} />
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ masthead + categories */}
      <Section id="g-chrome" n="04" th="หัวหน้าและหมวด" en="Masthead & categories">
        <div className="kit-grid kit-grid--phone">
          <Spec label="Phone · masthead · tool row · CategoryRow">
            <div className="kit-stage kit-force">
              <GuestHeader tableLabel="07" homeHref="#g-chrome" />
              <div className="toolrow">
                <SearchField value={search} onChange={setSearch} placeholder={t('common.search')} />
                <SegmentedControl label={t('common.menuGroups')} value={group} onChange={(v) => { setGroup(v); setCat(v === 'food' ? 'beef' : 'matcha'); }}
                  options={[{ value: 'food', label: L('อาหาร', 'Food') }, { value: 'drinks', label: L('เครื่องดื่ม', 'Drinks') }]} />
              </div>
              <CategoryRow categories={tabs} currentId={cat} onSelect={setCat} onOpenAll={() => setOpen('categories')} />
              <div style={{ height: 24 }} />
            </div>
          </Spec>
          <Spec label="Desktop · masthead nav · sidebar">
            <div className="kit-stage kit-desk">
              <header className="mast" style={{ position: 'relative' }}>
                <div className="mast__in" style={{ gridTemplateColumns: 'auto 1fr auto', gap: 16 }}>
                  <Wordmark href="#g-chrome" style={{ justifyItems: 'start' }} />
                  <GuestNav items={navItems} current={nav} onNavigate={(k, e) => { e.preventDefault(); setNav(k); }} />
                  <div className="mast__right"><ServiceKey variant="header" onClick={() => setOpen('service')} /></div>
                </div>
              </header>
              <div className="kit-stage--pad" style={{ paddingTop: 16 }}>
                <SegmentedControl block size="staff" label={t('common.menuGroups')} value={group} onChange={(v) => { setGroup(v); setCat(v === 'food' ? 'beef' : 'matcha'); }}
                  options={[{ value: 'food', label: L('อาหาร', 'Food') }, { value: 'drinks', label: L('เครื่องดื่ม', 'Drinks') }]} />
                <CategorySidebar categories={tabs} currentId={cat} onSelect={setCat} />
              </div>
            </div>
          </Spec>
          <Spec label="TableTag · Wordmark (guest / staff)">
            <div className="kit-row">
              <TableTag label="07" />
              <TableTag label="12" />
              <Wordmark />
              <div data-surface="dark" className="kit-panel kit-panel--dark"><Wordmark variant="staff" /></div>
            </div>
          </Spec>
          <Spec label="AllCategoriesSheet · inline preview">
            <div className="kit-row" style={{ marginBottom: 12 }}>
              <Button variant="outline" icon="list" opensDialog onClick={() => setOpen('categories')}>{t('common.allCategories')}</Button>
            </div>
            <AllCategoriesSheet inline open onClose={() => {}} groups={[{ ...catGroups[0], categories: catGroups[0].categories.slice(0, 3) }]} currentId={cat} onSelect={(id) => setCat(id)} />
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ menu */}
      <Section id="g-menu" n="05" th="รายการอาหาร" en="DishRow" note={L('ราคาอยู่บรรทัดแรกเสมอแม้ชื่อไทยขึ้นบรรทัดใหม่ แตะรูป ชื่อ หรือพื้นที่ว่างเพื่อเปิดรายละเอียด', 'The price stays on line one when a Thai name wraps. The photo, name and blank space all open the details.')}>
        <div className="kit-grid kit-grid--phone">
          <div className="kit-stage kit-force">
            <main className="g-main">
              <MenuSection id="kit-beef" numeral="01" {...sectionNames('เนื้อ', 'Beef Selection', lang)} hint={L('ไพร์มริบคิดราคาตามน้ำหนัก', 'Prime rib is priced by weight.')}>
                {dishRowFor(D.primeRib, { priority: true })}
                {dishRowFor(D.wagyu, { priority: true })}
                {dishRowFor(D.striploin, { qtyInDraft: striploinQty })}
                {dishRowFor(D.tongue)}
                {dishRowFor(D.stew)}
                {dishRowFor(D.lamb)}
              </MenuSection>
            </main>
          </div>
          <div className="kit-stage kit-force">
            <main className="g-main">
              <MenuSection id="kit-grill" numeral="02" {...sectionNames('จานหลักจากเตา', 'From the Grill', lang)}>
                {dishRowFor(D.prawns, { qtyInDraft: prawnsQty, confirmed: prawnsConfirmed, busy: busyAdd, onAdd: addPrawns })}
                {dishRowFor(D.ribs, {
                  qtyInDraft: ribsQty,
                  onChangeQty: setRibsQty,
                  onRemove: () => {
                    setRibsQty(0);
                    toast.show({ message: L('เอา ซี่โครงหมูย่าง ออกแล้ว', 'Removed Grilled Pork Ribs'), action: { label: t('common.undo'), onClick: () => setRibsQty(1) } });
                  },
                })}
                {dishRowFor(D.chicken)}
                {dishRowFor(D.fish, { meta: L('จานหลักจากเตา · From the Grill', 'From the Grill · จานหลักจากเตา') })}
              </MenuSection>
              <MenuSection id="kit-drinks" numeral="06" {...sectionNames('เบียร์สด', 'Draft Beer', lang)}>
                {dishRowFor(D.hoegaarden)}
                {dishRowFor(D.latte)}
                {dishRowFor(D.broken)}
              </MenuSection>
              <MenuSection id="kit-loading" numeral="03" {...sectionNames('ของเรียกน้ำย่อย', 'Appetizers', lang)}>
                {dishRowFor(D.calamari)}
                <SkeletonDishRow label={t('common.loading')} />
              </MenuSection>
            </main>
          </div>
        </div>
        <ul className="kit-spec__note" style={{ marginTop: 12, display: 'grid', gap: 2 }}>
          <li>{L('ไพร์มริบ: ราคาตามน้ำหนัก ต่อ 100 กรัม ไม่มีปุ่มเพิ่ม', 'Prime Rib: by weight, per 100 g, no Add button')}</li>
          <li>{L('สันนอก: มีตัวเลือก อยู่ในรายการ 1 · ลิ้นวัว: หมดชั่วคราว ราคาไม่ขีดฆ่า · สตูว์: ไม่มีรูป (text-led)', 'Striploin: has choices, 1 in the draft · Tongue: sold out, price never struck · Stew: no photo (text-led)')}</li>
          <li>{L('ซี่โครงแกะ: รอยืนยันราคา · กุ้ง: กดเพิ่มเพื่อดู กำลังเพิ่ม → เพิ่มแล้ว ✓ · ซี่โครงหมู: stepper ลดจาก 1 = เอาออก + เลิกทำ', 'Lamb rack: price pending · Prawns: tap Add for busy → Added ✓ · Pork ribs: stepper, 1 → 0 removes with undo')}</li>
          <li>{L('เบียร์: ไม่มีชื่อไทยในเมนู จึงแสดงชื่ออังกฤษ ราคาเริ่มต้น · คอร์นริบ: รูปโหลดไม่ได้ จึงกลายเป็นแถวตัวอักษร', 'Beer: no Thai name on file, English shown, "from" price · Corn rib: the photo fails and the row turns text-led')}</li>
        </ul>
      </Section>

      {/* ------------------------------------------------ sheets */}
      <Section id="g-sheets" n="06" th="แผ่นรายละเอียดและกล่องยืนยัน" en="Sheets" note={L('dialog จริง: Esc, ฉากหลัง และปุ่มย้อนกลับของเบราว์เซอร์ปิดได้ โฟกัสกลับไปที่ปุ่มเดิม', 'Native dialog: Escape, the backdrop and browser Back close it; focus returns to the trigger.')}>
        <div className="kit-row" style={{ marginTop: 16 }}>
          <Button variant="outline" opensDialog onClick={() => setOpen('sheet')}>{L('เปิดแผ่นรายละเอียด', 'Open item sheet')}</Button>
          <Button variant="outline" icon="bell" opensDialog onClick={() => setOpen('service')}>{t('common.service')}</Button>
          <Button variant="outline" icon="scale" opensDialog onClick={() => setOpen('weigh')}>{t('common.askToWeigh')}</Button>
          <Button variant="danger" opensDialog onClick={() => setOpen('dialog')}>{L('ยกเลิกรายการ…', 'Cancel line…')}</Button>
          <Button variant="outline" icon="tables" opensDialog onClick={() => setOpen('drawer')}>Drawer</Button>
        </div>
        <div className="kit-grid kit-grid--phone">
          <Spec label="Item sheet · inline">
            <Sheet inline open onClose={() => {}} kicker={kicker} labelledBy="kit-sheet-title-inline" footer={itemSheetFoot}>
              {itemSheetBody('inline')}
            </Sheet>
          </Spec>
          <div className="kit-stack kit-stack--fill">
            <Spec label="ServiceMenu · inline">
              <Sheet inline open onClose={() => {}} title={<>{L('บริการที่โต๊ะ', 'Service at table')} <span className="numeral">07</span></>}>
                <ServiceMenu items={serviceItems} />
              </Sheet>
            </Spec>
            <Spec label="ServiceMenu · offline">
              <Sheet inline open onClose={() => {}} title={t('common.serviceAt', { label: '07' })} hideClose>
                <ServiceMenu items={serviceItems} offline />
              </Sheet>
            </Spec>
            <Spec label="Dialog · inline (confirmation with reason)">
              <Sheet inline open variant="dialog" onClose={() => {}} title={L('ยกเลิก ปลาย่าง?', 'Cancel Grilled Fish?')} hideClose
                footerAlign="end"
                footer={<><Button variant="outline" size="lg">{t('common.cancel')}</Button><Button variant="danger-solid" size="lg">{L('ยกเลิกรายการ', 'Cancel line')}</Button></>}>
                <p className="sheet__lede">{L('โต๊ะจะเห็นว่าร้านยกเลิก พร้อมเหตุผล และไม่คิดในบิล', 'The table sees the cancellation with your reason, and it is not charged.')}</p>
                <TextArea className="sheet__block" label={t('common.reason')} value="" onChange={() => {}} error={t('common.reasonRequired')} limit={140} />
              </Sheet>
            </Spec>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------ fields */}
      <Section id="g-fields" n="07" th="ช่องกรอก" en="Fields" note={L('ตัวอักษรในช่อง 16px ตัวนับเป็นตัวอักษรตามที่เซิร์ฟเวอร์นับ และไม่ตัดกลางสระหรือวรรณยุกต์', 'Inputs are 16px. The counter matches the server count and never cuts a Thai cluster.')}>
        <div className="kit-grid">
          <Spec label="TextField · Select">
            <div className="kit-stack kit-stack--fill">
              <TextField label={L('ชื่อที่แสดง', 'Display name')} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nok" help={L('พนักงานจะเห็นชื่อนี้', 'Staff see this name')} />
              <TextField label={L('ยอดที่รับ', 'Amount received')} prefix="฿" inputMode="decimal" defaultValue="2,058" density="staff" />
              <TextField label="PIN" optional error={L('รหัสต้องมี 4 หลัก', 'The PIN has 4 digits')} defaultValue="12" inputMode="numeric" />
              <Select label={L('ระยะเวลาหยุดรับ', 'Pause for')} defaultValue="30" options={[{ value: '15', label: L('15 นาที', '15 minutes') }, { value: '30', label: L('30 นาที', '30 minutes') }, { value: 'close', label: L('จนกว่าจะเปิดเอง', 'Until resumed') }]} />
            </div>
          </Spec>
          <Spec label="TextArea · counter">
            <TextArea label={L('หมายเหตุถึงพนักงาน', 'Note to staff')} optional value={note} onChange={setNote} limit={120}
              help={L('เป็นคำขอถึงร้าน พนักงานจะยืนยันอีกครั้ง', 'A request to the restaurant. Staff will confirm it.')} />
          </Spec>
          <Spec label="Checkbox · Switch">
            <div className="kit-stack">
              <Checkbox label={L('แสดงรายการที่ปฏิเสธและยกเลิก', 'Show rejected and cancelled')} checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <Checkbox label={L('พิมพ์บัตร QR ใหม่', 'Reprint QR cards')} description={L('บัตรเก่าจะใช้ไม่ได้', 'Old cards stop working')} />
              <Checkbox label={L('ปิดใช้งาน', 'Disabled')} disabled />
              <Switch label={L('เสียงเตือน', 'Alert sound')} checked={alerts} onChange={setAlerts} />
              <Switch label={L('ลดการเคลื่อนไหว', 'Reduce motion')} checked={false} onChange={() => {}} density="staff" />
            </div>
          </Spec>
          <Spec label="RadioCard · ChoiceGroup">
            <div className="kit-stack kit-stack--fill">
              <ChoiceGroup legend={L('เครื่องเคียง', 'Sides')} example rule={L('เลือกได้สูงสุด 2', 'Choose up to 2')}>
                {[['fries', 'เฟรนช์ฟรายส์', 'French Fries', t('common.included')], ['mash', 'มันบด', 'Mashed Potato', '+฿40'], ['greens', 'ถั่วแขกผัดเบคอน', 'Sauteed Green Beans Bacon', '+฿40']].map(([v, th, en, price]) => (
                  <RadioCard key={v} type="checkbox" name="kit-sides" label={L(th, en)} aside={price}
                    checked={sides.includes(v)}
                    onChange={() => setSides((s) => (s.includes(v) ? s.filter((x) => x !== v) : s.length >= 2 ? s : [...s, v]))} />
                ))}
                <RadioCard type="checkbox" name="kit-sides" label={L('เห็ดผัด', 'Sauteed Mushrooms')} disabled />
              </ChoiceGroup>
              <ChoiceGroup legend={L('ระดับความสุก', 'Doneness')} example required satisfied={false}
                rule={L('จำเป็น · เลือก 1 อย่าง', 'Required · choose 1')} error={L('เลือกระดับความสุกก่อน', 'Choose a doneness first')}>
                <RadioCard name="kit-d2" label={L('มีเดียมแรร์', 'Medium rare')} aside={t('common.included')} />
                <RadioCard name="kit-d2" label={L('มีเดียม', 'Medium')} aside={t('common.included')} />
              </ChoiceGroup>
            </div>
          </Spec>
          <Spec label="SearchField · results">
            <div className="kit-stack kit-stack--fill">
              <SearchField value={search} onChange={setSearch} label={t('common.searchScope')} status={search ? t('common.results', { n: search.length > 3 ? 0 : 3 }) : null} statusHidden={false} />
              {search.length > 3 ? (
                <EmptyState icon="search" title={L(`ไม่พบเมนูที่ตรงกับ ‘${search}’`, `No dishes match ‘${search}’`)} compact
                  action={<Button variant="outline" onClick={() => setSearch('')}>{t('common.clearSearch')}</Button>}>
                  {L('ลองค้นด้วยชื่อไทยหรือชื่ออังกฤษของจาน', 'Try the Thai or English dish name.')}
                </EmptyState>
              ) : (
                <p className="kit-spec__note">{L('พิมพ์มากกว่า 3 ตัวอักษรเพื่อดูสถานะไม่พบผลลัพธ์', 'Type more than 3 characters to see the no-results state.')}</p>
              )}
            </div>
          </Spec>
          <Spec label="Stepper">
            <div className="kit-stack">
              <Stepper value={ribsQty || 1} onChange={setRibsQty} max={3} label={t('common.qtyInOrder', { name: 'ซี่โครงหมูย่าง' })} onRemove={() => setRibsQty(0)} />
              <Stepper variant="plain" size="lg" value={sheetQty} onChange={setSheetQty} max={10} label={t('common.qty')} />
              <p className="kit-spec__note">{L('ตัวบนสูงสุด 3 แล้วประกาศขีดจำกัด', 'The first is capped at 3 and announces the limit.')}</p>
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ status */}
      <Section id="g-status" n="08" th="สถานะ" en="Status" note={L('สถานะมีคำและไอคอนเสมอ ไม่ใช้สีอย่างเดียว', 'Every state has words and usually an icon, never colour alone.')}>
        <div className="kit-grid">
          <Spec label="StatusPill · line">
            <div className="kit-row">{LINE_STATUSES.map((s) => <StatusPill key={s} kind="line" status={s} />)}</div>
          </Spec>
          <Spec label="StatusPill · order · service">
            <div className="kit-row">
              {ORDER_STATUSES.map((s) => <StatusPill key={s} kind="order" status={s} />)}
              {SERVICE_STATUSES.map((s) => <StatusPill key={s} kind="service" status={s} size="sm" />)}
            </div>
          </Spec>
          <Spec label="StatusPill · table · job">
            <div className="kit-row">
              {TABLE_STATES.map((s) => <StatusPill key={s} kind="table" status={s} />)}
              {JOB_STATUSES.map((s) => <StatusPill key={s} kind="job" status={s} size="sm" />)}
            </div>
          </Spec>
          <Spec label="Pill · Badge">
            <div className="kit-row">
              <Pill tone="ok" live>{t('conn.liveGuest')}<span className="pill__soft"> · 19:52</span></Pill>
              <Pill tone="heat" icon="clock">{t('conn.dataAt', { time: '19:52' })}</Pill>
              <Pill tone="line">{L('ยังไม่ได้ขอ', 'Not requested')}</Pill>
              <Badge count={2} label={t('common.items', { n: 2 })} />
              <Badge count={3} tone="alert" />
              <Badge count={5} tone="ember" />
              <Badge count={128} />
            </div>
          </Spec>
          <Spec label="Tag · Chip">
            <div className="kit-row">
              <Tag tone="example" />
              <Tag tone="example" lang="en">Example</Tag>
              <Tag tone="ink" lang="en">500 ml</Tag>
              <Tag tone="ink" lang="en">Iced</Tag>
              <Tag tone="line">{L('ตามฤดูกาล', 'Seasonal')}</Tag>
              <Tag tone="ok">{L('ยืนยันแล้ว', 'Verified')}</Tag>
              <Tag tone="alert">{L('นม', 'Milk')}</Tag>
              <Tag tone="heat">{L('รอยืนยัน', 'Pending')}</Tag>
              <Tag tone="neutral">{L('ร่าง', 'Draft')}</Tag>
              <Chip qty={1}>มีเดียมแรร์</Chip>
              <Chip qty={1}>มีเดียม</Chip>
              <Chip tone="line">{L('ไม่ใส่ผักชี', 'No coriander')}</Chip>
            </div>
          </Spec>
          <Spec label="Flag">
            <div className="kit-row">
              <Flag kind="oldest" lang="en">Oldest waiting</Flag>
              <Flag kind="late" lang="en">Longer than usual · over 20 min</Flag>
              <Flag kind="just" lang="en">Just in</Flag>
              <Flag kind="ready" lang="en">Waiting to be served</Flag>
              <Flag kind="station" lang="en">Bar</Flag>
              <Flag kind="alcohol" />
              <Flag kind="example" />
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ feedback */}
      <Section id="g-feedback" n="09" th="แจ้งเตือนและสถานะว่าง" en="Feedback">
        <div className="kit-grid kit-grid--wide">
          <Spec label="Banner">
            <div className="kit-stage">
              <Banner variant="demo" title={t('common.demoData')}>{L('ตัวเลขเหล่านี้มาจากข้อมูลตัวอย่าง', 'These figures come from seed fixtures.')}</Banner>
              <Banner variant="offline" title={t('conn.lost')} action={<Button variant="outline">{t('service.call_staff')}</Button>}>{t('conn.lostBody')}</Banner>
              <Banner variant="paused" title={L('ร้านหยุดรับออเดอร์ชั่วคราว', 'Ordering is paused')} action={<Button variant="outline">{t('service.call_staff')}</Button>}>{L('เรียกพนักงานได้', 'Staff can still help')}</Banner>
              <Banner variant="billing" title={L('กำลังสรุปบิล', 'Preparing the bill')}>{L('สั่งเพิ่มได้โดยเรียกพนักงาน', 'Ask staff to order more')}</Banner>
              <Banner variant="info">{t('common.enOnly')}</Banner>
              <Banner variant="warning" title={L('ราคาเปลี่ยน', 'A price changed')}>{L('ตรวจรายการก่อนส่ง', 'Check your order before sending')}</Banner>
            </div>
          </Spec>
          <Spec label="ConnectionIndicator">
            <div className="kit-stack">
              <div className="kit-row">
                <ConnectionIndicator state="live" lastSyncAt={Date.parse(at('19:52')) + 4000} />
                <ConnectionIndicator state="reconnecting" lastSyncAt={Date.parse(at('19:51'))} />
                <ConnectionIndicator state="offline" lastSyncAt={Date.parse(at('19:48'))} />
                <ConnectionIndicator state="ended" />
              </div>
              <div className="kit-row">
                <ConnectionIndicator variant="track" state="live" lastSyncAt={Date.parse(at('19:52'))} />
                <ConnectionIndicator variant="track" state="offline" lastSyncAt={Date.parse(at('19:52'))} />
              </div>
              <div className="kit-stage" style={{ width: '100%' }}>
                <ConnectionIndicator variant="guest" state="reconnecting" lastSyncAt={Date.parse(at('19:52'))} />
                <div style={{ height: 8 }} />
                <ConnectionIndicator variant="guest" state="offline" offlineAction={<Button variant="outline">{t('service.call_staff')}</Button>} />
              </div>
            </div>
          </Spec>
          <Spec label="Toast · LiveRegion" note={L('ทีละอัน 4 วินาที หยุดนับเมื่อชี้หรือโฟกัส ข้อผิดพลาดเท่านั้นที่ประกาศแบบ assertive', 'One at a time, 4s, paused on hover or focus. Only errors are assertive.')}>
            <div className="kit-stack">
              <Toast message={L('เพิ่ม ซี่โครงหมูย่าง แล้ว', 'Added Grilled Pork Ribs')} action={{ label: t('common.undo'), onClick: () => {} }} />
              <Toast tone="error" message={L('ส่งออเดอร์ไม่สำเร็จ ลองอีกครั้ง', 'The order did not send. Try again.')} />
              <div className="kit-row">
                <Button variant="outline" onClick={() => toast.show({ message: L('เพิ่ม ซี่โครงหมูย่าง แล้ว', 'Added Grilled Pork Ribs'), action: { label: t('common.undo'), onClick: () => {} } })}>{L('แสดง toast', 'Show toast')}</Button>
                <Button variant="outline" onClick={() => toast.show({ tone: 'error', message: L('ขาดการเชื่อมต่อ', 'Connection lost') })}>{L('toast ข้อผิดพลาด', 'Error toast')}</Button>
              </div>
              <LiveRegion visible className="meta">{search ? t('common.results', { n: 3 }) : ''}</LiveRegion>
            </div>
          </Spec>
          <Spec label="EmptyState · Skeleton">
            <div className="kit-grid" style={{ marginTop: 0 }}>
              <div className="kit-panel">
                <EmptyState icon="pad" title={L('ยังไม่มีรายการ', 'Nothing in your order yet')} action={<LinkButton href="#g-menu" variant="secondary">{L('ดูเมนู', 'Browse the menu')}</LinkButton>}>
                  {L('เลือกจากเมนูได้เลย', 'Pick something from the menu.')}
                </EmptyState>
              </div>
              <div className="kit-panel">
                <EmptyState icon="track" title={L('ยังไม่ได้ส่งออเดอร์', 'No orders sent yet')}>
                  {L('รายการที่ส่งแล้วจะแสดงที่นี่', 'Sent orders will show here.')}
                </EmptyState>
              </div>
              <div className="kit-panel kit-stack kit-stack--fill">
                <Skeleton width="60%" height={22} />
                <Skeleton lines={3} />
                <div style={{ width: 120 }}><Skeleton shape="plate" /></div>
              </div>
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ track */}
      <Section id="g-track" n="10" th="ติดตามอาหาร" en="Track" note={L('ขั้นที่เสร็จมีเวลาจริง ขั้นถัดไปไม่มีเวลา ขั้นที่ข้ามแสดง ไม่ได้บันทึก รายการยกเลิกอยู่ข้างจานพร้อมเหตุผล', 'Done steps carry real times, upcoming steps none; skipped steps say "not recorded"; cancellations sit beside the dish with the reason.')}>
        <div className="kit-row" style={{ marginTop: 14 }}>
          <Button variant="outline" icon="chev-l" disabled={stepIdx === 0} onClick={() => setStepIdx((i) => Math.max(0, i - 1))}>{L('ย้อนขั้น', 'Step back')}</Button>
          <Button variant="outline" iconEnd="chev-r" disabled={stepIdx >= 5} onClick={() => setStepIdx((i) => Math.min(5, i + 1))}>{L('ครัวบันทึกขั้นถัดไป', 'Kitchen records next step')}</Button>
          <SegmentedControl label="Quote state" value={quoteState} onChange={setQuoteState}
            options={(['requested', 'quoted', 'revised', 'expired', 'confirmed'] as const).map((v) => ({ value: v, label: v, lang: 'en' }))} />
        </div>
        <div className="kit-grid kit-grid--phone">
          <div className="kit-stage kit-stage--pad">
            <PageHead
              kicker={L('โต๊ะ 07 · ส่งแล้ว 2 รอบ', 'Table 07 · 2 rounds sent')}
              title={L('ติดตามอาหาร', 'Track your food')}
              secondary={lang === 'th' ? 'Track' : undefined}
              row={<ConnectionIndicator variant="track" state="live" lastSyncAt={Date.parse(at('19:52'))} />}
              support={L('ออเดอร์ที่ส่งแล้วเป็นของทั้งโต๊ะ ทุกเครื่องที่โต๊ะ 07 เห็นสถานะเดียวกัน', 'Sent orders belong to the whole table. Every device at table 07 sees the same status.')}
            />
            <div className="pair">
              <Button variant="outline" size="lg" icon="bell">{t('service.call_staff')}</Button>
              <Button variant="outline" size="lg" icon="receipt">{t('service.bill')}</Button>
            </div>
            <PortionQuote
              state={quoteState}
              name={pick(D.primeRib.name)}
              secondary={both(D.primeRib.name).secondary}
              grams={420}
              rateMinor={49000}
              basisGrams={100}
              amountMinor={205800}
              expiresAt={at('20:05')}
              previous={{ grams: 380, amountMinor: 186200 }}
              onConfirm={() => setQuoteState('confirmed')}
              onChange={() => setOpen('weigh')}
              onRequestAgain={() => setQuoteState('requested')}
            />
            <RoundCard
              title={L('รอบที่ 2', 'Round 2')}
              meta={L('ส่งเมื่อ 19:42 · 4 รายการ · โต๊ะ 07', 'Sent 19:42 · 4 items · table 07')}
              reference="RG-4K7P"
              stateTitle={steps[stepIdx].label}
              stateMessage={L('ครัวเริ่มปรุงแล้ว แต่ละจานอาจเสร็จไม่พร้อมกัน', 'The kitchen has started. Dishes may finish at different times.')}
              dishes={(
                <DishLines title={L('รายจาน', 'By dish')} summary={L('เสิร์ฟแล้ว 1 · กำลังปรุง 2 · ยกเลิก 1', '1 served · 2 cooking · 1 cancelled')}>
                  <DishStatusLine name={pick(D.wagyu.name).text} nameLang={pick(D.wagyu.name).lang} quantity={1} image={IMG.wagyu} status="preparing" at={at('19:46')} trail={['done', 'done', 'now', 'todo', 'todo', 'todo']} />
                  <DishStatusLine name={pick(D.prawns.name).text} nameLang={pick(D.prawns.name).lang} quantity={1} image={IMG.prawns} status="preparing" at={at('19:46')} trail={['done', 'done', 'now', 'todo', 'todo', 'todo']} />
                  <DishStatusLine name={L('เห็ดผัด', 'Sauteed Mushrooms')} quantity={1} image={IMG.mushrooms} status="served" at={at('19:49')} trail={['done', 'done', 'done', 'skipped', 'done', 'done']} skipped={[L('ขั้นใกล้เสร็จ', 'Almost done')]} />
                  <DishStatusLine name={L('สลัดรวมกับซอสบัลซามิก', 'Green Salad with Balsamic Dressing')} quantity={1} image={IMG.salad} status="cancelled" at={at('19:45')} reason={L('วัตถุดิบหมด', 'Out of stock')} />
                </DishLines>
              )}
            >
              <Timeline steps={steps} label={L('ความคืบหน้ารอบที่ 2', 'Round 2 progress')} />
            </RoundCard>
            <PastRound
              title={<>{L('เสิร์ฟครบทุกจาน', 'All served')} <span className="num">19:31</span></>}
              meta={<>{L('รอบที่ 1', 'Round 1')} · <span className="ref-inline" lang="en">RG-3H2M</span> · {L('ส่งเมื่อ 19:08 · 3 รายการ', 'Sent 19:08 · 3 items')}</>}
              thumbs={[IMG.cornRib, IMG.caesar, IMG.fish]}
            >
              <Timeline steps={skippedSteps} label={L('ความคืบหน้ารอบที่ 1', 'Round 1 progress')} animate={false} />
            </PastRound>
            <UnsentCard count={2} nextRound={3} href="#g-order" />
            <RunningTotal
              label={L('ค่าอาหารที่ส่งแล้ว · 2 รอบ', 'Sent so far · 2 rounds')}
              totalMinor={363000}
              note={L('ไม่รวมรายการที่ร้านยกเลิกและไพร์มริบที่รอยืนยัน ยอดสุดท้ายพนักงานจะยืนยันในบิล', 'Excludes cancelled dishes and the prime rib awaiting confirmation. Staff confirm the final amount on the bill.')}
              action={<TextLink href="#g-order">{L('ดูบิลของโต๊ะ', 'View the table bill')}</TextLink>}
            />
          </div>
          <div className="kit-stack kit-stack--fill">
            <Spec label="Timeline · skipped optional step">
              <Card padded><Timeline steps={skippedSteps} label="Round 1" animate={false} /></Card>
            </Spec>
            <Spec label="PortionQuote · requested / expired">
              <PortionQuote state="requested" name={pick(D.primeRib.name)} secondary={both(D.primeRib.name).secondary} rateMinor={49000} />
              <PortionQuote state="expired" name={pick(D.primeRib.name)} secondary={both(D.primeRib.name).secondary} rateMinor={49000} onRequestAgain={() => setOpen('weigh')} />
            </Spec>
            <Spec label="AllergyNotice · verified (Example data)">
              <div className="kit-row" style={{ marginBottom: 8 }}><Tag tone="example" /></div>
              <AllergyNotice allergens={EXAMPLE_ALLERGENS} onCallStaff={() => setOpen('service')} />
            </Spec>
            <Spec label="ListRow">
              <Card padded>
                <ul>
                  <li><ListRow icon="bell" title={t('service.call_staff')} sub={L('พนักงานรับทราบแล้ว', 'Staff are on their way')} trailing={<StatusPill kind="service" status="acknowledged" />} /></li>
                  <li><ListRow icon="receipt" title={t('service.bill')} onClick={() => {}} opensDialog /></li>
                  <li><ListRow icon="glass" title={L('ขอน้ำเปล่า', 'Request water')} sub={L('ส่งไปแล้ว รอพนักงานรับทราบ', 'Already sent')} onClick={() => {}} disabled /></li>
                </ul>
              </Card>
            </Spec>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------ order */}
      <Section id="g-order" n="11" th="รายการของฉัน" en="Your order" note={L('รายการร่างอยู่ในเครื่องนี้ ออเดอร์ที่ส่งแล้วเป็นของทั้งโต๊ะ', 'The draft lives on this device. Sent orders belong to the table.')}>
        <div className="kit-grid kit-grid--phone">
          <Spec label="Desktop order panel">
            <aside className="cartpanel">
              <Card padded>
                <h2 className="cartpanel__t">{L('รายการของฉัน', 'Your order')} <span className="meta">· {L('ร่างในเครื่องนี้', 'draft on this device')}</span></h2>
                <ul className="cartpanel__list">
                  <OrderLine name={striploinName.text} nameLang={striploinName.lang} image={IMG.striploin} quantity={1} totalMinor={59000}
                    options={<>{L('มีเดียม', 'Medium')} <Tag tone="example" /></>} note="ขอจานแบ่ง 2 ใบ" />
                  <OrderLine name={pick(D.ribs.name).text} nameLang={pick(D.ribs.name).lang} image={IMG.ribs} quantity={1} totalMinor={59000} />
                </ul>
                <RunningTotal label={L('ยอดอาหาร · 2 รายการ', 'Food · 2 items')} totalMinor={118000} size="total"
                  note={L('ยังไม่ได้ส่งเข้าครัว · ร้านจะยืนยันออเดอร์หลังส่ง', 'Not sent to the kitchen yet · the restaurant confirms after you send')} />
                <Button variant="primary" size="lg" block priceMinor={118000} className="cartpanel__send">{L('ส่งออเดอร์', 'Send order')}</Button>
              </Card>
              <p className="support cartpanel__foot">{L('ออเดอร์ที่ส่งแล้วเป็นของทั้งโต๊ะ รายการนี้อยู่ในเครื่องนี้เท่านั้น', 'Sent orders belong to the whole table. This list stays on this device.')}</p>
            </aside>
          </Spec>
          <Spec label="Order lines · edit, remove, issues">
            <Card padded>
              <ul>
                <OrderLine size="lg" name={pick(D.ribs.name).text} image={IMG.ribs} quantity={ribsQty || 1} totalMinor={59000 * (ribsQty || 1)}
                  actions={<>
                    <Stepper value={ribsQty || 1} onChange={setRibsQty} label={t('common.qtyInOrder', { name: pick(D.ribs.name).text })} onRemove={() => setRibsQty(0)} />
                    <Button variant="ghost" icon="note">{t('common.edit')}</Button>
                    <Button variant="ghost">{t('common.remove')}</Button>
                  </>} />
                <OrderLine size="lg" name={pick(D.tongue.name).text} image={IMG.tongue} quantity={1} totalMinor={59000}
                  issue={L('หมดชั่วคราวหลังจากเพิ่มไว้ เอาออกก่อนส่ง', 'Sold out since you added it. Remove it before sending.')}
                  actions={<Button variant="ghost">{t('common.remove')}</Button>} />
                <OrderLine size="lg" name="Hoegaarden White" nameLang="en" quantity={2} totalMinor={59000}
                  options={<><Chip lang="en">500 ml</Chip> <Flag kind="alcohol" /></>}
                  issue={L('ราคาเปลี่ยนเป็น ฿295 ต่อแก้ว', 'The price is now ฿295 a glass')} />
              </ul>
            </Card>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ dock */}
      <Section id="g-dock" n="12" th="แถบล่าง" en="Dock" note={L('บริการเป็นปุ่มที่มีป้ายกำกับ ไม่ใช่ปลายทาง จึงไม่เคยเป็นหน้าปัจจุบัน', 'Service is a labelled key, not a destination, so it is never current.')}>
        <div className="kit-row" style={{ marginTop: 14 }}>
          <SegmentedControl label="Cart state" value={cartState} onChange={setCartState}
            options={(['idle', 'sending', 'review'] as const).map((v) => ({ value: v, label: v, lang: 'en' }))} />
        </div>
        <div className="kit-grid kit-grid--phone">
          <div className="kit-stage kit-force" style={{ paddingTop: 12 }}>
            <Dock inline>
              <CartBar count={draftCount || 2} totalMinor={draftTotal || 118000} href="#g-order" state={cartState} />
              <BottomNav items={navItems} current={nav} onNavigate={(k, e) => { e.preventDefault(); setNav(k); }} onService={() => setOpen('service')} />
            </Dock>
          </div>
          <Spec label="CartBar · review · one item">
            <div className="kit-force kit-stack kit-stack--fill">
              <CartBar count={1} totalMinor={59000} onClick={() => {}} state="review" />
              <CartBar count={4} totalMinor={323000} onClick={() => {}} state="sending" />
            </div>
          </Spec>
        </div>
      </Section>

      {/* ------------------------------------------------ modal instances */}
      <Sheet open={open === 'sheet'} onClose={close} kicker={kicker} labelledBy="kit-sheet-title" footer={itemSheetFoot}>
        {itemSheetBody('modal')}
      </Sheet>
      <Sheet open={open === 'service'} onClose={close} title={t('common.serviceAt', { label: '07' })}>
        <ServiceMenu items={serviceItems} />
      </Sheet>
      <AllCategoriesSheet open={open === 'categories'} onClose={close} groups={catGroups} currentId={cat}
        onSelect={(id, g) => { setGroup(g as 'food' | 'drinks'); setCat(id); }} />
      <Sheet
        open={open === 'weigh'}
        onClose={close}
        title={t('common.askToWeighNamed', { name: pick(D.primeRib.name).text })}
        footer={<Button variant="primary" size="lg" icon="scale" onClick={() => { close(); setQuoteState('requested'); toast.show(L('ส่งคำขอชั่งแล้ว', 'Weighing requested')); }}>{t('common.askToWeigh')}</Button>}
      >
        <p className="sheet__lede">{t('common.weighNote')}</p>
        <TextField className="sheet__block" label={L('น้ำหนักที่อยากได้ (กรัม)', 'Preferred weight (g)')} optional inputMode="numeric" placeholder="400" />
      </Sheet>
      <Dialog
        open={open === 'dialog'}
        onClose={close}
        tone="danger"
        title={L('ยกเลิก ปลาย่าง?', 'Cancel Grilled Fish?')}
        confirmLabel={L('ยกเลิกรายการ', 'Cancel line')}
        reason={{ label: t('common.reason'), required: true, limit: 140 }}
        onConfirm={() => new Promise<void>((r) => setTimeout(() => { r(); close(); toast.show(L('ยกเลิกรายการแล้ว', 'Line cancelled')); }, 700))}
      >
        {L('โต๊ะจะเห็นว่าร้านยกเลิก พร้อมเหตุผล และไม่คิดในบิล', 'The table sees the cancellation with your reason, and it is not charged.')}
      </Dialog>
      <Drawer
        open={open === 'drawer'}
        onClose={close}
        inline={false}
        lead={<div className="tno" aria-hidden="true"><span className="tno__k" lang="en">Table</span><span className="tno__n">07</span></div>}
        title={<>{L('โต๊ะ 07', 'Table 07')}</>}
        status={<StatusPill kind="table" status="dining" size="sm" />}
        subtitle={L('นั่งเมื่อ 19:04 · 48 นาที', 'Seated 19:04 · 48 min')}
        footer={<Button variant="primary" size="staff" block aria-disabled>{L('ปิดโต๊ะ', 'Complete checkout')}</Button>}
      >
        <div className="dsec">
          <div className="dsec__h"><h3 lang="en">Guest access</h3></div>
          <dl className="kv"><dt>{L('เครื่องที่เข้าร่วม', 'Devices joined')}</dt><dd>3</dd></dl>
        </div>
        <div className="dsec">
          <div className="dsec__h"><h3 lang="en">History</h3></div>
          <p className="meta">{L('ตัวอย่าง Drawer แบบ modal (มือถือและแท็บเล็ต)', 'Modal drawer preview (phones and tablets)')}</p>
        </div>
      </Drawer>
    </div>
  );
}

function sectionNames(th: string, en: string, lang: string) {
  return lang === 'th'
    ? { title: th, titleLang: 'th', secondary: en, secondaryLang: 'en' }
    : { title: en, titleLang: 'en', secondary: th, secondaryLang: 'th' };
}

function EmberDemo() {
  const items = ['01 เนื้อ', '02 จานหลัก', '03 สลัด'];
  const [cur, setCur] = useState(0);
  return (
    <div className="kit-mark" role="group" aria-label="Ember mark demo">
      {items.map((it, i) => (
        <button key={it} type="button" aria-current={i === cur ? 'true' : undefined} onClick={() => setCur(i)}>{it}</button>
      ))}
      <GlideUnder index={cur} />
    </div>
  );
}

function GlideUnder({ index }: { index: number }) {
  const [style, setStyle] = useState<{ width: number; x: number }>({ width: 0, x: 0 });
  useEffect(() => {
    const host = document.querySelector('.kit-mark');
    const el = host?.querySelectorAll('button')[index] as HTMLElement | undefined;
    if (el) setStyle({ width: el.offsetWidth - 24, x: el.offsetLeft + 12 });
  }, [index]);
  return <span className="mark" aria-hidden="true" style={{ width: style.width, transform: `translateX(${style.x}px)` }} />;
}
