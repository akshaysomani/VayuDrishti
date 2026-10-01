import React, { useState, useRef } from 'react';
import {
  ShieldCheck,
  CheckCircle,
  XCircle,
  Key,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Calendar,
  MapPin,
  Hash,
  Brain,
  Filter,
  Activity,
  AlertCircle,
  Info,
} from 'lucide-react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { CitizenReportRecord } from '../../types/citizenReport';
import type { ReportTriageRecord, TriageLabel } from '../../types/triage';

export interface StationContext {
  station_id: string;
  station_name: string;
  latest_pm25: number;
  observed_at: string;
  is_stale: boolean;
}

export interface ModerationReportItem extends CitizenReportRecord {
  triage?: ReportTriageRecord | null;
  station_context?: StationContext | null;
}

interface ModerationPanelProps {
  onReportModerated?: () => void;
}

const LABEL_NAMES: Record<TriageLabel, string> = {
  smoke: 'Smoke',
  fire: 'Fire / Burning',
  haze_fog: 'Haze / Smog / Fog',
  dust: 'Dust',
  clear_normal: 'Clear / Normal',
  not_relevant: 'Not Relevant (Indoor/Doc/Selfie)',
};

export const ModerationPanel: React.FC<ModerationPanelProps> = ({
  onReportModerated,
}) => {
  // In-memory token only (never written to localStorage or sessionStorage)
  const [token, setToken] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pendingReports, setPendingReports] = useState<ModerationReportItem[]>([]);
  const [modelEvalInfo, setModelEvalInfo] = useState<{
    is_evaluated: boolean;
    status: string;
    report_path: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterLabel, setFilterLabel] = useState<string>('ALL');

  const panelRef = useRef<HTMLDivElement>(null);

  // Subtle entrance animation respecting prefers-reduced-motion
  useGSAP(
    () => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) return;

      gsap.from('.triage-chip', {
        opacity: 0,
        y: -4,
        duration: 0.3,
        stagger: 0.05,
        ease: 'power2.out',
      });
    },
    { dependencies: [pendingReports, filterLabel], scope: panelRef }
  );

  const fetchPendingReports = async (providedToken?: string) => {
    const activeToken = providedToken ?? token;
    if (!activeToken) return;

    setLoading(true);
    setErrorMessage(null);

    try {
      const resp = await fetch('/api/reports/moderation/list?status=PENDING', {
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
      });

      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 503) {
          setIsAuthenticated(false);
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error ?? 'Invalid moderator token. Access denied.');
        }
        throw new Error(`Failed to load queue (${resp.status})`);
      }

      const data = await resp.json();
      setPendingReports(data.reports ?? []);
      if (data.model_evaluation) {
        setModelEvalInfo(data.model_evaluation);
      }
      setIsAuthenticated(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error accessing moderation queue.';
      setErrorMessage(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleModerationAction = async (
    reportId: string,
    action: 'APPROVE' | 'REJECT'
  ) => {
    setActionInProgress(reportId);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const reason = rejectReasons[reportId] || undefined;
      const resp = await fetch('/api/reports/moderation/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          report_id: reportId,
          action,
          reason,
        }),
      });

      const result = await resp.json();
      if (!resp.ok) {
        throw new Error(result.error ?? 'Action failed.');
      }

      setStatusMessage(
        `Report ${reportId.slice(0, 8)} successfully ${action === 'APPROVE' ? 'APPROVED' : 'REJECTED'}.`
      );

      // Remove from pending list
      setPendingReports((prev) => prev.filter((r) => r.id !== reportId));

      if (onReportModerated) {
        onReportModerated();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to execute moderation.';
      setErrorMessage(msg);
    } finally {
      setActionInProgress(null);
    }
  };

  // Filter queue items by suggested label or mismatch
  const filteredReports = pendingReports.filter((report) => {
    if (filterLabel === 'ALL') return true;
    if (filterLabel === 'MISMATCH') return Boolean(report.triage?.category_mismatch);
    if (filterLabel === 'NOT_RELEVANT') return report.triage?.suggested_label === 'not_relevant';
    if (filterLabel === 'UNCERTAIN') {
      const conf = report.triage?.confidence;
      return (
        report.triage?.status === 'DONE' &&
        (conf === null || conf === undefined || conf < 0.40)
      );
    }
    if (filterLabel === 'PENDING_TRIAGE') {
      return (
        report.triage?.status === 'PENDING' ||
        report.triage?.status === 'RUNNING' ||
        !report.triage
      );
    }
    return report.triage?.suggested_label === filterLabel;
  });

  return (
    <div
      ref={panelRef}
      className="bg-surface-card border border-surface-border rounded-xl p-5 sm:p-7 shadow-elevation1 space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-surface-border pb-4">
        <div>
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-semibold text-sm">
            <ShieldCheck className="w-4 h-4" />
            <span>Moderator Review Queue</span>
          </div>
          <p className="text-xs text-fg-secondary mt-1">
            Protected endpoint for human verification of citizen observations before public syndication.
          </p>
        </div>

        {isAuthenticated && (
          <button
            type="button"
            onClick={() => fetchPendingReports()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover text-xs font-semibold text-fg-primary transition-colors cursor-pointer self-start sm:self-auto disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh Queue</span>
          </button>
        )}
      </div>

      {/* Model Limitations Banner & Evaluation Badge */}
      {isAuthenticated && (
        <div className="space-y-2">
          {/* Limitations note */}
          <div className="p-3 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/70 dark:border-indigo-900/60 flex items-start gap-2.5 text-xs text-indigo-900 dark:text-indigo-200">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-indigo-600 dark:text-indigo-400" />
            <div className="space-y-0.5">
              <span className="font-semibold">AI Triage Advisory: </span>
              <span>
                Trained for general scenes, not validated on Indian urban smog; treat as a hint. Fog, haze, and dust cannot be learned from wildfire datasets. Final decision is always the moderator's click.
              </span>
            </div>
          </div>

          {/* Persistent Unvalidated Model Badge (shown when eval set not yet run) */}
          {(!modelEvalInfo || !modelEvalInfo.is_evaluated) && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  <strong>Unvalidated Model:</strong> Pending real-world evaluation on local Indian urban scenes (reports/triage_evaluation.md).
                </span>
              </div>
              <span className="text-[10px] font-mono uppercase bg-amber-200/60 dark:bg-amber-900/60 px-2 py-0.5 rounded text-amber-900 dark:text-amber-200 whitespace-nowrap">
                NOT EVALUATED
              </span>
            </div>
          )}
        </div>
      )}

      {/* Token Input Bar */}
      {!isAuthenticated && (
        <div className="p-4 rounded-xl bg-surface-subtle border border-surface-border space-y-3">
          <label className="block text-xs font-semibold text-fg-primary">
            Server Moderator Secret Token
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Key className="w-4 h-4 absolute left-3 top-2.5 text-fg-muted" />
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter moderator authentication key..."
                className="w-full pl-9 pr-3 py-2 text-xs font-mono rounded-lg border border-surface-border bg-surface-card text-fg-primary focus:border-brand-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => fetchPendingReports(token)}
              disabled={loading || !token.trim()}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Unlock Queue'}
            </button>
          </div>
          <p className="text-[11px] text-fg-muted">
            The moderator key is verified server-side against environment secrets and never stored in the client bundle.
          </p>
        </div>
      )}

      {/* Status & Error Alerts */}
      {statusMessage && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Pending Items List & Queue Filter Toolbar */}
      {isAuthenticated && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-fg-secondary">
            <div className="flex items-center gap-3">
              <span>
                Pending Moderation:{' '}
                <strong className="text-fg-primary">{pendingReports.length}</strong>
              </span>
              {filterLabel !== 'ALL' && (
                <span className="text-[11px] text-brand-600 dark:text-brand-400 font-medium">
                  Showing {filteredReports.length} matching filter
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setIsAuthenticated(false);
                setToken('');
                setPendingReports([]);
              }}
              className="text-[11px] text-fg-muted hover:text-fg-primary underline cursor-pointer self-start sm:self-auto"
            >
              Lock / Clear Token
            </button>
          </div>

          {/* Queue Filter Bar */}
          {pendingReports.length > 0 && (
            <div className="p-2.5 rounded-lg bg-surface-subtle border border-surface-border flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[11px] font-semibold text-fg-muted flex items-center gap-1 px-1">
                <Filter className="w-3 h-3" /> Filter Queue:
              </span>
              {[
                { id: 'ALL', label: 'All' },
                { id: 'MISMATCH', label: 'Category Mismatch' },
                { id: 'NOT_RELEVANT', label: 'Not Relevant' },
                { id: 'smoke', label: 'Smoke' },
                { id: 'fire', label: 'Fire' },
                { id: 'haze_fog', label: 'Haze / Smog' },
                { id: 'dust', label: 'Dust' },
                { id: 'clear_normal', label: 'Clear' },
                { id: 'UNCERTAIN', label: 'Uncertain (<40%)' },
                { id: 'PENDING_TRIAGE', label: 'Triage In Progress' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFilterLabel(opt.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    filterLabel === opt.id
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'bg-surface-card hover:bg-surface-hover text-fg-secondary border border-surface-border'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {pendingReports.length === 0 ? (
            <div className="text-center py-10 bg-surface-subtle rounded-xl border border-surface-border text-fg-muted space-y-1">
              <CheckCircle className="w-8 h-8 mx-auto text-emerald-500 mb-2 opacity-80" />
              <p className="text-xs font-medium text-fg-primary">Moderation Queue Clear</p>
              <p className="text-[11px]">All submitted citizen photo observations have been reviewed.</p>
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="text-center py-8 bg-surface-subtle rounded-xl border border-surface-border text-fg-muted space-y-2">
              <p className="text-xs font-medium text-fg-primary">No Reports Match Filter</p>
              <p className="text-[11px]">
                No pending observations match the current filter selection ({filterLabel}).
              </p>
              <button
                type="button"
                onClick={() => setFilterLabel('ALL')}
                className="text-xs text-brand-600 dark:text-brand-400 underline cursor-pointer"
              >
                Reset Filter to All
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredReports.map((report) => (
                <div
                  key={report.id}
                  className="p-4 rounded-xl border border-surface-border bg-surface-subtle flex flex-col md:flex-row gap-4 items-start"
                >
                  {/* Photo Thumbnail */}
                  <div className="w-full md:w-40 h-40 flex-shrink-0 rounded-lg overflow-hidden border border-surface-border bg-black/10 relative">
                    <img
                      src={`/api/reports/images/${report.thumb_key}`}
                      alt="Pending observation"
                      className="w-full h-full object-cover"
                    />
                    {report.triage?.category_mismatch && (
                      <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-600 text-white shadow-xs">
                        MISMATCH
                      </span>
                    )}
                  </div>

                  {/* Metadata, Triage Advisory and Review Controls */}
                  <div className="flex-1 space-y-2.5 w-full">
                    {/* Category & Timestamp Strip */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-100 dark:bg-brand-950/60 text-brand-900 dark:text-brand-200 border border-brand-300 dark:border-brand-800">
                          Citizen: {report.category.toUpperCase()}
                        </span>

                        {/* AI Triage Advisory Chip */}
                        {renderTriageChip(report.triage)}
                      </div>

                      <span className="text-[11px] font-mono text-fg-muted flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5" />
                        {new Date(report.created_at).toLocaleString()}
                      </span>
                    </div>

                    {/* Category Mismatch Warning Badge */}
                    {report.triage?.category_mismatch && (
                      <div className="px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                        <span>
                          <strong>Possible Category Mismatch:</strong> Citizen declared "
                          {report.category}" while AI suggestion is "
                          {report.triage.suggested_label ? LABEL_NAMES[report.triage.suggested_label] : 'None'}
                          " ({Math.round((report.triage.confidence || 0) * 100)}% confidence).
                        </span>
                      </div>
                    )}

                    {/* Description */}
                    <p className="text-xs text-fg-primary leading-relaxed bg-surface-card p-2.5 rounded-lg border border-surface-border">
                      {report.description || <em className="text-fg-muted">No description provided.</em>}
                    </p>

                    {/* Read-Only Station Telemetry Context (Requirement 7) */}
                    {report.station_context && (
                      <div className="p-2 rounded-lg bg-surface-card border border-surface-border flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-1.5 text-fg-secondary">
                          <Activity className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                          <span>
                            Nearest monitor: <strong>{report.station_context.station_name}</strong>
                          </span>
                        </div>
                        <div className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="text-fg-primary font-semibold">
                            PM2.5: {report.station_context.latest_pm25.toFixed(1)} µg/m³
                          </span>
                          <span className="text-fg-muted text-[10px]">
                            ({new Date(report.station_context.observed_at).toLocaleTimeString()})
                          </span>
                          {report.station_context.is_stale ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 font-semibold">
                              STALE &gt;6h
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                              Active
                            </span>
                          )}
                          <span className="text-[10px] text-fg-muted italic">
                            [context, not verification]
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Technical Telemetry Metadata */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-fg-secondary font-mono">
                      <div className="flex items-center gap-1.5 truncate">
                        <MapPin className="w-3 h-3 text-brand-500 flex-shrink-0" />
                        <span className="truncate">
                          {report.nearest_station_name ?? 'Station not matched'} (
                          {report.lat.toFixed(4)}, {report.lon.toFixed(4)})
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 truncate">
                        <Hash className="w-3 h-3 text-fg-muted flex-shrink-0" />
                        <span className="truncate">SHA: {report.content_hash.slice(0, 16)}...</span>
                      </div>
                    </div>

                    {/* Review Actions: Final decision is always the moderator's click */}
                    <div className="pt-2 flex flex-col sm:flex-row items-center gap-2">
                      <input
                        type="text"
                        placeholder="Rejection reason (if rejecting)..."
                        value={rejectReasons[report.id] || ''}
                        onChange={(e) =>
                          setRejectReasons({ ...rejectReasons, [report.id]: e.target.value })
                        }
                        className="w-full sm:flex-1 px-3 py-1.5 text-xs rounded-lg border border-surface-border bg-surface-card text-fg-primary focus:outline-none"
                      />

                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          type="button"
                          onClick={() => handleModerationAction(report.id, 'APPROVE')}
                          disabled={actionInProgress === report.id}
                          className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {actionInProgress === report.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="w-3.5 h-3.5" />
                          )}
                          <span>Approve</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleModerationAction(report.id, 'REJECT')}
                          disabled={actionInProgress === report.id}
                          className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {actionInProgress === report.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5" />
                          )}
                          <span>Reject</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Renders compact, stateful AI triage advisory chip
 */
function renderTriageChip(triage?: ReportTriageRecord | null) {
  if (!triage) {
    return (
      <span className="triage-chip px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-subtle text-fg-muted border border-surface-border flex items-center gap-1">
        <Brain className="w-3 h-3 text-fg-muted" />
        AI: Triage queued
      </span>
    );
  }

  if (triage.status === 'PENDING' || triage.status === 'RUNNING') {
    return (
      <span className="triage-chip px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
        AI: Triage in progress...
      </span>
    );
  }

  if (triage.status === 'UNAVAILABLE') {
    return (
      <span className="triage-chip px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 flex items-center gap-1">
        <Brain className="w-3 h-3 text-zinc-400" />
        AI: Triage unavailable
      </span>
    );
  }

  if (triage.status === 'FAILED') {
    return (
      <span className="triage-chip px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 flex items-center gap-1">
        <AlertTriangle className="w-3 h-3 text-rose-500" />
        AI: Triage failed
      </span>
    );
  }

  // Status === 'DONE'
  const confidence = triage.confidence ?? 0;
  const isUncertain = confidence < 0.40;

  if (isUncertain) {
    return (
      <span className="triage-chip px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 flex items-center gap-1">
        <Brain className="w-3 h-3 text-slate-500" />
        AI: Uncertain ({Math.round(confidence * 100)}%)
      </span>
    );
  }

  const label = triage.suggested_label || 'clear_normal';
  const labelDisplay = LABEL_NAMES[label] || label;
  const pct = Math.round(confidence * 100);

  // Semantic color badge based on suggested label
  let colorClasses = 'bg-brand-100 dark:bg-brand-950/60 text-brand-900 dark:text-brand-200 border-brand-300 dark:border-brand-800';
  if (label === 'not_relevant') {
    colorClasses = 'bg-rose-100 dark:bg-rose-950/60 text-rose-900 dark:text-rose-200 border-rose-300 dark:border-rose-800';
  } else if (label === 'fire') {
    colorClasses = 'bg-orange-100 dark:bg-orange-950/60 text-orange-900 dark:text-orange-200 border-orange-300 dark:border-orange-800';
  } else if (label === 'clear_normal') {
    colorClasses = 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800';
  } else if (label === 'dust') {
    colorClasses = 'bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-800';
  } else if (label === 'haze_fog') {
    colorClasses = 'bg-sky-100 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 border-sky-300 dark:border-sky-800';
  }

  return (
    <span
      className={`triage-chip px-2.5 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1.5 ${colorClasses}`}
    >
      <Brain className="w-3 h-3 opacity-80" />
      AI: {labelDisplay} ({pct}%)
    </span>
  );
}
