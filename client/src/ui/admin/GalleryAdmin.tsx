// Staff & data kit gallery (rendered inside /ui-kit, development only).
// Every ui/admin component in realistic states, using the admin mock fixtures:
// service Thu 17 Sep 2026, 19:52 Asia/Bangkok; tables 01–16; staff "Nok",
// "Ploy", "Kitchen 1". ALL NUMBERS AND NAMES OF PEOPLE ARE DEMO FIXTURES.
// DESIGN PLACEHOLDER: the doneness chips on table 03 only demonstrate the
// split-by-quantity layout (tagged Example); no doneness options are confirmed.
import { useState, type ReactNode } from 'react';
import type { StatsPeriod } from '../../../../shared/dto.ts';
import type { Station, TableState } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner } from '../Banner.tsx';
import { ConnectionIndicator } from '../ConnectionIndicator.tsx';
import { Pill } from '../Badge.tsx';
import { Button, IconButton, TextLink } from '../Button.tsx';
import { Drawer } from '../Sheet.tsx';
import {
  AdminRail, AttnBadge, AuditEntry, AuditList, BOARD_STAGES, BoardColumn, BoardGrid, BoardStatusSwitch, BoardToolbar,
  ChartPanel, CheckButton, CheckoutBlockers, DataTable, DateRangeNav, DrawerSection, FilterChips, GuestAccessPanel,
  HeroMetric, HistoryList, JobList, JobStatusRow, KeyValue, LineStatusPill, MetricSwitch, MiniBars, OrderingControl,
  PageHeader, PeriodSwitch, RailFooter, RailNav, RankingRow, RankingTable, RoundList, SectionHeader, SelectButton,
  StaffChip, StaffSearch, StatCard, StatGrid, TableBox, TableDrawerHeader, TableLegend, TableStatePill, TableStrip,
  TableTile, TablesSummaryBar, Ticket, WeekBarChart, WorkspaceHeader,
  type BoardStage, type ChartBucket, type DataColumn, type FloorTable, type RailItem, type RankingRowProps,
  type SortState, type TableFilter, type TableTileProps, type TicketProps,
} from './index.ts';
import { cx } from './parts.tsx';

type Tx = (en: string, th: string) => string;

function useTx(): Tx {
  const { lang } = useI18n();
  return (en, th) => (lang === 'th' ? th : en);
}

const noop = () => {};
const DISH = (slug: string) => `/media/dish/${slug}-240.webp`;

