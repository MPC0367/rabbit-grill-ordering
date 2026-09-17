// Rabbit Grill ui kit barrel (docs/DESIGN.md §10, docs/CLIENT.md).
// Styles: client/src/styles/base.css + components.css (class names from
// design-lab/final/final.css). The living styleguide is /ui-kit (dev only).

// primitives
export { Icon, ICON_NAMES } from './Icon.tsx';
export type { IconName, IconProps, IconSize } from './Icon.tsx';
export { Button, LinkButton, IconButton, TextLink } from './Button.tsx';
export type { ButtonProps, ButtonVariant, ButtonSize, LinkButtonProps, IconButtonProps, IconButtonVariant, TextLinkProps } from './Button.tsx';
export { SegmentedControl } from './SegmentedControl.tsx';
export type { SegmentedControlProps, SegmentOption } from './SegmentedControl.tsx';
export { Tabs, TabPanel } from './Tabs.tsx';
export type { TabsProps, TabItem, TabPanelProps } from './Tabs.tsx';
export { Badge, Pill, StatusPill, Tag, Flag, Chip, useStatusWording } from './Badge.tsx';
export type { BadgeProps, PillProps, PillTone, StatusPillProps, StatusPillSubject, TagProps, TagTone, FlagProps, FlagKind, ChipProps } from './Badge.tsx';
export { Price, Leader } from './Price.tsx';
export type { PriceProps, PriceSize, LeaderProps } from './Price.tsx';
export { Wordmark, TableTag, LangToggle } from './Brand.tsx';
export type { WordmarkProps, TableTagProps, LangToggleProps } from './Brand.tsx';
export { Stepper } from './Stepper.tsx';
export type { StepperProps } from './Stepper.tsx';
export { TextField, TextArea, Select, Checkbox, Switch, RadioCard, RequiredPill, ChoiceGroup } from './Field.tsx';
export type {
  FieldShellProps, TextFieldProps, TextAreaProps, SelectProps, SelectOption, CheckboxProps, SwitchProps, RadioCardProps, ChoiceGroupProps,
} from './Field.tsx';
export { SearchField } from './SearchField.tsx';
export type { SearchFieldProps } from './SearchField.tsx';

// overlays and feedback
export { Sheet, Dialog, Drawer } from './Sheet.tsx';
export type { SheetProps, SheetVariant, DialogProps, DialogReasonField, DrawerProps } from './Sheet.tsx';
export { Banner } from './Banner.tsx';
export type { BannerProps, BannerVariant } from './Banner.tsx';
export { ToastProvider, useToast, Toast, LiveRegion, useAnnounce, announce } from './Toast.tsx';
export type { ToastApi, ToastOptions, ToastTone, ToastProps, LiveRegionProps } from './Toast.tsx';
export { EmptyState, Skeleton, SkeletonDishRow } from './Feedback.tsx';
export type { EmptyStateProps, SkeletonProps } from './Feedback.tsx';
export { ConnectionIndicator } from './ConnectionIndicator.tsx';
export type { ConnectionIndicatorProps } from './ConnectionIndicator.tsx';

// guest kit
export { DishImage, dishImageUrl, dishSrcSet } from './DishImage.tsx';
export type { DishImageProps, DishImageSource, DishImageVariant } from './DishImage.tsx';
export { DishRow, MenuSection } from './DishRow.tsx';
export type { DishRowProps, DishRowItem, MenuSectionProps } from './DishRow.tsx';
export { CategoryRow, CategorySidebar, AllCategoriesSheet, useActiveSection, scrollToSection } from './CategoryRow.tsx';
export type { CategoryRowProps, CategoryTab, CategorySidebarProps, AllCategoriesSheetProps, CategoryListGroup, CategoryListItem } from './CategoryRow.tsx';
export { Dock, CartBar, OrderSlip, BottomNav, ServiceKey, GuestNav, useGuestNavItems } from './Dock.tsx';
export type { CartBarProps, CartBarState, BottomNavProps, NavItem, ServiceKeyProps, GuestNavProps } from './Dock.tsx';
export { Timeline, RoundCard, DishLines, DishStatusLine, PastRound } from './Timeline.tsx';
export type { TimelineProps, TimelineStep, StepState, RoundCardProps, DishLinesProps, DishStatusLineProps, TrailSegment, PastRoundProps } from './Timeline.tsx';
export { PortionQuote } from './PortionQuote.tsx';
export type { PortionQuoteProps, PortionQuoteState } from './PortionQuote.tsx';
export {
  GuestHeader, PageHead, Card, ListRow, ServiceMenu, AllergyNotice, OrderLine, UnsentCard, RunningTotal,
} from './Guest.tsx';
export type {
  GuestHeaderProps, PageHeadProps, CardProps, ListRowProps, ServiceMenuItem, ServiceMenuProps, AllergyNoticeProps,
  OrderLineProps, UnsentCardProps, RunningTotalProps,
} from './Guest.tsx';

// helpers
export {
  cx, mergeRefs, useConfirmFlash, prefersReducedMotion, graphemes, textLength, clampText, normalizeSearch, clockSeconds,
} from './cx.ts';
export type { LengthMeasure } from './cx.ts';
export { useGlideMark, rovingKeyDown, scrollIntoViewInline, useEscape } from './hooks.ts';
export { useHistoryDismiss, useScrollLock, useFocusReturn } from './overlay.ts';

// staff and data kit (C0b)
export * from './admin/index.ts';
