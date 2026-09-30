import React from 'react';
import { Map, Layers, Radio, AlertTriangle } from 'lucide-react';
import { getNetworkSummary } from '../data/loader';

export const CoverageMapPlaceholder: React.FC = () => {
  const summary = getNetworkSummary();

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-surface-border gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-fg-primary">
              National Air-Quality Coverage Map
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono rounded bg-brand-subtle text-brand-600 dark:text-brand-500 border border-brand-500/20">
              Interactive Map Shell
            </span>
          </div>
          <p className="text-sm text-fg-secondary mt-1">
            Spatial distribution of ambient air-quality monitoring stations and population buffer radii across India.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono">
          <div className="px-3 py-1.5 rounded-md bg-surface-subtle border border-surface-border text-fg-secondary">
            Stations: <span className="font-bold text-fg-primary">{summary.totalStations}</span>
          </div>
          <div className="px-3 py-1.5 rounded-md bg-surface-subtle border border-surface-border text-fg-secondary">
            Cities Monitored: <span className="font-bold text-fg-primary">{summary.totalCities}</span>
          </div>
        </div>
      </div>

      {/* Map Canvas Standby Stage (MapLibre GL JS Container) */}
      <div
        id="maplibre-stage-container"
        className="relative w-full h-[520px] rounded-xl border border-surface-border bg-gradient-to-b from-surface-subtle via-surface-card to-surface-subtle flex flex-col items-center justify-center text-center p-8 overflow-hidden shadow-elevation1"
      >
        {/* Subtle geospatial grid background lines */}
        <div 
          className="absolute inset-0 opacity-[0.04] dark:opacity-[0.07] pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: '32px 32px'
          }}
        />

        <div className="relative z-10 max-w-md space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-brand-subtle border border-brand-500/30 flex items-center justify-center mx-auto text-brand-500 shadow-elevation1">
            <Map className="w-8 h-8" />
          </div>

          <div>
            <h2 className="text-lg font-bold text-fg-primary">
              MapLibre GL JS Basemap Ready
            </h2>
            <p className="text-sm text-fg-muted mt-1 leading-relaxed">
              Basemap container scaffolded with key-less CartoDB Positron / OSM style attribution. Station coordinates and 10 km population buffers are loaded in data pipelines.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-xs font-mono text-fg-muted">
            <span className="px-2.5 py-1 rounded bg-surface-card border border-surface-border flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-sky-500" />
              {summary.reportingStations} Reporting in dataset ({summary.reportingPct}%)
            </span>
            <span className="px-2.5 py-1 rounded bg-surface-card border border-surface-border flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full border border-slate-400 bg-transparent" />
              {summary.noDataStations} No usable data in this dataset
            </span>
            <span className="px-2.5 py-1 rounded bg-surface-card border border-surface-border flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              {summary.gapCitiesCount} Unmonitored Cities
            </span>
          </div>

          <div className="pt-3">
            <div className="text-[11px] text-fg-muted bg-surface-card/90 backdrop-blur px-3 py-1.5 rounded-md border border-surface-border inline-block">
              Basemap Source Attribution: <code className="text-brand-600 dark:text-brand-500">© OpenStreetMap contributors, © CARTO</code>
            </div>
          </div>
        </div>

        {/* Technical Corner Telemetry */}
        <div className="absolute bottom-3 left-4 text-[11px] font-mono text-fg-muted">
          Center: 20.5937° N, 78.9629° E | Zoom: 4.8
        </div>
        <div className="absolute bottom-3 right-4 text-[11px] font-mono text-fg-muted">
          Coordinate System: EPSG:4326 / WGS 84
        </div>
      </div>

      {/* Semantic Distinction Guide (Crucial Requirement: Separate Air Quality from Monitoring Status) */}
      <div className="p-4 rounded-xl border border-surface-border bg-surface-card">
        <h3 className="text-xs font-bold uppercase tracking-wider text-fg-primary mb-2 flex items-center gap-2">
          <Layers className="w-4 h-4 text-brand-500" />
          Semantic Guidance: Air Quality vs. Monitoring Status Separation
        </h3>
        <p className="text-xs text-fg-secondary mb-3 leading-relaxed">
          To prevent judicial and public confusion, VayuDrishti strictly decouples <strong>ambient pollutant severity</strong> from <strong>sensor data reporting status</strong>:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg border border-surface-border bg-surface-subtle">
            <div className="font-semibold text-fg-primary mb-1 flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-aqi-poor" />
              Track 1: Ambient AQI Severity (Air Condition)
            </div>
            <p className="text-fg-muted text-[11px]">
              Uses CPCB Standard spectrum (Good, Satisfactory, Moderate, Poor, Very Poor, Severe). Indicates physical air composition.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-surface-border bg-surface-subtle">
            <div className="font-semibold text-fg-primary mb-1 flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-monitor-reporting" />
              Track 2: Data Status in Dataset
            </div>
            <p className="text-fg-muted text-[11px]">
              Uses Slate/Sky/Indigo tones with shapes (● Reporting in dataset, ◐ Partial, ○ No usable data in this dataset, ◌ Unmonitored gap). High reporting completeness never implies clean air, and absence of data never implies safe air.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
