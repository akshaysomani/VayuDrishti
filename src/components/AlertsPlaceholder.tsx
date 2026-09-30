import React from 'react';
import { Bell } from 'lucide-react';

export const AlertsPlaceholder: React.FC = () => {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-surface-border gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-fg-primary">
              Early-Warning & Public Health Alerts
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
              Pilot Module
            </span>
          </div>
          <p className="text-sm text-fg-secondary mt-1">
            Factual forecast alerts and monitor notification rules configured for judicial benches and municipal health authorities.
          </p>
        </div>
      </div>

      {/* Pilot Placeholder Card */}
      <div className="p-8 rounded-xl border border-surface-border bg-surface-card text-center space-y-4 max-w-lg mx-auto shadow-elevation1">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
          <Bell className="w-7 h-7" />
        </div>
        <div>
          <h2 className="text-base font-bold text-fg-primary">
            Automated Alert Rule Engine
          </h2>
          <p className="text-xs text-fg-muted mt-1 leading-relaxed">
            Will dispatch threshold warnings when 24h forecast exceedances breach CPCB standards or when primary city monitors have no usable data recorded for &gt;48 hours.
          </p>
        </div>

        <div className="pt-2">
          <div className="text-[11px] font-mono text-fg-secondary bg-surface-subtle p-3 rounded-lg border border-surface-border text-left space-y-1">
            <div className="flex items-center justify-between">
              <span>Rule 1: Severe AQI Forecast Alert</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Enabled</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Rule 2: Monitor Data Interruption Notification (&gt;48h)</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Enabled</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
