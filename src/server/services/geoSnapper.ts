/**
 * Geographic Coordinate Validation and Nearest Station Snapping
 * ==============================================================
 * Validates geographic bounds and snaps citizen reports to the
 * nearest established ground monitoring station for context.
 */

import alertDataRaw from '../../data/alert_data.json';

const alertData = alertDataRaw as {
  stations: Record<
    string,
    {
      id: string;
      name: string;
      city: string;
      lat: number;
      lon: number;
      coord_quality: string;
    }
  >;
};

export interface StationSnapResult {
  nearestStationId: string | null;
  nearestStationName: string | null;
  distanceKm: number | null;
}

/**
 * Haversine formula to calculate great-circle distance between two points in km.
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export function validateCoordinates(lat: number, lon: number): { valid: boolean; error?: string } {
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
    return { valid: false, error: 'Latitude and Longitude must be valid numbers.' };
  }
  if (lat < -90.0 || lat > 90.0) {
    return { valid: false, error: 'Latitude must be between -90.0 and 90.0 degrees.' };
  }
  if (lon < -180.0 || lon > 180.0) {
    return { valid: false, error: 'Longitude must be between -180.0 and 180.0 degrees.' };
  }
  return { valid: true };
}

export function snapToNearestStation(lat: number, lon: number): StationSnapResult {
  const stations = Object.values(alertData.stations);
  if (stations.length === 0) {
    return { nearestStationId: null, nearestStationName: null, distanceKm: null };
  }

  let minDistance = Infinity;
  let nearestStation: (typeof stations)[0] | null = null;

  for (const st of stations) {
    const dist = calculateHaversineDistanceKm(lat, lon, st.lat, st.lon);
    if (dist < minDistance) {
      minDistance = dist;
      nearestStation = st;
    }
  }

  return {
    nearestStationId: nearestStation ? nearestStation.id : null,
    nearestStationName: nearestStation ? nearestStation.name : null,
    distanceKm: minDistance < Infinity ? minDistance : null,
  };
}
