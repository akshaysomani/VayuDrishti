import React, { useState, useEffect, useRef } from 'react';
import {
  Bell,
  AlertTriangle,
  Clock,
  Users,
  RefreshCw,
  Sliders,
  Database,
  MapPin,
  Info,
  ShieldAlert,
  HelpCircle,
} from 'lucide-react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { fetchLiveAlert } from '../../services/liveAlertService';
import type { LiveAlertPayload } from '../../types/liveAlert';
import alertDataRaw from '../../data/alert_data.json';

gsap.registerPlugin(useGSAP);

interface StationOption {
  id: string;
  name: string;
  city: string;
}

const alertData = alertDataRaw as {
  stations: Record<string, StationOption>;
};

const stationList: StationOption[] = Object.values(alertData.stations).slice(0, 30);

export const LiveAlertCard: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);

  // State
  const [selectedStationId, setSelectedStationId] = useState<string>('DL001'); // Alipur, Delhi
  const [isDemoMode, setIsDemoMode] = useState<boolean>(true);
  const [withHistoryBuffer, setWithHistoryBuffer] = useState<boolean>(true);
  const [demoTier, setDemoTier] = useState<
    'nominal' | 'watch' | 'elevated' | 'high' | 'stale' | 'error' | 'model_unavailable'
  >('watch');
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<LiveAlertPayload | null>(null);

  const loadData = async (
    stationId: string,
    demo: boolean,
    tier: typeof demoTier,
    seedHistory: boolean
  ) => {
    setLoading(true);
    try {
      const payload = await fetchLiveAlert({
        stationId,
        demo,
        demoTier: tier,
        seedHistory: !demo && seedHistory,
      });
      setData(payload);
    } catch (err) {
      console.error('[LiveAlertCard] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(selectedStationId, isDemoMode, demoTier, withHistoryBuffer);
  }, [selectedStationId, isDemoMode, demoTier, withHistoryBuffer]);

  // Subtle GSAP micro-interaction on badge transition (respects prefers-reduced-motion)
  useGSAP(
    () => {
      if (!badgeRef.current) return;
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) return;

      gsap.fromTo(
        badgeRef.current,
        { scale: 0.96, opacity: 0.7 },
        { scale: 1.0, opacity: 1.0, duration: 0.25, ease: 'power2.out' }
      );
    },
    { dependencies: [data?.inference?.risk_tier.tier, data?.status], scope: containerRef }
  );

  const tier = data?.inference?.risk_tier;
  const isDemo = data?.is_demo;

  return (
    <div
      ref={containerRef}
      className={`p-5 sm:p-6 rounded-2xl border shadow-elevation2 transition-all relative overflow-hidden ${
        isDemo
          ? 'bg-surface-card border-brand-500/30'
          : 'bg-surface-card border-surface-border'
      }`}
    >
      {/* Top Banner: LIVE / DEMO indicator & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-surface-border">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
              isDemo
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30'
                : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isDemo ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'
              }`}
              aria-hidden="true"
            />
            <span>{isDemo ? 'DEMO DATA — NOT LIVE' : 'LIVE FEED — Development Server'}</span>
          </div>

          <span className="text-xs text-fg-muted font-mono hidden sm:inline">
            Source: {data?.observation.source ?? 'WAQI'} (Adapter)
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Demo toggle button */}
          <button
            type="button"
            onClick={() => setIsDemoMode((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
              isDemoMode
                ? 'bg-brand-500 text-white border-brand-600'
                : 'bg-surface-subtle hover:bg-surface-hover border-surface-border text-fg-secondary'
            }`}
            title="Toggle between Live WAQI adapter and deterministic demo scenarios"
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>{isDemoMode ? 'Demo Mode Active' : 'Switch to Demo'}</span>
          </button>

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => loadData(selectedStationId, isDemoMode, demoTier, withHistoryBuffer)}
            disabled={loading}
            className="p-1.5 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-fg-secondary hover:text-fg-primary transition-colors cursor-pointer disabled:opacity-50"
            title="Refresh Observation"
            aria-label="Refresh Observation"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Live Continuous Ingestion Status Banner (Visible when Demo Mode is NOT active) */}
      {!isDemoMode && (
        <div className="mt-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>Continuous WAQI Ingestion & Historical Buffer</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setWithHistoryBuffer((prev) => !prev)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold border transition-colors cursor-pointer ${
                  withHistoryBuffer
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-surface-card text-fg-secondary border-surface-border'
                }`}
                title="Toggle between raw isolated WAQI reading and 72-hour station telemetry buffer"
              >
                {withHistoryBuffer ? '72h Buffer: ACTIVE' : '72h Buffer: OFF (Raw Feed)'}
              </button>
            </div>
          </div>
          <div className="text-[11px] text-emerald-900/80 dark:text-emerald-300/80 flex flex-wrap items-center justify-between gap-2">
            <span>
              {withHistoryBuffer
                ? 'Station telemetry history loaded for days t-2 and t-1; genuine Phase 1 lag1 & rolling3 enabled.'
                : 'Raw isolated live WAQI reading only. Because Phase 1 requires lags, status will report MODEL UNAVAILABLE.'}
            </span>
          </div>
        </div>
      )}

      {/* Demo Tier Scenario Switcher (Visible when Demo Mode is Active) */}
      {isDemoMode && (
        <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" />
              <span>Exercise Demonstration Scenarios</span>
            </span>
            <span className="text-[11px] font-normal text-amber-700/80 dark:text-amber-400/80">
              Deterministic verification fixtures
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { id: 'nominal', label: 'Nominal (p < 0.05)' },
                { id: 'watch', label: 'Watch (0.05 ≤ p < 0.22)' },
                { id: 'elevated', label: 'Elevated (0.22 ≤ p < 0.50)' },
                { id: 'high', label: 'High (p ≥ 0.50)' },
                { id: 'stale', label: 'Stale (> 6h)' },
                { id: 'model_unavailable', label: 'Missing Features' },
                { id: 'error', label: 'API Error' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setDemoTier(item.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                  demoTier === item.id
                    ? 'bg-amber-600 text-white font-bold shadow-sm'
                    : 'bg-surface-card hover:bg-surface-hover text-fg-secondary border border-surface-border'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Body Grid */}
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Station Selector & Observation Metadata */}
        <div className="lg:col-span-4 space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="live-station-select"
              className="text-xs font-semibold text-fg-muted uppercase tracking-wider flex items-center gap-1.5"
            >
              <MapPin className="w-3.5 h-3.5 text-brand-500" />
              <span>Reporting Ground Station</span>
            </label>
            <select
              id="live-station-select"
              value={selectedStationId}
              onChange={(e) => setSelectedStationId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-subtle border border-surface-border text-fg-primary text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {stationList.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.city} — {st.name}
                </option>
              ))}
            </select>
          </div>

          {/* Observation Details Table */}
          <div className="p-3.5 rounded-xl bg-surface-subtle border border-surface-border space-y-2 text-xs">
            <div className="flex justify-between items-center text-fg-muted">
              <span>City</span>
              <span className="font-semibold text-fg-primary">{data?.observation.city ?? '—'}</span>
            </div>
            <div className="flex justify-between items-center text-fg-muted">
              <span>Coordinates</span>
              <span className="font-mono text-fg-primary">
                {data ? `${data.observation.latitude.toFixed(4)}, ${data.observation.longitude.toFixed(4)}` : '—'}
              </span>
            </div>
            <div className="flex justify-between items-center text-fg-muted">
              <span>Coord Quality</span>
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider ${
                  data?.observation.coord_quality === 'station' || data?.observation.coord_quality === 'manual'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : data?.observation.coord_quality === 'suspect'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30'
                      : 'bg-slate-500/10 text-slate-700 dark:text-slate-400 border border-slate-500/30'
                }`}
                title={`Coordinate Quality: ${data?.observation.coord_quality}`}
              >
                {data?.observation.coord_quality === 'city_point'
                  ? 'City-Point Fallback'
                  : data?.observation.coord_quality === 'suspect'
                    ? 'Suspect (Reverted)'
                    : 'Exact Station'}
              </span>
            </div>
            <div className="flex justify-between items-center text-fg-muted">
              <span>Observation Time</span>
              <span className="font-mono text-fg-primary">
                {data ? new Date(data.observation.observed_at).toLocaleTimeString() : '—'}
              </span>
            </div>
            <div className="flex justify-between items-center text-fg-muted">
              <span>Data Status</span>
              <span
                className={`inline-flex items-center gap-1 font-semibold ${
                  data?.status === 'fresh'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : data?.status === 'stale'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                <span className="capitalize">{data?.status.replace('_', ' ') ?? '—'}</span>
              </span>
            </div>
            <div className="flex justify-between items-center text-fg-muted">
              <span>Current PM2.5</span>
              <span className="font-mono font-bold text-fg-primary">
                {data?.observation.pm25 != null ? `${data.observation.pm25.toFixed(1)} µg/m³` : 'Unavailable'}
              </span>
            </div>
          </div>
        </div>

        {/* Center / Right Column: Live Alert Status & Shipped Model Inference */}
        <div className="lg:col-span-8 flex flex-col justify-between space-y-4">
          {/* Status Banners: Stale / Error / Model Unavailable */}
          {data?.status === 'stale' && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-900 dark:text-amber-300 flex items-start gap-2.5 text-xs sm:text-sm"
            >
              <Clock className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div>
                <strong>Stale Observation Warning:</strong> The latest reading from this station is{' '}
                {data.observation.age_minutes} minutes old (&gt; 6 hours). Live alert issuance is paused to prevent false urgency.
              </div>
            </div>
          )}

          {data?.status === 'error' && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-900 dark:text-rose-300 flex items-start gap-2.5 text-xs sm:text-sm"
            >
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
              <div>
                <strong>Upstream Connection Error:</strong> {data.error_message}
              </div>
            </div>
          )}

          {data?.status === 'model_unavailable' && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-900 dark:text-sky-300 flex items-start gap-2.5 text-xs sm:text-sm"
            >
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-sky-600 dark:text-sky-400" />
              <div>
                <strong>MODEL UNAVAILABLE — Historical Features Required:</strong> Live PM2.5 observation is captured ({data.observation.pm25 != null ? `${data.observation.pm25.toFixed(1)} µg/m³` : '—'}), but the shipped Calibrated Logistic Regression model requires 72-hour historical telemetry (<code>pm25_lag1</code> and <code>pm25_rolling3</code>). An isolated live WAQI reading does not provide past daily averages, so inference probability is suppressed to maintain safety.
              </div>
            </div>
          )}

          {/* Active Model Inference Presentation */}
          {tier && data?.inference && (
            <div
              ref={badgeRef}
              className={`p-5 rounded-xl border ${tier.badgeBg} ${tier.badgeBorder} space-y-4`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-3 py-1 rounded-lg text-sm font-black uppercase tracking-wider border ${tier.badgeBorder} ${tier.badgeText} ${tier.badgeBg}`}
                    >
                      {tier.tier}
                    </span>
                    <span className="text-sm font-mono text-fg-secondary">
                      ({tier.rangeLabel})
                    </span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-fg-primary">
                    {(data.inference.probability * 100).toFixed(1)}% Spike Probability
                  </div>
                </div>

                <div className="text-right space-y-1">
                  <div
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                      data.inference.alert_fired
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/40'
                        : 'bg-slate-500/15 text-slate-700 dark:text-slate-400 border border-slate-500/40'
                    }`}
                  >
                    {data.inference.alert_fired ? (
                      <>
                        <Bell className="w-3.5 h-3.5 animate-bounce" />
                        <span>Alert Active ({tier.operationalRole.split(' ')[0]})</span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>No Alert (Nominal)</span>
                      </>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-fg-muted">
                    Threshold: p ≥ 0.050
                  </div>
                </div>
              </div>

              {/* Action Text */}
              <p className="text-xs sm:text-sm text-fg-primary leading-relaxed border-t border-surface-border/60 pt-3">
                <strong>Protocol Action:</strong> {tier.actionText}
              </p>
            </div>
          )}

          {/* Phase 2 Population Exposure Context */}
          {data?.exposure && (
            <div className="p-4 rounded-xl bg-surface-subtle border border-surface-border space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-fg-muted">
                <span className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-brand-500" />
                  <span>Phase 2 Population Exposure Catchment</span>
                </span>
                <span className="text-[11px] font-mono text-fg-muted">
                  WorldPop 2020 1km Union
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div className="p-2.5 rounded-lg bg-surface-card border border-surface-border">
                  <div className="text-[11px] text-fg-muted">Station 5km Buffer</div>
                  <div className="text-sm sm:text-base font-bold text-fg-primary">
                    {data.exposure.station_population_5km.toLocaleString()}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-card border border-surface-border">
                  <div className="text-[11px] text-fg-muted">City 5km Union</div>
                  <div className="text-sm sm:text-base font-bold text-fg-primary">
                    {data.exposure.city_population_5km_union.toLocaleString()}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-card border border-surface-border">
                  <div className="text-[11px] text-fg-muted">Daily Expected Exposed</div>
                  <div className="text-sm sm:text-base font-bold text-fg-primary">
                    {Math.round(data.exposure.city_mean_daily_expected_exposed).toLocaleString()}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-card border border-surface-border">
                  <div className="text-[11px] text-fg-muted">Already Poor Baseline</div>
                  <div className="text-sm sm:text-base font-bold text-fg-primary">
                    {data.exposure.already_poor_share_pct.toFixed(1)}% days
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-fg-secondary leading-normal flex items-start gap-1.5 pt-1">
                <HelpCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-fg-muted" />
                <span>
                  Exposure reflects verified Phase 2 geodesic population raster integration. Model-predicted spike probability is combined with ground monitor buffers without synthesizing ad-hoc population counts.
                </span>
              </div>
            </div>
          )}

          {/* Model & Source Provenance Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-muted pt-2 border-t border-surface-border/60">
            <span className="flex items-center gap-1 font-mono">
              <Database className="w-3 h-3 text-brand-500" />
              <span>Model: calibrated-logreg-v1 (Shipped)</span>
            </span>
            <span className="font-mono text-fg-secondary">
              Observed: {data ? new Date(data.observation.observed_at).toLocaleString() : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LiveAlertCard;
