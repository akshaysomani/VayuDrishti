import React from 'react';
import { ArrowUpRight, Minus, ArrowDownRight, Scale, Info } from 'lucide-react';
import type { SegmentData } from '../../types/alert';

interface BaselineComparisonCardProps {
  segments: Record<string, SegmentData>;
}

interface SegmentMetaDisplay {
  key: string;
  name: string;
  description: string;
}

const SEGMENT_ROWS: SegmentMetaDisplay[] = [
  {
    key: 'all_rows',
    name: 'All Rows',
    description: 'Full 2019 test set across all monitoring ground stations',
  },
  {
    key: 'no_fire_100km',
    name: 'No Fire (100km)',
    description: 'Zero detected MODIS fire detections within 100 km radius',
  },
  {
    key: 'any_fire_100km',
    name: 'Any Fire (100km)',
    description: 'At least one detected MODIS fire observation within 100 km',
  },
  {
    key: 'upwind_fire_100km',
    name: 'Upwind Fire (100km)',
    description: 'Fires positioned within ±45° upwind azimuth based on ERA5 wind vectors',
  },
  {
    key: 'top10_upwind_intensity',
    name: 'Top 10% Upwind Fire (Positive Days)',
    description: 'Top decile of upwind fire radiative power among positive fire days (FRP ≥ 375.3 MW)',
  },
  {
    key: 'top10_upwind_intensity_all_rows',
    name: 'Top 10% Upwind Fire (All Rows)',
    description: 'Top decile of upwind fire radiative power across all observation rows (FRP ≥ 9.3 MW)',
  },
];

function getDifferenceBadge(
  diff: number | null,
  ci: [number, number] | null,
  status?: string
): { label: string; bgClass: string; textClass: string; icon: React.ReactNode } {
  if (status === 'not reached' || diff === null || ci === null) {
    return {
      label: 'not reached',
      bgClass: 'bg-surface-subtle',
      textClass: 'text-fg-muted',
      icon: <Minus className="w-3 h-3" aria-hidden="true" />,
    };
  }

  const [low, high] = ci;
  if (low > 0 && high > 0) {
    return {
      label: 'gain',
      bgClass: 'bg-emerald-500/10 dark:bg-emerald-500/20 border-emerald-500/30',
      textClass: 'text-emerald-700 dark:text-emerald-300',
      icon: <ArrowUpRight className="w-3 h-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />,
    };
  }
  if (low < 0 && high < 0) {
    return {
      label: 'worse than rule',
      bgClass: 'bg-rose-500/10 dark:bg-rose-500/20 border-rose-500/30',
      textClass: 'text-rose-700 dark:text-rose-300',
      icon: <ArrowDownRight className="w-3 h-3 text-rose-600 dark:text-rose-400" aria-hidden="true" />,
    };
  }
  return {
    label: 'no clear difference',
    bgClass: 'bg-surface-subtle border-surface-border',
    textClass: 'text-fg-secondary',
    icon: <Minus className="w-3 h-3 text-fg-muted" aria-hidden="true" />,
  };
}

