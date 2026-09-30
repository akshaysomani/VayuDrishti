import React from 'react';
import {
  TrendingDown,
  ArrowUpRight,
  Minus,
  ArrowDownRight,
} from 'lucide-react';
import type { SegmentData } from '../../types/alert';

interface ForecastErrorCardProps {
  segments: Record<string, SegmentData>;
}

export const ForecastErrorCard: React.FC<ForecastErrorCardProps> = ({ segments }) => {
  const segmentKeys = [
    'all_rows',
    'no_fire_100km',
    'any_fire_100km',
    'upwind_fire_100km',
    'top10_upwind_intensity',
    'top10_upwind_intensity_all_rows',
  ];

  return (
    <section aria-labelledby="forecast-error-heading" className="space-y-6">
      {/* 1. Main Forecast Error Card (Continuous MAE) */}
      <div className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-brand-500" aria-hidden="true" />
            <h2 id="forecast-error-heading" className="text-base sm:text-lg font-bold text-fg-primary">
              Legacy continuous PM2.5 forecast (LightGBM regressor)
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary">
            Mean Absolute Error (MAE in µg/m³) evaluated on next-day PM2.5 forecasts against the persistence benchmark
            (&ldquo;tomorrow = today&rdquo;). Evaluated across meteorological and fire segments.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-surface-border text-fg-muted font-mono uppercase text-[11px] bg-surface-subtle/50">
                <th scope="col" className="py-2.5 px-3">Segment</th>
                <th scope="col" className="py-2.5 px-3 text-right">Rows (n)</th>
                <th scope="col" className="py-2.5 px-3 text-right">Persistence MAE</th>
                <th scope="col" className="py-2.5 px-3 text-right">Model MAE</th>
                <th scope="col" className="py-2.5 px-3 text-right">Improvement %</th>
                <th scope="col" className="py-2.5 px-3">95% Date CI &amp; Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {segmentKeys.map((key) => {
                const seg = segments[key];
                if (!seg) return null;

                const ci = seg.improvement_ci_95_date;

                // CI entirely above 0 = "gain"; includes 0 = "no gain"; entirely below 0 = "worse than persistence"
                let statusLabel = 'no gain';
                let badgeClass = 'bg-surface-subtle text-fg-secondary border-surface-border';
                let IconComponent = Minus;

                if (ci[0] > 0 && ci[1] > 0) {
                  statusLabel = 'gain';
                  badgeClass = 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
                  IconComponent = ArrowUpRight;
                } else if (ci[0] < 0 && ci[1] < 0) {
                  statusLabel = 'worse than persistence';
                  badgeClass = 'bg-rose-500/10 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border-rose-500/30';
                  IconComponent = ArrowDownRight;
                }

                return (
                  <tr key={key} className="hover:bg-surface-subtle/40 transition-colors">
                    <td className="py-3 px-3">
                      <div className="font-semibold text-fg-primary text-xs capitalize">
                        {key.replace(/_/g, ' ')}
                      </div>
                      <div className="text-[11px] text-fg-muted max-w-sm mt-0.5 leading-snug">
                        {seg.definition}
                      </div>
                      {seg.denominator && (
                        <div className="text-[10px] text-fg-muted font-mono mt-0.5">
                          Denominator: {seg.denominator}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-fg-primary">
                      {seg.n.toLocaleString()}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-fg-secondary">
                      {seg.persistence_mae.toFixed(1)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-fg-primary font-semibold">
                      {seg.model_mae.toFixed(1)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono">
                      <span className={seg.improvement_pct > 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-fg-secondary'}>
                        {seg.improvement_pct >= 0 ? '+' : ''}{seg.improvement_pct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${badgeClass}`}
                        >
                          <IconComponent className="w-3 h-3" aria-hidden="true" />
                          <span>{statusLabel}</span>
                        </span>
                        <span className="text-[10px] text-fg-muted font-mono">
                          [{ci[0].toFixed(1)}%, {ci[1].toFixed(1)}%] by date
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* COVID Lockdown Window Note */}
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary leading-relaxed">
          <strong>Evaluation Window Context:</strong> The 12-month test window (Jul 2019 – Jun 2020) includes the nationwide COVID-19 lockdown (Mar – Jun 2020), during which acute pollution events dropped by over 58% across Indian monitoring networks.
        </div>
      </div>
    </section>
  );
};

