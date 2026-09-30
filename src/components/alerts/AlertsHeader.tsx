import React from 'react';
import { AlertCircle, Calendar, ShieldCheck, Database, Layers } from 'lucide-react';
import type { AlertMeta } from '../../types/alert';

interface AlertsHeaderProps {
  meta: AlertMeta;
}

export const AlertsHeader: React.FC<AlertsHeaderProps> = ({ meta }) => {
  return (
    <header className="space-y-4" aria-label="Alert system header and metadata">
      {/* 1. Persistent Backtest Banner (Strict Requirement) */}
      <div
        role="region"
        aria-label="Dataset limitation notice"
        className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-fg-primary text-xs sm:text-sm font-medium"
      >
        <div className="flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" aria-hidden="true" />
          <span>
            <strong>Backtest on 2019 data. Not a live forecast.</strong> Data ends 2020-07.
          </span>
        </div>
        <span className="hidden sm:inline-block text-[11px] font-mono text-fg-muted">
          Historical evaluation
        </span>
      </div>

      {/* 2. Main Title and Alert Definition */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-surface-border">
        <div className="space-y-1.5 max-w-4xl">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg-primary">
              Air Quality Early-Warning Alert System
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono font-medium rounded bg-surface-subtle text-fg-secondary border border-surface-border">
              {meta.model_name}
            </span>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary leading-relaxed">
            {meta.alert_definition}
          </p>
        </div>

        {/* 3. Evaluation Split Metadata Badge Strip */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-fg-muted">
          <div className="flex items-center gap-1.5 bg-surface-subtle px-3 py-1.5 rounded-lg border border-surface-border">
            <Calendar className="w-3.5 h-3.5 text-brand-500" aria-hidden="true" />
            <span>Test Year: {meta.test_year}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-surface-subtle px-3 py-1.5 rounded-lg border border-surface-border">
            <Database className="w-3.5 h-3.5 text-brand-500" aria-hidden="true" />
            <span>Rows: {meta.n_rows.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-surface-subtle px-3 py-1.5 rounded-lg border border-surface-border">
            <Layers className="w-3.5 h-3.5 text-brand-500" aria-hidden="true" />
            <span>Train: {meta.train_years.join(', ')} | Val: {meta.validation_year}</span>
          </div>
        </div>
      </div>

      {/* 4. Threshold Split Notice */}
      <div className="flex items-center gap-2 px-3.5 py-2 rounded-md bg-surface-subtle border border-surface-border text-xs text-fg-secondary">
        <ShieldCheck className="w-4 h-4 text-brand-500 flex-shrink-0" aria-hidden="true" />
        <span>
          <strong>Data Partitioning:</strong> {meta.threshold_split} (Default fresh-crossing decision threshold:{' '}
          <code className="font-mono text-fg-primary">{meta.alert_threshold.toFixed(2)}</code>).
        </span>
      </div>
    </header>
  );
};
