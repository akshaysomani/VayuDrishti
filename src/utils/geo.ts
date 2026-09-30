import type { PopulationCell, Station } from '../types/dashboard';

/**
 * Generate a GeoJSON Polygon circle around [lon, lat] with specified radius in kilometers.
 * Uses equirectangular approximation suitable for India latitudes (8°N to 37°N).
 */
export function createGeoJSONCircle(
  center: [number, number],
  radiusInKm: number,
  points: number = 64
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [lon, lat] = center;
  const coords: [number, number][] = [];
  const radLat = (lat * Math.PI) / 180;
  const distanceX = radiusInKm / (111.32 * Math.cos(radLat));
  const distanceY = radiusInKm / 110.574;

  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    coords.push([Number((lon + x).toFixed(5)), Number((lat + y).toFixed(5))]);
  }
  coords.push(coords[0]); // close loop

  return {
    type: 'Feature',
    properties: {
      radiusKm: radiusInKm,
      label: `${radiusInKm} km`,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coords],
    },
  };
}

/**
 * Generate coverage rings collection at 10, 25, 50, 100, 200 km
 */
export function createCoverageRingsGeoJSON(center: [number, number]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const radii = [200, 100, 50, 25, 10]; // Order largest to smallest so smaller layers sit on top
  const features = radii.map((r) => createGeoJSONCircle(center, r));
  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Build GeoJSON Polygons for population 0.25-degree cells
 */
export function buildPopulationCellsGeoJSON(cells: PopulationCell[]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const halfDeg = 0.125;
  const features = cells.map((cell, idx) => ({
    type: 'Feature' as const,
    id: idx,
    properties: {
      pop: cell.pop,
      dist_km: cell.dist_km,
      underserved: cell.dist_km > 100 ? 1 : 0,
    },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [Number((cell.lon - halfDeg).toFixed(4)), Number((cell.lat - halfDeg).toFixed(4))],
          [Number((cell.lon + halfDeg).toFixed(4)), Number((cell.lat - halfDeg).toFixed(4))],
          [Number((cell.lon + halfDeg).toFixed(4)), Number((cell.lat + halfDeg).toFixed(4))],
          [Number((cell.lon - halfDeg).toFixed(4)), Number((cell.lat + halfDeg).toFixed(4))],
          [Number((cell.lon - halfDeg).toFixed(4)), Number((cell.lat - halfDeg).toFixed(4))],
        ],
      ],
    },
  }));

  return {
    type: 'FeatureCollection',
    features,
  };
}

export interface CityStationCluster {
  cityName: string;
  state: string;
  lat: number;
  lon: number;
  totalStations: number;
  reportingStations: number;
  noDataStations: number;
  hasReporting: boolean;
  stations: Station[];
}

/**
 * Group stations by city so markers never stack invisibly
 */
export function groupStationsByCity(stations: Station[]): CityStationCluster[] {
  const map = new Map<string, CityStationCluster>();

  for (const s of stations) {
    let cluster = map.get(s.city);
    if (!cluster) {
      cluster = {
        cityName: s.city,
        state: s.state,
        lat: s.lat,
        lon: s.lon,
        totalStations: 0,
        reportingStations: 0,
        noDataStations: 0,
        hasReporting: false,
        stations: [],
      };
      map.set(s.city, cluster);
    }

    cluster.totalStations += 1;
    cluster.stations.push(s);
    if (s.displayStatus === 'reporting_in_dataset') {
      cluster.reportingStations += 1;
    } else {
      cluster.noDataStations += 1;
    }
  }

  const clusters = Array.from(map.values());
  for (const c of clusters) {
    c.hasReporting = c.reportingStations > 0;
  }

  return clusters;
}
