// UI (React): HUD, panely, grafy.
export {
  EM_DASH,
  MINUS_SIGN,
  PLUS_SIGN,
  TIMES_SIGN,
  formatCount,
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
export { Icon, TrendIcon, iconHref, toIconName } from './icon';
export type { IconName, IconProps } from './icon';
export { SpeedControl } from './speed-control';
export type { SpeedControlProps } from './speed-control';
export { HUD_PANEL_BUTTONS, HUD_THROTTLE_MS, TopHUD, TopHUDView, resolveSpeedRequest, useSetGameSpeed } from './top-hud';
export type { TopHUDProps, TopHUDViewProps } from './top-hud';
export { BuildBar, canBuyItem, itemAction, itemDetail, itemStatus, itemTooltip, resolveItemSelection } from './build-bar';
export type {
  BuildBarCategory,
  BuildBarItem,
  BuildBarItemAction,
  BuildBarItemStatus,
  BuildBarProps,
  ItemTooltip,
} from './build-bar';
export {
  CRANE_STATE_LABELS,
  ModuleInspector,
  VEHICLE_STATE_INFO,
  badgeText,
  berthStats,
  canSellVehicle,
  craneStateLabel,
  craneStateOk,
  craneStats,
  craneTimeSplit,
  depotStats,
  depotVehicleCounts,
  inspectorBadge,
  moduleKindIcon,
  sellTitle,
  storageFillPct,
  storageFree,
  storageStats,
  utilizationTone,
  vehicleCode,
} from './module-inspector';
export type {
  CraneStateName,
  DepotVehicleData,
  DepotVehicleState,
  InspectorBadge,
  InspectorStat,
  ModuleInspectorData,
  ModuleInspectorProps,
  StatTone,
  VehicleStateInfo,
} from './module-inspector';
export { MAX_TOASTS, TOAST_SHOW_LABEL, Toasts, visibleToasts } from './toasts';
export type { ToastData, ToastId, ToastTone, ToastsProps } from './toasts';
