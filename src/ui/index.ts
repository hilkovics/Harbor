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
  RAMP_INOPERATIVE_FALLBACK,
  RAMP_INOPERATIVE_TEXTS,
  VEHICLE_STATE_INFO,
  badgeText,
  bayStates,
  berthStats,
  canSellVehicle,
  craneStateLabel,
  craneStateOk,
  craneStats,
  craneTimeSplit,
  depotStats,
  depotVehicleCounts,
  dockTruckLabel,
  gateStats,
  gateThroughputText,
  inspectorBadge,
  moduleKindIcon,
  rampInoperativeReason,
  rampInoperativeText,
  rampStats,
  rampTotals,
  sellTitle,
  stagingSlots,
  storageFillPct,
  storageFree,
  storageStats,
  utilizationTone,
  vehicleCode,
  waitingAreaFree,
  waitingAreaStats,
} from './module-inspector';
export type {
  BayState,
  CraneStateName,
  DepotVehicleData,
  DepotVehicleState,
  GateData,
  InspectorBadge,
  InspectorStat,
  ModuleInspectorData,
  ModuleInspectorProps,
  RampData,
  RampDockData,
  StatTone,
  VehicleStateInfo,
  WaitingAreaData,
} from './module-inspector';
export { MAX_TOASTS, TOAST_SHOW_LABEL, Toasts, visibleToasts } from './toasts';
export type { ToastData, ToastId, ToastTone, ToastsProps } from './toasts';
