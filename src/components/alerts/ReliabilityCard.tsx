import React, { useState } from 'react';
import { Target, Info, Table as TableIcon, LineChart } from 'lucide-react';
import type { AlertMeta, ReliabilityBin } from '../../types/alert';

interface ReliabilityCardProps {
  meta: AlertMeta;
}

export const ReliabilityCard: React.FC<ReliabilityCardProps> = ({ meta }) => {
  const [selectedCohort, setSelectedCohort] = useState<'all_rows' | 'any_fire_100km'>('all_rows');
  const [showTable, setShowTable] = useState<boolean>(false);

  const bins: ReliabilityBin[] = meta.reliability_diagram[selectedCohort] ?? [];
  const calibrationInfo = meta.probability_calibration;

  // Compute overshoot for rows fine today from JSON
  const topBin = bins[bins.length - 1];
  const maxOvershootBin = (() => {
    let maxDiff = -1;
    let target = bins[0];
    for (const b of bins) {
      if (b.n_eligible_fresh >= 30) {
        const diff = b.mean_risk_score - b.observed_frequency_fresh_crossing;
        if (diff > maxDiff) {
          maxDiff = diff;
          target = b;
        }
      }
    }
    return target;
  })();

  const overshootCaption = (() => {
    if (!maxOvershootBin) return 'Reliability metrics unavailable.';
    return (
      `For observations where air quality is currently fine (PM2.5 ≤ 90 µg/m³), the model's risk score overshoots ` +
      `observed crossing rates in upper score bins. Specifically, in bin [${maxOvershootBin.bin_range[0].toFixed(1)}, ${maxOvershootBin.bin_range[1].toFixed(1)}], ` +
      `the mean risk score is ${maxOvershootBin.mean_risk_score.toFixed(2)}, but the observed fresh-crossing frequency is only ` +
      `${maxOvershootBin.observed_frequency_fresh_crossing.toFixed(2)} (n=${maxOvershootBin.n_eligible_fresh} eligible days). ` +
      (topBin && topBin.n_eligible_fresh < 30
        ? `In the highest bin [0.9, 1.0], only ${topBin.n_eligible_fresh} eligible days occurred, leading to sparse estimation.`
        : '')
    );
  })();

  // SVG Chart Dimensions
  const width = 600;
  const height = 300;
  const padding = { top: 25, right: 30, bottom: 40, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const getX = (val: number) => padding.left + val * chartW;
  const getY = (val: number) => padding.top + chartH - val * chartH;

  // Build series paths
  const overallPath = bins
    .map((b, i) => `${i === 0 ? 'M' : 'L'} ${getX(b.mean_risk_score).toFixed(1)} ${getY(b.observed_frequency_overall).toFixed(1)}`)
    .join(' ');

  const freshPath = bins
    .filter((b) => b.n_eligible_fresh >= 30)
    .map((b, i) => `${i === 0 ? 'M' : 'L'} ${getX(b.mean_risk_score).toFixed(1)} ${getY(b.observed_frequency_fresh_crossing).toFixed(1)}`)
    .join(' ');

  return (
    <section
      aria-labelledby="reliability-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-5"
    >
      {/* Title & Cohort Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-brand-500" aria-hidden="true" />
            <h2 id="reliability-heading" className="text-base sm:text-lg font-bold text-fg-primary">
              Reliability Diagram &amp; Score Calibration
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary">
            Assessing alignment between predicted risk scores and actual observed frequencies across 10 decile bins.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Cohort Selector */}
          <div className="flex items-center p-0.5 rounded-lg bg-surface-subtle border border-surface-border text-xs">
            <button
              type="button"
              onClick={() => setSelectedCohort('all_rows')}
              className={`px-3 py-1 rounded-md transition-colors cursor-pointer font-medium ${
                selectedCohort === 'all_rows'
                  ? 'bg-surface-card text-fg-primary shadow-xs'
                  : 'text-fg-muted hover:text-fg-primary'
              }`}
            >
              All Rows
            </button>
            <button
              type="button"
              onClick={() => setSelectedCohort('any_fire_100km')}
              className={`px-3 py-1 rounded-md transition-colors cursor-pointer font-medium ${
                selectedCohort === 'any_fire_100km'
                  ? 'bg-surface-card text-fg-primary shadow-xs'
                  : 'text-fg-muted hover:text-fg-primary'
              }`}
            >
              Any Fire (100km)
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowTable(!showTable)}
            aria-pressed={showTable}
            className="px-3 py-1 rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover text-xs font-medium text-fg-secondary flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {showTable ? <LineChart className="w-3.5 h-3.5 text-brand-500" /> : <TableIcon className="w-3.5 h-3.5 text-brand-500" />}
            <span>{showTable ? 'Show Chart' : 'Show Table'}</span>
          </button>
        </div>
      </div>

      {/* Explanatory Callout on Risk Score Nature & Overshoot */}
      <div className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border space-y-2 text-xs sm:text-sm text-fg-primary leading-relaxed">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <strong>Calibration Reality:</strong> {overshootCaption}
          </p>
        </div>
        <div className="pl-6 text-xs text-fg-secondary">
          <strong>Statistical Derivation:</strong> The model output is a <em>risk score</em> rescaled from continuous regression residual dispersion (formula: <code className="font-mono text-fg-primary">{calibrationInfo.formula}</code> using validation residual sigma = <code className="font-mono text-fg-primary">{calibrationInfo.params.sigma.toFixed(2)}</code>). It represents an operational ranking metric, not an empirical likelihood or physical frequency.
        </div>
      </div>

      {/* SVG Diagram or Data Table */}
      {!showTable ? (
        <div className="p-3 bg-surface-subtle border border-surface-border rounded-lg space-y-2">
          <div className="flex items-center justify-between text-xs text-fg-muted px-1">
            <span className="font-mono">10-Bin Reliability Diagram</span>
            <span className="text-[11px]">Diagonal: perfect calibration | Hatched/Greyed: &lt; 30 eligible days</span>
          </div>

          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto select-none font-mono text-[10px]"
            aria-label="Reliability Diagram plotting mean risk score against observed frequencies"
          >
            {/* Grid Lines */}
            {[0.0, 0.2, 0.4, 0.6, 0.8, 1.0].map((v) => {
              const y = getY(v);
              const x = getX(v);
              return (
                <g key={v}>
                  <line
                    x1={padding.left}
                    x2={padding.left + chartW}
                    y1={y}
                    y2={y}
                    stroke="var(--border-subtle)"
                    strokeWidth={0.8}
                  />
                  <line
                    x1={x}
                    x2={x}
                    y1={padding.top}
                    y2={padding.top + chartH}
                    stroke="var(--border-subtle)"
                    strokeWidth={0.8}
                  />
                  <text
                    x={padding.left - 8}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--text-muted)"
                    fontSize="9"
                  >
                    {v.toFixed(1)}
                  </text>
                  <text
                    x={x}
                    y={padding.top + chartH + 18}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize="9"
                  >
                    {v.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* Perfect Calibration Reference Line (45 degree diagonal) */}
            <line
              x1={padding.left}
              y1={padding.top + chartH}
              x2={padding.left + chartW}
              y2={padding.top}
              stroke="var(--text-muted)"
              strokeDasharray="4 3"
              strokeWidth={1.5}
            />

            {/* Greyed-out background bands for sparse bins (< 30 eligible days) */}
            {bins.map((b, i) => {
              if (b.n_eligible_fresh < 30) {
                const xStart = getX(b.bin_range[0]);
                const xEnd = getX(b.bin_range[1]);
                return (
                  <rect
                    key={i}
                    x={xStart}
                    y={padding.top}
                    width={xEnd - xStart}
                    height={chartH}
                    fill="var(--surface-selected)"
                    opacity={0.35}
                  />
                );
              }
              return null;
            })}

            {/* Overall Observed Frequency Series */}
            <path
              d={overallPath}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={1.8}
              strokeDasharray="3 2"
            />

            {/* Fresh Crossing Observed Frequency Series */}
            <path
              d={freshPath}
              fill="none"
              stroke="var(--brand-500)"
              strokeWidth={2.4}
            />

            {/* Data Points */}
            {bins.map((b, i) => {
              const isSparse = b.n_eligible_fresh < 30;
              const cx = getX(b.mean_risk_score);
              const cyOverall = getY(b.observed_frequency_overall);
              const cyFresh = getY(b.observed_frequency_fresh_crossing);

              return (
                <g key={i}>
                  {/* Overall Point */}
                  <circle
                    cx={cx}
                    cy={cyOverall}
                    r={3}
                    fill="var(--text-muted)"
                  />

                  {/* Fresh Crossing Point */}
                  <circle
                    cx={cx}
                    cy={cyFresh}
                    r={isSparse ? 3.5 : 5}
                    fill={isSparse ? 'var(--text-muted)' : 'var(--brand-500)'}
                    stroke="var(--surface-card)"
                    strokeWidth={1.5}
                  />
                </g>
              );
            })}

            {/* Axis Labels */}
            <text
              x={padding.left + chartW / 2}
              y={height - 5}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              fontWeight="bold"
            >
              Mean Risk Score (Predicted)
            </text>
            <text
              transform="rotate(-90)"
              x={-(padding.top + chartH / 2)}
              y={14}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              fontWeight="bold"
            >
              Observed Frequency
            </text>
          </svg>

          {/* Legend */}
          <div className="flex flex-wrap items-center justify-center gap-6 pt-1 text-xs text-fg-secondary">
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 bg-brand-500 block" />
              <span>Fresh Crossing Observed Frequency</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 border-t border-dashed border-fg-muted block" />
              <span>Overall Poor Tomorrow Frequency</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 border-t border-dashed border-fg-muted block" />
              <span>Perfect Calibration (45°)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 bg-surface-selected opacity-50 block border border-surface-border" />
              <span>Greyed: Sparse Bins (&lt; 30 eligible days)</span>
            </div>
          </div>
        </div>
      ) : (
        /* Accessible Table of Reliability Bins */
        <div className="overflow-x-auto max-h-80 border border-surface-border rounded-lg">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 bg-surface-subtle border-b border-surface-border font-mono uppercase text-[10px] text-fg-muted">
              <tr>
                <th className="py-2 px-3">Bin Range</th>
                <th className="py-2 px-3 text-right">Mean Score</th>
                <th className="py-2 px-3 text-right">Observed (Overall)</th>
                <th className="py-2 px-3 text-right">Eligible Days (Fresh)</th>
                <th className="py-2 px-3 text-right">Observed (Fresh Crossing)</th>
                <th className="py-2 px-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {bins.map((b, i) => (
                <tr key={i} className="hover:bg-surface-subtle/50 font-mono">
                  <td className="py-1.5 px-3">[{b.bin_range[0].toFixed(1)}, {b.bin_range[1].toFixed(1)}]</td>
                  <td className="py-1.5 px-3 text-right">{b.mean_risk_score.toFixed(3)}</td>
                  <td className="py-1.5 px-3 text-right text-fg-muted">{b.observed_frequency_overall.toFixed(3)}</td>
                  <td className="py-1.5 px-3 text-right">{b.n_eligible_fresh.toLocaleString()}</td>
                  <td className="py-1.5 px-3 text-right font-semibold text-brand-600 dark:text-brand-400">
                    {b.observed_frequency_fresh_crossing.toFixed(3)}
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    {b.n_eligible_fresh < 30 ? (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-sans">
                        sparse (&lt;30)
                      </span>
                    ) : (
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-sans">
                        adequate
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