// ------------------------------------------------------------------ frame helpers

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="gk__sec" aria-labelledby={id}>
      <div className="gk__h">
        <h2 id={id}>{title}</h2>
        {note ? <p>{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Frame({ width, label, children }: { width: 1440 | 820 | 390; label: string; children: ReactNode }) {
  return (
    <div className={`gk__frame gk__frame--${width}`}>
      <p className="gk__label" lang="en"><span>{label}</span><span>{width} px</span></p>
      {children}
    </div>
  );
}

/** The workspace connection slot with the fixture sync time (19:52:04 Asia/Bangkok). */
const SYNCED_AT = Date.UTC(2026, 8, 17, 12, 52, 4);
function ConnSlot() {
  return <ConnectionIndicator variant="staff" state="live" lastSyncAt={SYNCED_AT} />;
}

type Dest = 'orders' | 'tables' | 'menu' | 'insights' | 'more';

function railItems(tx: Tx, current: Dest): RailItem[] {
  return [
    { id: 'orders', label: tx('Orders', 'ออร์เดอร์'), href: '#orders', icon: 'orders', count: 2, countLabel: tx('2 new', 'ใหม่ 2'), current: current === 'orders' },
    { id: 'tables', label: tx('Tables', 'โต๊ะ'), href: '#tables', icon: 'tables', current: current === 'tables' },
    { id: 'menu', label: tx('Menu', 'เมนู'), href: '#menu', icon: 'cutlery', current: current === 'menu' },
    { id: 'insights', label: tx('Insights', 'สถิติ'), href: '#insights', icon: 'bars', current: current === 'insights' },
    { id: 'more', label: tx('More', 'เพิ่มเติม'), href: '#more', icon: 'more', current: current === 'more' },
  ];
}

function StaffRail({ current, compact }: { current: Dest; compact?: boolean }) {
  const { lang, setLang } = useI18n();
  const tx = useTx();
  const [alerts, setAlerts] = useState(true);
  const [tested, setTested] = useState(0);
  return (
    <AdminRail
      mode={compact ? 'compact' : 'full'}
      homeHref="#top"
      nav={<RailNav items={railItems(tx, current)} onNavigate={(_, e) => e.preventDefault()} />}
      footer={
        <RailFooter
          alertsOn={alerts}
          onAlertsChange={setAlerts}
          onTestAlert={() => setTested(tested + 1)}
          onLock={noop}
          lang={lang}
          onLangChange={setLang}
          dateLabel={tx('Thu 17 Sep 2026', 'พฤ. 17 ก.ย. 2026')}
          timeZone="Asia/Bangkok"
        />
      }
    />
  );
}

// ------------------------------------------------------------------ fixtures: floor + board

function floorTables(tx: Tx): FloorTable[] {
  const avail = (n: string): FloorTable => ({ id: `t${n}`, label: n, state: 'available' });
  const dining = (n: string, short: string, long: string, attention: FloorTable['attention']): FloorTable => ({
    id: `t${n}`, label: n, state: 'dining', duration: short, durationLong: long, attention,
  });
  return [
    avail('01'),
    dining('02', '1h 04', tx('1 hour 4 minutes', '1 ชั่วโมง 4 นาที'), ['ready']),
    dining('03', '6m', tx('6 minutes', '6 นาที'), ['new']),
    avail('04'),
    { id: 't05', label: '05', state: 'checking_out' },
    avail('06'),
    dining('07', '48m', tx('48 minutes', '48 นาที'), ['quote']),
    avail('08'),
    dining('09', '29m', tx('29 minutes', '29 นาที'), ['call']),
    avail('10'),
    avail('11'),
    dining('12', '22m', tx('22 minutes', '22 นาที'), ['new']),
    avail('13'),
    avail('14'),
    avail('15'),
    { id: 't16', label: '16', state: 'disabled' },
  ];
}

type TicketFixture = TicketProps & { id: string };

function boardTickets(tx: Tx): Record<BoardStage, TicketFixture[]> {
  const more = noop;
  return {
    submitted: [
      {
        id: 'RG-4M2Q', table: '03', reference: 'RG-4M2Q', round: 1, time: '19:48', waitMinutes: 4, stage: 'submitted', isNew: true,
        flags: [{ kind: 'oldest' }],
        allergy: { text: 'แพ้ถั่วลิสง', lang: 'th' },
        lines: [
          {
            id: 'l1', quantity: 2, name: 'เนื้อสันนอกออสเตรเลีย', nameLang: 'th', secondary: 'Australian Striploin', secondaryLang: 'en', status: 'submitted',
            chips: [{ label: 'มีเดียมแรร์', quantity: 1, lang: 'th' }, { label: 'มีเดียม', quantity: 1, lang: 'th' }], example: true,
          },
          { id: 'l2', quantity: 1, name: 'มันบด', nameLang: 'th', secondary: 'Mashed Potato', secondaryLang: 'en', status: 'submitted' },
          { id: 'l3', quantity: 2, name: 'เฟรนช์ฟรายส์', nameLang: 'th', secondary: 'French Fries', secondaryLang: 'en', status: 'submitted' },
        ],
        primary: { label: tx('Accept', 'รับออร์เดอร์'), count: 5, icon: 'check', onClick: noop },
        onMore: more,
      },
      {
        id: 'RG-4M3T', table: '12', reference: 'RG-4M3T', round: 2, time: '19:51', waitMinutes: 1, stage: 'submitted', isNew: true,
        flags: [{ kind: 'just' }, { kind: 'station', label: tx('Bar', 'บาร์') }],
        lines: [
          {
            id: 'l1', quantity: 2, name: 'Hoegaarden White', nameLang: 'en', secondary: 'Draft beer', secondaryLang: 'en', noThaiName: true,
            chips: [{ label: '500 ml', lang: 'en' }], alcohol: true, status: 'submitted',
          },
          { id: 'l2', quantity: 1, name: 'Matcha Latte', nameLang: 'en', secondary: 'Special Matcha', secondaryLang: 'en', noThaiName: true, chips: [{ label: 'Iced', lang: 'en' }], status: 'submitted' },
          { id: 'l3', quantity: 1, name: 'น้ำลำไย', nameLang: 'th', secondary: 'Longan Juice', secondaryLang: 'en', status: 'submitted' },
        ],
        primary: { label: tx('Accept', 'รับออร์เดอร์'), count: 4, icon: 'check', onClick: noop },
        onMore: more,
      },
    ],
    accepted: [
      {
        id: 'RG-4M1H', table: '02', reference: 'RG-4M1H', round: 3, time: '19:47', waitMinutes: 5, stage: 'accepted',
        lines: [
          { id: 'l1', quantity: 1, name: 'เห็ดผัด', nameLang: 'th', secondary: 'Sauteed Mushrooms', secondaryLang: 'en', status: 'accepted' },
          { id: 'l2', quantity: 1, name: 'บรอกโคลีเล็กผัด', nameLang: 'th', secondary: 'Sauteed Mini Broccoli', secondaryLang: 'en', status: 'accepted' },
        ],
        note: { text: 'ขอจานแบ่ง 2 ใบ', lang: 'th' },
        primary: { label: tx('Start preparing', 'เริ่มทำ'), count: 2, onClick: noop },
        onMore: more,
      },
    ],
    preparing: [
      {
        id: 'RG-4K7P', table: '07', reference: 'RG-4K7P', round: 2, time: '19:42', waitMinutes: 10, lateAfterMinutes: 20, stage: 'preparing',
        lines: [
          { id: 'l1', quantity: 1, name: 'เนื้อสันในวากิวย่างซอสไวน์แดง', nameLang: 'th', secondary: 'Wagyu Tenderloin MB 6⁠–⁠7 · 300 g', secondaryLang: 'en', status: 'preparing', statusAt: '19:46' },
          { id: 'l2', quantity: 1, name: 'กุ้งแม่น้ำย่าง', nameLang: 'th', secondary: 'Grilled River Prawns', secondaryLang: 'en', status: 'preparing', statusAt: '19:46' },
          { id: 'l3', quantity: 1, name: 'เห็ดผัด', nameLang: 'th', secondary: 'Sauteed Mushrooms', secondaryLang: 'en', status: 'served', statusAt: '19:49', actor: 'Ploy' },
          { id: 'l4', quantity: 1, name: 'สลัดรวมกับซอสบัลซามิก', nameLang: 'th', secondary: 'Green Salad', secondaryLang: 'en', status: 'cancelled', statusAt: '19:45', reason: tx('out of stock', 'ของหมด') },
        ],
        primary: { label: tx('Mark ready', 'พร้อมเสิร์ฟ'), count: 2, onClick: noop },
        secondary: { label: tx('Almost done', 'ใกล้เสร็จ'), onClick: noop },
        onMore: more,
      },
      {
        id: 'RG-4L1C', table: '12', reference: 'RG-4L1C', round: 1, time: '19:30', waitMinutes: 22, lateAfterMinutes: 20, stage: 'preparing',
        lines: [
          { id: 'l1', quantity: 1, name: 'ไพร์มริบ', nameLang: 'th', secondary: 'Prime Rib', secondaryLang: 'en', status: 'preparing', weight: { text: '380 g · ฿1,862', confirmedAt: '19:33' } },
          { id: 'l2', quantity: 1, name: 'มันบด', nameLang: 'th', secondary: 'Mashed Potato', secondaryLang: 'en', status: 'preparing' },
        ],
        primary: { label: tx('Mark ready', 'พร้อมเสิร์ฟ'), count: 2, onClick: noop },
        secondary: { label: tx('Almost done', 'ใกล้เสร็จ'), onClick: noop },
        onMore: more,
      },
    ],
    almost_done: [
      {
        id: 'RG-4K2W', table: '09', reference: 'RG-4K2W', round: 1, time: '19:36', waitMinutes: 16, lateAfterMinutes: 20, stage: 'almost_done',
        lines: [
          { id: 'l1', quantity: 1, name: 'ซี่โครงหมูย่าง', nameLang: 'th', secondary: 'Grilled Pork Ribs', secondaryLang: 'en', status: 'almost_done' },
          { id: 'l2', quantity: 1, name: 'สลัดรวมกับซอสบัลซามิก', nameLang: 'th', secondary: 'Green Salad with Balsamic Dressing', secondaryLang: 'en', status: 'almost_done' },
        ],
        primary: { label: tx('Mark ready', 'พร้อมเสิร์ฟ'), count: 2, onClick: noop },
        onMore: more,
      },
    ],
    ready: [
      {
        id: 'RG-4K5N', table: '02', reference: 'RG-4K5N', round: 2, time: '19:50', timeKind: 'ready', waitMinutes: 2, stage: 'ready',
        flags: [{ kind: 'ready' }],
        lines: [{ id: 'l1', quantity: 1, name: 'ปลาย่าง', nameLang: 'th', secondary: 'Grilled Fish', secondaryLang: 'en', status: 'ready' }],
        primary: { label: tx('Mark served', 'เสิร์ฟแล้ว'), count: 1, icon: 'check', onClick: noop },
        onMore: more,
      },
    ],
  };
}

function OrdersScreen({ tablet }: { tablet?: boolean }) {
  const { t } = useI18n();
  const tx = useTx();
  const [station, setStation] = useState<Station | 'all'>('all');
  const [table, setTable] = useState('all');
  const [sort, setSort] = useState('oldest');
  const [exceptions, setExceptions] = useState(false);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<BoardStage>('submitted');
  const [picked, setPicked] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const tickets = boardTickets(tx);
  const counts = Object.fromEntries(BOARD_STAGES.map((s) => [s, tickets[s].length])) as Record<BoardStage, number>;
  const floor = floorTables(tx);
  const columns = BOARD_STAGES.filter((s) => !tablet || s === stage).map((s) => (
    <BoardColumn
      key={s}
      stage={s}
      count={tickets[s].length}
      current={s === stage}
      help={s === 'ready' ? tx('Food under the rail is waiting to be run. Finish order records served lines only; it never closes a table.', 'อาหารใต้ราวรอพนักงานนำไปเสิร์ฟ ปุ่มจบออร์เดอร์บันทึกเฉพาะจานที่เสิร์ฟแล้ว และไม่ปิดโต๊ะ') : undefined}
    >
      {tickets[s].map(({ id, ...tk }) => <Ticket key={id} {...tk} />)}
    </BoardColumn>
  ));
  return (
    <div className={cx('a-app', tablet && 'a-app--compact')}>
      <StaffRail current="orders" compact={tablet} />
      <div className="ws">
        <WorkspaceHeader
          title={tx('Orders', 'ออร์เดอร์')}
          compact={tablet}
          demo
          tabs={[
            { id: 'board', label: tx('Board', 'บอร์ด'), href: '#board', current: true },
            { id: 'requests', label: tx('Requests', 'คำขอ'), href: '#requests', count: 2, countLabel: tx('2 open', 'รอ 2') },
            { id: 'history', label: tx('History', 'ประวัติ'), href: '#history' },
          ]}
          onTabNavigate={(_, e) => e.preventDefault()}
          connection={<ConnSlot />}
          ordering={<OrderingControl paused={paused} pausedDetail={t('common.staff.pausedBy', { name: 'Nok', time: '19:40' })} onPause={() => setPaused(true)} onResume={() => setPaused(false)} />}
          identity={<StaffChip name="Nok" role={tx('Floor manager', 'ผู้จัดการหน้าร้าน')} />}
        />
        <TableStrip tables={floor} openHref="#tables" onOpen={(e) => e.preventDefault()} selectedId={picked} onSelect={(id) => setPicked(picked === id ? null : id)} />
        <BoardToolbar
          stationCounts={{ kitchen: 6, bar: 3 }}
          station={station}
          onStation={setStation}
          tables={[{ value: 'all', label: tx('All', 'ทั้งหมด') }, ...floor.map((f) => ({ value: f.label, label: f.label }))]}
          table={table}
          onTable={setTable}
          sorts={[
            { value: 'oldest', label: tx('Oldest first', 'เก่าสุดก่อน') },
            { value: 'newest', label: tx('Newest first', 'ใหม่สุดก่อน') },
            { value: 'table', label: tx('Table number', 'เลขโต๊ะ') },
          ]}
          sort={sort}
          onSort={setSort}
          showExceptions={exceptions}
          onShowExceptions={setExceptions}
          query={query}
          onQuery={setQuery}
        />
        {tablet ? <BoardStatusSwitch counts={counts} value={stage} onChange={setStage} /> : null}
        <BoardGrid layout={tablet ? 'single' : 'columns'}>{columns}</BoardGrid>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fixtures: tables

type TileFixture = Omit<TableTileProps, 'action'> & { id: string };

function tableTiles(tx: Tx): TileFixture[] {
  const avail = (n: string): TileFixture => ({ id: n, label: n, state: 'available' });
  const dining = (n: string, seated: string, fact: string, attention: TileFixture['attention']): TileFixture => ({
    id: n, label: n, state: 'dining', seated, facts: [fact], attention,
  });
  return [
    avail('01'),
    dining('02', '1h 04', tx('3 rounds · 3 unserved', '3 รอบ · ยังไม่เสิร์ฟ 3'), [{ kind: 'ready', detail: 1 }]),
    dining('03', tx('6 min', '6 นาที'), tx('1 round · 5 to accept', '1 รอบ · รอรับ 5'), [{ kind: 'new' }]),
    avail('04'),
    {
      id: '05', label: '05', state: 'checking_out',
      facts: [<>{tx('Bill', 'บิล')} <b>฿2,480</b> · {tx('paid', 'ชำระแล้ว')} 19:49</>, tx('All food served', 'เสิร์ฟครบทุกจาน')],
    },
    avail('06'),
    dining('07', tx('48 min', '48 นาที'), tx('2 rounds · 2 preparing', '2 รอบ · กำลังทำ 2'), [{ kind: 'quote' }]),
    avail('08'),
    dining('09', tx('29 min', '29 นาที'), tx('1 round · 2 almost done', '1 รอบ · ใกล้เสร็จ 2'), [{ kind: 'call', detail: '19:50' }]),
    avail('10'),
    avail('11'),
    dining('12', tx('22 min', '22 นาที'), tx('2 rounds · 6 unserved', '2 รอบ · ยังไม่เสิร์ฟ 6'), [{ kind: 'new' }]),
    avail('13'),
    avail('14'),
    avail('15'),
    { id: '16', label: '16', state: 'disabled' },
  ];
}

function TableSeven({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const tx = useTx();
  const [revealed, setRevealed] = useState(false);
  return (
    <Drawer
      open
      inline
      onClose={onClose}
      lead={<TableBox label="07" />}
      title={t('common.table', { label: '07' })}
      status={<TableStatePill state="dining" />}
      subtitle={tx('Seated 19:04 · 48 min · 4 diners recorded by Nok', 'นั่งตั้งแต่ 19:04 · 48 นาที · 4 ท่าน บันทึกโดย Nok')}
      closeLabel={`${t('common.close')} · ${t('common.table', { label: '07' })}`}
      footer={
        <>
          <CheckoutBlockers
            id="gk-blockers-07"
            items={[
              tx('2 dishes in round 2 are not served', 'รอบที่ 2 ยังไม่ได้เสิร์ฟ 2 จาน'),
              tx('1 portion quote is waiting for the guest', 'มีใบชั่ง 1 รายการรอลูกค้ายืนยัน'),
              tx('No finalised bill or confirmed payment', 'ยังไม่มีบิลที่สรุปแล้วหรือการชำระที่ยืนยัน'),
            ]}
          />
          <div className="drawer__actions">
            <Button variant="outline" size="staff" icon="receipt" opensDialog>{tx('Start bill…', 'เริ่มสรุปบิล…')}</Button>
            <Button variant="primary" size="staff" aria-disabled aria-describedby="gk-blockers-07">{t('common.tile.checkout')}</Button>
          </div>
        </>
      }
    >
      <GuestAccessPanel pin="4821" revealed={revealed} onReveal={setRevealed} onRotate={noop} onRevoke={noop} devices={2} />
      <DrawerSection
        title={tx('Rounds', 'รอบที่สั่ง')}
        aside={<Button variant="ghost" size="staff" icon="plus">{tx('Assist order', 'สั่งแทนลูกค้า')}</Button>}
      >
        <RoundList
          rounds={[
            {
              id: 'r2', round: 2, reference: 'RG-4K7P', sentAt: '19:42',
              lines: [
                { id: 'a', quantity: 1, name: 'เนื้อสันในวากิวย่างซอสไวน์แดง', nameLang: 'th', status: 'preparing' },
                { id: 'b', quantity: 1, name: 'กุ้งแม่น้ำย่าง', nameLang: 'th', status: 'preparing' },
                { id: 'c', quantity: 1, name: 'เห็ดผัด', nameLang: 'th', status: 'served', time: '19:49' },
                { id: 'd', quantity: 1, name: 'สลัดรวมกับซอสบัลซามิก', nameLang: 'th', status: 'cancelled' },
              ],
            },
            {
              id: 'r1', round: 1, reference: 'RG-3H2M', allServedAt: '19:31',
              lines: [
                { id: 'e', quantity: 1, name: 'คอร์นริบ', nameLang: 'th', status: 'served' },
                { id: 'f', quantity: 1, name: 'เนื้อสันนอกออสเตรเลีย', nameLang: 'th', status: 'served' },
                { id: 'g', quantity: 1, name: 'เฟรนช์ฟรายส์', nameLang: 'th', status: 'served' },
              ],
            },
          ]}
          quotes={[{ name: 'ไพร์มริบ', nameLang: 'th', detail: '420 g · ฿2,058', status: tx('Awaiting guest · expires 20:05', 'รอลูกค้ายืนยัน · หมดอายุ 20:05') }]}
        />
      </DrawerSection>
      <DrawerSection title={tx('Bill', 'บิล')} aside={<Pill tone="line" size="sm">{tx('Open · not requested', 'เปิดอยู่ · ยังไม่ขอบิล')}</Pill>}>
        <KeyValue
          items={[
            { term: tx('Accepted food, 2 rounds', 'อาหารที่รับแล้ว 2 รอบ'), value: '฿3,630', strong: true },
            { term: tx('Cancelled (not charged)', 'ยกเลิก (ไม่คิดเงิน)'), value: '฿260' },
            { term: tx('Portion quote, not confirmed', 'ใบชั่งที่ยังไม่ยืนยัน'), value: tx('not included', 'ยังไม่รวม'), muted: true },
            { term: tx('Service charge / VAT', 'ค่าบริการ / VAT'), value: tx('Not configured', 'ยังไม่ได้ตั้งค่า'), muted: true },
          ]}
        />
      </DrawerSection>
      <DrawerSection title={tx('History', 'ประวัติ')} aside={<TextLink href="#audit" icon={null} onClick={(e) => e.preventDefault()}>{t('common.history.full')}</TextLink>}>
        <HistoryList
          items={[
            { id: 'h1', time: '19:50', event: tx('Portion quote sent', 'ส่งใบชั่ง'), detail: 'Prime Rib 420 g · Nok' },
            { id: 'h2', time: '19:49', event: tx('Served', 'เสิร์ฟแล้ว'), detail: 'Sauteed Mushrooms · Ploy' },
            { id: 'h3', time: '19:46', event: tx('Preparing', 'กำลังทำ'), detail: tx('2 dishes · Kitchen 1', '2 จาน · Kitchen 1') },
            { id: 'h4', time: '19:45', event: tx('Cancelled', 'ยกเลิก'), detail: tx('Green Salad · out of stock · Nok', 'Green Salad · ของหมด · Nok') },
            { id: 'h5', time: '19:43', event: tx('Accepted', 'รับแล้ว'), detail: tx('round 2 · Kitchen 1', 'รอบที่ 2 · Kitchen 1') },
            { id: 'h6', time: '19:42', event: tx('Received', 'ได้รับ'), detail: tx('round 2 · guest device', 'รอบที่ 2 · เครื่องลูกค้า') },
            { id: 'h7', time: '19:04', event: tx('Visit opened', 'เปิดโต๊ะ'), detail: tx('4 diners · Nok', '4 ท่าน · Nok') },
          ]}
        />
      </DrawerSection>
    </Drawer>
  );
}

function TablesScreen({ tablet }: { tablet?: boolean }) {
  const tx = useTx();
  const [filter, setFilter] = useState<TableFilter>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(tablet ? null : '07');
  const tiles = tableTiles(tx);
  const counts: Record<TableState, number> = { available: 0, dining: 0, checking_out: 0, disabled: 0 };
  for (const tl of tiles) counts[tl.state] += 1;
  const shown = tiles.filter((tl) =>
    (filter === 'all' || tl.state === filter)
    && (!attentionOnly || (tl.attention?.length ?? 0) > 0 || tl.state === 'checking_out')
    && (!query || tl.label.includes(query.trim())));
  const drawerOpen = !tablet && open !== null;
  return (
    <div className={cx('a-app', tablet && 'a-app--compact')}>
      <StaffRail current="tables" compact={tablet} />
      <div className="ws">
        <WorkspaceHeader
          title={tx('Tables', 'โต๊ะ')}
          compact={tablet}
          demo
          tabs={[
            { id: 'live', label: tx('Live', 'สด'), href: '#live', current: true },
            { id: 'qr', label: tx('QR codes', 'คิวอาร์โค้ด'), href: '#qr' },
            { id: 'visits', label: tx('Visit history', 'ประวัติการเปิดโต๊ะ'), href: '#visits' },
          ]}
          onTabNavigate={(_, e) => e.preventDefault()}
          connection={<ConnSlot />}
          identity={<StaffChip name="Nok" role={tx('Floor manager', 'ผู้จัดการหน้าร้าน')} />}
        />
        <TablesSummaryBar
          counts={counts}
          filter={filter}
          onFilter={setFilter}
          attentionCount={4}
          attentionOnly={attentionOnly}
          onAttentionOnly={setAttentionOnly}
          query={query}
          onQuery={setQuery}
        />
        <div className={cx('tgrid-wrap', !drawerOpen && 'tgrid-wrap--closed')}>
          <div className="tgrid">
            {shown.map(({ id, ...tl }) => (
              <TableTile
                key={id}
                {...tl}
                selected={tl.state === 'dining' && open === tl.label}
                action={{ onClick: tl.state === 'dining' ? () => setOpen(open === tl.label ? null : tl.label) : noop }}
              />
            ))}
          </div>
          {drawerOpen ? (
            open === '07' ? <TableSeven onClose={() => setOpen(null)} /> : (
              <Drawer open inline onClose={() => setOpen(null)} lead={<TableBox label={open} />} title={tx(`Table ${open}`, `โต๊ะ ${open}`)} status={<TableStatePill state="dining" />}>
                <p className="gk__note">{tx('The gallery carries full drawer fixtures for table 07 only.', 'แกลเลอรีนี้มีข้อมูลตัวอย่างครบเฉพาะโต๊ะ 07')}</p>
              </Drawer>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fixtures: insights

function weekBuckets(tx: Tx): ChartBucket[] {
  return [
    { key: '2026-09-14', label: tx('Mon', 'จ.'), sublabel: tx('14 Sep', '14 ก.ย.'), spoken: tx('Monday 14 September', 'วันจันทร์ที่ 14 กันยายน'), state: 'complete', value: 34, prior: 30, detail: tx('33 accepted, 1 cancelled, 20 ordering visits', 'รับ 33 ยกเลิก 1 โต๊ะที่สั่ง 20') },
    { key: '2026-09-15', label: tx('Tue', 'อ.'), sublabel: tx('15 Sep', '15 ก.ย.'), spoken: tx('Tuesday 15 September', 'วันอังคารที่ 15 กันยายน'), state: 'complete', value: 39, prior: 36, detail: tx('37 accepted, 1 rejected, 1 cancelled, 22 ordering visits', 'รับ 37 ปฏิเสธ 1 ยกเลิก 1 โต๊ะที่สั่ง 22') },
    { key: '2026-09-16', label: tx('Wed', 'พ.'), sublabel: tx('16 Sep', '16 ก.ย.'), spoken: tx('Wednesday 16 September', 'วันพุธที่ 16 กันยายน'), state: 'complete', value: 0, prior: 0 },
    { key: '2026-09-17', label: tx('Thu', 'พฤ.'), sublabel: tx('17 Sep', '17 ก.ย.'), spoken: tx('Thursday 17 September, today', 'วันพฤหัสบดีที่ 17 กันยายน วันนี้'), state: 'partial', value: 21, prior: 22, detail: tx('19 accepted, 13 ordering visits so far', 'รับแล้ว 19 โต๊ะที่สั่ง 13 จนถึงตอนนี้') },
    { key: '2026-09-18', label: tx('Fri', 'ศ.'), spoken: tx('Friday 18 September', 'วันศุกร์ที่ 18 กันยายน'), state: 'future', value: null },
    { key: '2026-09-19', label: tx('Sat', 'ส.'), spoken: tx('Saturday 19 September', 'วันเสาร์ที่ 19 กันยายน'), state: 'future', value: null },
    { key: '2026-09-20', label: tx('Sun', 'อา.'), spoken: tx('Sunday 20 September', 'วันอาทิตย์ที่ 20 กันยายน'), state: 'future', value: null },
  ];
}

const DAY_DETAIL: Record<string, { submitted: number; accepted: number; rejected: number; cancelled: number; visits: number }> = {
  '2026-09-14': { submitted: 34, accepted: 33, rejected: 0, cancelled: 1, visits: 20 },
  '2026-09-15': { submitted: 39, accepted: 37, rejected: 1, cancelled: 1, visits: 22 },
  '2026-09-16': { submitted: 0, accepted: 0, rejected: 0, cancelled: 0, visits: 0 },
  '2026-09-17': { submitted: 21, accepted: 19, rejected: 0, cancelled: 0, visits: 13 },
};

function monthBuckets(tx: Tx): ChartBucket[] {
  const values: Array<number | null> = [26, 0, 22, 35, null, 44, 30, 33, 0, 24, 37, 46, 41, 34, 39, 0, 21];
  return Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const key = `2026-09-${String(day).padStart(2, '0')}`;
    const spoken = tx(`${day} September`, `${day} กันยายน`);
    if (day > 17) return { key, label: String(day), spoken, state: 'future' as const, value: null };
    const v = values[i];
    if (v === null) return { key, label: String(day), spoken, state: 'missing' as const, value: null };
    return { key, label: String(day), spoken, state: day === 17 ? 'partial' as const : 'complete' as const, value: v };
  });
}

function yearBuckets(tx: Tx): ChartBucket[] {
  const en = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const th = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const values: Array<number | null> = [604, 571, null, 655, 690, 612, 701, 733, 402];
  return en.map((m, i) => {
    const key = `2026-${String(i + 1).padStart(2, '0')}`;
    const spoken = tx(`${m} 2026`, `${th[i]} 2026`);
    const label = tx(m, th[i]);
    if (i > 8) return { key, label, spoken, state: 'future' as const, value: null };
    if (values[i] === null) return { key, label, spoken, state: 'missing' as const, value: null };
    return { key, label, spoken, state: i === 8 ? 'partial' as const : 'complete' as const, value: values[i] };
  });
}

interface DrillRow { ref: string; table: string; round: number; sent: string; source: string; items: number; status: 'served' | 'partly' | 'rejected' }

function drillRows(tx: Tx): DrillRow[] {
  return [
    { ref: 'RG-3F8K', table: '04', round: 1, sent: '11:24', source: tx('Guest QR', 'QR ลูกค้า'), items: 3, status: 'served' },
    { ref: 'RG-3F9A', table: '11', round: 1, sent: '11:52', source: tx('Guest QR', 'QR ลูกค้า'), items: 5, status: 'served' },
    { ref: 'RG-3G2C', table: '02', round: 2, sent: '12:10', source: tx('Staff assist · Nok', 'พนักงานสั่งแทน · Nok'), items: 2, status: 'served' },
    { ref: 'RG-3G4N', table: '07', round: 1, sent: '12:31', source: tx('Guest QR', 'QR ลูกค้า'), items: 4, status: 'partly' },
    { ref: 'RG-3G7Q', table: '14', round: 1, sent: '12:48', source: tx('Guest QR', 'QR ลูกค้า'), items: 1, status: 'rejected' },
    { ref: 'RG-3H1D', table: '09', round: 3, sent: '13:05', source: tx('Guest QR', 'QR ลูกค้า'), items: 2, status: 'served' },
  ];
}

function rankingRows(tx: Tx): Array<RankingRowProps & { id: string }> {
  return [
    { id: 'corn', rank: 1, image: DISH('corn-rib'), name: 'คอร์นริบ', nameLang: 'th', english: 'Corn Rib', category: tx('Appetizers', 'ของทานเล่น'), servings: 31, shareText: '13%', bar: 1, orders: 27, visits: 25, change: { label: 'up', delta: 4 }, context: { kind: 'available' } },
    { id: 'strip', rank: 2, image: DISH('striploin'), name: 'เนื้อสันนอกออสเตรเลีย', nameLang: 'th', english: 'Australian Striploin', category: tx('Beef Selection', 'เนื้อ'), servings: 24, shareText: '10%', bar: 0.77, orders: 21, visits: 19, change: { label: 'up', delta: 2 }, context: { kind: 'available' } },
    { id: 'caesar', rank: 3, image: DISH('caesar'), name: 'กริลล์ซีซาร์สลัด', nameLang: 'th', english: 'Grilled Caesar Salad', category: tx('Salads', 'สลัด'), servings: 22, shareText: '9%', bar: 0.71, orders: 20, visits: 18, change: { label: 'down', delta: -3 }, context: { kind: 'available' } },
    { id: 'prawn', rank: 4, image: DISH('river-prawns'), name: 'กุ้งแม่น้ำย่าง', nameLang: 'th', english: 'Grilled River Prawns', category: tx('From the Grill', 'จากเตาย่าง'), servings: 17, shareText: '7%', bar: 0.55, orders: 16, visits: 15, change: { label: 'flat', delta: 0 }, context: { kind: 'available' } },
    { id: 'rib', rank: 5, image: DISH('primerib-full'), name: 'ไพร์มริบ', nameLang: 'th', english: 'Prime Rib', category: tx('Beef Selection', 'เนื้อ'), servings: 11, shareText: tx('5% · servings', '5% · จาน'), bar: 0.35, orders: 11, visits: 10, change: { label: 'up', delta: 1 }, context: { kind: 'by_weight', total: tx('4.6 kg confirmed in total', 'ยืนยันแล้วรวม 4.6 กก.') } },
    { id: 'tongue', rank: 6, image: DISH('grilled-tongue'), name: 'ลิ้นวัวย่าง', nameLang: 'th', english: 'Grilled Tongue', category: tx('Beef Selection', 'เนื้อ'), servings: 6, shareText: '3%', bar: 0.19, orders: 6, visits: 6, change: { label: 'down', delta: -5 }, context: { kind: 'sold_out', soldOutDays: 2, openDays: 3 } },
  ];
}

function InsightsScreen({ tablet }: { tablet?: boolean }) {
  const { t } = useI18n();
  const tx = useTx();
  const [period, setPeriod] = useState<StatsPeriod>('week');
  const [metric, setMetric] = useState('rounds');
  const [selected, setSelected] = useState('2026-09-15');
  const [sort, setSort] = useState<SortState>({ key: 'sent', dir: 'asc' });
  const [rankPeriod, setRankPeriod] = useState<StatsPeriod>('week');
  const [category, setCategory] = useState('food');
  const [direction, setDirection] = useState<'most' | 'least'>('most');
  const [find, setFind] = useState('');
  const week = weekBuckets(tx);
  const sel = week.find((b) => b.key === selected) ?? week[1];
  const detail = DAY_DETAIL[sel.key];
  const rows = [...drillRows(tx)].sort((a, b) => {
    const k = sort.key as keyof DrillRow;
    const va = a[k];
    const vb = b[k];
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return sort.dir === 'asc' ? c : -c;
  });
  const statusCell = (r: DrillRow) => r.status === 'served'
    ? <Pill tone="ok" icon="check" size="sm">{tx('Served', 'เสิร์ฟแล้ว')}</Pill>
    : r.status === 'partly'
      ? <Pill tone="heat" icon="slash" size="sm">{tx('Served · 1 cancelled', 'เสิร์ฟแล้ว · ยกเลิก 1')}</Pill>
      : <Pill tone="alert" icon="slash" size="sm">{tx('Rejected · table asked to cancel', 'ปฏิเสธ · โต๊ะขอยกเลิก')}</Pill>;
  const columns: Array<DataColumn<DrillRow>> = [
    { key: 'ref', header: tx('Reference', 'เลขอ้างอิง'), code: true, sortable: true, cell: (r) => <span lang="en">{r.ref}</span> },
    { key: 'table', header: tx('Table', 'โต๊ะ'), sortable: true, cell: (r) => r.table },
    { key: 'round', header: tx('Round', 'รอบ'), numeric: true, cell: (r) => r.round },
    { key: 'sent', header: tx('Sent', 'เวลาส่ง'), sortable: true, cell: (r) => r.sent },
    { key: 'source', header: tx('Source', 'ช่องทาง'), cell: (r) => r.source },
    { key: 'items', header: tx('Items', 'รายการ'), numeric: true, sortable: true, cell: (r) => r.items },
    { key: 'status', header: tx('Status', 'สถานะ'), cell: statusCell },
  ];
  const hourly = [3, 6, 5, 2, 1, 0, 2, 5, 7, 6, 2].map((v, i) => ({ key: `h${11 + i}`, label: String(11 + i), value: v }));
  return (
    <div className={cx('a-app', tablet && 'a-app--compact')}>
      <StaffRail current="insights" compact={tablet} />
      <div className="ws">
        <WorkspaceHeader
          title={tx('Insights', 'สถิติ')}
          compact={tablet}
          tabs={[
            { id: 'orders', label: tx('Order Stats', 'สถิติออร์เดอร์'), href: '#order-stats', current: true },
            { id: 'menu', label: tx('Menu Stats', 'สถิติเมนู'), href: '#menu-stats' },
            { id: 'engagement', label: tx('Engagement', 'การใช้งาน'), href: '#engagement' },
          ]}
          onTabNavigate={(_, e) => e.preventDefault()}
          extra={
            <>
              <p className="ordering__state gk__asof">{tx('Data as of', 'ข้อมูลเมื่อ')} <b>19:52</b>&nbsp;· {tx('refreshed 1 min ago', 'อัปเดต 1 นาทีที่แล้ว')}</p>
              <Button variant="outline" size="staff" icon="download">{tx('Export CSV', 'ส่งออก CSV')}</Button>
            </>
          }
          identity={<StaffChip name="Nok" role={tx('Owner', 'เจ้าของร้าน')} />}
        />
        <Banner variant="demo" staff title={tx('Demo data.', 'ข้อมูลทดลอง')}>
          {tx('These figures come from seed fixtures, not from Rabbit Grill’s real service. Reports and exports are labelled the same way until live data exists.', 'ตัวเลขชุดนี้มาจากข้อมูลตัวอย่าง ไม่ใช่การขายจริงของร้าน รายงานและไฟล์ส่งออกจะติดป้ายแบบเดียวกันจนกว่าจะมีข้อมูลจริง')}
        </Banner>
        <div className="ins">
          <DateRangeNav
            period={period}
            onPeriod={setPeriod}
            label={tx('This week', 'สัปดาห์นี้')}
            range={tx('Mon 14 – Sun 20 Sep 2026', 'จ. 14 – อา. 20 ก.ย. 2026')}
            timeZone="Asia/Bangkok"
            onPrev={noop}
            onNext={noop}
            onCurrent={noop}
            isCurrent
            date="2026-09-17"
            onPickDate={noop}
          />
          <MetricSwitch
            value={metric}
            onChange={setMetric}
            onExplain={noop}
            options={[
              { value: 'rounds', label: tx('Order rounds', 'รอบสั่ง') },
              { value: 'accepted', label: tx('Accepted rounds', 'รอบที่รับแล้ว') },
              { value: 'visits', label: tx('Ordering visits', 'โต๊ะที่สั่ง') },
              { value: 'devices', label: tx('Ordering devices', 'เครื่องที่สั่ง') },
              { value: 'diners', label: tx('Recorded diners', 'จำนวนลูกค้าที่บันทึก') },
              { value: 'items', label: tx('Items ordered', 'จำนวนจานที่สั่ง') },
            ]}
          />
          <ChartPanel labelledBy={tablet ? 'gk-wk-t' : 'gk-wk-d'}>
            <HeroMetric
              labelId={tablet ? 'gk-wk-t' : 'gk-wk-d'}
              label={tx('Order rounds · this week so far', 'รอบสั่ง · สัปดาห์นี้ถึงตอนนี้')}
              value="94"
              unit={tx('submitted order rounds, Mon 14 to Thu 17 at 19:52', 'รอบสั่งที่ส่งเข้ามา จ. 14 ถึง พฤ. 17 เวลา 19:52')}
              comparison={{
                direction: 'up',
                delta: '6',
                text: tx('vs 88 at the same point last week', 'เทียบกับ 88 ในช่วงเดียวกันของสัปดาห์ก่อน'),
                sub: tx('Mon–Thu to 19:52 · +7%', 'จ.–พฤ. ถึง 19:52 · +7%'),
              }}
              selected={detail ? {
                title: `${sel.label} ${sel.sublabel ?? ''}`.trim(),
                tag: t('common.stats.selected'),
                items: [
                  { term: tx('Submitted', 'ส่งเข้ามา'), value: String(detail.submitted) },
                  { term: tx('Accepted', 'รับแล้ว'), value: String(detail.accepted) },
                  { term: tx('Rejected · cancelled', 'ปฏิเสธ · ยกเลิก'), value: `${detail.rejected} · ${detail.cancelled}` },
                  { term: tx('Ordering visits', 'โต๊ะที่สั่ง'), value: String(detail.visits) },
                ],
              } : null}
            />
            <WeekBarChart
              title={tx('Submitted order rounds per day', 'รอบสั่งที่ส่งเข้ามาต่อวัน')}
              unit={tx('order rounds', 'รอบสั่ง')}
              listLabel={tx('Order rounds by day', 'รอบสั่งรายวัน')}
              buckets={week}
              selectedKey={selected}
              onSelect={setSelected}
            />
          </ChartPanel>

          <StatGrid>
            <StatCard label={tx('Orders today', 'ออร์เดอร์วันนี้')} value="21" live comparison={{ direction: 'down', delta: '1', text: tx('vs last Thursday at 19:52', 'เทียบกับพฤหัสก่อนเวลา 19:52') }} definition={tx('Submitted order rounds since opening today, including rounds later rejected.', 'รอบสั่งที่ส่งเข้ามาตั้งแต่เปิดร้านวันนี้ รวมรอบที่ถูกปฏิเสธภายหลัง')} />
            <StatCard label={tx('Ordering visits', 'โต๊ะที่สั่ง')} value="58" unit={tx('this week', 'สัปดาห์นี้')} note={tx('Distinct visits, counted once for the week', 'นับแต่ละการเปิดโต๊ะครั้งเดียวทั้งสัปดาห์')} definition={tx('Dining visits with at least one submitted round. Repeat rounds do not add visits.', 'การเปิดโต๊ะที่มีรอบสั่งอย่างน้อยหนึ่งรอบ สั่งซ้ำไม่นับเพิ่ม')} />
            <StatCard label={tx('Recorded diners', 'ลูกค้าที่บันทึก')} value="164" coverage={{ ratio: 49 / 58, text: <>{tx('Covers entered for', 'บันทึกจำนวนลูกค้าแล้ว')} <b>{tx('49 of 58', '49 จาก 58')}</b> {tx('visits. Missing covers are not estimated.', 'โต๊ะ ส่วนที่ไม่ได้บันทึกจะไม่ประมาณเอง')}</> }} definition={tx('Sum of staff-entered covers. A shared phone cannot tell how many people are seated.', 'ผลรวมจำนวนลูกค้าที่พนักงานบันทึก โทรศัพท์เครื่องเดียวบอกจำนวนคนที่นั่งไม่ได้')} />
            <StatCard label={tx('Median acceptance', 'เวลารับออร์เดอร์ (มัธยฐาน)')} parts={[{ n: '2', unit: 'm' }, { n: '10', unit: 's' }]} note={tx('Received to accepted · 92 rounds', 'จากได้รับถึงรับออร์เดอร์ · 92 รอบ')} definition={tx('Middle value of the time between a round arriving and staff accepting it.', 'ค่ากลางของเวลาตั้งแต่รอบสั่งเข้ามาจนพนักงานกดรับ')} />
            <StatCard label={tx('Unresolved now', 'ค้างอยู่ตอนนี้')} value="5" live note={<>{tx('Oldest waiting', 'รอนานที่สุด')} <b>{tx('22 min', '22 นาที')}</b> · {tx('table 12', 'โต๊ะ 12')}</>} definition={tx('Rounds with at least one line not yet served, rejected or cancelled.', 'รอบที่ยังมีจานที่ยังไม่เสิร์ฟ ไม่ถูกปฏิเสธ และไม่ถูกยกเลิก')} />
          </StatGrid>

          <section className="gk__stack" aria-labelledby={tablet ? 'gk-dd-t' : 'gk-dd-d'}>
            <SectionHeader
              titleId={tablet ? 'gk-dd-t' : 'gk-dd-d'}
              title={tx('Tue 15 Sep · 39 order rounds', 'อ. 15 ก.ย. · 39 รอบสั่ง')}
              description={tx('Table shown as it was when the order was sent · showing 6 of 39', 'แสดงโต๊ะตามตอนที่ส่งออร์เดอร์ · แสดง 6 จาก 39')}
              actions={<Button variant="outline" size="staff" icon="download">{tx('CSV for this day', 'CSV ของวันนี้')}</Button>}
            />
            <DataTable<DrillRow>
              caption={tx('Order rounds on Tuesday 15 September', 'รอบสั่งวันอังคารที่ 15 กันยายน')}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.ref}
              sort={sort}
              onSort={(key) => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
              footer={<TextLink href="#all" icon={null} onClick={(e) => e.preventDefault()}>{tx('Show all 39 rounds', 'ดูทั้งหมด 39 รอบ')}</TextLink>}
            />
            <div className="gk__card">
              <MiniBars title={tx('Rounds by hour · Tue 15 Sep', 'รอบสั่งรายชั่วโมง · อ. 15 ก.ย.')} unit={tx('rounds', 'รอบ')} data={hourly} />
            </div>
          </section>

          <section className="gk__split" aria-labelledby={tablet ? 'gk-ms-t' : 'gk-ms-d'}>
            <SectionHeader
              display
              titleId={tablet ? 'gk-ms-t' : 'gk-ms-d'}
              title={tx('Menu Stats', 'สถิติเมนู')}
              description={tx('Most ordered · net accepted servings · rejected and cancelled quantities excluded', 'สั่งมากที่สุด · นับจานที่รับแล้วสุทธิ · ไม่นับจานที่ปฏิเสธหรือยกเลิก')}
              actions={<StaffSearch label={tx('Find a dish', 'ค้นหาจาน')} placeholder={tx('Find a dish', 'ค้นหาจาน')} value={find} onChange={setFind} className="gk__find" />}
            />
            <DateRangeNav
              layout="ranking"
              period={rankPeriod}
              onPeriod={setRankPeriod}
              periods={['week', 'month', 'year', 'custom']}
              label={tx('Mon 14 – Thu 17 Sep 2026', 'จ. 14 – พฤ. 17 ก.ย. 2026')}
              range={tx('This week so far', 'สัปดาห์นี้ถึงตอนนี้')}
              onPrev={noop}
              onNext={noop}
              nextDisabled
            >
              <SelectButton
                label={tx('Category', 'หมวด')}
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'food', label: tx('All food', 'อาหารทั้งหมด') },
                  { value: 'beef', label: tx('Beef Selection', 'เนื้อ') },
                  { value: 'drinks', label: tx('All drinks', 'เครื่องดื่มทั้งหมด') },
                ]}
              />
              <FilterChips
                label={tx('Order', 'ลำดับ')}
                value={direction}
                onChange={setDirection}
                options={[
                  { value: 'most', label: tx('Most ordered', 'สั่งมากที่สุด') },
                  { value: 'least', label: tx('Least ordered', 'สั่งน้อยที่สุด') },
                ]}
              />
            </DateRangeNav>
            <RankingTable
              label={tx('Most ordered dishes this week', 'จานที่สั่งมากที่สุดสัปดาห์นี้')}
              footerText={<>{tx('Showing 6 of 34 published food items', 'แสดง 6 จาก 34 เมนูอาหารที่เปิดขาย')} · <b>2</b> {tx('never ordered despite being available', 'มีขายแต่ยังไม่มีคนสั่ง')} · <b>1</b> {tx('with too little availability to rank', 'มีขายน้อยเกินกว่าจะจัดอันดับ')}</>}
              footerAction={<Button variant="outline" size="staff">{tx('Full ranking', 'ดูอันดับทั้งหมด')}</Button>}
            >
              {rankingRows(tx).filter((r) => !find || `${r.name} ${r.english ?? ''}`.toLowerCase().includes(find.trim().toLowerCase())).map(({ id, ...r }) => <RankingRow key={id} {...r} imageLoading="eager" />)}
            </RankingTable>
          </section>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ states and pieces

function ChartStates() {
  const tx = useTx();
  const [monthSel, setMonthSel] = useState<string | null>('2026-09-15');
  const [yearSel, setYearSel] = useState<string | null>('2026-08');
  const [view, setView] = useState<'chart' | 'table'>('table');
  const week = weekBuckets(tx);
  return (
    <div className="gk__stack">
      <ChartPanel solo aria-label={tx('Month view', 'มุมมองรายเดือน')}>
        <WeekBarChart
          title={tx('Order rounds per day · September 2026', 'รอบสั่งรายวัน · กันยายน 2026')}
          unit={tx('order rounds', 'รอบสั่ง')}
          buckets={monthBuckets(tx)}
          selectedKey={monthSel}
          onSelect={setMonthSel}
          onRetry={noop}
          height={220}
        />
      </ChartPanel>
      <ChartPanel solo aria-label={tx('Year view', 'มุมมองรายปี')}>
        <WeekBarChart
          title={tx('Order rounds per month · 2026', 'รอบสั่งรายเดือน · 2026')}
          unit={tx('order rounds', 'รอบสั่ง')}
          buckets={yearBuckets(tx)}
          selectedKey={yearSel}
          onSelect={setYearSel}
          onRetry={noop}
          currentLabel={tx('This month', 'เดือนนี้')}
          height={220}
          legend={false}
        />
      </ChartPanel>
      <div className="gk__grid2">
        <ChartPanel solo aria-label={tx('Text equivalent', 'ข้อมูลแบบตาราง')}>
          <WeekBarChart
            title={tx('Submitted order rounds per day', 'รอบสั่งที่ส่งเข้ามาต่อวัน')}
            unit={tx('order rounds', 'รอบสั่ง')}
            buckets={week}
            view={view}
            onViewChange={setView}
            selectedKey="2026-09-15"
          />
        </ChartPanel>
        <ChartPanel solo tone="light" aria-label={tx('Light variant for print', 'แบบพื้นสว่างสำหรับพิมพ์')}>
          <WeekBarChart
            title={tx('Light variant · print and PDF', 'แบบพื้นสว่าง · พิมพ์และ PDF')}
            unit={tx('order rounds', 'รอบสั่ง')}
            buckets={week}
            height={200}
            legend={false}
          />
        </ChartPanel>
      </div>
      <StatGrid>
        <StatCard label={tx('Orders today', 'ออร์เดอร์วันนี้')} state="loading" />
        <StatCard label={tx('Ordering devices', 'เครื่องที่สั่ง')} state="error" onRetry={noop} />
        <StatCard label={tx('Items ordered', 'จำนวนจานที่สั่ง')} value="212" comparison={{ direction: 'none', text: '' }} note={tx('Previous week had no service', 'สัปดาห์ก่อนร้านไม่ได้เปิด')} />
        <StatCard label={tx('Accepted rounds', 'รอบที่รับแล้ว')} value="90" comparison={{ direction: 'flat', text: tx('vs last week at 19:52', 'เทียบกับสัปดาห์ก่อนเวลา 19:52') }} />
        <StatCard label={tx('Recorded diners', 'ลูกค้าที่บันทึก')} value="0" coverage={{ ratio: 0, text: tx('Covers entered for 0 of 13 visits today. Missing covers are not estimated.', 'วันนี้ยังไม่ได้บันทึกจำนวนลูกค้าเลยจาก 13 โต๊ะ ส่วนที่ไม่ได้บันทึกจะไม่ประมาณเอง') }} />
      </StatGrid>
      <RankingTable
        label={tx('Least ordered dishes this week', 'จานที่สั่งน้อยที่สุดสัปดาห์นี้')}
        footerText={tx('Least ordered includes published dishes with zero orders; drafts and dishes never available this week are left out.', 'รายการสั่งน้อยที่สุดรวมเมนูที่เปิดขายแต่ยังไม่มีคนสั่ง ไม่รวมฉบับร่างและเมนูที่ไม่ได้ขายสัปดาห์นี้')}
      >
        <RankingRow imageLoading="eager" rank={32} image={DISH('mushrooms')} name="เห็ดผัด" nameLang="th" english="Sauteed Mushrooms" category={tx('Sides', 'เครื่องเคียง')} servings={2} shareText="1%" bar={0.06} orders={2} visits={2} change={{ label: 'no_baseline' }} context={{ kind: 'partial', availableDays: 2, openDays: 3 }} />
        <RankingRow rank={33} image={null} name="Hoegaarden White" nameLang="en" category={tx('Beer', 'เบียร์')} servings={1} shareText="0%" bar={0.03} orders={1} visits={1} change={{ label: 'new' }} context={{ kind: 'insufficient' }} variants={[{ name: '500 ml', lang: 'en', servings: 1 }]} />
        <RankingRow imageLoading="eager" rank={34} image={DISH('pork-ribs')} name="ซี่โครงหมูย่าง" nameLang="th" english="Grilled Pork Ribs" category={tx('From the Grill', 'จากเตาย่าง')} servings={0} shareText="0%" bar={0} orders={0} visits={0} change={{ label: 'flat', delta: 0 }} context={{ kind: 'never_ordered' }} />
      </RankingTable>
    </div>
  );
}

function TicketStates() {
  const { t } = useI18n();
  const tx = useTx();
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [stage, setStage] = useState<'all' | 'kitchen' | 'bar'>('all');
  return (
    <div className="gk__row">
      <div className="gk__col gk__well">
        <Ticket
          table="09"
          reference="RG-4K2W"
          round={1}
          time="19:36"
          waitMinutes={17}
          stage="almost_done"
          conflict={reviewed ? null : { by: 'Ploy', at: '19:51', onReview: () => setReviewed(true) }}
          lines={[
            { id: 'a', quantity: 1, name: 'ซี่โครงหมูย่าง', nameLang: 'th', secondary: 'Grilled Pork Ribs', secondaryLang: 'en', status: 'ready', statusAt: '19:51', actor: 'Kitchen 1' },
            { id: 'b', quantity: 1, name: 'สลัดรวมกับซอสบัลซามิก', nameLang: 'th', secondary: 'Green Salad with Balsamic Dressing', secondaryLang: 'en', status: 'almost_done', statusAt: '19:49' },
          ]}
          primary={{ label: tx('Mark ready', 'พร้อมเสิร์ฟ'), count: 1, onClick: noop }}
          onMore={noop}
        />
      </div>
      <div className="gk__col gk__well">
        <Ticket
          table="04"
          reference="RG-4M4B"
          round={1}
          time="19:52"
          waitMinutes={0}
          stage="submitted"
          isNew
          flags={[{ kind: 'just' }, { kind: 'station', label: tx('Kitchen', 'ครัว') }]}
          lines={[
            { id: 'a', quantity: 1, name: 'ลิ้นวัวย่าง', nameLang: 'th', secondary: 'Grilled Tongue', secondaryLang: 'en', status: 'submitted', note: 'ไม่ใส่พริกไทย', noteLang: 'th' },
            { id: 'b', quantity: 3, name: 'คอร์นริบ', nameLang: 'th', secondary: 'Corn Rib', secondaryLang: 'en', status: 'rejected', statusAt: '19:52', reason: tx('sold out', 'หมด'), actor: 'Nok' },
          ]}
          primary={{ label: tx('Accept', 'รับออร์เดอร์'), count: 1, icon: 'check', busy, onClick: () => { setBusy(true); window.setTimeout(() => setBusy(false), 1400); } }}
          onMore={noop}
        />
      </div>
      <div className="gk__col gk__well">
        <Ticket
          table="02"
          reference="RG-4K5N"
          round={2}
          time="19:50"
          timeKind="ready"
          waitMinutes={6}
          stage="ready"
          flags={[{ kind: 'ready', minutes: 6 }]}
          lines={[
            { id: 'a', quantity: 2, name: 'ปลาย่าง', nameLang: 'th', secondary: 'Grilled Fish', secondaryLang: 'en', status: 'served', statusAt: '19:55', actor: 'Ploy' },
            { id: 'b', quantity: 1, name: 'เฟรนช์ฟรายส์', nameLang: 'th', secondary: 'French Fries', secondaryLang: 'en', status: 'ready', statusAt: '19:50' },
          ]}
          primary={{ label: tx('Mark served', 'เสิร์ฟแล้ว'), count: 1, icon: 'check', onClick: noop }}
          onMore={noop}
        />
      </div>
      <div className="gk__col">
        <div className="board board--flush">
          <BoardColumn stage="accepted" count={0} />
        </div>
      </div>
      <div className="gk__stack gk__stack--start">
        <FilterChips
          label={tx('Station', 'จุดทำอาหาร')}
          value={stage}
          onChange={setStage}
          options={[
            { value: 'all', label: tx('All stations', 'ทุกจุด') },
            { value: 'kitchen', label: tx('Kitchen', 'ครัว'), count: 6 },
            { value: 'bar', label: tx('Bar', 'บาร์'), count: 3 },
          ]}
        />
        <OrderingControl paused pausedDetail={t('common.staff.pausedBy', { name: 'Nok', time: '19:40' })} onResume={noop} />
        <OrderingControl paused={false} onPause={noop} />
        <div className="gk__row">
          {(['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served', 'rejected', 'cancelled'] as const).map((s) => (
            <LineStatusPill key={s} status={s} time={s === 'served' ? '19:49' : undefined} />
          ))}
        </div>
        <div className="gk__row">
          {(['new', 'ready', 'call', 'quote', 'bill'] as const).map((k) => <span key={k} className="tcard__badges"><AttnBadge kind={k} detail={k === 'call' ? '19:50' : k === 'ready' ? 1 : undefined} /></span>)}
        </div>
        <TableLegend counts={{ available: 9, dining: 5, checking_out: 1, disabled: 1 }} />
      </div>
    </div>
  );
}

interface TeamRow { id: string; name: string; role: string; last: string }

function PiecesSection() {
  const { t } = useI18n();
  const tx = useTx();
  const [seg, setSeg] = useState<StatsPeriod>('week');
  const [check, setCheck] = useState(true);
  const [pick, setPick] = useState('07');
  const [search, setSearch] = useState('Prime');
  const [revealed, setRevealed] = useState(true);
  const [teamSort, setTeamSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const team: TeamRow[] = [
    { id: 'u1', name: 'Nok', role: tx('Floor manager', 'ผู้จัดการหน้าร้าน'), last: '17 Sep, 16:58' },
    { id: 'u2', name: 'Ploy', role: tx('Server', 'พนักงานเสิร์ฟ'), last: '17 Sep, 17:02' },
    { id: 'u3', name: 'Kitchen 1', role: tx('Kitchen', 'ครัว'), last: '17 Sep, 16:40' },
  ];
  const sortedTeam = [...team].sort((a, b) => (teamSort.dir === 'asc' ? 1 : -1) * a[teamSort.key as 'name' | 'role'].localeCompare(b[teamSort.key as 'name' | 'role']));
  return (
    <div className="gk__stack">
      <div className="gk__frame gk__frame--1440">
        <PageHeader
          title={tx('Annual reports', 'รายงานประจำปี')}
          back={{ label: tx('More', 'เพิ่มเติม'), href: '#more', onNavigate: (e) => e.preventDefault() }}
          description={tx('Each report is a snapshot of one calendar year in Asia/Bangkok. A new version is generated when earlier data changes; older files stay available.', 'รายงานแต่ละฉบับคือภาพรวมหนึ่งปีปฏิทินตามเวลา Asia/Bangkok ถ้าข้อมูลย้อนหลังเปลี่ยนจะสร้างฉบับใหม่ และยังดาวน์โหลดฉบับเก่าได้')}
          actions={<Button variant="primary" size="staff" opensDialog>{tx('Generate report…', 'สร้างรายงาน…')}</Button>}
          demo
        />
        <div className="gk__pad">
          <JobList aria-label={tx('Report jobs', 'งานสร้างรายงาน')}>
            <JobStatusRow as="li" title={tx('Annual report 2026 · PDF', 'รายงานประจำปี 2026 · PDF')} label="provisional" fixture status="queued" meta={tx('Requested by Nok · 17 Sep, 19:52 · data to 19:52', 'Nok ขอเมื่อ 17 ก.ย. 19:52 · ข้อมูลถึง 19:52')} />
            <JobStatusRow as="li" title={tx('Annual report 2026 · CSV export', 'รายงานประจำปี 2026 · ไฟล์ CSV')} label="provisional" fixture status="generating" meta={tx('Requested by Nok · 17 Sep, 19:40 · started 19:41', 'Nok ขอเมื่อ 17 ก.ย. 19:40 · เริ่ม 19:41')} />
            <JobStatusRow as="li" title={tx('Annual report 2025 · PDF', 'รายงานประจำปี 2025 · PDF')} label="revised" revision={2} status="ready" size="2.4 MB" downloadHref="#download" meta={tx('Generated 1 Jan 2026, 00:12 · snapshot v3', 'สร้างเมื่อ 1 ม.ค. 2026 00:12 · ข้อมูลชุดที่ 3')} />
            <JobStatusRow as="li" title={tx('Annual report 2025 · CSV export', 'รายงานประจำปี 2025 · ไฟล์ CSV')} label="final" status="failed" attempts={2} error={tx('The export stopped before it finished. Nothing was saved; try again.', 'การส่งออกหยุดก่อนเสร็จ ยังไม่มีไฟล์ถูกบันทึก ลองอีกครั้งได้')} onRetry={noop} meta={tx('Requested by Nok · 16 Sep, 22:05', 'Nok ขอเมื่อ 16 ก.ย. 22:05')} />
          </JobList>
          <AuditList aria-label={tx('Audit entries', 'บันทึกการแก้ไข')}>
            <AuditEntry time="19:45" date={tx('17 Sep', '17 ก.ย.')} at="2026-09-17T12:45:00Z" actor="Nok" action={tx('Line cancelled', 'ยกเลิกจาน')} target="Green Salad · RG-4K7P · table 07" reason={tx('Out of stock', 'ของหมด')} changes={[{ field: tx('Status', 'สถานะ'), before: tx('Preparing', 'กำลังทำ'), after: tx('Cancelled', 'ยกเลิกแล้ว') }, { field: tx('Charged', 'คิดเงิน'), before: '฿260', after: '฿0' }]} />
            <AuditEntry time="19:40" date={tx('17 Sep', '17 ก.ย.')} actor="Nok" action={tx('Guest ordering paused', 'หยุดรับออร์เดอร์ชั่วคราว')} reason={tx('Kitchen backed up, 15 minutes', 'ครัวแน่น 15 นาที')} changes={[{ field: tx('Guest ordering', 'การสั่งของลูกค้า'), before: tx('Open', 'เปิดรับ'), after: tx('Paused until 19:55', 'หยุดถึง 19:55') }]} />
            <AuditEntry time="16:58" date={tx('17 Sep', '17 ก.ย.')} actor={tx('System', 'ระบบ')} actorType="system" action={tx('Menu price published', 'เผยแพร่ราคาเมนู')} target="Prime Rib" changes={[{ field: tx('Rate per 100 g', 'ราคาต่อ 100 กรัม'), before: '', after: '฿490' }]} />
          </AuditList>
        </div>
      </div>

      <div className="gk__grid2">
        <div className="gk__card gk__stack">
          <div className="gk__row">
            <PeriodSwitch value={seg} onChange={setSeg} />
            <CheckButton label={tx('Needs attention', 'ต้องดูแล')} checked={check} onChange={setCheck} count={4} />
          </div>
          <div className="gk__row">
            <SelectButton label={tx('Table', 'โต๊ะ')} value={pick} onChange={setPick} options={['01', '02', '03', '07', '12'].map((v) => ({ value: v, label: v }))} />
            <SelectButton label={tx('Sort', 'เรียง')} icon="sort" value="oldest" onChange={noop} options={[{ value: 'oldest', label: tx('Oldest first', 'เก่าสุดก่อน') }]} disabled />
          </div>
          <StaffSearch label={tx('Search table, reference or dish', 'ค้นหาโต๊ะ เลขอ้างอิง หรือชื่อจาน')} placeholder={tx('Table, reference or dish', 'โต๊ะ เลขอ้างอิง หรือชื่อจาน')} value={search} onChange={setSearch} />
          <KeyValue items={[{ term: tx('Opened', 'เปิดโต๊ะ'), value: '19:04' }, { term: tx('Diners', 'จำนวนลูกค้า'), value: tx('4 · recorded by Nok', '4 · บันทึกโดย Nok') }, { term: tx('Guest devices', 'เครื่องลูกค้า'), value: '2' }]} />
        </div>
        <div className="gk__drawer">
          <TableDrawerHeader label="12" state="dining" meta={tx('Seated 19:30 · 22 min · diners not recorded', 'นั่งตั้งแต่ 19:30 · 22 นาที · ยังไม่ได้บันทึกจำนวนลูกค้า')} onClose={noop} />
          <div className="drawer__body">
            <GuestAccessPanel pin="0419" revealed={revealed} onReveal={setRevealed} onRotate={noop} onRevoke={noop} devices={1} lockedUntil="20:05" />
          </div>
        </div>
      </div>

      <div className="gk__grid2">
        <DataTable<TeamRow>
          caption={tx('Team', 'ทีม')}
          showCaption
          columns={[
            { key: 'name', header: tx('Name', 'ชื่อ'), sortable: true, cell: (r) => <b>{r.name}</b> },
            { key: 'role', header: tx('Role', 'ตำแหน่ง'), sortable: true, cell: (r) => r.role },
            { key: 'last', header: tx('Last sign-in', 'เข้าระบบล่าสุด'), cell: (r) => r.last },
          ]}
          rows={sortedTeam}
          rowKey={(r) => r.id}
          selectedKey="u2"
          sort={teamSort}
          onSort={(key) => setTeamSort(teamSort.key === key ? { key, dir: teamSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
          rowActions={(r) => <IconButton icon="more" variant="framed" size="staff" label={tx(`Actions for ${r.name}`, `การทำงานของ ${r.name}`)} opensDialog />}
          footer={<span className="gk__note">{t('common.staff.showing', { n: 3, total: 3 })}</span>}
          maxHeight={260}
        />
        <DataTable<TeamRow>
          caption={tx('Payments with exceptions', 'การชำระที่มีข้อยกเว้น')}
          showCaption
          columns={[
            { key: 'name', header: tx('Table', 'โต๊ะ'), cell: (r) => r.name },
            { key: 'role', header: tx('Reason', 'เหตุผล'), cell: (r) => r.role },
          ]}
          rows={[]}
          rowKey={(r) => r.id}
          empty={<p className="dtable__none">{tx('No payment exceptions today.', 'วันนี้ไม่มีการชำระที่มีข้อยกเว้น')}</p>}
        />
      </div>

      <div className="gk__phone">
        <WorkspaceHeader title={tx('Orders', 'ออร์เดอร์')} compact connection={<ConnSlot />} identity={<StaffChip name="Nok" role={tx('Floor manager', 'ผู้จัดการหน้าร้าน')} onOpen={noop} menuLabel={tx('Open account menu', 'เปิดเมนูบัญชี')} />} />
        <div className="gk__pad">
          <BoardStatusSwitch counts={{ submitted: 2, accepted: 1, preparing: 2, almost_done: 1, ready: 1 }} value="submitted" onChange={noop} />
          <Ticket
            table="03"
            reference="RG-4M2Q"
            round={1}
            time="19:48"
            waitMinutes={4}
            stage="submitted"
            isNew
            flags={[{ kind: 'oldest' }]}
            allergy={{ text: 'แพ้ถั่วลิสง', lang: 'th' }}
            lines={[{ id: 'a', quantity: 1, name: 'มันบด', nameLang: 'th', secondary: 'Mashed Potato', secondaryLang: 'en', status: 'submitted' }]}
            primary={{ label: tx('Accept', 'รับออร์เดอร์'), count: 1, icon: 'check', onClick: noop }}
            onMore={noop}
          />
        </div>
        <RailNav mode="bar" items={railItems(tx, 'orders')} onNavigate={(_, e) => e.preventDefault()} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

function AdminKitGallery() {
  const { lang } = useI18n();
  const tx = useTx();
  return (
    <div className="gk" lang={lang} id="admin-kit">
      <header className="gk__intro">
        <p className="gk__kicker" lang="en">ui/admin · staff &amp; data kit</p>
        <h1 className="gk__title">{tx('Staff & data kit', 'ชุดคอมโพเนนต์ฝั่งพนักงาน')}</h1>
        <p className="gk__lede">
          {tx(
            'Every staff and analytics component with the admin mock fixtures (Thu 17 Sep 2026, 19:52, Asia/Bangkok). All figures and staff names are demo data. The language box in any rail switches the whole kit between Thai and English.',
            'คอมโพเนนต์ฝั่งพนักงานและสถิติทั้งหมด พร้อมข้อมูลตัวอย่างจากม็อกอัป (พฤ. 17 ก.ย. 2026 เวลา 19:52 Asia/Bangkok) ตัวเลขและชื่อพนักงานทั้งหมดเป็นข้อมูลทดลอง ใช้ปุ่มภาษาที่แถบด้านซ้ายเพื่อสลับภาษาไทยและอังกฤษ',
          )}
        </p>
      </header>

      <Section id="gk-orders" title={tx('Orders board', 'บอร์ดออร์เดอร์')} note={tx('Rail, workspace header, live table strip, toolbar, five columns and tickets', 'แถบนำทาง หัวหน้าจอ แถบโต๊ะสด แถบเครื่องมือ ห้าคอลัมน์ และใบออร์เดอร์')}>
        <Frame width={1440} label="Desktop"><OrdersScreen /></Frame>
        <Frame width={820} label="Tablet · one status at a time"><OrdersScreen tablet /></Frame>
      </Section>

      <Section id="gk-tables" title={tx('Tables', 'โต๊ะ')} note={tx('Summary filter that reconciles (16 = 9 + 5 + 1 + 1), large tiles, table drawer with blocked checkout', 'ตัวกรองที่ยอดตรงกัน (16 = 9 + 5 + 1 + 1) การ์ดโต๊ะ และแผงรายละเอียดที่ยังปิดโต๊ะไม่ได้')}>
        <Frame width={1440} label="Desktop"><TablesScreen /></Frame>
        <Frame width={820} label="Tablet · drawer overlays"><TablesScreen tablet /></Frame>
      </Section>

      <Section id="gk-insights" title={tx('Insights', 'สถิติ')} note={tx('Period bar, metric selector, charcoal headline and WeekBarChart, stat cards, day drill-down, Menu Stats ranking', 'แถบช่วงเวลา ตัวชี้วัด กราฟรายสัปดาห์ การ์ดสถิติ รายละเอียดรายวัน และอันดับเมนู')}>
        <Frame width={1440} label="Desktop"><InsightsScreen /></Frame>
        <Frame width={820} label="Tablet"><InsightsScreen tablet /></Frame>
      </Section>

      <Section id="gk-charts" title={tx('Chart and data states', 'สถานะของกราฟและข้อมูล')} note={tx('Month (30 bars) and year (12 bars) with a failed load, table view, light variant, card loading and error, least-ordered ranking', 'รายเดือน รายปี ข้อมูลโหลดไม่สำเร็จ มุมมองตาราง แบบพื้นสว่าง การ์ดกำลังโหลดและผิดพลาด และอันดับที่สั่งน้อย')}>
        <ChartStates />
      </Section>

      <Section id="gk-tickets" title={tx('Ticket and control states', 'สถานะใบออร์เดอร์และปุ่มควบคุม')} note={tx('Stale-version conflict, busy action, rejected line with reason, per-line note, ready minutes, empty column, pills and word badges', 'ข้อมูลชนกัน ปุ่มกำลังทำงาน จานที่ปฏิเสธพร้อมเหตุผล โน้ตรายจาน เวลาที่พร้อมเสิร์ฟ คอลัมน์ว่าง')}>
        <TicketStates />
      </Section>

      <Section id="gk-pieces" title={tx('Reports, audit, tables and phone', 'รายงาน บันทึก ตาราง และมือถือ')} note={tx('Page header, report jobs in all four states, audit diff, controls, guest access, data tables, phone bottom bar', 'หัวหน้าจอรอง งานรายงานทั้งสี่สถานะ บันทึกการแก้ไข ปุ่มควบคุม การเข้าร่วม ตาราง และแถบล่างบนมือถือ')}>
        <PiecesSection />
      </Section>
    </div>
  );
}

/** Rendered by /ui-kit inside the app's I18nProvider; the rail language boxes switch the whole page. */
export default function GalleryAdmin() {
  return <AdminKitGallery />;
}
