import React, { useState } from 'react';
import { Info, ChevronRight, X, Layers } from 'lucide-react';
import { getHeadlineCoverageStat, getCoverageThresholds, getMeta } from '../data/loader';
import type { CoverageThreshold, DashboardMeta } from '../types/dashboard';

interface CoverageBannerProps {
  className?: string;
  onExploreCoverage?: () => void;
}

export const CoverageBanner: React.FC<CoverageBannerProps> = ({ className = '', onExploreCoverage }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [showThresholdDetails, setShowThresholdDetails] = useState(false);

  const headline = getHeadlineCoverageStat();
  const [thresholds, setThresholds] = useState<CoverageThreshold[]>([]);
  const [meta, setMeta] = useState<DashboardMeta | null>(null);

  React.useEffect(() => {
    getCoverageThresholds().then(setThresholds);
    getMeta().then(setMeta);
  }, []);

  if (!isOpen) {
    return (
      <div className="bg-surface-subtle border-b border-surface-border px-4 py-1.5 flex items-center justify-between text-xs text-fg-muted">
        <span className="flex items-center gap-1.5 font-medium">
          <Info className="w-3.5 h-3.5 text-brand-500" aria-hidden="true" />
          Coverage baseline: 4.8% within 10 km of a monitoring station in this dataset
        </span>
        <button
          onClick={() => setIsOpen(true)}
          className="text-brand-600 hover:text-brand-700 dark:text-brand-500 underline font-medium cursor-pointer focus-visible:ring-1"
          aria-label="Expand headline coverage banner"
        >
          Show details
        </button>
      </div>
    );
  }

  return (
    <section
      role="region"
      aria-label="National monitoring coverage announcement"
      className={`relative bg-brand-50/70 dark:bg-slate-900/90 border-b border-brand-500/20 dark:border-brand-500/30 transition-colors duration-fast ${className}`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 sm:py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
        {/* Headline Stat & Context */}
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <div className="p-1.5 rounded-md bg-brand-500/10 text-brand-600 dark:text-brand-500 flex-shrink-0 mt-0.5 sm:mt-0">
            <Layers className="w-4 h-4" aria-hidden="true" />
          </div>

          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold text-fg-primary text-[13px] sm:text-sm tracking-tight">
              {headline.statText}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 self-end md:self-auto flex-shrink-0">
          <button
            onClick={() => setShowThresholdDetails(!showThresholdDetails)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-surface-card hover:bg-surface-hover border border-surface-border text-fg-primary shadow-elevation1 transition-colors cursor-pointer"
            aria-expanded={showThresholdDetails}
            aria-controls="coverage-thresholds-panel"
          >
            <span>{showThresholdDetails ? 'Hide thresholds' : 'View 10km to 200km'}</span>
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform duration-fast ${
                showThresholdDetails ? 'rotate-90' : ''
              }`}
            />
          </button>

          {onExploreCoverage && (
            <button
              onClick={onExploreCoverage}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md bg-brand-500 hover:bg-brand-600 text-white shadow-elevation1 transition-colors cursor-pointer"
            >
              Explore Map
            </button>
          )}

          <button
            onClick={() => setIsOpen(false)}
            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-fg-muted hover:text-fg-primary cursor-pointer transition-colors"
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Expanded Thresholds Popover Panel */}
      {showThresholdDetails && (
        <div
          id="coverage-thresholds-panel"
          className="border-t border-brand-500/15 bg-surface-card px-4 sm:px-6 py-3.5 animate-fadeIn"
        >
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 mb-3 border-b border-surface-border gap-2">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-fg-primary">
                  Distance-to-Monitor Population Coverage Gradients
                </h4>
                <p className="text-[12px] text-fg-muted">
                  Cumulative share of Indian population living within designated radius of at least one monitoring station in this dataset.
                </p>
              </div>
              <span className="text-[11px] text-fg-muted font-mono bg-surface-subtle px-2 py-1 rounded border border-surface-border">
                Baseline: {meta?.population_source ?? 'WorldPop 2017 1km UN-adjusted'}
              </span>
            </div>

            {/* Threshold Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              {thresholds.map((t) => {
                const isSelected = t.within_km === 10;
                return (
                  <div
                    key={t.within_km}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-brand-500 bg-brand-subtle ring-1 ring-brand-500/30'
                        : 'border-surface-border bg-surface-subtle/50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-[11px] font-mono font-medium text-fg-muted">
                        ≤ {t.within_km} km
                      </span>
                      {isSelected && (
                        <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.2 rounded bg-brand-500 text-white">
                          Headline
                        </span>
                      )}
                    </div>
                    <div className="text-xl font-bold font-mono tracking-tight text-fg-primary">
                      {t.share_pct}%
                    </div>
                    <div className="text-[11px] text-fg-secondary mt-0.5">
                      {t.people_m} million people
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Methodological Facts (Strict factual disclosure) */}
            <div className="mt-3 flex items-start gap-2 text-[11px] text-fg-muted bg-surface-subtle p-2.5 rounded border border-surface-border">
              <Info className="w-3.5 h-3.5 text-brand-500 flex-shrink-0 mt-0.5" />
              <span>
                Station coordinates are city-level geocodes, population is WorldPop 2017 (1 km), data covers 2015-01-01 to 2020-07-01 and is historical, and the station set is the CPCB extract in this dataset, not the current live network.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
