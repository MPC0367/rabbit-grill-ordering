// Staff & data kit (C0b). Re-exported by client/src/ui/index.ts.
// Styles: final.css class names (components.css) + client/src/styles/admin-kit.css.
export { AdminRail, RailNav, RailFooter } from './AdminRail.tsx';
export type { AdminRailProps, RailFooterProps, RailItem, RailMode, RailNavProps } from './AdminRail.tsx';

export { WorkspaceHeader, SubTabs, DemoStamp, OrderingControl, StaffChip, PageHeader, SectionHeader } from './WorkspaceHeader.tsx';
export type { WorkspaceHeaderProps, SubTabItem, SubTabsProps, OrderingControlProps, StaffChipProps, PageHeaderProps, SectionHeaderProps } from './WorkspaceHeader.tsx';

export { Ticket, TicketLine, TicketFlag, AllergyBand, GuestNote, ProgressMeter } from './Ticket.tsx';
export type { TicketProps, TicketAction, TicketLineData, TicketLineProps, TicketChip, TicketFlagKind, TicketFlagSpec, AllergyBandProps, ProgressMeterProps } from './Ticket.tsx';

export { BoardColumn, BoardGrid, BoardStatusSwitch, BoardToolbar, BOARD_STAGES } from './Board.tsx';
export type { BoardStage, BoardColumnProps, BoardGridProps, BoardStatusSwitchProps, BoardToolbarProps } from './Board.tsx';

export { TableStrip, FloorTile, TableLegend, AttnBadge, attentionKinds, ATTN_PRIORITY, STATE_SWATCH } from './Floor.tsx';
export type { AttnKind, AttnBadgeProps, FloorTable, FloorTileProps, TableLegendProps, TableStripProps } from './Floor.tsx';

export {
  TableTile, TablesSummaryBar, TableDrawerHeader, TableBox, TableStatePill, DrawerSection, GuestAccessPanel, CheckoutBlockers,
  RoundList, QuoteWell, LineStatusPill, HistoryList,
} from './Tables.tsx';
export type {
  TableTileProps, TileAction, TableFilter, TablesSummaryBarProps, TableDrawerHeaderProps, DrawerSectionProps,
  GuestAccessPanelProps, CheckoutBlockersProps, RoundData, RoundLineData, RoundListProps, QuoteWellProps, HistoryItem,
} from './Tables.tsx';

export { FilterChips, SelectButton, CheckButton, StaffSearch } from './Controls.tsx';
export type { ChipOption, FilterChipsProps, SelectButtonProps, CheckButtonProps, StaffSearchProps, TableSwatch } from './Controls.tsx';

export { StatCard, StatGrid, HeroMetric, ChartPanel, MetricSwitch, DefinitionButton, ComparisonLine } from './Stats.tsx';
export type { StatCardProps, Comparison, HeroMetricProps, ChartPanelProps, MetricSwitchProps, DefinitionButtonProps } from './Stats.tsx';

export { WeekBarChart, ChartLegend } from './WeekBarChart.tsx';
export type { WeekBarChartProps, ChartBucket, BucketState } from './WeekBarChart.tsx';

export { MiniBars } from './MiniBars.tsx';
export type { MiniBarsProps, MiniBarDatum } from './MiniBars.tsx';

export { RankingRow, RankingTable, Delta } from './Ranking.tsx';
export type { RankingRowProps, RankingTableProps, RankChange, RankContext } from './Ranking.tsx';

export { DataTable } from './DataTable.tsx';
export type { DataTableProps, DataColumn, SortState } from './DataTable.tsx';

export { KeyValue } from './KeyValue.tsx';
export type { KeyValueProps, KeyValueItem } from './KeyValue.tsx';

export { DateRangeNav, PeriodSwitch } from './DateRangeNav.tsx';
export type { DateRangeNavProps, PeriodSwitchProps } from './DateRangeNav.tsx';

export { JobStatusRow, JobList } from './Jobs.tsx';
export type { JobStatusRowProps } from './Jobs.tsx';

export { AuditEntry, AuditList } from './Audit.tsx';
export type { AuditEntryProps, AuditChange } from './Audit.tsx';

export type { AdminIconName } from './parts.tsx';
