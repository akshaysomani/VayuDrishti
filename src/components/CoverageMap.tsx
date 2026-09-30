import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  RotateCcw,
  Users,
  X,
} from 'lucide-react';
import type {
  PopulationCell,
  Station,
  City,
  GapCity,
} from '../types/dashboard';
import {
  buildPopulationCellsGeoJSON,
  createCoverageRingsGeoJSON,
  groupStationsByCity,
  type CityStationCluster,
} from '../utils/geo';

interface CoverageMapProps {
  populationCells: PopulationCell[];
  stations: Station[];
  gapCities: GapCity[];
  selectedCity: City | GapCity | null;
  onSelectCity: (city: City | GapCity | null) => void;
  selectedKm: number;
  isUnderservedMode: boolean;
  onToggleUnderservedMode: (val: boolean) => void;
}

const INDIA_CENTER: [number, number] = [78.9629, 22.5937];
const INDIA_ZOOM = 4.3;

export const CoverageMap: React.FC<CoverageMapProps> = ({
  populationCells,
  stations,
  gapCities,
  selectedCity,
  onSelectCity,
  selectedKm,
  isUnderservedMode,
  onToggleUnderservedMode,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [selectedCluster, setSelectedCluster] = useState<CityStationCluster | null>(null);

  // Group stations by city so markers never stack invisibly
  const clusters = React.useMemo(() => groupStationsByCity(stations), [stations]);

  // Initialize MapLibre
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Basemap: Key-less CartoDB Positron with OSM fallback
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: INDIA_CENTER,
      zoom: INDIA_ZOOM,
      minZoom: 3.5,
      maxZoom: 12,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: '© OpenStreetMap contributors, © CARTO | Historical CPCB station extract',
        compact: true,
      }),
      'bottom-right'
    );

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    map.on('load', () => {
      // 1. Add population cells GeoJSON source
      const cellsGeoJSON = buildPopulationCellsGeoJSON(populationCells);

      map.addSource('pop-cells', {
        type: 'geojson',
        data: cellsGeoJSON,
      });

      // Sequential color scale: light = close to monitor, dark = far
      map.addLayer(
        {
          id: 'pop-cells-layer',
          type: 'fill',
          source: 'pop-cells',
          paint: {
            'fill-color': [
              'step',
              ['get', 'dist_km'],
              '#e0f2fe', // <= 25 km
              25,
              '#bae6fd', // 25 - 50 km
              50,
              '#7dd3fc', // 50 - 100 km
              100,
              '#0284c7', // 100 - 200 km
              200,
              '#0369a1', // 200 - 400 km
              400,
              '#0f172a', // > 400 km
            ],
            'fill-opacity': [
              'interpolate',
              ['linear'],
              ['get', 'pop'],
              2000,
              0.12,
              50000,
              0.35,
              500000,
              0.65,
              2000000,
              0.85,
            ],
          },
        },
        // Place below labels if available
        map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
      );

      // 2. Add coverage rings source and layer
      map.addSource('coverage-rings', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      });

      map.addLayer({
        id: 'coverage-rings-fill',
        type: 'fill',
        source: 'coverage-rings',
        paint: {
          'fill-color': '#0284c7',
          'fill-opacity': [
            'match',
            ['get', 'radiusKm'],
            10,
            0.18,
            25,
            0.12,
            50,
            0.08,
            100,
            0.05,
            200,
            0.03,
            0.05,
          ],
        },
      });

      map.addLayer({
        id: 'coverage-rings-line',
        type: 'line',
        source: 'coverage-rings',
        paint: {
          'line-color': '#0284c7',
          'line-width': ['match', ['get', 'radiusKm'], 10, 2.2, 25, 1.8, 1.2],
          'line-dasharray': [2, 2],
        },
      });

      // 3. Connector line between selected gap city and its nearest working city
      map.addSource('gap-connector', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      });

      map.addLayer({
        id: 'gap-connector-line',
        type: 'line',
        source: 'gap-connector',
        paint: {
          'line-color': '#ea580c',
          'line-width': 2.5,
          'line-dasharray': [3, 2],
        },
      });

      mapRef.current = map;
      setMapLoaded(true);
    });

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    if (mapContainerRef.current) {
      resizeObserver.observe(mapContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [populationCells]);

  // Update opacity when "underserved people" mode toggles
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    if (isUnderservedMode) {
      // Underserved mode: Emphasize population where dist_km > 100, keep non-underserved visible at min opacity 0.15
      map.setPaintProperty('pop-cells-layer', 'fill-opacity', [
        'case',
        ['>', ['get', 'dist_km'], 100],
        ['interpolate', ['linear'], ['get', 'pop'], 2000, 0.45, 500000, 0.95],
        0.15, // Non-underserved cells visible at minimum opacity of 0.15
      ]);
    } else {
      // Normal mode: Standard population scaling
      map.setPaintProperty('pop-cells-layer', 'fill-opacity', [
        'interpolate',
        ['linear'],
        ['get', 'pop'],
        2000,
        0.12,
        50000,
        0.35,
        500000,
        0.65,
        2000000,
        0.85,
      ]);
    }
  }, [isUnderservedMode, mapLoaded]);

  // Highlight coverage ring corresponding to selectedKm threshold
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    if (map.getLayer('coverage-rings-line')) {
      map.setPaintProperty('coverage-rings-line', 'line-width', [
        'match',
        ['get', 'radiusKm'],
        selectedKm,
        3.2,
        1.2,
      ]);
    }
  }, [selectedKm, mapLoaded]);

  // Draw coverage rings when a working city is clicked or selected
  const drawCoverageRings = useCallback((lon: number, lat: number) => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const ringsSource = map.getSource('coverage-rings') as maplibregl.GeoJSONSource | undefined;
    if (ringsSource) {
      const geojson = createCoverageRingsGeoJSON([lon, lat]);
      ringsSource.setData(geojson);
    }
  }, []);

  const clearCoverageRings = useCallback(() => {
    if (!mapRef.current) return;
    const ringsSource = mapRef.current.getSource('coverage-rings') as maplibregl.GeoJSONSource | undefined;
    if (ringsSource) {
      ringsSource.setData({ type: 'FeatureCollection', features: [] });
    }
    const connectorSource = mapRef.current.getSource('gap-connector') as maplibregl.GeoJSONSource | undefined;
    if (connectorSource) {
      connectorSource.setData({ type: 'FeatureCollection', features: [] });
    }
  }, []);

  // Synchronize city station markers & gap city markers
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    // Clear existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // 1. Add Clustered Station Markers per City
    clusters.forEach((cluster) => {
      const el = document.createElement('div');
      el.className = 'station-cluster-marker group cursor-pointer select-none';

      // Visual distinction: filled dot for reporting, hollow dot for no usable data
      const isReporting = cluster.hasReporting;
      const count = cluster.totalStations;

      if (isReporting) {
        el.innerHTML = `
          <div class="relative flex items-center justify-center">
            <div class="w-6 h-6 rounded-full bg-brand-500 text-white flex items-center justify-center text-[10px] font-mono font-bold shadow-md ring-2 ring-white hover:scale-115 transition-transform">
              ${count > 1 ? count : ''}
            </div>
            ${count === 1 ? '<span class="absolute w-2.5 h-2.5 rounded-full bg-white"></span>' : ''}
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="relative flex items-center justify-center">
            <div class="w-5 h-5 rounded-full border-2 border-slate-500 bg-white/90 dark:bg-slate-900/90 text-slate-700 dark:text-slate-200 flex items-center justify-center text-[9px] font-mono font-bold shadow-sm hover:scale-115 transition-transform">
              ${count > 1 ? count : ''}
            </div>
          </div>
        `;
      }

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedCluster(cluster);
        onSelectCity({
          city: cluster.cityName,
          state: cluster.state,
          n_stations: cluster.totalStations,
          n_reporting: cluster.reportingStations,
          lat: cluster.lat,
          lon: cluster.lon,
          pop10km: cluster.stations[0]?.pop10km ?? 0,
          city_status: cluster.hasReporting ? 'all_reporting' : 'no_working_station',
          nearest_working_km: 0,
          nearest_working_city: cluster.cityName,
          displayStatus: cluster.hasReporting ? 'all_reporting' : 'no_usable_data',
          displayStatusLabel: cluster.hasReporting ? 'Reporting in dataset' : 'No usable data in this dataset',
        });

        if (cluster.hasReporting) {
          drawCoverageRings(cluster.lon, cluster.lat);
        } else {
          clearCoverageRings();
        }

        map.easeTo({
          center: [cluster.lon, cluster.lat],
          zoom: Math.max(map.getZoom(), 6.5),
          duration: 700,
        });
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([cluster.lon, cluster.lat])
        .addTo(map);

      markersRef.current.push(marker);
    });

    // 2. Add Gap Cities Markers with 2 Distinct Marker Styles
    gapCities.forEach((gap) => {
      const el = document.createElement('div');
      el.className = 'gap-city-marker cursor-pointer select-none group';

      if (gap.type === 'never_registered') {
        // Not listed in this dataset: Amber diamond with distinct pattern badge
        el.innerHTML = `
          <div class="flex flex-col items-center">
            <div class="w-6 h-6 rotate-45 rounded bg-amber-500 text-white flex items-center justify-center shadow-md ring-2 ring-white dark:ring-slate-900 group-hover:scale-115 transition-transform">
              <span class="-rotate-45 text-[9px] font-bold">▧</span>
            </div>
            <span class="mt-1 px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-200 text-[10px] font-semibold border border-amber-300 shadow-sm whitespace-nowrap">
              ${gap.city}
            </span>
          </div>
        `;
      } else {
        // Listed in this dataset, but no usable data: Slate ring with crossed mark
        el.innerHTML = `
          <div class="flex flex-col items-center">
            <div class="w-6 h-6 rounded-full border-2 border-slate-700 dark:border-slate-300 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 flex items-center justify-center shadow-md group-hover:scale-115 transition-transform">
              <span class="text-[11px] font-bold">○</span>
            </div>
            <span class="mt-1 px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-[10px] font-semibold border border-slate-400 shadow-sm whitespace-nowrap">
              ${gap.city}
            </span>
          </div>
        `;
      }

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedCluster(null);
        onSelectCity(gap);

        // Find coordinates of nearest working city
        const nearestMatch = clusters.find((c) => c.cityName === gap.nearest_working && c.hasReporting);
        if (nearestMatch) {
          const connectorSource = map.getSource('gap-connector') as maplibregl.GeoJSONSource | undefined;
          if (connectorSource) {
            connectorSource.setData({
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'LineString',
                    coordinates: [
                      [gap.lon, gap.lat],
                      [nearestMatch.lon, nearestMatch.lat],
                    ],
                  },
                },
              ],
            });
          }
        }

        clearCoverageRings();

        map.easeTo({
          center: [gap.lon, gap.lat],
          zoom: Math.max(map.getZoom(), 6.5),
          duration: 700,
        });
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([gap.lon, gap.lat])
        .addTo(map);

      markersRef.current.push(marker);
    });
  }, [clusters, gapCities, mapLoaded, onSelectCity, drawCoverageRings, clearCoverageRings]);

  // Pan to selected city when changed from right panel
  useEffect(() => {
    if (!mapRef.current || !selectedCity) return;
    const map = mapRef.current;

    map.easeTo({
      center: [selectedCity.lon, selectedCity.lat],
      zoom: 6.8,
      duration: 800,
    });

    const isWorking = 'n_reporting' in selectedCity && selectedCity.n_reporting > 0;
    if (isWorking) {
      drawCoverageRings(selectedCity.lon, selectedCity.lat);
    }
  }, [selectedCity, drawCoverageRings]);

  const resetView = () => {
    if (!mapRef.current) return;
    mapRef.current.easeTo({
      center: INDIA_CENTER,
      zoom: INDIA_ZOOM,
      duration: 900,
    });
    clearCoverageRings();
    setSelectedCluster(null);
    onSelectCity(null);
  };

  return (
    <div className="relative w-full h-full min-h-[520px] bg-slate-900 overflow-hidden flex flex-col">
      {/* Map Canvas Container */}
      <div ref={mapContainerRef} className="w-full flex-1 min-h-[460px]" />

      {/* Floating Map Controls & Overlays */}
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
        {/* Underserved People Mode Toggle */}
        <button
          onClick={() => onToggleUnderservedMode(!isUnderservedMode)}
          className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg shadow-elevation2 backdrop-blur-md transition-all cursor-pointer ${
            isUnderservedMode
              ? 'bg-amber-500 text-white ring-2 ring-amber-300'
              : 'bg-surface-card/95 hover:bg-surface-card text-fg-primary border border-surface-border'
          }`}
          aria-pressed={isUnderservedMode}
        >
          <Users className="w-3.5 h-3.5" />
          <span>{isUnderservedMode ? 'Underserved mode: ON (>100 km)' : 'Highlight underserved population'}</span>
        </button>

        {/* Reset View Button */}
        <button
          onClick={resetView}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-surface-card/90 hover:bg-surface-card text-fg-secondary hover:text-fg-primary border border-surface-border shadow-elevation1 backdrop-blur-md transition-colors cursor-pointer self-start"
          title="Reset map view to national center"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset View</span>
        </button>
      </div>

      {/* Distance Legend Scale */}
      <div className="absolute bottom-4 left-4 z-10 p-3 rounded-xl bg-surface-card/95 backdrop-blur-md border border-surface-border text-xs text-fg-primary shadow-elevation2 max-w-xs space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-fg-muted flex items-center justify-between">
          <span>Distance to Nearest Monitor</span>
          <span className="font-mono text-[10px]">WorldPop 2017</span>
        </div>

        {/* Color Ramp */}
        <div className="space-y-1">
          <div className="h-2.5 rounded-full w-full bg-gradient-to-r from-[#e0f2fe] via-[#7dd3fc] via-[#0284c7] via-[#0369a1] to-[#0f172a]" />
          <div className="flex justify-between text-[10px] font-mono text-fg-muted">
            <span>≤ 25km</span>
            <span>50km</span>
            <span>100km</span>
            <span>200km</span>
            <span>&gt;400km</span>
          </div>
        </div>

        {/* Marker Key */}
        <div className="pt-2 border-t border-surface-border grid grid-cols-2 gap-1.5 text-[10px] text-fg-secondary">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-500 ring-1 ring-white" />
            <span>Reporting station</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-500 bg-white" />
            <span>No usable data</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rotate-45 rounded bg-amber-500" />
            <span>Not listed in this dataset</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-700 bg-slate-200" />
            <span>Listed in this dataset, but no usable data</span>
          </div>
        </div>
      </div>

      {/* Selected City Inspector Card (Floating Modal / Popover) */}
      {selectedCity && (
        <div className="absolute top-4 right-14 z-20 w-80 sm:w-88 p-4 rounded-xl bg-surface-card/95 backdrop-blur-md border border-surface-border text-fg-primary shadow-elevation3 animate-fadeIn">
          <div className="flex items-start justify-between pb-2 border-b border-surface-border mb-3">
            <div>
              <div className="flex items-center gap-1.5">
                <h4 className="font-bold text-sm text-fg-primary">
                  {selectedCity.city}
                </h4>
                <span className="text-xs text-fg-muted">({selectedCity.state})</span>
              </div>
              <span className="text-[10px] font-mono mt-0.5 inline-block text-fg-muted">
                {'type' in selectedCity ? 'Gap City' : 'Has stations in dataset'}
              </span>
            </div>

            <button
              onClick={() => {
                onSelectCity(null);
                setSelectedCluster(null);
                clearCoverageRings();
              }}
              className="p-1 rounded text-fg-muted hover:text-fg-primary cursor-pointer"
              aria-label="Close details"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* If it's a Gap City */}
          {'type' in selectedCity && (
            <div className="space-y-2 text-xs">
              <div className="p-2.5 rounded-lg bg-surface-subtle border border-surface-border space-y-1">
                <div className="flex justify-between">
                  <span className="text-fg-muted">Classification:</span>
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    {selectedCity.type === 'never_registered'
                      ? 'Not listed in this dataset'
                      : 'No usable data in this dataset'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-fg-muted">Approximate Population:</span>
                  <span className="font-mono font-bold text-fg-primary">
                    {selectedCity.approx_pop_m} Million
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-fg-muted">Nearest Working Monitor:</span>
                  <span className="font-semibold text-fg-primary">
                    {selectedCity.nearest_working}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-fg-muted">Distance to Monitor:</span>
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {selectedCity.dist_km} km
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-fg-muted italic">
                Orange dashed trajectory links {selectedCity.city} to {selectedCity.nearest_working}.
              </p>
            </div>
          )}

          {/* If it's a Standard City Cluster */}
          {selectedCluster && (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-xs py-1 border-b border-surface-border/50">
                <span className="text-fg-muted">Stations in dataset:</span>
                <span className="font-mono font-bold text-fg-primary">{selectedCluster.totalStations}</span>
              </div>
              <div className="flex justify-between text-xs py-1 border-b border-surface-border/50">
                <span className="text-fg-muted">Reporting in dataset:</span>
                <span className="font-mono font-bold text-brand-600 dark:text-brand-400">
                  {selectedCluster.reportingStations}
                </span>
              </div>
              <div className="flex justify-between text-xs py-1 border-b border-surface-border/50">
                <span className="text-fg-muted">No usable data:</span>
                <span className="font-mono text-slate-500">{selectedCluster.noDataStations}</span>
              </div>

              {/* Station Listing */}
              <div className="pt-2">
                <div className="text-[11px] font-semibold text-fg-muted mb-1 uppercase tracking-wider">
                  Station Breakdown:
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {selectedCluster.stations.map((st) => (
                    <div
                      key={st.id}
                      className="p-1.5 rounded bg-surface-subtle border border-surface-border text-[11px]"
                    >
                      <div className="font-medium text-fg-primary truncate">{st.name}</div>
                      <div className="flex justify-between text-[10px] text-fg-muted mt-0.5">
                        <span className="font-mono">{st.id}</span>
                        <span
                          className={
                            st.displayStatus === 'reporting_in_dataset'
                              ? 'text-sky-600 dark:text-sky-400 font-medium'
                              : 'text-slate-500'
                          }
                        >
                          {st.displayStatusLabel}
                        </span>
                      </div>
                      <div className="text-[10px] text-fg-muted flex justify-between mt-0.5">
                        <span>Completeness: {(st.completeness * 100).toFixed(1)}%</span>
                        <span>{st.days_with_data} days with data</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {selectedCluster.hasReporting && (
                <div className="pt-2 text-[10px] text-brand-600 dark:text-brand-400 font-mono">
                  Displaying concentric coverage rings at 10, 25, 50, 100, 200 km.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
