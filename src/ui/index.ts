// UI (React): HUD, panely, grafy.
export { EM_DASH, MINUS_SIGN, PLUS_SIGN, formatGameTime, formatMoney, formatMoneyDelta, formatSpeed, formatXp, moneySign } from './format';
export type { GameTimeParts } from './format';
export { Icon, TrendIcon, iconHref } from './icon';
export type { IconName, IconProps } from './icon';
export { SpeedControl } from './speed-control';
export type { SpeedControlProps } from './speed-control';
export { HUD_PANEL_BUTTONS, HUD_THROTTLE_MS, TopHUD, TopHUDView, resolveSpeedRequest, useSetGameSpeed } from './top-hud';
export type { TopHUDProps, TopHUDViewProps } from './top-hud';