export const BaselineComparisonCard: React.FC<BaselineComparisonCardProps> = ({ segments }) => {
  const allRowsSeg = segments['all_rows'];
  const matchedPrAll = allRowsSeg?.matched_pr;
  const tunedThresholdX = allRowsSeg?.fresh_crossing?.persistence_tuned?.threshold_x;

  // Short computed summary sentence stating the overall result in plain words
  const computedSummarySentence = (() => {
    if (!matchedPrAll || tunedThresholdX === undefined) {
      return 'Summary metrics unavailable.';
    }

    const apModel = matchedPrAll.model_average_precision;
    const apBaseline = matchedPrAll.baseline_average_precision;
    const apDiff = matchedPrAll.diff_average_precision;
    const apCi = matchedPrAll.diff_ap_ci_95_date;

    const r85 = matchedPrAll.precision_at_recall_85;
    const r85Model = r85.model;
    const r85Base = r85.baseline;
    const r85Diff = r85.diff_model_minus_baseline;
    const r85Ci = r85.diff_ci_95_date;

    const apTag = apCi[0] > 0 && apCi[1] > 0
      ? 'a statistically measurable gain'
      : apCi[0] < 0 && apCi[1] < 0
      ? 'lower precision than the baseline'
      : 'no clear difference from the rule';

    return (
      `Across all evaluation rows, the model achieves an average precision of ${apModel.toFixed(3)} versus ${apBaseline.toFixed(3)} ` +
      `for the simple tuned rule (alert if today's PM2.5 > ${tunedThresholdX.toFixed(1)} µg/m³), showing ${apTag} ` +
      `(${apDiff >= 0 ? '+' : ''}${apDiff.toFixed(3)}, 95% date CI [${apCi[0].toFixed(3)}, ${apCi[1].toFixed(3)}]). ` +
      (r85Model !== null && r85Base !== null && r85Diff !== null && r85Ci !== null
        ? `At 85% matched recall, model precision is ${r85Model.toFixed(3)} versus ${r85Base.toFixed(3)} for the rule ` +
          `(${r85Diff >= 0 ? '+' : ''}${r85Diff.toFixed(3)}, 95% date CI [${r85Ci[0].toFixed(3)}, ${r85Ci[1].toFixed(3)}]).`
        : 'At 85% recall, baseline was not reached.')
    );
  })();

  return (
    <section
      aria-labelledby="baseline-comparison-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-5"
    >
      {/* Title & Introduction */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Scale className="w-5 h-5 text-brand-500" aria-hidden="true" />
          <h2 id="baseline-comparison-heading" className="text-base sm:text-lg font-bold text-fg-primary">
            Model vs a Simple Rule (Matched Recall &amp; Average Precision)
          </h2>
        </div>
        <p className="text-xs sm:text-sm text-fg-secondary">
          Comparing the shipped calibrated model against the calibrated persistence rule (&ldquo;alert if today&rsquo;s PM2.5 is above{' '}
          <code className="font-mono text-fg-primary font-semibold">
            {tunedThresholdX !== undefined ? tunedThresholdX.toFixed(1) : '...'} µg/m³
          </code>
          &rdquo;) on fresh crossings where today&rsquo;s air is fine (≤ 90 µg/m³).
        </p>
      </div>

      {/* Computed Summary Sentence */}
      <div className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border text-xs sm:text-sm text-fg-primary leading-relaxed flex items-start gap-2.5">
        <Info className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          <strong>Summary:</strong> {computedSummarySentence}
        </p>
      </div>

      {/* Comparison Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-surface-border text-fg-muted font-mono uppercase text-[11px] bg-surface-subtle/50">
              <th scope="col" className="py-2.5 px-3">Segment</th>
              <th scope="col" className="py-2.5 px-3">Average Precision (Model vs Rule)</th>
              <th scope="col" className="py-2.5 px-3">Precision @ 60% Recall</th>
              <th scope="col" className="py-2.5 px-3">Precision @ 75% Recall</th>
              <th scope="col" className="py-2.5 px-3">Precision @ 85% Recall</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {SEGMENT_ROWS.map((segDef) => {
              const seg = segments[segDef.key];
              if (!seg) return null;
              const matchedPr = seg.matched_pr;
              const apBadge = getDifferenceBadge(
                matchedPr.diff_average_precision,
                matchedPr.diff_ap_ci_95_date
              );
              const r60 = matchedPr.precision_at_recall_60;
              const r60Badge = getDifferenceBadge(
                r60.diff_model_minus_baseline,
                r60.diff_ci_95_date,
                r60.model_status === 'not reached' || r60.baseline_status === 'not reached' ? 'not reached' : 'reached'
              );
              const r75 = matchedPr.precision_at_recall_75;
              const r75Badge = getDifferenceBadge(
                r75.diff_model_minus_baseline,
                r75.diff_ci_95_date,
                r75.model_status === 'not reached' || r75.baseline_status === 'not reached' ? 'not reached' : 'reached'
              );
              const r85 = matchedPr.precision_at_recall_85;
              const r85Badge = getDifferenceBadge(
                r85.diff_model_minus_baseline,
                r85.diff_ci_95_date,
                r85.model_status === 'not reached' || r85.baseline_status === 'not reached' ? 'not reached' : 'reached'
              );

              return (
                <tr key={segDef.key} className="hover:bg-surface-subtle/40 transition-colors">
                  <td className="py-3 px-3">
                    <div className="font-semibold text-fg-primary text-xs">{segDef.name}</div>
                    <div className="text-[11px] text-fg-muted font-mono">
                      n={seg.n.toLocaleString()} | eligible={seg.fresh_crossing.eligible_n.toLocaleString()}
                    </div>
                  </td>

                  {/* Average Precision */}
                  <td className="py-3 px-3">
                    <div className="font-mono text-fg-primary">
                      {matchedPr.model_average_precision.toFixed(3)} vs {matchedPr.baseline_average_precision.toFixed(3)}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${apBadge.bgClass} ${apBadge.textClass}`}
                      >
                        {apBadge.icon}
                        <span>{apBadge.label}</span>
                      </span>
                      <span className="text-[10px] text-fg-muted font-mono">
                        by date [{matchedPr.diff_ap_ci_95_date[0].toFixed(3)}, {matchedPr.diff_ap_ci_95_date[1].toFixed(3)}]
                      </span>
                    </div>
                  </td>

                  {/* Precision @ 60% */}
                  <td className="py-3 px-3">
                    {r60.model !== null && r60.baseline !== null ? (
                      <>
                        <div className="font-mono text-fg-primary">
                          {r60.model.toFixed(3)} vs {r60.baseline.toFixed(3)}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${r60Badge.bgClass} ${r60Badge.textClass}`}
                          >
                            {r60Badge.icon}
                            <span>{r60Badge.label}</span>
                          </span>
                          {r60.diff_ci_95_date && (
                            <span className="text-[10px] text-fg-muted font-mono">
                              [{r60.diff_ci_95_date[0].toFixed(3)}, {r60.diff_ci_95_date[1].toFixed(3)}]
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="text-fg-muted italic">not reached</span>
                    )}
                  </td>

                  {/* Precision @ 75% */}
                  <td className="py-3 px-3">
                    {r75.model !== null && r75.baseline !== null ? (
                      <>
                        <div className="font-mono text-fg-primary">
                          {r75.model.toFixed(3)} vs {r75.baseline.toFixed(3)}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${r75Badge.bgClass} ${r75Badge.textClass}`}
                          >
                            {r75Badge.icon}
                            <span>{r75Badge.label}</span>
                          </span>
                          {r75.diff_ci_95_date && (
                            <span className="text-[10px] text-fg-muted font-mono">
                              [{r75.diff_ci_95_date[0].toFixed(3)}, {r75.diff_ci_95_date[1].toFixed(3)}]
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="text-fg-muted italic">not reached</span>
                    )}
                  </td>

                  {/* Precision @ 85% */}
                  <td className="py-3 px-3">
                    {r85.model !== null && r85.baseline !== null ? (
                      <>
                        <div className="font-mono text-fg-primary">
                          {r85.model.toFixed(3)} vs {r85.baseline.toFixed(3)}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${r85Badge.bgClass} ${r85Badge.textClass}`}
                          >
                            {r85Badge.icon}
                            <span>{r85Badge.label}</span>
                          </span>
                          {r85.diff_ci_95_date && (
                            <span className="text-[10px] text-fg-muted font-mono">
                              [{r85.diff_ci_95_date[0].toFixed(3)}, {r85.diff_ci_95_date[1].toFixed(3)}]
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="text-fg-muted italic">not reached</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* COVID Lockdown Evaluation Window Note */}
      <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary leading-relaxed">
        <strong>Evaluation Window Context:</strong> The 12-month test window (Jul 2019 – Jun 2020) spans the pre-pandemic baseline through the nationwide COVID-19 lockdown (Mar – Jun 2020), during which acute pollution events dropped by over 58% due to industrial and transport shutdowns.
      </div>
    </section>
  );
};
