import React from 'react';
import { Flame, Info, Calendar } from 'lucide-react';
import type { AlertMeta, SegmentData } from '../../types/alert';

interface FireContextPanelProps {
  meta: AlertMeta;
  segments: Record<string, SegmentData>;
}

export const FireContextPanel: React.FC<FireContextPanelProps> = ({ meta, segments }) => {
  const fireAnalysis = meta.fire_seasonality_analysis;

  // Segments to display side by side
  const segmentList = [
    { key: 'no_fire_100km', name: 'No Fire (100km)', isBaseline: true },
    { key: 'any_fire_100km', name: 'Any Fire (100km)', isBaseline: false },
    { key: 'upwind_fire_100km', name: 'Upwind Fire (100km)', isBaseline: false },
    { key: 'top10_upwind_intensity', name: 'Top 10% Fire (Positive Days)', isBaseline: false },
    { key: 'top10_upwind_intensity_all_rows', name: 'Top 10% Fire (All Rows)', isBaseline: false },
  ];

  // Upwind fire analysis records
  const upwindAnalysis = fireAnalysis['upwind_fire_100km'];
  const upwindAll = upwindAnalysis?.all_year;
  const upwindWinter = upwindAnalysis?.oct_feb;
  const upwindSummer = upwindAnalysis?.mar_sep;

  // Fire vs No Fire comparative cohorts
  const fireSeg = segments['any_fire_100km']?.fresh_crossing;
  const noFireSeg = segments['no_fire_100km']?.fresh_crossing;
  const fireRecall = fireSeg?.model;
  const noFireRecall = noFireSeg?.model;

  // Headline sentence covering all-year, winter, and summer ratios together
  const headlineSentence = (() => {
    if (!upwindAll || !upwindWinter || !upwindSummer) return 'Seasonality analysis unavailable.';

    const allRatioStr = upwindAll.rate_ratio_to_no_fire?.toFixed(2) ?? '...';
    const allCiStr = upwindAll.ratio_ci_95_date
      ? `[95% date CI ${upwindAll.ratio_ci_95_date[0].toFixed(2)} to ${upwindAll.ratio_ci_95_date[1].toFixed(2)}]`
      : '';

    const winterRatioStr = upwindWinter.rate_ratio_to_no_fire?.toFixed(2) ?? '...';
    const winterCiStr = upwindWinter.ratio_ci_95_date
      ? `[95% date CI ${upwindWinter.ratio_ci_95_date[0].toFixed(2)} to ${upwindWinter.ratio_ci_95_date[1].toFixed(2)}]`
      : '';
    const winterIncludes1 =
      upwindWinter.ratio_ci_95_date &&
      upwindWinter.ratio_ci_95_date[0] <= 1.0 &&
      upwindWinter.ratio_ci_95_date[1] >= 1.0;

    const summerRatioStr = upwindSummer.rate_ratio_to_no_fire?.toFixed(2) ?? '...';
    const summerCiStr = upwindSummer.ratio_ci_95_date
      ? `[95% date CI ${upwindSummer.ratio_ci_95_date[0].toFixed(2)} to ${upwindSummer.ratio_ci_95_date[1].toFixed(2)}]`
      : '';

    return (
      `Over the full year, upwind fire days are associated with a fresh-crossing rate ratio of ${allRatioStr} ${allCiStr} ` +
      `versus days without fire. Within the winter season (Oct–Feb), the rate ratio is ${winterRatioStr} ${winterCiStr}` +
      (winterIncludes1 ? ' (where the confidence interval includes 1.0, showing no clear statistical difference within winter)' : '') +
      `, while during Mar–Sep the rate ratio is ${summerRatioStr} ${summerCiStr}.`
    );
  })();

  const renderRatioCell = (record?: {
    rate_ratio_to_no_fire: number | null;
    status: string;
    ratio_ci_95_date: [number, number] | null;
  }) => {
    if (!record) return <span className="text-fg-muted font-mono">-</span>;
    if (record.status.startsWith('too few events')) {
      return (
        <span className="text-[11px] text-amber-600 dark:text-amber-400 font-mono italic">
          {record.status}
        </span>
      );
    }
    if (record.rate_ratio_to_no_fire === null) {
      return <span className="text-fg-muted font-mono">-</span>;
    }

    return (
      <div>
        <span className="font-mono font-bold text-fg-primary">
          {record.rate_ratio_to_no_fire.toFixed(2)}x
        </span>
        {record.ratio_ci_95_date && (
          <div className="text-[10px] text-fg-muted font-mono">
            [{record.ratio_ci_95_date[0].toFixed(2)}, {record.ratio_ci_95_date[1].toFixed(2)}]
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      aria-labelledby="fire-context-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-5"
    >
      {/* Title */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Flame className="w-5 h-5 text-amber-500" aria-hidden="true" />
          <h2 id="fire-context-heading" className="text-base sm:text-lg font-bold text-fg-primary">
            Biomass Burning Context &amp; Seasonal Confounding
          </h2>
        </div>
        <p className="text-xs sm:text-sm text-fg-secondary">
          Assessing the descriptive statistical association between regional satellite fire detections and ground-level
          fresh crossings, controlling for seasonal meteorological periods.
        </p>
      </div>

      {/* Cohort Comparison Readout: Base Rate, Recall, Precision */}
      {fireSeg && noFireSeg && fireRecall && noFireRecall && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-fg-primary">Days With Fire (within 100km)</span>
              <span className="font-mono text-[11px] text-fg-muted">{fireSeg.eligible_n.toLocaleString()} eligible days</span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono">
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Base Rate</span>
                <span className="font-bold text-fg-primary text-sm">{fireSeg.event_rate.toFixed(1)}%</span>
                <span className="text-[10px] text-fg-muted block">({fireSeg.event_n} events)</span>
              </div>
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Recall</span>
                <span className="font-bold text-fg-primary text-sm">{fireRecall.recall.toFixed(1)}%</span>
                <span className="text-[10px] text-fg-muted block">[{fireRecall.recall_ci_95_date[0].toFixed(0)}–{fireRecall.recall_ci_95_date[1].toFixed(0)}%]</span>
              </div>
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Precision</span>
                <span className="font-bold text-fg-primary text-sm">{fireRecall.precision.toFixed(2)}</span>
                <span className="text-[10px] text-fg-muted block">[{fireRecall.precision_ci_95_date[0].toFixed(2)}–{fireRecall.precision_ci_95_date[1].toFixed(2)}]</span>
              </div>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-fg-primary">Days Without Fire (within 100km)</span>
              <span className="font-mono text-[11px] text-fg-muted">{noFireSeg.eligible_n.toLocaleString()} eligible days</span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono">
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Base Rate</span>
                <span className="font-bold text-fg-primary text-sm">{noFireSeg.event_rate.toFixed(1)}%</span>
                <span className="text-[10px] text-fg-muted block">({noFireSeg.event_n} events)</span>
              </div>
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Recall</span>
                <span className="font-bold text-fg-primary text-sm">{noFireRecall.recall.toFixed(1)}%</span>
                <span className="text-[10px] text-fg-muted block">[{noFireRecall.recall_ci_95_date[0].toFixed(0)}–{noFireRecall.recall_ci_95_date[1].toFixed(0)}%]</span>
              </div>
              <div>
                <span className="text-[10px] text-fg-muted block uppercase">Precision</span>
                <span className="font-bold text-fg-primary text-sm">{noFireRecall.precision.toFixed(2)}</span>
                <span className="text-[10px] text-fg-muted block">[{noFireRecall.precision_ci_95_date[0].toFixed(2)}–{noFireRecall.precision_ci_95_date[1].toFixed(2)}]</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Headline Sentence Box & Scientific Caption */}
      <div className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border space-y-2.5 text-xs sm:text-sm text-fg-primary leading-relaxed">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <strong>Seasonal Analysis:</strong> {headlineSentence}
          </p>
        </div>
        <div className="pl-6 text-xs text-fg-secondary border-t border-surface-border/60 pt-2 space-y-1">
          <p>
            <strong>Note on Base Rate and Model Performance:</strong> Days with fire have a substantially higher background event base rate ({fireSeg?.event_rate.toFixed(1)}% vs. {noFireSeg?.event_rate.toFixed(1)}% on non-fire days) because agricultural burning coincides with winter atmospheric temperature inversions and stagnation.
          </p>
          <p className="text-[11px] text-fg-muted italic">
            Phase 1 targeted ablation testing demonstrated that fire features provide no measurable predictive lift over autoregressive air quality lags and meteorology. The slightly higher observed recall and precision on fire days reflect this higher seasonal base rate, not superior model performance on fire days.
          </p>
        </div>
      </div>

      {/* Comparison Table: Rates & Season-Controlled Ratios */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-surface-border text-fg-muted font-mono uppercase text-[11px] bg-surface-subtle/50">
              <th scope="col" className="py-2.5 px-3">Cohort</th>
              <th scope="col" className="py-2.5 px-3">Fresh Crossing Rate (Events / Eligible)</th>
              <th scope="col" className="py-2.5 px-3">All-Year Ratio vs No Fire</th>
              <th scope="col" className="py-2.5 px-3">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-brand-500" />
                  <span>Oct–Feb (Winter)</span>
                </span>
              </th>
              <th scope="col" className="py-2.5 px-3">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-brand-500" />
                  <span>Mar–Sep (Summer/Monsoon)</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {segmentList.map((item) => {
              const seg = segments[item.key];
              const sAnalysis = fireAnalysis[item.key];

              if (!seg) return null;
              const fc = seg.fresh_crossing;

              return (
                <tr key={item.key} className="hover:bg-surface-subtle/40 transition-colors">
                  <td className="py-3 px-3">
                    <div className="font-semibold text-fg-primary text-xs">{item.name}</div>
                    <div className="text-[11px] text-fg-muted max-w-xs">{seg.definition}</div>
                  </td>

                  {/* Fresh crossing rate */}
                  <td className="py-3 px-3">
                    <div className="font-mono font-bold text-fg-primary">
                      {fc.event_rate.toFixed(1)}%
                    </div>
                    <div className="text-[10px] text-fg-muted font-mono">
                      {fc.event_n.toLocaleString()} of {fc.eligible_n.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-fg-muted font-mono">
                      [{fc.event_rate_ci_95_date[0].toFixed(1)}%, {fc.event_rate_ci_95_date[1].toFixed(1)}%] by date
                    </div>
                  </td>

                  {/* All-Year Ratio */}
                  <td className="py-3 px-3">
                    {item.isBaseline ? (
                      <span className="text-fg-muted font-mono font-medium">1.00 (Reference)</span>
                    ) : (
                      renderRatioCell(sAnalysis?.all_year)
                    )}
                  </td>

                  {/* Oct-Feb (Winter) Ratio */}
                  <td className="py-3 px-3">
                    {item.isBaseline ? (
                      <div>
                        <span className="font-mono text-fg-muted">1.00 (Reference)</span>
                        <div className="text-[10px] text-fg-muted font-mono">
                          Rate: {upwindWinter?.no_fire_rate ? `${upwindWinter.no_fire_rate.toFixed(1)}%` : '...'}
                        </div>
                      </div>
                    ) : (
                      renderRatioCell(sAnalysis?.oct_feb)
                    )}
                  </td>

                  {/* Mar-Sep Ratio */}
                  <td className="py-3 px-3">
                    {item.isBaseline ? (
                      <div>
                        <span className="font-mono text-fg-muted">1.00 (Reference)</span>
                        <div className="text-[10px] text-fg-muted font-mono">
                          Rate: {upwindSummer?.no_fire_rate ? `${upwindSummer.no_fire_rate.toFixed(1)}%` : '...'}
                        </div>
                      </div>
                    ) : (
                      renderRatioCell(sAnalysis?.mar_sep)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
