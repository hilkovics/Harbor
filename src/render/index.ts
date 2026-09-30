// Render sveta (PixiJS): WorldRenderer, vrstvy, kamera. Čisté moduly (autotile, camera, tokens) nezávisia od Pixi.
export { WorldRenderer, starterParcelRect } from './world-renderer';
export type { WorldRendererOptions } from './world-renderer';
export { TerrainLayer, planTerrain, terrainFillKey } from './terrain-layer';
export type { TerrainFillKey, TerrainPlan } from './terrain-layer';
export { coastTile, coastWaterMask } from './coast';
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
export type { VehicleLoad, VehiclePose, VehicleViewDeps, VehicleViewStyle } from './vehicle-view';
export { TRUCK_STYLE, TruckView, sameTruckShape, truckSpriteFile } from './truck-view';
export { QUEUE_BADGE_MAX, QueueBadge, createWarningBadge, queueBadgeLabel } from './badges';
export type { QueueBadgeDeps } from './badges';
export { BARRIER_MOTION_MS, BarrierMotion, GateDecor, queueBadgePosition } from './gate-decor';
export { WaitingAreaDecor, occupiedStalls } from './waiting-area-decor';
export { RampDecor, STAGED_INSET_PX, stagedPlacements } from './ramp-decor';
export type { StagedPlacement } from './ramp-decor';
export { MODULE_DECORS } from './module-decors';
export type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory, ModuleViewDeps } from './module-decor';
export {
  LANE_CENTER_PX,
  LANE_OFFSET_CELLS,
  LANE_WIDTH_PX,
  ROAD_ASPHALT_PX,
  VEHICLE_CONTENT_WIDTH_PX,
  VEHICLE_LANE_SCALE,
  createRoadKindAt,
  createRoadMaskAt,
  defaultRoadKindAt,
  forwardOf,
  laneMagnitude,
  laneOffset,
  noRoadMaskAt,
  rightOf,
  roadKindOfCell,
} from './lane';
export type { RoadKindAt, RoadMaskAt } from './lane';
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
