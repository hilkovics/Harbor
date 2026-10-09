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
export type {
  CraneCycleVM,
  CraneVM,
  EntitiesVM,
  ModuleGhostVM,
  ModuleVM,
  ShipVM,
  TruckVM,
  VehicleVM,
  ViewRotation,
  ViewSide,
} from './view-models';
export { ModuleLayer } from './module-layer';
export { ModuleView, moduleBodyFile, moduleFillState, sameModuleShape, unitLook } from './module-view';
export { FILL_25_BELOW, FILL_50_BELOW, FILL_STATES, fillState, fillStateKey } from './storage-fill';
export type { FillState } from './storage-fill';
export { EntityLayer } from './entity-layer';
export {
  LASHING_STATE,
  SHIP_VARIANT_CANDIDATES,
  ShipView,
  hasDeckCargo,
  lerp,
  sameShipShape,
  shipDisplayLoad,
  shipLoad,
  shipPose,
  shipSpriteFile,
  shipVariantKey,
} from './ship-view';
export { DeckCargo, deckDirections, deckFill, deckSlots } from './ship-deck';
export type { CargoDirection, DeckCargoDeps, DeckFill, DeckSlot, DeckSplit } from './ship-deck';
export { RIB_COUNT, drawContainerBox } from './container-box';
export type { BoxAxis, BoxColors, BoxRect } from './container-box';
export { LASHING_BADGE_SCALE, LASHING_PROGRESS_STEPS, LashingBadge, lashingProgress, lashingStep } from './lashing-badge';
export type { ShipLoad, ShipPose, ShipViewDeps } from './ship-view';
export { VEHICLE_STYLE, VehicleView, sameVehicleShape, vehicleLoad, vehiclePose, vehicleSpriteFile } from './vehicle-view';
export type { PoseDirector, VehicleLoad, VehiclePose, VehicleViewDeps, VehicleViewStyle } from './vehicle-view';
export { TRUCK_STYLE, TruckView, sameTruckShape, truckSpriteFile } from './truck-view';
export { HoldBadge, QUEUE_BADGE_MAX, QueueBadge, createWarningBadge, holdBadgeLabel, queueBadgeLabel } from './badges';
export type { QueueBadgeDeps } from './badges';
export { DepotBadge, damagedBadgeLabel, repairBadgeLabel } from './depot-badge';
export type { DepotBadgeKind } from './depot-badge';
export { DEPOT_BADGE_GAP_PX, DEPOT_BADGE_INSET_PX, DepotDecor, depotDecorFactory, depotMarks } from './depot-decor';
export type { DepotMark } from './depot-decor';
export { BARRIER_MOTION_MS, BarrierMotion, createBarrier } from './gate-barrier';
export { HOLD_BADGE_INSET_PX, HoldDecor, holdDecorFactory, holdMarks } from './hold-decor';
export type { HoldMark } from './hold-decor';
export { YARD_BOX_CELLS, YARD_INSET_CELLS, YardCraneDecor, yardCraneHome, yardSlotSpot } from './yard-crane-decor';
export { CRANE_LIFT_SCALE, CRANE_PHASE_MS, YardCraneMotion, craneOpDuration } from './yard-crane-motion';
export type { CraneCargo, CraneOp, CranePhase, CraneSpot, StorageOpKind, YardCranePose } from './yard-crane-motion';
export { articulatedPose, blendedLaneMagnitude, shiftRight, trailAt } from './articulated-pose';
export type { ArticulatedPose, InterpolatedTrail } from './articulated-pose';
export { ParkedVehiclesDecor, parkingGrid, parkingSlots } from './parked-vehicles-decor';
export { TrafficJamLayer } from './traffic-jam-layer';
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
  CRANE_CYCLE_STYLE,
  CraneView,
  badgeScaleForZoom,
  craneBoomTilt,
  craneBox,
  craneCycleDirection,
  craneParts,
  trolleyBoomY,
  trolleyTravelFraction,
} from './crane-view';
export type { CraneDirection, CraneParts, CraneState, CraneViewDeps } from './crane-view';
export { CargoSprite, LINE_BAND_SHARE, cargoSizePx } from './cargo-sprite';
export type { CargoLook } from './cargo-sprite';
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
  shipDeck,
  shipSprite,
  vehicleSprite,
} from './entity-assets';
export type {
  ManifestConnector,
  ManifestPart,
  ManifestRect,
  ModuleSpriteEntry,
  ShipDeckEntry,
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
  DIRECTION_OUTLINE_SHADE,
  LINE_COLOR_TOKENS,
  ROAD_EDGE_SHADE,
  documentTokenResolver,
  lineColorOf,
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
