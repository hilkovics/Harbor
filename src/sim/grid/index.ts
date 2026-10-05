// Mriežka, bunky, terén, rotácia footprintu, parcely a načítanie mapy (ARCHITECTURE §4.7, §5.1, §5.2, §8 bod 7).
// Explicitný zoznam: pomocné funkcie (napr. `pointerSegment`) nie sú verejné API simu.
export { TERRAIN_TYPES, TERRAIN_TRAITS, terrainFromChar, isWater, isRoadBuildable } from './terrain';
export type { TerrainType, TerrainTraits } from './terrain';
export { Grid, DIRECTIONS_4, directionOfStep } from './grid';
export type { Cell, CellCoord, CellInit, DepthClass, Direction4, Direction4Name, Rect, RoadLayer } from './grid';
export { DEFAULT_ROAD_KIND, ROAD_KINDS, ROAD_KIND_TRAITS, isRoadKind } from './road-kind';
export type { RoadKind, RoadKindTraits } from './road-kind';
export { DIRECTION_NAMES, OPPOSITE_DIRECTION, dragDirections, isDirection4Name, isRoadStepAllowed } from './road-direction';
export type { RoadStepCell } from './road-direction';
export { ROTATIONS, isRotation, rotateFootprint, rotateLocalCell } from './rotation';
export type { Rotation } from './rotation';
export type { Parcel, ParcelOwnership } from './parcel';
export { MapError } from './map-error';
export { DEFAULT_ANCHORAGE_HEADING, PORTAL_DIRECTIONS, parseMapDef } from './map-def';
export type { DepthZoneClass, MapDef, MapParcelDef, MapPortalDef, MapStarterDef, MapStarterRoadDef, PlacedModuleSpec, PortalDirection } from './map-def';
export { loadMap, loadBundledMap } from './map-loader';
export type { LoadedMap, LoadedStarter, MapPortal } from './map-loader';
