import React from 'react';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
import type { AlertMeta, SegmentData } from '../../types/alert';

interface LimitsSectionProps {
  meta: AlertMeta;
  segments?: Record<string, SegmentData>;
}

export const LimitsSection: React.FC<LimitsSectionProps> = ({ meta, segments }) => {
  const allRowsMae = segments?.all_rows?.model_mae;

  const caveats = [
    {
      title: 'City-Centre Coordinates, Not Station Sites',
      body: 'MODIS thermal fire detections and ERA5 atmospheric wind vectors are spatially matched to nominal city-centre geographic coordinates rather than individual monitor rooftop coordinates.',
    },
    {
      title: 'Low Satellite Pass Frequency',
      body: 'MODIS instruments (Terra and Aqua polar orbiters) provide only 2 to 4 passes over India per day. Transient agricultural stubble burning events ignited outside these satellite overpass windows are omitted.',
    },
    {
      title: 'Evaluated on Historical Split Only',
      body: `All reported performance metrics and decision thresholds reflect a single historical evaluation window (${meta.test_period ?? meta.test_year}, ${meta.n_rows.toLocaleString()} rows across reporting ground stations) using the calibrated model pipeline.`,
    },
    {
      title: 'Local Retraining & Methodology Variance',
      body: `The model was trained locally on pre-test data (train period: ${meta.train_period ?? meta.train_years?.join('–') ?? 'pre-2018'}, validation period: ${meta.validation_period ?? meta.validation_year ?? '2018-2019'}) for this dashboard release, and continuous MAE results differ from earlier exploratory phases.`,
    },
    {
      title: 'Unexplained MAE Performance Gap',
      body: `The continuous test MAE achieved here (${allRowsMae !== undefined ? `${allRowsMae.toFixed(1)} µg/m³` : 'under evaluation'}) is higher than earlier exploratory benchmark retests (17.2 µg/m³); this gap is not explained by this pipeline.`,
    },
    {
      title: 'No External Spatial or Temporal Validation',
      body: 'The forecasting architecture has not been externally tested or validated on post-2019 time windows or monitoring stations outside India.',
    },
    {
      title: 'Not Validated Against Health Outcomes',
      body: 'Alert thresholds and continuous forecasts have not been benchmarked against clinical epidemiological endpoints such as hospital emergency visits, cardiovascular events, or respiratory mortality.',
    },
    {
      title: 'Small Sample Size in Top-Decile Fire Cohorts',
      body: 'Extreme upwind fire radiative power subsets contain very small sample sizes on positive-day cutoffs, leading to wide confidence intervals and high sample variance.',
    },
    {
      title: 'Cluster Bootstrap Resamples Calendar Dates',
      body: 'All reported 95% confidence intervals are generated using a cluster bootstrap at the calendar-date level (resampling entire days with all reporting stations intact) to guard against spatial correlation across adjacent stations.',
    },
    {
      title: 'Winter Stagnation & Fire Seasonal Confounding',
      body: 'Biomass burning in northwest India strongly clusters during late autumn and early winter, coinciding precisely with cold-season thermal inversion and shallow boundary layers. High alert rates reflect this joint seasonal co-occurrence rather than isolated fire effects.',
    },
  ];

  return (
    <section
      aria-labelledby="limits-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-4"
    >
      <div className="flex items-center gap-2 pb-2 border-b border-surface-border">
        <ShieldAlert className="w-5 h-5 text-amber-500" aria-hidden="true" />
        <h2 id="limits-heading" className="text-base sm:text-lg font-bold text-fg-primary">
          Analytical Limits, Methodological Caveats &amp; Data Provenance
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        {caveats.map((c, i) => (
          <div
            key={i}
            className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" aria-hidden="true" />
              <h3 className="font-semibold text-fg-primary text-xs">{c.title}</h3>
            </div>
            <p className="text-fg-secondary leading-relaxed text-[11px] pl-5.5">{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
};
