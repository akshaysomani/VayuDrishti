import React, { useState, useMemo } from 'react';
import { Sliders, Table as TableIcon, LineChart } from 'lucide-react';
import type {
  OperatingPointDef,
  SegmentData,
  PrCurveSegment,
} from '../../types/alert';

interface OperatingPointCardProps {
  operatingPoints: {
    balanced: OperatingPointDef;
    high_recall: OperatingPointDef;
    high_precision: OperatingPointDef;
  };
  selectedOpKey: 'balanced' | 'high_recall' | 'high_precision';
  onSelectOpKey: (key: 'balanced' | 'high_recall' | 'high_precision') => void;
  segments: Record<string, SegmentData>;
  prCurves: Record<string, PrCurveSegment>;
}

export const OperatingPointCard: React.FC<OperatingPointCardProps> = ({
  operatingPoints,
  selectedOpKey,
  onSelectOpKey,
  segments,
  prCurves,
}) => {
  // Selectable meteorological and fire segments for interactive PR curve
  const selectableSegments = useMemo(() => {
    return [
      { key: 'all_rows', label: 'All Rows' },
      { key: 'no_fire_100km', label: 'No Fire (100km)' },
      { key: 'any_fire_100km', label: 'Any Fire (100km)' },
      { key: 'upwind_fire_100km', label: 'Upwind Fire (100km)' },
      { key: 'top10_upwind_intensity', label: 'Top 10% Fire (Positive Days)' },
      { key: 'top10_upwind_intensity_all_rows', label: 'Top 10% Fire (All Rows)' },
    ];
  }, []);

  const [selectedSegKey, setSelectedSegKey] = useState<string>('all_rows');
  const [showTable, setShowTable] = useState<boolean>(false);

  const activeOp = operatingPoints[selectedOpKey];
  const activeSegment = segments[selectedSegKey];
  const activePrCurve = prCurves[selectedSegKey];

  // Match the selected operating point threshold against the segment's PR curve points
  const matchedModelPoint = useMemo(() => {
    if (!activePrCurve?.model || activePrCurve.model.length === 0) return null;
    const targetTh = activeOp.threshold;
    let closest = activePrCurve.model[0];
    let minDiff = Math.abs(closest.threshold - targetTh);
    for (const pt of activePrCurve.model) {
      const diff = Math.abs(pt.threshold - targetTh);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }
    return closest;
  }, [activePrCurve, activeOp.threshold]);

  const baseRate = activeSegment
    ? activeSegment.fresh_crossing.event_n / Math.max(1, activeSegment.fresh_crossing.eligible_n)
    : 0.07;

  // Derived metrics
  const recallVal = matchedModelPoint ? matchedModelPoint.recall : 0;
  const precisionVal = matchedModelPoint ? matchedModelPoint.precision : 0;
  const alertsPer100 = matchedModelPoint ? matchedModelPoint.alerts_per_100_days : 0;

  const trueAlertsOutOf100 = Math.round(precisionVal * 100);
  const falseAlertsOutOf100 = 100 - trueAlertsOutOf100;
  const falseAlarmsPerCaught = precisionVal > 0 ? ((1 - precisionVal) / precisionVal).toFixed(1) : '...';

  // SVG PR Curve Dimensions
  const width = 650;
  const height = 300;
  const padding = { top: 25, right: 30, bottom: 40, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const getX = (recallPct: number) => padding.left + (recallPct / 100) * chartW;
  const getY = (prec: number) => padding.top + chartH - prec * chartH;

  // SVG Paths
  const modelCurvePath = useMemo(() => {
    if (!activePrCurve?.model || activePrCurve.model.length === 0) return '';
    const sorted = [...activePrCurve.model].sort((a, b) => a.recall - b.recall);
    return sorted
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(pt.recall).toFixed(1)} ${getY(pt.precision).toFixed(1)}`)
      .join(' ');
  }, [activePrCurve]);

  const baselineCurvePath = useMemo(() => {
    if (!activePrCurve?.baseline || activePrCurve.baseline.length === 0) return '';
    const sorted = [...activePrCurve.baseline].sort((a, b) => a.recall - b.recall);
    return sorted
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(pt.recall).toFixed(1)} ${getY(pt.precision).toFixed(1)}`)
      .join(' ');
  }, [activePrCurve]);

  return (
    <section
      aria-labelledby="operating-points-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-6"
    >
      {/* Title & Controls Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-brand-500" aria-hidden="true" />
            <h2 id="operating-points-heading" className="text-base sm:text-lg font-bold text-fg-primary">
              Decision Thresholds &amp; Precision-Recall Trade-offs
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary">
            Select an operational policy calibrated on pre-2019 validation data to inspect false alarms versus sensitivity.
          </p>
        </div>

        {/* Segment Selector Dropdown */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="pr-segment-picker" className="text-[11px] font-mono text-fg-muted">
              Evaluation Cohort:
            </label>
            <select
              id="pr-segment-picker"
              value={selectedSegKey}
              onChange={(e) => setSelectedSegKey(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-surface-border bg-surface-card text-xs font-mono text-fg-primary focus:outline-hidden focus:ring-2 focus:ring-brand-500 cursor-pointer"
            >
              {selectableSegments.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowTable(!showTable)}
            aria-pressed={showTable}
            className="self-end px-3 py-1.5 rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover text-xs font-medium text-fg-secondary flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {showTable ? <LineChart className="w-3.5 h-3.5 text-brand-500" /> : <TableIcon className="w-3.5 h-3.5 text-brand-500" />}
            <span>{showTable ? 'Show PR Curve' : 'Show Table'}</span>
          </button>
        </div>
      </div>

      {/* Segmented Control for Operating Points */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(['balanced', 'high_recall', 'high_precision'] as const).map((key) => {
          const op = operatingPoints[key];
          const isSelected = selectedOpKey === key;
          const title = key === 'balanced' ? 'Balanced F1' : key === 'high_recall' ? 'High Recall (Health Alert)' : 'High Precision';

          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectOpKey(key)}
              className={`p-3.5 rounded-lg border text-left transition-all cursor-pointer ${
                isSelected
                  ? 'bg-brand-500/10 border-brand-500/40 ring-1 ring-brand-500/30'
                  : 'bg-surface-subtle hover:bg-surface-hover border-surface-border'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-fg-primary">{title}</span>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-card border border-surface-border text-brand-600 dark:text-brand-400 font-semibold">
                  Threshold: {op.threshold.toFixed(2)}
                </span>
              </div>
              <p className="text-[11px] text-fg-muted mt-1 leading-snug">
                {op.meaning}
              </p>
            </button>
          );
        })}
      </div>

      {/* Metrics Strip for Selected Operating Point */}
      <div className="p-4 rounded-lg bg-surface-subtle border border-surface-border space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <span className="text-[11px] font-mono text-fg-muted block">Recall (Sensitivity)</span>
            <span className="text-lg font-mono font-bold text-brand-600 dark:text-brand-400">
              {recallVal.toFixed(1)}%
            </span>
          </div>
          <div>
            <span className="text-[11px] font-mono text-fg-muted block">Precision</span>
            <span className="text-lg font-mono font-bold text-fg-primary">
              {precisionVal.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="text-[11px] font-mono text-fg-muted block">Alerts Rate</span>
            <span className="text-lg font-mono font-bold text-fg-primary">
              {alertsPer100.toFixed(1)} <span className="text-xs font-normal text-fg-muted">per 100 days</span>
            </span>
          </div>
          <div>
            <span className="text-[11px] font-mono text-fg-muted block">Events / Eligible</span>
            <span className="text-sm font-mono font-semibold text-fg-primary mt-1 block">
              {activeSegment ? `${activeSegment.fresh_crossing.event_n.toLocaleString()} of ${activeSegment.fresh_crossing.eligible_n.toLocaleString()}` : '...'}
            </span>
            <span className="text-[10px] text-fg-muted font-mono">
              ({(baseRate * 100).toFixed(1)}% base rate)
            </span>
          </div>
        </div>

        {/* Computed Sentences */}
        <div className="pt-3 border-t border-surface-border text-xs text-fg-primary leading-relaxed space-y-1">
          <p>
            <strong>Operational Impact:</strong> Of 100 alerts issued under this threshold, about{' '}
            <code className="font-mono font-bold text-fg-primary">{trueAlertsOutOf100}</code> are followed by a fresh crossing
            and about <code className="font-mono font-bold text-fg-primary">{falseAlertsOutOf100}</code> are false alarms.
          </p>
          <p className="text-fg-secondary">
            About <code className="font-mono font-semibold text-fg-primary">{falseAlarmsPerCaught}</code> false alarms accompany
            each caught crossing under this operating policy.
          </p>
        </div>
      </div>

      {/* PR Curve SVG Visualization or Data Table */}
      {!showTable ? (
        <div className="p-3 bg-surface-subtle border border-surface-border rounded-lg space-y-2">
          <div className="flex items-center justify-between text-xs text-fg-muted px-1">
            <span className="font-mono">Precision-Recall Curve (2019 Test Set)</span>
            <span className="text-[11px]">Dashed line: random guess base rate ({(baseRate * 100).toFixed(1)}%)</span>
          </div>

          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto select-none font-mono text-[10px]"
            aria-label="Precision-Recall Curve comparing Model against Tuned Persistence baseline"
          >
            {/* Grid Lines */}
            {[0.2, 0.4, 0.6, 0.8, 1.0].map((prec) => {
              const y = getY(prec);
              return (
                <g key={prec}>
                  <line
                    x1={padding.left}
                    x2={padding.left + chartW}
                    y1={y}
                    y2={y}
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
                    {prec.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {[0, 20, 40, 60, 80, 100].map((rec) => {
              const x = getX(rec);
              return (
                <g key={rec}>
                  <line
                    x1={x}
                    x2={x}
                    y1={padding.top}
                    y2={padding.top + chartH}
                    stroke="var(--border-subtle)"
                    strokeWidth={0.8}
                  />
                  <text
                    x={x}
                    y={padding.top + chartH + 18}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize="9"
                  >
                    {rec}%
                  </text>
                </g>
              );
            })}

            {/* Base Rate Horizontal Dashed Line */}
            <line
              x1={padding.left}
              x2={padding.left + chartW}
              y1={getY(baseRate)}
              y2={getY(baseRate)}
              stroke="var(--text-muted)"
              strokeDasharray="4 3"
              strokeWidth={1}
            />

            {/* Baseline Curve */}
            <path
              d={baselineCurvePath}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={1.8}
              strokeDasharray="4 3"
            />

            {/* Model Curve */}
            <path
              d={modelCurvePath}
              fill="none"
              stroke="var(--brand-500)"
              strokeWidth={2.4}
            />

            {/* Selected Operating Point Marker */}
            {matchedModelPoint && (
              <g>
                <circle
                  cx={getX(matchedModelPoint.recall)}
                  cy={getY(matchedModelPoint.precision)}
                  r={6}
                  fill="var(--brand-500)"
                  stroke="var(--surface-card)"
                  strokeWidth={2}
                />
                <text
                  x={getX(matchedModelPoint.recall) + 8}
                  y={getY(matchedModelPoint.precision) - 8}
                  fill="var(--text-primary)"
                  fontSize="10"
                  fontWeight="bold"
                >
                  {selectedOpKey.replace(/_/g, ' ')} ({matchedModelPoint.recall.toFixed(1)}%, {matchedModelPoint.precision.toFixed(2)})
                </text>
              </g>
            )}

            {/* Axis Titles */}
            <text
              x={padding.left + chartW / 2}
              y={height - 5}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              fontWeight="bold"
            >
              Recall (% of fresh crossings detected)
            </text>
            <text
              transform={`rotate(-90)`}
              x={-(padding.top + chartH / 2)}
              y={14}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              fontWeight="bold"
            >
              Precision
            </text>
          </svg>

          {/* Chart Legend */}
          <div className="flex flex-wrap items-center justify-center gap-6 pt-1 text-xs text-fg-secondary">
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 bg-brand-500 block" />
              <span>Model PR Curve</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 border-t border-dashed border-fg-muted block" />
              <span>Tuned Baseline PR Curve</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-brand-500 block" />
              <span>Current Operating Point</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-0.5 border-t border-dotted border-fg-muted block" />
              <span>Base Rate ({(baseRate * 100).toFixed(1)}%)</span>
            </div>
          </div>
        </div>
      ) : (
        /* Accessible Table of PR curve points */
        <div className="overflow-x-auto max-h-80 border border-surface-border rounded-lg">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 bg-surface-subtle border-b border-surface-border font-mono uppercase text-[10px] text-fg-muted">
              <tr>
                <th className="py-2 px-3">Threshold</th>
                <th className="py-2 px-3 text-right">Recall</th>
                <th className="py-2 px-3 text-right">Precision</th>
                <th className="py-2 px-3 text-right">Alerts per 100 Days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {activePrCurve?.model.map((pt, i) => (
                <tr key={i} className="hover:bg-surface-subtle/50 font-mono">
                  <td className="py-1.5 px-3">{pt.threshold.toFixed(2)}</td>
                  <td className="py-1.5 px-3 text-right">{pt.recall.toFixed(1)}%</td>
                  <td className="py-1.5 px-3 text-right font-semibold">{pt.precision.toFixed(3)}</td>
                  <td className="py-1.5 px-3 text-right text-fg-muted">{pt.alerts_per_100_days.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
