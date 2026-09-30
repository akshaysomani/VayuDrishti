import React, { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Activity, ShieldAlert, CheckCircle2, Building2, Info } from 'lucide-react';
import type { Station, City } from '../types/dashboard';

interface MonitoringHealthSummaryStripProps {
  stations: Station[];
  cities: City[];
}

export const MonitoringHealthSummaryStrip: React.FC<MonitoringHealthSummaryStripProps> = ({
  stations,
  cities,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const reportingNumRef = useRef<HTMLSpanElement>(null);
  const noDataNumRef = useRef<HTMLSpanElement>(null);
  const medianNumRef = useRef<HTMLSpanElement>(null);
  const unmonitoredCitiesNumRef = useRef<HTMLSpanElement>(null);

  // Compute stats dynamically from dataset
  const totalStations = stations.length;
  const reportingStations = stations.filter((s) => s.displayStatus === 'reporting_in_dataset').length;
  const noDataStations = stations.filter((s) => s.displayStatus === 'no_usable_data').length;

  // Median completeness among reporting stations
  const reportingComps = stations
    .filter((s) => s.displayStatus === 'reporting_in_dataset' && typeof s.completeness === 'number')
    .map((s) => s.completeness)
    .sort((a, b) => a - b);

  let medianCompleteness = 0;
  if (reportingComps.length > 0) {
    const mid = Math.floor(reportingComps.length / 2);
    medianCompleteness =
      reportingComps.length % 2 === 0
        ? (reportingComps[mid - 1] + reportingComps[mid]) / 2
        : reportingComps[mid];
  }
  const medianPct = (medianCompleteness * 100);

  const totalCities = cities.length;
  const unmonitoredCities = cities.filter((c) => c.city_status === 'no_working_station');
  const unmonitoredCount = unmonitoredCities.length;
  const within50kmCount = unmonitoredCities.filter((c) => c.nearest_working_km <= 50).length;

  // GSAP Count-up animation
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (reportingNumRef.current) reportingNumRef.current.innerText = `${reportingStations}`;
        if (noDataNumRef.current) noDataNumRef.current.innerText = `${noDataStations}`;
        if (medianNumRef.current) medianNumRef.current.innerText = `${medianPct.toFixed(1)}%`;
        if (unmonitoredCitiesNumRef.current) unmonitoredCitiesNumRef.current.innerText = `${unmonitoredCount}`;
        return;
      }

      const proxy = { reporting: 0, noData: 0, median: 0, unmonitored: 0 };
      gsap.to(proxy, {
        reporting: reportingStations,
        noData: noDataStations,
        median: medianPct,
        unmonitored: unmonitoredCount,
        duration: 0.8,
        ease: 'power2.out',
        onUpdate: () => {
          if (reportingNumRef.current) {
            reportingNumRef.current.innerText = `${Math.round(proxy.reporting)}`;
          }
          if (noDataNumRef.current) {
            noDataNumRef.current.innerText = `${Math.round(proxy.noData)}`;
          }
          if (medianNumRef.current) {
            medianNumRef.current.innerText = `${proxy.median.toFixed(1)}%`;
          }
          if (unmonitoredCitiesNumRef.current) {
            unmonitoredCitiesNumRef.current.innerText = `${Math.round(proxy.unmonitored)}`;
          }
        },
      });
    },
    { dependencies: [stations, cities], scope: containerRef }
  );

  return (
    <div ref={containerRef} className="space-y-4">
      {/* 4 Summary Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Reporting Stations */}
        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span className="font-semibold text-fg-primary uppercase tracking-wider text-[11px]">
              Reporting in Dataset
            </span>
            <CheckCircle2 className="w-4 h-4 text-sky-500" aria-hidden="true" />
          </div>
          <div className="mt-2">
            <div className="text-3xl font-bold font-mono text-brand-600 dark:text-brand-400 tracking-tight">
              <span ref={reportingNumRef}>{reportingStations}</span>
              <span className="text-sm font-normal text-fg-muted ml-1.5 font-sans">
                of {totalStations}
              </span>
            </div>
            <p className="text-xs text-fg-secondary mt-1">
              Ground stations with data in the 2015–2020 dataset.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-surface-border text-[11px] text-fg-muted font-mono flex justify-between">
            <span>Reporting Share:</span>
            <span className="font-semibold text-fg-primary">
              {((reportingStations / (totalStations || 1)) * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Card 2: No Usable Data Stations */}
        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span className="font-semibold text-fg-primary uppercase tracking-wider text-[11px]">
              No Usable Data
            </span>
            <ShieldAlert className="w-4 h-4 text-slate-500" aria-hidden="true" />
          </div>
          <div className="mt-2">
            <div className="text-3xl font-bold font-mono text-slate-700 dark:text-slate-300 tracking-tight">
              <span ref={noDataNumRef}>{noDataStations}</span>
              <span className="text-sm font-normal text-fg-muted ml-1.5 font-sans">
                of {totalStations}
              </span>
            </div>
            <p className="text-xs text-fg-secondary mt-1">
              Listed in this dataset, but no valid daily observations recorded.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-surface-border text-[11px] text-fg-muted font-mono flex justify-between">
            <span>No Usable Data Share:</span>
            <span className="font-semibold text-fg-primary">
              {((noDataStations / (totalStations || 1)) * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Card 3: Median Completeness */}
        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span className="font-semibold text-fg-primary uppercase tracking-wider text-[11px]">
              Median Completeness (Reporting Stations)
            </span>
            <Activity className="w-4 h-4 text-brand-500" aria-hidden="true" />
          </div>
          <div className="mt-2">
            <div className="text-3xl font-bold font-mono text-fg-primary tracking-tight">
              <span ref={medianNumRef}>{medianPct.toFixed(1)}%</span>
            </div>
            <p className="text-xs text-fg-secondary mt-1">
              Median completeness across reporting stations in this dataset.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-surface-border text-[11px] text-fg-muted font-mono flex justify-between">
            <span>National Target:</span>
            <span className="text-brand-600 dark:text-brand-400 font-semibold">≥ 85.0%</span>
          </div>
        </div>

        {/* Card 4: Cities Without a Working Station */}
        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span className="font-semibold text-fg-primary uppercase tracking-wider text-[11px]">
              Unmonitored Cities
            </span>
            <Building2 className="w-4 h-4 text-amber-500" aria-hidden="true" />
          </div>
          <div className="mt-2">
            <div className="text-3xl font-bold font-mono text-amber-700 dark:text-amber-400 tracking-tight">
              <span ref={unmonitoredCitiesNumRef}>{unmonitoredCount}</span>
              <span className="text-sm font-normal text-fg-muted ml-1.5 font-sans">
                of {totalCities}
              </span>
            </div>
            <p className="text-xs text-fg-secondary mt-1">
              Cities with no working ground station listed in this dataset.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-surface-border text-[11px] text-fg-muted leading-tight">
            <strong className="text-fg-primary font-mono">{within50kmCount}</strong> within 50 km of a working city (e.g. Noida, Thane, Howrah).
          </div>
        </div>
      </div>

      {/* About this data Caveat Banner */}
      <div
        className="p-3.5 sm:p-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-surface-subtle flex items-start gap-3 text-xs leading-relaxed"
        role="note"
        aria-label="About this data"
      >
        <Info className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 text-fg-secondary">
          <p>
            <strong className="text-fg-primary font-medium">About this data:</strong> The classification{' '}
            <strong className="text-fg-primary font-mono">"no usable data in this dataset"</strong> reflects observations recorded in this historical archive (2015-01-01 to 2020-07-01) and must be verified against current live CPCB portal status before making regulatory or policy claims.
          </p>
          <p className="text-[11px] text-fg-muted">
            Note: 3 stations in the historical archive recorded sporadic hourly observations but never reached the 12-hour minimum per day used in this analysis, and are therefore classified as having no usable data.
          </p>
        </div>
      </div>
    </div>
  );
};
