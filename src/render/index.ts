// Render sveta (PixiJS): WorldRenderer, vrstvy, kamera. Čisté moduly (autotile, camera, tokens) nezávisia od Pixi.
export { WorldRenderer, starterParcelRect } from './world-renderer';
export type { WorldRendererOptions } from './world-renderer';
export { TerrainLayer, planTerrain, terrainFillKey } from './terrain-layer';
export type { TerrainFillKey, TerrainPlan } from './terrain-layer';
export { coastQuarterTurns, coastTile, coastWaterMask, type QuarterTurns } from './coast';
export type { CoastTileId, TerrainSpriteId } from './coast';
export { SPRITE_RASTER_RESOLUTION, SpriteAtlas } from './sprite-atlas';
export type {
  EntityTextures,
  InfraLayerId,
  InfraTileId,
  SpriteAtlasOptions,
  SpriteTextures,
  WorldOverlayId,
} from './sprite-atlas';
export { assetUrl } from './asset-urls';
export { RoadLayer } from './road-layer';
export { ARROW_ROTATION, RoadMarkLayer } from './road-mark-layer';
export {
  FLARE_DEPTH_PX,
  NARROW_ASPHALT_PX,
  ROAD_EDGE_PX,
  ROAD_FILLET_PX,
  narrowRoadPaths,
} from './narrow-road';
export type { NarrowRoadPaths, PathOp } from './narrow-road';
export { ParcelLayer, outlineScaleForZoom, parcelOutlineId } from './parcel-layer';
export type { ParcelOutlineId } from './parcel-layer';
export { PortalLayer, portalRotation } from './portal-layer';
export type { PortalKind, PortalSet } from './portal-layer';
export { BuildLayer, CONNECTOR_MARKER_ROTATION, loadGhostPalette, moduleGhostCells } from './build-layer';
export type { BuildLayerCreateOptions, BuildLayerOptions, GhostArrow, GhostArrowsView, GhostCell, GhostPalette, GhostView } from './build-layer';
export type { CraneVM, EntitiesVM, ModuleGhostVM, ModuleVM, ShipVM, TruckVM, VehicleVM, ViewRotation, ViewSide } from './view-models';
export { ModuleLayer } from './module-layer';
export { ModuleView, moduleBodyFile, moduleFillState, sameModuleShape } from './module-view';
export { FILL_25_BELOW, FILL_50_BELOW, FILL_STATES, fillState, fillStateKey } from './storage-fill';
export type { FillState } from './storage-fill';
export { EntityLayer } from './entity-layer';
export {
  SHIP_VARIANT_CANDIDATES,
  ShipView,
  lerp,
  sameShipShape,
  shipLoad,
  shipPose,
  shipSpriteFile,
  shipVariantKey,
} from './ship-view';
export type { ShipLoad, ShipPose, ShipViewDeps } from './ship-view';
export { VEHICLE_STYLE, VehicleView, sameVehicleShape, vehicleLoad, vehiclePose, vehicleSpriteFile } from './vehicle-view';
export type { PoseDirector, VehicleLoad, VehiclePose, VehicleViewDeps, VehicleViewStyle } from './vehicle-view';
export { TRUCK_STYLE, TruckView, sameTruckShape, truckSpriteFile } from './truck-view';
export { DOCK_CATCH_UP, DOCK_LEAVE_MS, DOCK_REVERSE_MS, DOCK_STOP_MS, DockManeuver, blendPose, dockPose, planDockPath } from './dock-maneuver';
export type { DockPath, DockPhase, DockPoses, PosePx, SwingSide } from './dock-maneuver';
export { QUEUE_BADGE_MAX, QueueBadge, createWarningBadge, queueBadgeLabel } from './badges';
export type { QueueBadgeDeps } from './badges';
export { BARRIER_MOTION_MS, BarrierMotion, GateDecor, queueBadgePosition } from './gate-decor';
export { WaitingAreaDecor, occupiedStalls } from './waiting-area-decor';
export { RampDecor, STAGED_ANGLE, STAGED_INSET_PX, stagedPlacements } from './ramp-decor';
export type { StagedPlacement } from './ramp-decor';
export { YARD_BOX_CELLS, YARD_INSET_CELLS, YardCraneDecor, yardCraneHome, yardSlotSpot } from './yard-crane-decor';
export { CRANE_LIFT_SCALE, CRANE_PHASE_MS, YardCraneMotion, craneOpDuration } from './yard-crane-motion';
export type { CraneCargo, CraneOp, CranePhase, CraneSpot, StorageOpKind, YardCranePose } from './yard-crane-motion';
export { MODULE_DECORS } from './module-decors';
export type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory, ModuleViewDeps } from './module-decor';
export {
  LANE_CENTER_PX,
  LANE_OFFSET_CELLS,
  LANE_WIDTH_PX,
  ROAD_ASPHALT_PX,
  VEHICLE_OFFSET_CELLS,
  VEHICLE_OFFSET_PX,
  VEHICLE_SCALE,
  VEHICLE_WIDTH_PX,
  createRoadKindAt,
  createRoadMaskAt,
  defaultRoadKindAt,
  forwardOf,
  laneMagnitude,
  laneOverhangPx,
  laneOffset,
  noRoadMaskAt,
  rightOf,
  roadKindOfCell,
} from './lane';
export type { RoadKindAt, RoadMaskAt } from './lane';
export { ConnectorArmIndex, connectorArm, noConnectorMask, worldConnectors } from './module-connectors';
export type { ConnectorArm, ConnectorHost, ConnectorMaskAt, WorldConnector } from './module-connectors';
export {
  cornerAlpha,
  cornerTurn,
  headingDelta,
  isQuarterTurn,
  lerpHeading,
  normalizeAngle,
  turnArcPose,
  turnArcRadius,
} from './turn-arc';
export type { ArcPose, CornerTurn } from './turn-arc';
export { CraneLayer } from './crane-layer';
export {
  BADGE_MAX_SCALE,
  CRANE_BOOM_TILT_DEG,
  CraneView,
  badgeScaleForZoom,
  craneBox,
  craneParts,
  trolleyBoomY,
  trolleyTravelFraction,
} from './crane-view';
export type { CraneParts, CraneState, CraneViewDeps } from './crane-view';
export { CargoSprite, cargoSizePx } from './cargo-sprite';
export {
  CARRIER_LENGTH_PX,
  CARRIER_WIDTH_PX,
  METERS_PER_CELL,
  PX_PER_METER,
  TEU_PX,
  TRUCK_LENGTH_PX,
  TRUCK_WIDTH_PX,
  metersToPx,
} from './world-scale';
export type { CargoSpriteDeps } from './cargo-sprite';
export { SIDE_STEP, footprintPose, localCellCenter, localCellWorldCenter, rotateOffset } from './footprint-pose';
export type { FootprintBox, FootprintPose } from './footprint-pose';
export { dockCenter, dockHeading, findDockCenter, findStallCenter, rectCenterCells, stallCenter } from './module-slots';
export type { SlotHost } from './module-slots';
export { ViewSync } from './view-sync';
export type { SyncedView, ViewSyncHooks } from './view-sync';
export {
  LOADED_SHIP_VARIANTS,
  LOADED_STATE_MODULES,
  LOADED_VEHICLES,
  MANIFEST_CELL_PX,
  QUEUE_BADGE_FILE,
  QUEUE_BADGE_SIZE,
  WARNING_BADGE_FILE,
  WARNING_BADGE_SIZE,
  cargoDisplaySize,
  cargoSpriteEntry,
  cargoTypeOfCategory,
  entitySpriteFiles,
  manifestScale,
  moduleSprite,
  shipSprite,
  vehicleSprite,
} from './entity-assets';
export type {
  ManifestConnector,
  ManifestPart,
  ManifestRect,
  ModuleSpriteEntry,
  ShipSpriteEntry,
  VehicleSpriteEntry,
} from './entity-assets';
export { GHOST_HATCH_PATTERN, PATH_ARROW_FOOTPRINT, overlayAssetUrl } from './overlay-assets';
export type { OverlayAssetId, PatternSize } from './overlay-assets';
export {
  AUTOTILE_SHAPE_BASE_MASK,
  AUTOTILE_TABLE,
  autotileAffected,
  autotileMask,
  autotileShape,
  autotileTile,
  rotateMask,
} from './autotile';
export type { AutotileShape, AutotileTile } from './autotile';
export { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, CAMERA_START_ZOOM, Camera } from './camera';
export type { CameraOptions, CameraTransform, Point } from './camera';
export {
  ROAD_EDGE_SHADE,
  documentTokenResolver,
  loadRenderPalette,
  parseCssColor,
  parseCssPx,
  readColorToken,
  readLengthToken,
  shadeColor,
  tokenResolverFromCss,
} from './tokens';
export { loadEntityPalette } from './tokens';
export type {
  ColorValue,
  EntityPalette,
  ParcelPalette,
  RenderPalette,
  RoadPalette,
  TerrainPalette,
  TokenResolver,
} from './tokens';
