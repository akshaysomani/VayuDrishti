import React, { useState, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Flip } from 'gsap/Flip';
import {
  Layers,
  Search,
  AlertTriangle,
  Info,
  ChevronRight,
  ShieldAlert,
  Building2,
} from 'lucide-react';
import type { CoverageThreshold, City, GapCity, DashboardMeta } from '../types/dashboard';

gsap.registerPlugin(useGSAP, Flip);

interface CoverageRightPanelProps {
  thresholds: CoverageThreshold[];
  selectedKm: number;
  onSelectKm: (km: number) => void;
  unmonitoredCities: City[];
  gapCities: GapCity[];
  onSelectCity: (city: City | GapCity) => void;
  meta?: DashboardMeta | null;
}

export const CoverageRightPanel: React.FC<CoverageRightPanelProps> = ({
  thresholds,
  selectedKm,
  onSelectKm,
  unmonitoredCities,
  gapCities,
  onSelectCity,
  meta,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'distance' | 'population'>('distance');
  const panelRef = useRef<HTMLDivElement>(null);
  const percentNumberRef = useRef<HTMLSpanElement>(null);
  const peopleNumberRef = useRef<HTMLSpanElement>(null);
  const cityListRef = useRef<HTMLDivElement>(null);

  const currentThreshold = thresholds.find((t) => t.within_km === selectedKm);

  // GSAP Count-up animation on threshold change
  useGSAP(
    () => {
      if (!currentThreshold) return;

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (percentNumberRef.current) {
          percentNumberRef.current.innerText = `${currentThreshold.share_pct}%`;
        }
        if (peopleNumberRef.current) {
          peopleNumberRef.current.innerText = `${currentThreshold.people_m}M`;
        }
        return;
      }

      const proxy = { pct: 0, people: 0 };
      gsap.to(proxy, {
        pct: currentThreshold.share_pct,
        people: currentThreshold.people_m,
        duration: 0.6,
        ease: 'power2.out',
        onUpdate: () => {
          if (percentNumberRef.current) {
            percentNumberRef.current.innerText = `${proxy.pct.toFixed(1)}%`;
          }
          if (peopleNumberRef.current) {
            peopleNumberRef.current.innerText = `${proxy.people.toFixed(1)}M`;
          }
        },
      });
    },
    { dependencies: [selectedKm, currentThreshold], scope: panelRef }
  );

  // Filter and sort cities
  const filteredCities = unmonitoredCities
    .filter((c) => {
      const q = searchTerm.toLowerCase();
      return (
        c.city.toLowerCase().includes(q) ||
        c.state.toLowerCase().includes(q) ||
        c.nearest_working_city.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sortBy === 'distance') {
        return b.nearest_working_km - a.nearest_working_km;
      }
      return b.pop10km - a.pop10km;
    });

  // Handle Sort toggle with GSAP Flip animation
  const handleSortChange = (newSort: 'distance' | 'population') => {
    if (newSort === sortBy) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSortBy(newSort);
      return;
    }

    const state = Flip.getState('.city-card-item');
    setSortBy(newSort);

    requestAnimationFrame(() => {
      Flip.from(state, {
        duration: 0.4,
        ease: 'power2.out',
        stagger: 0.02,
      });
    });
  };

  const neverRegisteredGaps = gapCities.filter((g) => g.type === 'never_registered');
  const silentGaps = gapCities.filter((g) => g.type === 'registered_silent');

  return (
    <aside
      ref={panelRef}
      className="w-full lg:w-96 xl:w-[420px] bg-surface-card border-l border-surface-border flex flex-col h-full overflow-hidden text-fg-primary shadow-elevation1"
      aria-label="Coverage metrics and unmonitored cities panel"
    >
      {/* 1. TOP HEADER & THRESHOLD SELECTOR */}
      <div className="p-4 sm:p-5 border-b border-surface-border space-y-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand-500" />
            <h3 className="text-sm font-bold tracking-tight text-fg-primary uppercase">
              Distance-to-Monitor Threshold
            </h3>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-surface-subtle border border-surface-border text-fg-secondary">
            Baseline: {meta?.india_population_m ? `${meta.india_population_m}M` : 'Data unavailable'}
          </span>
        </div>

        {/* Segmented Control */}
        <div
          role="radiogroup"
          aria-label="Distance threshold in kilometers"
          className="grid grid-cols-5 gap-1 p-1 bg-surface-subtle rounded-lg border border-surface-border"
        >
          {thresholds.map((t) => {
            const isSelected = t.within_km === selectedKm;
            return (
              <button
                key={t.within_km}
                role="radio"
                aria-checked={isSelected}
                onClick={() => onSelectKm(t.within_km)}
                className={`py-2 text-xs font-mono font-medium rounded-md transition-all text-center cursor-pointer min-h-[38px] flex items-center justify-center ${
                  isSelected
                    ? 'bg-brand-500 text-white font-bold shadow-elevation1'
                    : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-hover'
                }`}
              >
                {t.within_km}km
              </button>
            );
          })}
        </div>

        {/* Dynamic Metric Display with Running Total */}
        <div className="p-3.5 rounded-xl bg-surface-subtle/80 border border-surface-border flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-fg-muted font-medium">
              Population Within {selectedKm} km
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                ref={percentNumberRef}
                className="text-2xl font-bold font-mono text-brand-600 dark:text-brand-500 tracking-tight"
              >
                {currentThreshold ? `${currentThreshold.share_pct}%` : 'Data unavailable'}
              </span>
              <span className="text-xs text-fg-muted font-mono">
                {currentThreshold && meta?.india_population_m ? (
                  <>
                    (<span ref={peopleNumberRef}>{currentThreshold.people_m}M</span> of {meta.india_population_m}M)
                  </>
                ) : (
                  <span>(Data unavailable)</span>
                )}
              </span>
            </div>
          </div>

          {/* Running Progress Bar */}
          <div className="w-28 space-y-1">
            <div className="flex justify-between text-[10px] font-mono text-fg-muted">
              <span>Coverage</span>
              <span>{currentThreshold ? `${currentThreshold.share_pct}%` : '—'}</span>
            </div>
            <div className="w-full h-2 rounded-full bg-surface-card border border-surface-border overflow-hidden">
              <div
                className="h-full bg-brand-500 rounded-full transition-all duration-relaxed"
                style={{ width: `${Math.min(100, currentThreshold?.share_pct ?? 0)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 2. SCROLLABLE CONTENT BODY */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
        {/* Two-Tier Gap Explanation */}
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-fg-primary">
            <Info className="w-3.5 h-3.5 text-brand-500" />
            Two-Tier Gap Classification
          </div>

          <div className="grid grid-cols-1 gap-2.5 text-xs">
            {/* Tier 1: Not Listed */}
            <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-amber-800 dark:text-amber-300">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                  Tier 1: Not Listed in This Dataset
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-200/50 dark:bg-amber-900/50">
                  {neverRegisteredGaps.length} Metropolitan Cities
                </span>
              </div>
              <p className="text-[11px] text-amber-900/80 dark:text-amber-200/80 leading-relaxed">
                No station listed in this dataset.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {neverRegisteredGaps.map((city) => (
                  <button
                    key={city.city}
                    onClick={() => onSelectCity(city)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors cursor-pointer"
                  >
                    <span>{city.city}</span>
                    <span className="text-fg-muted">({city.approx_pop_m}M)</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Tier 2: No Usable Data in this Dataset */}
            <div className="p-3 rounded-lg border border-slate-400/40 bg-slate-100/60 dark:bg-slate-800/40 space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-fg-primary">
                <span className="flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-slate-500" />
                  Tier 2: No Usable Data in this Dataset
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-card border border-surface-border text-fg-secondary">
                  {silentGaps.length} Listed Cities
                </span>
              </div>
              <p className="text-[11px] text-fg-secondary leading-relaxed">
                Listed in this dataset, but no usable data.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {silentGaps.map((city) => (
                  <button
                    key={city.city}
                    onClick={() => onSelectCity(city)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-white dark:bg-slate-900 border border-surface-border hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    <span>{city.city}</span>
                    <span className="text-fg-muted">({city.approx_pop_m}M)</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 3. LIST OF LARGEST CITIES WITH NO WORKING STATION */}
        <div className="space-y-3 pt-2 border-t border-surface-border">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-fg-primary flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-brand-500" />
                Cities with No Working Station ({filteredCities.length})
              </h4>
              <p className="text-[11px] text-fg-muted">
                From cities dataset with <code>city_status = "no_working_station"</code>
              </p>
            </div>

            {/* Sort Toggle */}
            <div className="flex items-center gap-1 text-[11px] font-mono bg-surface-subtle p-0.5 rounded border border-surface-border">
              <button
                onClick={() => handleSortChange('distance')}
                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                  sortBy === 'distance'
                    ? 'bg-brand-500 text-white font-semibold'
                    : 'text-fg-muted hover:text-fg-primary'
                }`}
                title="Sort by distance to nearest working city"
              >
                Dist
              </button>
              <button
                onClick={() => handleSortChange('population')}
                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                  sortBy === 'population'
                    ? 'bg-brand-500 text-white font-semibold'
                    : 'text-fg-muted hover:text-fg-primary'
                }`}
                title="Sort by population in 10 km buffer"
              >
                Pop
              </button>
            </div>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-fg-muted absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search unmonitored city or state..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-subtle border border-surface-border text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-brand-500 transition-colors"
              aria-label="Filter unmonitored cities by name or state"
            />
          </div>

          {/* City Cards List */}
          <div ref={cityListRef} className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
            {filteredCities.map((city) => (
              <div
                key={city.city}
                onClick={() => onSelectCity(city)}
                className="city-card-item p-2.5 rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover hover:border-brand-500/50 transition-all cursor-pointer group"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectCity(city);
                  }
                }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold text-xs text-fg-primary group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors flex items-center gap-1.5">
                      <span>{city.city}</span>
                      <span className="text-[10px] text-fg-muted font-normal">({city.state})</span>
                    </div>
                    <div className="text-[11px] text-fg-muted mt-0.5">
                      Pop in 10 km: <strong className="text-fg-secondary">{(city.pop10km / 1000000).toFixed(2)}M</strong>
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0">
                    <span className="inline-block font-mono text-xs font-bold text-slate-700 dark:text-slate-300">
                      {city.nearest_working_km} km
                    </span>
                    <div className="text-[10px] text-fg-muted">
                      to {city.nearest_working_city}
                    </div>
                  </div>
                </div>

                <div className="mt-2 pt-1.5 border-t border-surface-border/60 flex items-center justify-between text-[10px] text-fg-muted">
                  <span className="inline-flex items-center gap-1 font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                    No usable data in this dataset
                  </span>
                  <ChevronRight className="w-3 h-3 text-fg-muted group-hover:text-fg-primary group-hover:translate-x-0.5 transition-transform" />
                </div>
              </div>
            ))}

            {filteredCities.length === 0 && (
              <div className="p-4 text-center text-xs text-fg-muted bg-surface-subtle rounded-lg border border-surface-border">
                No unmonitored cities matching "{searchTerm}".
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. MANDATORY INFO FOOTER */}
      <footer className="p-3.5 border-t border-surface-border bg-surface-subtle/70 text-[11px] text-fg-muted flex-shrink-0 leading-relaxed">
        <p>
          Coordinates are city-level geocodes, population is WorldPop 2017, data covers 2015-01 to 2020-07 and is historical, not live.
        </p>
      </footer>
    </aside>
  );
};
