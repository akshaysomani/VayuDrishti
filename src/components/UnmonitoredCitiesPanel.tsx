import React, { useState, useMemo } from 'react';
import { Building2, Search, MapPin } from 'lucide-react';
import type { City } from '../types/dashboard';

interface UnmonitoredCitiesPanelProps {
  cities: City[];
}

export const UnmonitoredCitiesPanel: React.FC<UnmonitoredCitiesPanelProps> = ({ cities }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'population' | 'distance'>('population');
  const [filterTier, setFilterTier] = useState<'all' | 'beyond100' | 'within50'>('all');

  const unmonitoredList = useMemo(() => {
    return cities.filter((c) => c.city_status === 'no_working_station');
  }, [cities]);

  const beyond100Count = useMemo(() => {
    return unmonitoredList.filter((c) => c.nearest_working_km > 100).length;
  }, [unmonitoredList]);

  const within50Count = useMemo(() => {
    return unmonitoredList.filter((c) => c.nearest_working_km <= 50).length;
  }, [unmonitoredList]);

  const filteredAndSorted = useMemo(() => {
    return unmonitoredList
      .filter((c) => {
        const q = searchTerm.toLowerCase();
        const matchesQuery =
          c.city.toLowerCase().includes(q) ||
          c.state.toLowerCase().includes(q) ||
          c.nearest_working_city.toLowerCase().includes(q);

        if (!matchesQuery) return false;

        if (filterTier === 'beyond100') return c.nearest_working_km > 100;
        if (filterTier === 'within50') return c.nearest_working_km <= 50;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'population') {
          return b.pop10km - a.pop10km;
        }
        return b.nearest_working_km - a.nearest_working_km;
      });
  }, [unmonitoredList, searchTerm, sortBy, filterTier]);

  return (
    <div className="flex flex-col h-full bg-surface-card border border-surface-border rounded-xl shadow-elevation1 overflow-hidden">
      {/* Panel Header */}
      <div className="p-4 border-b border-surface-border space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-fg-primary uppercase tracking-wider">
              Cities Without a Working Station
            </h3>
          </div>
          <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-surface-subtle border border-surface-border text-fg-primary">
            {unmonitoredList.length} Cities
          </span>
        </div>

        <p className="text-xs text-fg-secondary leading-relaxed">
          Municipal centers listed in this dataset with no reporting station. Ranked by population in 10 km urban buffer.
        </p>

        {/* Search & Sort Controls */}
        <div className="space-y-2 pt-1">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-fg-muted absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search unmonitored city or state..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-subtle border border-surface-border text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-brand-500 transition-colors"
              aria-label="Filter unmonitored cities"
            />
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            {/* Quick Filter Buttons */}
            <div className="flex items-center gap-1 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setFilterTier('all')}
                className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                  filterTier === 'all'
                    ? 'bg-brand-500 text-white font-semibold'
                    : 'bg-surface-subtle text-fg-muted hover:text-fg-primary'
                }`}
              >
                All ({unmonitoredList.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTier('beyond100')}
                className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                  filterTier === 'beyond100'
                    ? 'bg-amber-600 text-white font-semibold'
                    : 'bg-surface-subtle text-amber-700 dark:text-amber-400 hover:text-fg-primary'
                }`}
                title="Highlight cities > 100 km from any monitor"
              >
                &gt;100km ({beyond100Count})
              </button>
              <button
                type="button"
                onClick={() => setFilterTier('within50')}
                className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                  filterTier === 'within50'
                    ? 'bg-sky-600 text-white font-semibold'
                    : 'bg-surface-subtle text-sky-700 dark:text-sky-400 hover:text-fg-primary'
                }`}
                title="Cities within 50 km of a station reporting in this dataset"
              >
                ≤50km ({within50Count})
              </button>
            </div>

            {/* Sort Toggle */}
            <div className="flex items-center gap-1 font-mono text-[11px] bg-surface-subtle p-0.5 rounded border border-surface-border">
              <button
                type="button"
                onClick={() => setSortBy('population')}
                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  sortBy === 'population'
                    ? 'bg-surface-card text-fg-primary font-bold shadow-xs'
                    : 'text-fg-muted hover:text-fg-primary'
                }`}
              >
                Pop
              </button>
              <button
                type="button"
                onClick={() => setSortBy('distance')}
                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  sortBy === 'distance'
                    ? 'bg-surface-card text-fg-primary font-bold shadow-xs'
                    : 'text-fg-muted hover:text-fg-primary'
                }`}
              >
                Dist
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* City Items List */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2 min-h-0">
        {filteredAndSorted.map((city) => {
          const isFar = city.nearest_working_km > 100;
          const isNear = city.nearest_working_km <= 50;

          return (
            <div
              key={city.city}
              className={`p-3 rounded-lg border transition-all ${
                isFar
                  ? 'border-amber-400/40 bg-amber-50/40 dark:bg-amber-950/20'
                  : isNear
                  ? 'border-sky-300/40 bg-sky-50/30 dark:bg-sky-950/15'
                  : 'border-surface-border bg-surface-subtle'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-fg-primary">{city.city}</span>
                    <span className="text-[10px] text-fg-muted">({city.state})</span>
                    {isFar && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
                        &gt;100 km Void
                      </span>
                    )}
                    {isNear && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-medium bg-sky-100 dark:bg-sky-900/60 text-sky-800 dark:text-sky-300">
                        Within 50 km of reporting station
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-fg-secondary mt-1">
                    Population in 10 km: <strong className="text-fg-primary font-mono">{(city.pop10km / 1000000).toFixed(2)}M</strong>
                  </div>
                </div>

                <div className="text-right flex-shrink-0">
                  <div className="font-mono text-xs font-bold text-fg-primary">
                    {city.nearest_working_km} km
                  </div>
                  <div className="text-[10px] text-fg-muted flex items-center justify-end gap-1 mt-0.5">
                    <MapPin className="w-2.5 h-2.5" />
                    <span>to {city.nearest_working_city}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {filteredAndSorted.length === 0 && (
          <div className="p-6 text-center text-xs text-fg-muted bg-surface-subtle rounded-lg border border-surface-border">
            No unmonitored cities match your filters.
          </div>
        )}
      </div>

      {/* Footer Summary */}
      <div className="p-3 border-t border-surface-border bg-surface-subtle/50 text-[11px] text-fg-muted font-mono flex justify-between items-center flex-shrink-0">
        <span>Showing {filteredAndSorted.length} of {unmonitoredList.length}</span>
        <span>{beyond100Count} cities &gt; 100 km</span>
      </div>
    </div>
  );
};
