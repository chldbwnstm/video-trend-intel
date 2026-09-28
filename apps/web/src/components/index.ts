/**
 * Design-system barrel. Pages import from here:
 *   import { Card, CardHeader, MetricCell, DataTable } from '../components/index.ts';
 * See apps/web/UI_GUIDE.md for the catalogue.
 */
export { Button, IconButton, Card, CardHeader, Badge, Chip, Spinner, Skeleton, ScrollX, StatRow } from './primitives.tsx';
export type { ButtonProps, ButtonVariant, IconButtonProps, CardProps, CardHeaderProps, BadgeProps, ChipProps, Tone } from './primitives.tsx';
export { Tooltip, InfoTip } from './Tooltip.tsx';
export type { TooltipProps } from './Tooltip.tsx';
export { Drawer, Modal, Popover } from './Overlay.tsx';
export type { DrawerProps, ModalProps, PopoverProps } from './Overlay.tsx';
export { EmptyState, LoadingState, ErrorState, SectionBoundary, errorText } from './states.tsx';
export type { EmptyStateProps, LoadingStateProps, ErrorStateProps, SectionBoundaryProps } from './states.tsx';
export { Tabs, TabPanel, SegmentedControl, Select, SearchInput, Checkbox } from './controls.tsx';
export type { TabItem, TabsProps, SegmentOption, SegmentedControlProps, SelectOption, SelectProps, SearchInputProps } from './controls.tsx';
export { MultiSelect, Pager, selectionSummary, pageCount, clampPage } from './MultiSelect.tsx';
export type { MultiSelectProps, MultiSelectOption, PagerProps } from './MultiSelect.tsx';
export { DataTable } from './DataTable.tsx';
export type { Column, DataTableProps, SortDir } from './DataTable.tsx';
export { MetricCell } from './MetricCell.tsx';
export type { MetricCellProps } from './MetricCell.tsx';
export { NumberDelta } from './NumberDelta.tsx';
export type { NumberDeltaProps } from './NumberDelta.tsx';
export { PlatformBadge, PlatformPicker } from './PlatformBadge.tsx';
export type { PlatformBadgeProps, PlatformPickerProps } from './PlatformBadge.tsx';
export { CategoryChip, CategoryPicker, categoryPathLabel, toggleCategory, filterTree } from './Category.tsx';
export type { CategoryChipProps, CategoryPickerProps } from './Category.tsx';
export {
  DateModePicker,
  RangePicker,
  AgePicker,
  rangeSpecLabel,
  DATE_MODE_LABELS,
  DATE_MODE_DESCRIPTIONS,
  DATE_MODE_EXAMPLE,
  DEFAULT_RANGE_PRESETS,
  AGE_LABELS,
} from './DatePickers.tsx';
export type { DateModePickerProps, RangePickerProps, AgePickerProps } from './DatePickers.tsx';
export { VideoThumb, VideoTitleLink, VideoCell, safeHttpUrl } from './Video.tsx';
export type { VideoThumbProps, VideoTitleLinkProps, VideoCellProps } from './Video.tsx';
export { SparkLine, GrowthChart, BarList, mergeSeries } from './charts.tsx';
export type { SparkLineProps, GrowthChartProps, GrowthSeries, GrowthPoint, BarListProps, BarListItem } from './charts.tsx';
export { ExportCsvButton, toCsv, downloadText, csvFilename } from './ExportCsvButton.tsx';
export type { ExportCsvButtonProps } from './ExportCsvButton.tsx';
export { SourceNote, windowLabel } from './SourceNote.tsx';
export type { SourceNoteProps } from './SourceNote.tsx';
export { PageHeader, FilterBar, KpiTile, KpiGrid, FreshnessBadge, freshnessLevel, SectionGrid } from './layoutParts.tsx';
export type { PageHeaderProps, KpiTileProps, FreshnessLevel } from './layoutParts.tsx';
export { PagePlaceholder } from './PagePlaceholder.tsx';
