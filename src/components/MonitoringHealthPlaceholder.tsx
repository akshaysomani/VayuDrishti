import React from 'react';
import { Activity, Radio, AlertOctagon, CheckCircle2, BarChart2 } from 'lucide-react';
import { getNetworkSummary } from '../data/loader';

export const MonitoringHealthPlaceholder: React.FC = () => {
  const summary = getNetworkSummary();

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-surface-border gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-fg-primary">
              Monitoring Infrastructure Health
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono rounded bg-slate-100 dark:bg-slate-800 text-fg-secondary border border-surface-border">
              Historical Completeness Analytics
            </span>
          </div>
          <p className="text-sm text-fg-secondary mt-1">
            Station reliability, transmission completeness, and continuous data gaps across ground stations.
          </p>
        </div>

        <div className="text-xs font-mono text-fg-muted bg-surface-subtle px-3 py-1.5 rounded-md border border-surface-border">
          Data Period: {summary.dataPeriod}
        </div>
      </div>

      {/* Network Health Key Figures */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1">
          <div className="text-xs font-medium text-fg-muted flex items-center justify-between">
            <span>Total Stations</span>
            <Radio className="w-4 h-4 text-brand-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-fg-primary mt-2">
            {summary.totalStations}
          </div>
          <div className="text-xs text-fg-secondary mt-1">
            Stations in dataset
          </div>
        </div>

        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1">
          <div className="text-xs font-medium text-fg-muted flex items-center justify-between">
            <span>Reporting in Dataset</span>
            <CheckCircle2 className="w-4 h-4 text-sky-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-fg-primary mt-2">
            {summary.reportingStations}
          </div>
          <div className="text-xs text-sky-600 dark:text-sky-400 mt-1 font-medium">
            {summary.reportingPct}% reporting rate
          </div>
        </div>

        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1">
          <div className="text-xs font-medium text-fg-muted flex items-center justify-between">
            <span>No usable data in this dataset</span>
            <AlertOctagon className="w-4 h-4 text-slate-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-fg-primary mt-2">
            {summary.noDataStations}
          </div>
          <div className="text-xs text-fg-muted mt-1">
            No usable data recorded in dataset
          </div>
        </div>

        <div className="p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1">
          <div className="text-xs font-medium text-fg-muted flex items-center justify-between">
            <span>Monitored Cities</span>
            <Activity className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-fg-primary mt-2">
            {summary.totalCities}
          </div>
          <div className="text-xs text-fg-secondary mt-1">
            {summary.fullCities} full reporting, {summary.unmonitoredCities} unmonitored
          </div>
        </div>
      </div>

      {/* Standby View Container */}
      <div className="p-8 rounded-xl border border-surface-border bg-surface-subtle/60 text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-surface-card border border-surface-border flex items-center justify-center mx-auto text-fg-muted shadow-elevation1">
          <BarChart2 className="w-6 h-6 text-brand-500" />
        </div>
        <h2 className="text-base font-bold text-fg-primary">
          Monitoring Health & Data Completeness Matrix
        </h2>
        <p className="text-xs text-fg-muted max-w-lg mx-auto leading-relaxed">
          Monthly transmission matrices (2015-2020) and station completeness distributions are typed and ready in <code>availability_monthly</code> and <code>stations</code> loaders.
        </p>
        <div className="text-xs font-mono text-fg-secondary pt-2">
          Standby mode — Data visualisation ready for phase 2.
        </div>
      </div>
    </div>
  );
};
