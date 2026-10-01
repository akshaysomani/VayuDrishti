import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  Camera,
  ShieldAlert,
  ListFilter,
  ShieldCheck,
  RefreshCw,
  X,
  MapPin,
  Calendar,
  AlertCircle,
} from 'lucide-react';
import { ReportSubmissionForm } from './ReportSubmissionForm';
import { ReportCard } from './ReportCard';
import { ModerationPanel } from './ModerationPanel';
import type { PublicCitizenReport } from '../../types/citizenReport';

gsap.registerPlugin(useGSAP);

export const CitizenReportsSection: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'submit' | 'moderate'>('feed');
  const [reports, setReports] = useState<PublicCitizenReport[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lightbox modal state
  const [selectedPhoto, setSelectedPhoto] = useState<PublicCitizenReport | null>(null);

  const fetchApprovedReports = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/reports?limit=50');
      if (!resp.ok) {
        throw new Error(`Failed to load reports (${resp.status})`);
      }
      const data = await resp.json();
      setReports(data.reports ?? []);
      setTotalCount(data.total ?? 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error fetching citizen reports.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovedReports();
  }, []);

  // Subtle GSAP card entrance animation with prefers-reduced-motion check
  useGSAP(
    () => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        gsap.set('.citizen-sub-card', { opacity: 1, y: 0 });
        return;
      }

      gsap.fromTo(
        '.citizen-sub-card',
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: 0.3,
          ease: 'power2.out',
          clearProps: 'transform',
        }
      );
    },
    { dependencies: [activeTab, reports.length], scope: containerRef }
  );

  return (
    <div
      ref={containerRef}
      className="bg-surface-card border border-surface-border rounded-xl p-5 sm:p-7 shadow-elevation2 space-y-6"
    >
      {/* 1. SECTION HEADER WITH STRICT NOT-MODEL-INPUT DISCLAIMER */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-fg-primary">
            <div className="p-2 rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold">
                Citizen Photo Reports & Observational Context
              </h2>
              <p className="text-xs text-fg-secondary">
                Ground-level crowd observations for acute local smoke, burning, and dust events.
              </p>
            </div>
          </div>

          {/* Tab Navigation Pill Bar */}
          <div className="flex p-1 rounded-xl bg-surface-subtle border border-surface-border self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setActiveTab('feed')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'feed'
                  ? 'bg-surface-card text-brand-600 dark:text-brand-400 shadow-sm'
                  : 'text-fg-secondary hover:text-fg-primary'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5" />
              <span>Public Feed ({totalCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('submit')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'submit'
                  ? 'bg-surface-card text-brand-600 dark:text-brand-400 shadow-sm'
                  : 'text-fg-secondary hover:text-fg-primary'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Submit Report</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('moderate')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'moderate'
                  ? 'bg-surface-card text-brand-600 dark:text-brand-400 shadow-sm'
                  : 'text-fg-secondary hover:text-fg-primary'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Moderation Desk</span>
            </button>
          </div>
        </div>

        {/* PROMINENT SAFETY BANNER: CITIZEN REPORTS ARE NEVER MODEL INPUTS */}
        <div
          role="note"
          aria-label="Model isolation statement"
          className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-950 dark:text-amber-200 text-xs flex items-start gap-2.5"
        >
          <ShieldAlert className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="leading-relaxed">
            <strong className="font-semibold text-amber-900 dark:text-amber-100">
              Qualitative Context Only — Strict Model Isolation:
            </strong>{' '}
            Citizen reports are unverified crowd observations and <strong>NOT model inputs</strong>.
            The production Calibrated Logistic Regression model computes probabilities solely from
            regulatory CPCB monitor telemetry (PM2.5, lag1, rolling3, ratio_90). Citizen uploads do
            not modify model coefficients, thresholds, risk tiers, or population exposure equations.
          </div>
        </div>
      </div>

      {/* 2. TAB CONTENT */}
      {activeTab === 'feed' && (
        <div className="citizen-sub-card space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-fg-secondary">
              Showing approved observations verified by dashboard moderators.
            </span>
            <button
              type="button"
              onClick={fetchApprovedReports}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-fg-muted hover:text-fg-primary rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {loading && reports.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="h-64 rounded-xl bg-surface-subtle animate-pulse border border-surface-border"
                />
              ))}
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-12 rounded-xl bg-surface-subtle border border-surface-border space-y-3">
              <Camera className="w-10 h-10 mx-auto text-fg-muted opacity-40" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-fg-primary">No Approved Reports Yet</p>
                <p className="text-xs text-fg-secondary max-w-md mx-auto">
                  Be the first to submit a photo observation of local smoke or dust in your area.
                  Once verified, it will appear here.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('submit')}
                className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-sm"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Submit Ground Observation</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {reports.map((report) => (
                <ReportCard key={report.id} report={report} onOpenPhoto={setSelectedPhoto} />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'submit' && (
        <div className="citizen-sub-card">
          <ReportSubmissionForm
            onReportSubmitted={() => {
              setActiveTab('feed');
              fetchApprovedReports();
            }}
          />
        </div>
      )}

      {activeTab === 'moderate' && (
        <div className="citizen-sub-card">
          <ModerationPanel onReportModerated={fetchApprovedReports} />
        </div>
      )}

      {/* 3. LIGHTBOX MODAL FOR FULL-SIZE PHOTO VIEWING */}
      {selectedPhoto && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div
            className="relative max-w-3xl w-full bg-surface-card rounded-2xl overflow-hidden border border-surface-border shadow-elevation3"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-3 border-b border-surface-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-100 dark:bg-brand-950/60 text-brand-900 dark:text-brand-200 border border-brand-300 dark:border-brand-800">
                  {selectedPhoto.category.toUpperCase()}
                </span>
                <span className="text-xs text-fg-muted font-mono flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(selectedPhoto.created_at).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPhoto(null)}
                className="p-1.5 rounded-lg text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer"
                aria-label="Close photo view"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Photo */}
            <div className="bg-black flex items-center justify-center max-h-[60vh] overflow-hidden">
              <img
                src={selectedPhoto.image_url}
                alt={`Full observation of ${selectedPhoto.category}`}
                className="w-full h-full object-contain"
              />
            </div>

            {/* Footer Details */}
            <div className="p-5 space-y-3 bg-surface-card">
              {selectedPhoto.description && (
                <p className="text-xs text-fg-primary leading-relaxed">
                  {selectedPhoto.description}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-secondary pt-2 border-t border-surface-border font-mono">
                <div className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-brand-500" />
                  <span>
                    Nearest Monitor: <strong>{selectedPhoto.nearest_station_name}</strong> (
                    {selectedPhoto.nearest_station_distance_km} km away)
                  </span>
                </div>
                <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>Unverified observational context</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
