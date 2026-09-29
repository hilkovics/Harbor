// UI (React): HUD, panely, grafy.
export {
  EM_DASH,
  MINUS_SIGN,
  PLUS_SIGN,
  TIMES_SIGN,
  formatFootprint,
  formatFraction,
  formatGameTime,
  formatMoney,
  formatMoneyDelta,
  formatPercent,
  formatSpeed,
  formatXp,
  moneySign,
} from './format';
export type { GameTimeParts } from './format';
export { Icon, TrendIcon, iconHref } from './icon';
export type { IconName, IconProps } from './icon';
export { SpeedControl } from './speed-control';
export type { SpeedControlProps } from './speed-control';
export { HUD_PANEL_BUTTONS, HUD_THROTTLE_MS, TopHUD, TopHUDView, resolveSpeedRequest, useSetGameSpeed } from './top-hud';
export type { TopHUDProps, TopHUDViewProps } from './top-hud';
export { BuildBar, categoryKey, itemStatus, itemTooltip, resolveItemSelection, toIconName } from './build-bar';
export type { BuildBarCategory, BuildBarItem, BuildBarItemStatus, BuildBarProps, ItemTooltip } from './build-bar';
export {
  CRANE_STATE_LABELS,
  ModuleInspector,
  badgeText,
  berthStats,
  craneStateLabel,
  craneStateOk,
  craneStats,
  craneTimeSplit,
  moduleKindIcon,
  utilizationTone,
} from './module-inspector';
export type { CraneStateName, InspectorStat, ModuleInspectorData, ModuleInspectorProps, StatTone } from './module-inspector';
