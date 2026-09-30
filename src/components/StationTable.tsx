import React, { useState, useMemo, useRef, useEffect } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Flip } from 'gsap/Flip';
import {
  Search,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Activity,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';
import type { Station, AvailabilityMonthly } from '../types/dashboard';
import { StationAvailabilityHeatmap } from './StationAvailabilityHeatmap';

gsap.registerPlugin(useGSAP, Flip);

interface StationTableProps {
  stations: Station[];
  availabilityMonthly: AvailabilityMonthly;
  initialSearchTerm?: string;
}

type SortColumn =
  | 'status'
  | 'name'
  | 'completeness'
  | 'days_with_data'
  | 'dates'
  | 'longest_gap'
  | 'population';

type SortDirection = 'asc' | 'desc';

export const StationTable: React.FC<StationTableProps> = ({
  stations,
  availabilityMonthly,
  initialSearchTerm,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm ?? '');
  const [selectedState, setSelectedState] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'reporting' | 'no_usable_data'>('all');
  const [selectedBand, setSelectedBand] = useState<'all' | 'high' | 'mid' | 'low' | 'zero'>('all');

  const [sortColumn, setSortColumn] = useState<SortColumn>('population');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedStationId, setExpandedStationId] = useState<string | null>(null);

  // Synchronize incoming search filter from other views (e.g. Alerts replay link)
  useEffect(() => {
    if (initialSearchTerm !== undefined) {
      setSearchTerm(initialSearchTerm);
      setExpandedStationId(initialSearchTerm);
    }
  }, [initialSearchTerm]);

  // Extract unique states for dropdown filter
  const states = useMemo(() => {
    const set = new Set(stations.map((s) => s.state));
    return Array.from(set).sort();
  }, [stations]);

  // Filter stations
  const filteredStations = useMemo(() => {
    return stations.filter((s) => {
      // 1. Search text
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const matches =
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.city.toLowerCase().includes(q) ||
          s.state.toLowerCase().includes(q);
        if (!matches) return false;
      }

      // 2. State filter
      if (selectedState !== 'all' && s.state !== selectedState) {
        return false;
      }

      // 3. Status filter
      if (selectedStatus === 'reporting' && s.displayStatus !== 'reporting_in_dataset') {
        return false;
      }
      if (selectedStatus === 'no_usable_data' && s.displayStatus !== 'no_usable_data') {
        return false;
      }

      // 4. Completeness band filter
      if (selectedBand === 'high' && s.completeness < 0.9) return false;
      if (selectedBand === 'mid' && (s.completeness < 0.75 || s.completeness >= 0.9)) return false;
      if (selectedBand === 'low' && (s.completeness <= 0 || s.completeness >= 0.75)) return false;
      if (selectedBand === 'zero' && s.completeness > 0) return false;

      return true;
    });
  }, [stations, searchTerm, selectedState, selectedStatus, selectedBand]);

  // Sort stations
  const sortedStations = useMemo(() => {
    return [...filteredStations].sort((a, b) => {
      let diff = 0;
      switch (sortColumn) {
        case 'population':
          diff = a.pop10km - b.pop10km;
          break;
        case 'completeness':
          diff = a.completeness - b.completeness;
          break;
        case 'days_with_data':
          diff = a.days_with_data - b.days_with_data;
          break;
        case 'longest_gap':
          diff = a.longest_gap_days - b.longest_gap_days;
          break;
        case 'name':
          diff = a.name.localeCompare(b.name);
          break;
        case 'status':
          diff = a.displayStatus.localeCompare(b.displayStatus);
          break;
        case 'dates':
          diff = (a.first_date || '').localeCompare(b.first_date || '');
          break;
      }
      return sortDirection === 'asc' ? diff : -diff;
    });
  }, [filteredStations, sortColumn, sortDirection]);

  // Handle Sort Click with Flip animation
  const handleSort = (col: SortColumn) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (sortColumn === col) {
        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        setSortColumn(col);
        setSortDirection('desc');
      }
      return;
    }

    // Capture state of first 40 rows for performance
    const state = Flip.getState('.station-row-item:nth-child(-n+40)');
    if (sortColumn === col) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection('desc');
    }

    requestAnimationFrame(() => {
      Flip.from(state, {
        duration: 0.35,
        ease: 'power2.out',
        stagger: 0.01,
      });
    });
  };

  // Animate rows entrance on initial mount
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      gsap.from('.station-row-item:nth-child(-n+30)', {
        opacity: 0,
        y: 12,
        duration: 0.4,
        stagger: 0.015,
        ease: 'power2.out',
      });
    },
    { dependencies: [], scope: containerRef }
  );

  const toggleExpand = (stationId: string) => {
    setExpandedStationId((prev) => (prev === stationId ? null : stationId));
  };

  const resetFilters = () => {
    setSearchTerm('');
    setSelectedState('all');
    setSelectedStatus('all');
    setSelectedBand('all');
    setSortColumn('population');
    setSortDirection('desc');
  };

  // Helper for rendering Sort Arrows
  const renderSortIndicator = (col: SortColumn) => {
    if (sortColumn !== col) {
      return <ArrowUpDown className="w-3 h-3 text-fg-muted/60 ml-1 inline-block" />;
    }
    return sortDirection === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-brand-500 ml-1 inline-block" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-brand-500 ml-1 inline-block" />
    );
  };

  const getAriaSort = (col: SortColumn): 'ascending' | 'descending' | 'none' => {
    if (sortColumn !== col) return 'none';
    return sortDirection === 'asc' ? 'ascending' : 'descending';
  };

  return (
    <div ref={containerRef} className="space-y-4">
      {/* 1. FILTER & SEARCH CONTROL BAR */}
      <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 space-y-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Bar */}
          <div className="relative flex-1">
            <label htmlFor="station-search-input" className="sr-only">
              Search station name, station ID, city or state
            </label>
            <Search className="w-4 h-4 text-fg-muted absolute left-3 top-2.5" aria-hidden="true" />
            <input
              id="station-search-input"
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search station name, station ID (e.g. DL001), city or state..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg bg-surface-subtle border border-surface-border text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-brand-500 transition-colors"
            />
          </div>

          {/* Filter Dropdowns Grid */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* State Filter */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="station-state-select" className="text-[11px] text-fg-muted font-medium">
                State:
              </label>
              <select
                id="station-state-select"
                value={selectedState}
                onChange={(e) => setSelectedState(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-surface-subtle border border-surface-border text-fg-primary text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="all">All States ({states.length})</option>
                {states.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>

            {/* Status Filter */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="station-status-select" className="text-[11px] text-fg-muted font-medium">
                Status:
              </label>
              <select
                id="station-status-select"
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value as any)}
                className="px-2.5 py-1.5 rounded-lg bg-surface-subtle border border-surface-border text-fg-primary text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="all">All Statuses (230)</option>
                <option value="reporting">Reporting in dataset (107)</option>
                <option value="no_usable_data">No usable data in this dataset (123)</option>
              </select>
            </div>

            {/* Completeness Band Filter */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="station-completeness-select" className="text-[11px] text-fg-muted font-medium">
                Completeness:
              </label>
              <select
                id="station-completeness-select"
                value={selectedBand}
                onChange={(e) => setSelectedBand(e.target.value as any)}
                className="px-2.5 py-1.5 rounded-lg bg-surface-subtle border border-surface-border text-fg-primary text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="all">All Bands</option>
                <option value="high">High (≥ 90%)</option>
                <option value="mid">Moderate (75% – 89%)</option>
                <option value="low">Low (&lt; 75%)</option>
                <option value="zero">No usable data (0%)</option>
              </select>
            </div>

            {/* Reset Button */}
            {(searchTerm || selectedState !== 'all' || selectedStatus !== 'all' || selectedBand !== 'all') && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs text-fg-muted hover:text-fg-primary transition-colors cursor-pointer"
                aria-label="Reset all search filters"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>

        {/* Results Counter */}
        <div className="flex items-center justify-between text-[11px] text-fg-muted font-mono pt-1 border-t border-surface-border/50">
          <span>
            Showing <strong className="text-fg-primary">{sortedStations.length}</strong> of {stations.length} ground stations
          </span>
          <span>Click any row or expand button to inspect monthly availability heatmap</span>
        </div>
      </div>

      {/* 2. DESKTOP VIEW: SEMANTIC DATA TABLE (Hidden under 640px) */}
      <div className="hidden sm:block rounded-xl border border-surface-border bg-surface-card shadow-elevation1 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-surface-border bg-surface-subtle/80 text-[11px] font-bold text-fg-muted uppercase tracking-wider">
                <th scope="col" className="py-3 px-3 w-10 text-center">
                  <span className="sr-only">Expand</span>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('status')}
                  className="py-3 px-3"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('status')}
                    className="flex items-center hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Status, currently ${getAriaSort('status')}`}
                  >
                    <span>Status</span>
                    {renderSortIndicator('status')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('name')}
                  className="py-3 px-3 min-w-[220px]"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('name')}
                    className="flex items-center hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Station & Location, currently ${getAriaSort('name')}`}
                  >
                    <span>Station &amp; Location</span>
                    {renderSortIndicator('name')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('completeness')}
                  className="py-3 px-3 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('completeness')}
                    className="flex items-center justify-end w-full hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Completeness, currently ${getAriaSort('completeness')}`}
                  >
                    <span>Completeness</span>
                    {renderSortIndicator('completeness')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('days_with_data')}
                  className="py-3 px-3 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('days_with_data')}
                    className="flex items-center justify-end w-full hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Days with Data, currently ${getAriaSort('days_with_data')}`}
                  >
                    <span>Days with Data</span>
                    {renderSortIndicator('days_with_data')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('dates')}
                  className="py-3 px-3"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('dates')}
                    className="flex items-center hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by First to Last Date, currently ${getAriaSort('dates')}`}
                  >
                    <span>First to Last Date</span>
                    {renderSortIndicator('dates')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('longest_gap')}
                  className="py-3 px-3 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('longest_gap')}
                    className="flex items-center justify-end w-full hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Longest gap in data, currently ${getAriaSort('longest_gap')}`}
                  >
                    <span>Longest Gap in Data</span>
                    {renderSortIndicator('longest_gap')}
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={getAriaSort('population')}
                  className="py-3 px-3 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('population')}
                    className="flex items-center justify-end w-full hover:text-fg-primary transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1 -mx-1"
                    aria-label={`Sort by Population in 10 km, currently ${getAriaSort('population')}`}
                  >
                    <span>Pop (10 km)</span>
                    {renderSortIndicator('population')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {sortedStations.map((station) => {
                const isExpanded = expandedStationId === station.id;
                const isReporting = station.displayStatus === 'reporting_in_dataset';

                return (
                  <React.Fragment key={station.id}>
                    <tr
                      onClick={() => toggleExpand(station.id)}
                      className={`station-row-item hover:bg-surface-hover/80 transition-colors cursor-pointer ${
                        isExpanded ? 'bg-surface-subtle/70' : ''
                      }`}
                    >
                      {/* Chevron Expand Button */}
                      <td className="py-2.5 px-2 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(station.id);
                          }}
                          aria-expanded={isExpanded}
                          aria-controls={`heatmap-row-${station.id}`}
                          aria-label={
                            isExpanded
                              ? `Collapse monthly details for ${station.name}`
                              : `Expand monthly details for ${station.name}`
                          }
                          className="p-1 rounded text-fg-muted hover:text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500 transition-colors cursor-pointer"
                        >
                          {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </td>

                      {/* 1. Status Pill */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {isReporting ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-100 dark:bg-sky-950/80 text-sky-800 dark:text-sky-300 border border-sky-300 dark:border-sky-800">
                            <Activity className="w-3 h-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                            <span>Reporting in dataset</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
                            <ShieldAlert className="w-3 h-3 text-slate-500" aria-hidden="true" />
                            <span>No usable data</span>
                          </span>
                        )}
                      </td>

                      {/* 2. Station and City/State */}
                      <td className="py-2.5 px-3">
                        <div className="font-semibold text-fg-primary">{station.name}</div>
                        <div className="flex items-center gap-2 text-[11px] text-fg-muted mt-0.5">
                          <span className="font-mono text-fg-secondary font-medium">{station.id}</span>
                          <span>•</span>
                          <span>{station.city}, {station.state}</span>
                        </div>
                      </td>

                      {/* 3. Completeness % */}
                      <td className="py-2.5 px-3 text-right font-mono">
                        {isReporting ? (
                          <div className="inline-flex flex-col items-end">
                            <span className="font-bold text-fg-primary">
                              {(station.completeness * 100).toFixed(1)}%
                            </span>
                            <div className="w-16 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 mt-1 overflow-hidden">
                              <div
                                className="h-full bg-sky-500 rounded-full"
                                style={{ width: `${Math.min(100, station.completeness * 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-600">0.0%</span>
                        )}
                      </td>

                      {/* 4. Days with Data */}
                      <td className="py-2.5 px-3 text-right font-mono text-fg-primary">
                        {station.days_with_data > 0 ? (
                          <strong>{station.days_with_data.toLocaleString()}</strong>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-600">0</span>
                        )}
                      </td>

                      {/* 5. First & Last Date */}
                      <td className="py-2.5 px-3 font-mono text-[11px] text-fg-secondary whitespace-nowrap">
                        {isReporting && station.first_date !== '—' ? (
                          <span>
                            {station.first_date} → {station.last_date}
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-600">No records</span>
                        )}
                      </td>

                      {/* 6. Longest Gap in Days */}
                      <td className="py-2.5 px-3 text-right font-mono">
                        {isReporting && station.longest_gap_days > 0 ? (
                          <span className={station.longest_gap_days > 60 ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-fg-secondary'}>
                            {station.longest_gap_days}d
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-600">—</span>
                        )}
                      </td>

                      {/* 7. Population within 10 km */}
                      <td className="py-2.5 px-3 text-right font-mono font-medium text-fg-primary">
                        {(station.pop10km / 1000000).toFixed(2)}M
                      </td>
                    </tr>

                    {/* Expandable Heatmap Row */}
                    {isExpanded && (
                      <tr id={`heatmap-row-${station.id}`} className="bg-surface-subtle/50">
                        <td colSpan={8} className="p-3 sm:p-4">
                          <StationAvailabilityHeatmap
                            stationId={station.id}
                            stationName={station.name}
                            availabilityMonthly={availabilityMonthly}
                            hasReporting={isReporting}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}

              {sortedStations.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-xs text-fg-muted">
                    No stations found matching the selected filter criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. MOBILE VIEW: RESPONSIVE CARDS (Visible under 640px) */}
      <div className="block sm:hidden space-y-3">
        {sortedStations.map((station) => {
          const isExpanded = expandedStationId === station.id;
          const isReporting = station.displayStatus === 'reporting_in_dataset';

          return (
            <div
              key={station.id}
              className="p-3.5 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 space-y-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-xs text-fg-primary">{station.name}</div>
                  <div className="text-[11px] text-fg-muted font-mono mt-0.5">
                    {station.id} • {station.city}, {station.state}
                  </div>
                </div>

                {isReporting ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300 border border-sky-300 flex-shrink-0">
                    Reporting
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-300 flex-shrink-0">
                    No data
                  </span>
                )}
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-surface-border/60">
                <div>
                  <div className="text-[10px] text-fg-muted uppercase">Completeness:</div>
                  <div className="font-mono font-bold text-fg-primary">
                    {isReporting ? `${(station.completeness * 100).toFixed(1)}%` : '0.0%'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-fg-muted uppercase">Days with Data:</div>
                  <div className="font-mono font-bold text-fg-primary">
                    {station.days_with_data > 0 ? station.days_with_data.toLocaleString() : '0'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-fg-muted uppercase">Longest Gap in Data:</div>
                  <div className="font-mono text-fg-secondary">
                    {station.longest_gap_days > 0 ? `${station.longest_gap_days} days` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-fg-muted uppercase">Pop in 10 km:</div>
                  <div className="font-mono font-bold text-fg-primary">
                    {(station.pop10km / 1000000).toFixed(2)}M
                  </div>
                </div>
              </div>

              {/* Expand Toggle Button */}
              <button
                type="button"
                onClick={() => toggleExpand(station.id)}
                aria-expanded={isExpanded}
                aria-controls={`mobile-heatmap-${station.id}`}
                aria-label={
                  isExpanded
                    ? `Hide monthly data for ${station.name}`
                    : `View monthly data heatmap for ${station.name}`
                }
                className="w-full mt-2 py-1.5 px-3 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs font-medium text-fg-primary flex items-center justify-between transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <span>{isExpanded ? 'Hide Monthly Strip' : 'View Monthly Availability Heatmap'}</span>
                {isExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>

              {/* Expanded Heatmap in Mobile Card */}
              {isExpanded && (
                <div id={`mobile-heatmap-${station.id}`} className="pt-2">
                  <StationAvailabilityHeatmap
                    stationId={station.id}
                    stationName={station.name}
                    availabilityMonthly={availabilityMonthly}
                    hasReporting={isReporting}
                  />
                </div>
              )}
            </div>
          );
        })}

        {sortedStations.length === 0 && (
          <div className="p-6 text-center text-xs text-fg-muted bg-surface-card rounded-xl border border-surface-border">
            No stations match your filters.
          </div>
        )}
      </div>
    </div>
  );
};
