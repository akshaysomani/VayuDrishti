import React, { useState, useEffect } from 'react';
import {
  getStations,
  getCities,
  getAvailabilityMonthly,
  getMeta,
} from '../data/loader';
import type {
  Station,
  City,
  AvailabilityMonthly,
  DashboardMeta,
} from '../types/dashboard';
import { MonitoringHealthSummaryStrip } from './MonitoringHealthSummaryStrip';
import { StationTable } from './StationTable';
import { UnmonitoredCitiesPanel } from './UnmonitoredCitiesPanel';
import { Activity, Building2, Calendar } from 'lucide-react';

interface MonitoringHealthViewProps {
  initialSearchTerm?: string;
}

export const MonitoringHealthView: React.FC<MonitoringHealthViewProps> = ({ initialSearchTerm }) => {
  const [stations, setStations] = useState<Station[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [availabilityMonthly, setAvailabilityMonthly] = useState<AvailabilityMonthly | null>(null);
  const [meta, setMeta] = useState<DashboardMeta | null>(null);
  const [loading, setLoading] = useState(true);

  // Tab state for mobile/tablet switching or unified desktop view
  const [activeTab, setActiveTab] = useState<'stations' | 'unmonitored-cities'>('stations');

  useEffect(() => {
    Promise.all([
      getStations(),
      getCities(),
      getAvailabilityMonthly(),
      getMeta(),
    ]).then(([st, ci, av, m]) => {
      setStations(st);
      setCities(ci);
      setAvailabilityMonthly(av);
      setMeta(m);
      setLoading(false);
    });
  }, []);

  if (loading || !availabilityMonthly) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[500px] text-fg-muted space-y-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-mono">Loading station availability datasets...</span>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* 1. VIEW HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-surface-border gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg-primary">
              Monitoring Infrastructure Health &amp; Completeness
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono font-medium rounded bg-surface-subtle text-fg-secondary border border-surface-border">
              Historical Ground Station Records
            </span>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary mt-1 max-w-3xl leading-relaxed">
            Historical station uptime, observation gaps, and city-level monitoring voids across India's Central Pollution Control Board network.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 text-xs font-mono text-fg-muted bg-surface-subtle px-3 py-1.5 rounded-lg border border-surface-border">
          <Calendar className="w-3.5 h-3.5 text-brand-500" />
          <span>Data Period: {meta?.data_period ?? '2015-01-01 to 2020-07-01'}</span>
        </div>
      </div>

      {/* 2. SUMMARY STRIP */}
      <MonitoringHealthSummaryStrip stations={stations} cities={cities} />

      {/* 3. WORKSPACE LAYOUT */}
      <div className="space-y-4">
        {/* Mobile / Tablet Segmented Tab Switcher */}
        <div className="flex xl:hidden items-center p-1 bg-surface-subtle rounded-lg border border-surface-border max-w-md">
          <button
            type="button"
            onClick={() => setActiveTab('stations')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-all cursor-pointer ${
              activeTab === 'stations'
                ? 'bg-surface-card text-fg-primary shadow-xs'
                : 'text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-brand-500" />
            <span>Stations in dataset ({stations.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('unmonitored-cities')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-all cursor-pointer ${
              activeTab === 'unmonitored-cities'
                ? 'bg-surface-card text-fg-primary shadow-xs'
                : 'text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Building2 className="w-3.5 h-3.5 text-amber-500" />
            <span>Unmonitored Cities (101)</span>
          </button>
        </div>

        {/* Desktop 2-Column Grid (xl+) or Tabbed View (<xl) */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Main Station Table (8 cols on XL) */}
          <div
            className={`xl:col-span-8 ${
              activeTab === 'stations' ? 'block' : 'hidden xl:block'
            }`}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-fg-primary uppercase tracking-wider flex items-center gap-2">
                  <Activity className="w-4 h-4 text-brand-500" />
                  <span>Ground Station Registry &amp; Completeness Records</span>
                </h2>
                <span className="text-[11px] font-mono text-fg-muted hidden sm:inline-block">
                  Click a row to expand monthly heatmap
                </span>
              </div>
              <StationTable
                stations={stations}
                availabilityMonthly={availabilityMonthly}
                initialSearchTerm={initialSearchTerm}
              />
            </div>
          </div>

          {/* Secondary Panel: Cities Without a Working Station (4 cols on XL) */}
          <div
            className={`xl:col-span-4 xl:sticky xl:top-20 ${
              activeTab === 'unmonitored-cities' ? 'block' : 'hidden xl:block'
            }`}
          >
            <div className="xl:h-[820px]">
              <UnmonitoredCitiesPanel cities={cities} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
