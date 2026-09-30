import React, { useState, useRef, useMemo } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { validateAlertData, type AlertDataPayload } from '../types/alert';
import { AlertsHeader } from './alerts/AlertsHeader';
import { BaselineComparisonCard } from './alerts/BaselineComparisonCard';
import { ForecastErrorCard } from './alerts/ForecastErrorCard';
import { ReplayExplorer } from './alerts/ReplayExplorer';
import { OperatingPointCard } from './alerts/OperatingPointCard';
import { FireContextPanel } from './alerts/FireContextPanel';
import { ReliabilityCard } from './alerts/ReliabilityCard';
import { LimitsSection } from './alerts/LimitsSection';

import alertDataRaw from '../data/alert_data.json';

gsap.registerPlugin(useGSAP);

interface AlertsViewProps {
  onNavigateToMonitoring?: (stationId: string) => void;
}

export const AlertsView: React.FC<AlertsViewProps> = ({ onNavigateToMonitoring }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Validate alert data against strict schema assertions
  const { data, error } = useMemo(() => {
    try {
      validateAlertData(alertDataRaw);
      return { data: alertDataRaw as unknown as AlertDataPayload, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { data: null, error: msg };
    }
  }, []);

  // Selected operating point policy state (defaults to balanced)
  const [selectedOpKey, setSelectedOpKey] = useState<
    'balanced' | 'high_recall' | 'high_precision'
  >('balanced');

  // Subtle GSAP entrance animation with full prefers-reduced-motion fallback
  useGSAP(
    () => {
      if (!data || error) return;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        gsap.set('.alerts-section-card', { opacity: 1, y: 0 });
        return;
      }

      gsap.fromTo(
        '.alerts-section-card',
        { opacity: 0, y: 14 },
        {
          opacity: 1,
          y: 0,
          duration: 0.35,
          stagger: 0.08,
          ease: 'power2.out',
          clearProps: 'transform',
        }
      );
    },
    { dependencies: [data, error], scope: containerRef }
  );

  // Error state
  if (error || !data) {
    return (
      <div
        role="alert"
        className="p-8 max-w-3xl mx-auto my-12 rounded-xl bg-surface-card border border-rose-500/30 text-fg-primary space-y-4 shadow-elevation2"
      >
        <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
          <AlertCircle className="w-6 h-6 flex-shrink-0" />
          <h2 className="text-lg font-bold">Unable to Load Alert System Data</h2>
        </div>
        <p className="text-xs sm:text-sm text-fg-secondary font-mono leading-relaxed bg-surface-subtle p-3 rounded-lg border border-surface-border">
          {error ?? 'Unknown error occurred while parsing alert records.'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs font-semibold text-fg-primary transition-colors cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Reload Dashboard</span>
        </button>
      </div>
    );
  }

  const activeOp = data.operating_points[selectedOpKey];

  return (
    <div ref={containerRef} className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
      {/* SECTION A: Header, persistent backtest banner & data partitioning */}
      <div className="alerts-section-card">
        <AlertsHeader meta={data.meta} />
      </div>

      {/* SECTION B: Baseline comparison card (First card after header, always shown) */}
      <div className="alerts-section-card">
        <BaselineComparisonCard segments={data.segments} />
      </div>

      {/* SECTION C: Forecast error card (MAE vs persistence) & "The broader question" */}
      <div className="alerts-section-card">
        <ForecastErrorCard segments={data.segments} />
      </div>

      {/* SECTION D: 2019 Replay explorer with daily scrub against CPCB bands */}
      <div className="alerts-section-card">
        <ReplayExplorer
          predictions={data.predictions}
          operatingPoint={activeOp}
          onNavigateToMonitoring={onNavigateToMonitoring}
        />
      </div>

      {/* SECTION E: Operating point control & Precision-Recall curves */}
      <div className="alerts-section-card">
        <OperatingPointCard
          operatingPoints={data.operating_points}
          selectedOpKey={selectedOpKey}
          onSelectOpKey={setSelectedOpKey}
          segments={data.segments}
          prCurves={data.pr_curves}
        />
      </div>

      {/* SECTION F: Biomass burning & season-controlled ratios panel */}
      <div className="alerts-section-card">
        <FireContextPanel meta={data.meta} segments={data.segments} />
      </div>

      {/* SECTION G: Reliability diagram & score calibration */}
      <div className="alerts-section-card">
        <ReliabilityCard meta={data.meta} />
      </div>

      {/* SECTION H: Limits, caveats, and data provenance */}
      <div className="alerts-section-card">
        <LimitsSection meta={data.meta} segments={data.segments} />
      </div>
    </div>
  );
};

export default AlertsView;
