import React, { useState, useMemo } from 'react';
import { Users, Info, ArrowUpDown } from 'lucide-react';
import type { CityExposureSummary } from '../../types/alert';

interface CityExposureCardProps {
  cityExposure?: Record<string, CityExposureSummary>;
}

type SortField =
  | 'city'
  | 'population_5km_union'
  | 'already_poor_share_pct'
  | 'mean_daily_expected_exposed'
  | 'watch_pct'
  | 'elevated_pct'
  | 'high_pct'
  | 'nominal_pct';

export const CityExposureCard: React.FC<CityExposureCardProps> = ({ cityExposure }) => {
  const [sortField, setSortField] = useState<SortField>('mean_daily_expected_exposed');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [selectedTierFilter, setSelectedTierFilter] = useState<'all' | 'high' | 'elevated' | 'watch'>('all');

  const cityList = useMemo(() => {
    if (!cityExposure) return [];
    return Object.values(cityExposure);
  }, [cityExposure]);

  const sortedCities = useMemo(() => {
    let list = [...cityList];

    if (selectedTierFilter === 'high') {
      list = list.filter((c) => (c.mean_monitor_share_by_tier?.High ?? 0) > 0.02);
    } else if (selectedTierFilter === 'elevated') {
      list = list.filter((c) => (c.mean_monitor_share_by_tier?.Elevated ?? 0) > 0.10);
    } else if (selectedTierFilter === 'watch') {
      list = list.filter((c) => (c.mean_monitor_share_by_tier?.Watch ?? 0) > 0.10);
    }

    list.sort((a, b) => {
      let valA = 0;
      let valB = 0;

      switch (sortField) {
        case 'city':
          return sortAsc ? a.city.localeCompare(b.city) : b.city.localeCompare(a.city);
        case 'population_5km_union':
          valA = a.population_5km_union ?? a.population_within_5km_of_monitors ?? 0;
          valB = b.population_5km_union ?? b.population_within_5km_of_monitors ?? 0;
          break;
        case 'already_poor_share_pct':
          valA = a.already_poor_share_pct ?? 0;
          valB = b.already_poor_share_pct ?? 0;
          break;
        case 'mean_daily_expected_exposed':
          valA = a.mean_daily_expected_exposed ?? 0;
          valB = b.mean_daily_expected_exposed ?? 0;
          break;
        case 'high_pct':
          valA = a.mean_monitor_share_by_tier?.High ?? 0;
          valB = b.mean_monitor_share_by_tier?.High ?? 0;
          break;
        case 'elevated_pct':
          valA = a.mean_monitor_share_by_tier?.Elevated ?? 0;
          valB = b.mean_monitor_share_by_tier?.Elevated ?? 0;
          break;
        case 'watch_pct':
          valA = a.mean_monitor_share_by_tier?.Watch ?? 0;
          valB = b.mean_monitor_share_by_tier?.Watch ?? 0;
          break;
        case 'nominal_pct':
          valA = a.mean_monitor_share_by_tier?.Nominal ?? 0;
          valB = b.mean_monitor_share_by_tier?.Nominal ?? 0;
          break;
      }

      return sortAsc ? valA - valB : valB - valA;
    });

    return list;
  }, [cityList, sortField, sortAsc, selectedTierFilter]);

  if (!cityExposure || cityList.length === 0) {
    return null;
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  return (
    <section
      aria-labelledby="city-exposure-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-5"
    >
      {/* Title & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-brand-500" aria-hidden="true" />
            <h2 id="city-exposure-heading" className="text-base sm:text-lg font-bold text-fg-primary">
              City Population Exposure &amp; Operational Risk Tiers
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary">
            Daily population exposure within 5 km monitor union buffers across four standardized risk tiers.
          </p>
        </div>

        {/* Filter Badges for Risk Tiers */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono text-fg-muted mr-1">Filter Tier:</span>
          <button
            type="button"
            onClick={() => setSelectedTierFilter('all')}
            className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
              selectedTierFilter === 'all'
                ? 'bg-brand-500/20 text-brand-700 dark:text-brand-300 border-brand-500/40 font-semibold'
                : 'bg-surface-subtle text-fg-secondary hover:bg-surface-hover border-surface-border'
            }`}
          >
            All Cities ({cityList.length})
          </button>
          <button
            type="button"
            onClick={() => setSelectedTierFilter('high')}
            className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
              selectedTierFilter === 'high'
                ? 'bg-rose-500/20 text-rose-800 dark:text-rose-200 border-rose-500/50 font-semibold'
                : 'bg-surface-subtle text-fg-secondary hover:bg-surface-hover border-surface-border'
            }`}
          >
            High Tier &gt;2%
          </button>
          <button
            type="button"
            onClick={() => setSelectedTierFilter('elevated')}
            className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
              selectedTierFilter === 'elevated'
                ? 'bg-orange-500/20 text-orange-800 dark:text-orange-200 border-orange-500/50 font-semibold'
                : 'bg-surface-subtle text-fg-secondary hover:bg-surface-hover border-surface-border'
            }`}
          >
            Elevated Tier &gt;10%
          </button>
          <button
            type="button"
            onClick={() => setSelectedTierFilter('watch')}
            className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
              selectedTierFilter === 'watch'
                ? 'bg-amber-500/20 text-amber-800 dark:text-amber-200 border-amber-500/50 font-semibold'
                : 'bg-surface-subtle text-fg-secondary hover:bg-surface-hover border-surface-border'
            }`}
          >
            Watch Tier &gt;10%
          </button>
        </div>
      </div>

      {/* Exposure Table */}
      <div className="overflow-x-auto max-h-96 border border-surface-border rounded-lg">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 bg-surface-subtle border-b border-surface-border">
            <tr className="font-mono uppercase text-[10px] text-fg-muted">
              <th className="py-2.5 px-3 cursor-pointer hover:text-fg-primary" onClick={() => handleSort('city')}>
                <div className="flex items-center gap-1">
                  <span>City</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th className="py-2.5 px-3 text-right">Stations</th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary"
                onClick={() => handleSort('population_5km_union')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>5km Pop</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary"
                onClick={() => handleSort('already_poor_share_pct')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>Already Poor %</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary"
                onClick={() => handleSort('mean_daily_expected_exposed')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>Mean Daily Exposed</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary text-slate-700 dark:text-slate-300"
                onClick={() => handleSort('nominal_pct')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>Nominal (&lt;0.05)</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary text-amber-700 dark:text-amber-300"
                onClick={() => handleSort('watch_pct')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>Watch (0.05–0.22)</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary text-orange-700 dark:text-orange-300"
                onClick={() => handleSort('elevated_pct')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>Elevated (0.22–0.50)</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
              <th
                className="py-2.5 px-3 text-right cursor-pointer hover:text-fg-primary text-rose-700 dark:text-rose-300"
                onClick={() => handleSort('high_pct')}
              >
                <div className="flex items-center justify-end gap-1">
                  <span>High (≥0.50)</span>
                  <ArrowUpDown className="w-3 h-3" />
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {sortedCities.map((c) => {
              const nomShare = (c.mean_monitor_share_by_tier?.Nominal ?? 0) * 100;
              const watchShare = (c.mean_monitor_share_by_tier?.Watch ?? 0) * 100;
              const eleShare = (c.mean_monitor_share_by_tier?.Elevated ?? 0) * 100;
              const highShare = (c.mean_monitor_share_by_tier?.High ?? 0) * 100;

              return (
                <tr key={c.city} className="hover:bg-surface-subtle/50 transition-colors">
                  <td className="py-2 px-3 font-semibold text-fg-primary">
                    <div className="flex items-center gap-1.5">
                      <span>{c.city}</span>
                      {c.is_shared_city_point && (
                        <span
                          title={`Shares identical coordinates with ${c.shared_coordinates_with?.join(', ')}`}
                          className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-600/30 text-[9px] font-mono"
                        >
                          Shared Coord
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-fg-muted">{c.stations_count}</td>
                  <td className="py-2 px-3 text-right font-mono font-medium text-fg-primary">
                    {(((c.population_5km_union ?? c.population_within_5km_of_monitors ?? 0)) / 1_000_000).toFixed(2)}M
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-fg-muted">
                    {(c.already_poor_share_pct ?? 0).toFixed(1)}%
                  </td>
                  <td className="py-2 px-3 text-right font-mono font-semibold text-brand-600 dark:text-brand-400">
                    {c.mean_daily_expected_exposed.toLocaleString()}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                    {nomShare.toFixed(1)}%
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-amber-700 dark:text-amber-400 font-medium">
                    {watchShare.toFixed(1)}%
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-orange-700 dark:text-orange-400 font-medium">
                    {eleShare.toFixed(1)}%
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-rose-700 dark:text-rose-400 font-semibold">
                    {highShare.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Informative Legend & Operational Rules Callout */}
      <div className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border text-xs space-y-2">
        <div className="flex items-center gap-1.5 text-fg-primary font-semibold">
          <Info className="w-4 h-4 text-brand-500" />
          <span>Operational Risk Tier Architecture (Phase 2f Approved Consistency Standard)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-[11px] pt-1">
          <div className="p-2 rounded bg-surface-card border border-surface-border">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/30 mb-1">
              Nominal: p &lt; 0.05
            </span>
            <p className="text-fg-secondary">
              <strong>Routine Baseline Monitoring</strong>: Station stays below alert threshold. No active warning issued.
            </p>
          </div>
          <div className="p-2 rounded bg-surface-card border border-surface-border">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-600/40 mb-1">
              Watch: 0.05 ≤ p &lt; 0.22
            </span>
            <p className="text-fg-secondary">
              <strong>Advisory Alert</strong>: Selected operational threshold (84.2% sensitivity). Early public health warning.
            </p>
          </div>
          <div className="p-2 rounded bg-surface-card border border-surface-border">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-500/10 text-orange-800 dark:text-orange-300 border border-orange-600/40 mb-1">
              Elevated: 0.22 ≤ p &lt; 0.50
            </span>
            <p className="text-fg-secondary">
              <strong>Actionable Alert</strong>: Balanced operational point (30.9% precision, F₁=0.400). Targeted mitigation.
            </p>
          </div>
          <div className="p-2 rounded bg-surface-card border border-surface-border">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-800 dark:text-rose-300 border border-rose-600/40 mb-1">
              High: p ≥ 0.50
            </span>
            <p className="text-fg-secondary">
              <strong>Emergency Alert</strong>: Majority likelihood of acute crossing. Priority emergency response.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
