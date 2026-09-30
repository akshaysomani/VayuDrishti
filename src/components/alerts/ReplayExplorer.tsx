import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Calendar,
  CheckCircle2,
  XCircle,
  AlertOctagon,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Table as TableIcon,
  LineChart,
} from 'lucide-react';
import type { PredictionsColumnar, OperatingPointDef } from '../../types/alert';

export interface StationDayRecord {
  date: string;
  station_id: string;
  city: string;
  pm25_today: number;
  pm25_pred_tomorrow: number;
  pm25_actual_tomorrow: number;
  risk_score: number | null;
  status?: string;
  actual_poor_or_worse: boolean;
  actual_fresh_crossing: boolean;
  fire_any_100km: boolean;
  fire_upwind_100km: boolean;
  top10_upwind: boolean;
}

export type DayOutcome =
  | 'caught'
  | 'missed'
  | 'false_alarm'
  | 'quiet_correctly'
  | 'already_poor_today';

interface ReplayExplorerProps {
  predictions: PredictionsColumnar;
  operatingPoint: OperatingPointDef;
  onNavigateToMonitoring?: (stationId: string) => void;
}

export const ReplayExplorer: React.FC<ReplayExplorerProps> = ({
  predictions,
  operatingPoint,
  onNavigateToMonitoring,
}) => {
  // 1. Group predictions by station_id
  const { stationMap, stationList } = useMemo(() => {
    const map = new Map<string, StationDayRecord[]>();
    const n = predictions.date.length;

    for (let i = 0; i < n; i++) {
      const stId = predictions.station_id[i];
      let arr = map.get(stId);
      if (!arr) {
        arr = [];
        map.set(stId, arr);
      }
      arr.push({
        date: predictions.date[i],
        station_id: stId,
        city: predictions.city[i],
        pm25_today: predictions.pm25_today[i],
        pm25_pred_tomorrow: predictions.pm25_pred_tomorrow[i],
        pm25_actual_tomorrow: predictions.pm25_actual_tomorrow[i],
        risk_score: predictions.risk_score[i],
        actual_poor_or_worse: predictions.actual_poor_or_worse[i],
        actual_fresh_crossing: predictions.actual_fresh_crossing[i],
        fire_any_100km: predictions.fire_any_100km[i],
        fire_upwind_100km: predictions.fire_upwind_100km[i],
        top10_upwind: predictions.top10_upwind[i],
      });
    }

    // Sort days for each station chronologically
    for (const [_, days] of map.entries()) {
      days.sort((a, b) => a.date.localeCompare(b.date));
    }

    const list = Array.from(map.keys()).sort((a, b) => {
      const cityA = map.get(a)?.[0]?.city ?? '';
      const cityB = map.get(b)?.[0]?.city ?? '';
      return cityA.localeCompare(cityB) || a.localeCompare(b);
    });

    return { stationMap: map, stationList: list };
  }, [predictions]);

  // Selected station (defaults to Delhi DL003 or first available)
  const [selectedStationId, setSelectedStationId] = useState<string>(() => {
    return stationList.includes('DL003') ? 'DL003' : stationList[0] ?? '';
  });

  const currentStationDays = useMemo(() => {
    return stationMap.get(selectedStationId) ?? [];
  }, [stationMap, selectedStationId]);

  // Selected day index within station days
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(0);
  const [showTable, setShowTable] = useState<boolean>(false);
  const [announcement, setAnnouncement] = useState<string>('');
  const scrubContainerRef = useRef<HTMLDivElement>(null);

  // Clamp selectedDayIdx when station changes
  useEffect(() => {
    if (selectedDayIdx >= currentStationDays.length) {
      setSelectedDayIdx(Math.max(0, currentStationDays.length - 1));
    }
  }, [currentStationDays, selectedDayIdx]);

  const activeDay: StationDayRecord | undefined = currentStationDays[selectedDayIdx];

  // Helper to determine day outcome
  const getDayOutcome = (day: StationDayRecord, threshold: number): DayOutcome => {
    if (day.pm25_today > 90) {
      return 'already_poor_today';
    }
    const alertFired = day.risk_score !== null && day.risk_score !== undefined && day.risk_score >= threshold;
    const eventOccurred = day.actual_fresh_crossing;

    if (alertFired && eventOccurred) return 'caught';
    if (!alertFired && eventOccurred) return 'missed';
    if (alertFired && !eventOccurred) return 'false_alarm';
    return 'quiet_correctly';
  };

  // Station-level tally of outcome chips
  const stationTally = useMemo(() => {
    const tally = {
      caught: 0,
      missed: 0,
      false_alarm: 0,
      quiet_correctly: 0,
      already_poor_today: 0,
    };
    for (const d of currentStationDays) {
      const outcome = getDayOutcome(d, operatingPoint.threshold);
      tally[outcome] += 1;
    }
    return tally;
  }, [currentStationDays, operatingPoint.threshold]);

  const activeOutcome = activeDay
    ? getDayOutcome(activeDay, operatingPoint.threshold)
    : 'quiet_correctly';

  // Keyboard navigation for scrubber
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (currentStationDays.length === 0) return;

    let newIdx = selectedDayIdx;
    if (e.key === 'ArrowRight') {
      newIdx = Math.min(currentStationDays.length - 1, selectedDayIdx + 1);
    } else if (e.key === 'ArrowLeft') {
      newIdx = Math.max(0, selectedDayIdx - 1);
    } else if (e.key === 'PageDown') {
      newIdx = Math.min(currentStationDays.length - 1, selectedDayIdx + 7);
    } else if (e.key === 'PageUp') {
      newIdx = Math.max(0, selectedDayIdx - 7);
    } else if (e.key === 'Home') {
      newIdx = 0;
    } else if (e.key === 'End') {
      newIdx = currentStationDays.length - 1;
    } else {
      return;
    }

    e.preventDefault();
    setSelectedDayIdx(newIdx);
    const day = currentStationDays[newIdx];
    if (day) {
      setAnnouncement(
        `Selected date ${day.date}. PM2.5 today ${day.pm25_today.toFixed(1)}, forecast ${day.pm25_pred_tomorrow.toFixed(1)}, actual next day ${day.pm25_actual_tomorrow.toFixed(1)}. Outcome: ${getDayOutcome(day, operatingPoint.threshold).replace(/_/g, ' ')}.`
      );
    }
  };

  // SVG Chart Dimensions & Math
  const width = 800;
  const height = 260;
  const padding = { top: 20, right: 20, bottom: 35, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = useMemo(() => {
    if (currentStationDays.length === 0) return 300;
    let m = 150;
    for (const d of currentStationDays) {
      m = Math.max(m, d.pm25_today, d.pm25_pred_tomorrow, d.pm25_actual_tomorrow);
    }
    return Math.min(600, Math.ceil(m / 50) * 50);
  }, [currentStationDays]);

  const numDays = currentStationDays.length;
  const getX = (idx: number) => padding.left + (idx / Math.max(1, numDays - 1)) * chartW;
  const getY = (val: number) => padding.top + chartH - (Math.min(val, maxVal) / maxVal) * chartH;

  // Build SVG path strings
  const todayPath = useMemo(() => {
    if (numDays === 0) return '';
    return currentStationDays.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.pm25_today).toFixed(1)}`).join(' ');
  }, [currentStationDays, maxVal]);

  const predPath = useMemo(() => {
    if (numDays === 0) return '';
    return currentStationDays.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.pm25_pred_tomorrow).toFixed(1)}`).join(' ');
  }, [currentStationDays, maxVal]);

  const actualPath = useMemo(() => {
    if (numDays === 0) return '';
    return currentStationDays.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.pm25_actual_tomorrow).toFixed(1)}`).join(' ');
  }, [currentStationDays, maxVal]);

  // Helper to determine CPCB category label
  const getCpcbBand = (val: number): string => {
    if (val <= 30) return 'Good';
    if (val <= 60) return 'Satisfactory';
    if (val <= 90) return 'Moderate';
    if (val <= 120) return 'Poor';
    if (val <= 250) return 'Very Poor';
    return 'Severe';
  };

  // CPCB 24-hr PM2.5 Breakpoints (µg/m³): Good: 0-30, Satisfactory: 30-60, Moderate: 60-90, Poor: 90-120, Very Poor: 120-250, Severe: >250
  const aqiBands = [
    { low: 0, high: 30, color: 'var(--aqi-good-bg)', label: 'Good' },
    { low: 30, high: 60, color: 'var(--aqi-satisfactory-bg)', label: 'Satisfactory' },
    { low: 60, high: 90, color: 'var(--aqi-moderate-bg)', label: 'Moderate' },
    { low: 90, high: 120, color: 'var(--aqi-poor-bg)', label: 'Poor' },
    { low: 120, high: 250, color: 'var(--aqi-verypoor-bg)', label: 'Very Poor' },
    { low: 250, high: maxVal, color: 'var(--aqi-severe-bg)', label: 'Severe' },
  ];

  return (
    <section
      aria-labelledby="replay-explorer-heading"
      className="p-4 sm:p-6 rounded-xl bg-surface-card border border-surface-border shadow-elevation1 space-y-5"
    >
      {/* Screen reader region for accessibility announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* Header and Station Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-brand-500" aria-hidden="true" />
            <h2 id="replay-explorer-heading" className="text-base sm:text-lg font-bold text-fg-primary">
              2019 Historical Replay Explorer
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-fg-secondary">
            Scrub daily observations, next-day model predictions, and persistence forecasts against CPCB air quality categories.
          </p>
        </div>

        {/* Station Picker Controls */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="station-picker" className="text-[11px] font-mono text-fg-muted">
              Select Reporting Station:
            </label>
            <select
              id="station-picker"
              value={selectedStationId}
              onChange={(e) => {
                setSelectedStationId(e.target.value);
                setSelectedDayIdx(0);
              }}
              className="px-3 py-1.5 rounded-lg border border-surface-border bg-surface-card text-xs font-mono text-fg-primary focus:outline-hidden focus:ring-2 focus:ring-brand-500 cursor-pointer"
            >
              {stationList.map((stId) => {
                const city = stationMap.get(stId)?.[0]?.city ?? '';
                const count = stationMap.get(stId)?.length ?? 0;
                return (
                  <option key={stId} value={stId}>
                    {city} ({stId}) - {count} days
                  </option>
                );
              })}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowTable(!showTable)}
            aria-pressed={showTable}
            className="self-end px-3 py-1.5 rounded-lg border border-surface-border bg-surface-subtle hover:bg-surface-hover text-xs font-medium text-fg-secondary flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {showTable ? <LineChart className="w-3.5 h-3.5 text-brand-500" /> : <TableIcon className="w-3.5 h-3.5 text-brand-500" />}
            <span>{showTable ? 'Show Chart' : 'Show as Table'}</span>
          </button>
        </div>
      </div>

      {/* Station Tally Strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[11px] font-mono text-fg-muted mr-1">Station 2019 Tally:</span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-600 dark:border-emerald-400/50 font-mono">
          <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
          <span>Caught: {stationTally.caught}</span>
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/10 text-rose-800 dark:text-rose-300 border border-rose-600 dark:border-rose-400/60 font-mono">
          <XCircle className="w-3 h-3 text-rose-600 dark:text-rose-400" />
          <span>Missed: {stationTally.missed}</span>
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-600 dark:border-amber-400/60 font-mono">
          <AlertOctagon className="w-3 h-3 text-amber-600 dark:text-amber-400" />
          <span>False Alarm: {stationTally.false_alarm}</span>
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-subtle text-slate-700 dark:text-slate-200 border border-slate-500 dark:border-slate-400/60 font-mono">
          <ShieldCheck className="w-3 h-3 text-fg-muted" />
          <span>Quiet: {stationTally.quiet_correctly}</span>
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-subtle text-slate-700 dark:text-slate-200 border border-slate-500 dark:border-slate-400/60 font-mono">
          <span>Already Poor: {stationTally.already_poor_today}</span>
        </span>
      </div>

      {/* Main Interactive Chart or Tabular View */}
      {!showTable ? (
        <div
          ref={scrubContainerRef}
          tabIndex={0}
          role="slider"
          aria-label="Interactive 2019 calendar day scrubber"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, numDays - 1)}
          aria-valuenow={selectedDayIdx}
          aria-valuetext={activeDay ? `${activeDay.date}: PM2.5 ${activeDay.pm25_today.toFixed(1)} µg/m³` : ''}
          onKeyDown={handleKeyDown}
          className="relative focus:outline-hidden focus:ring-2 focus:ring-brand-500 rounded-lg p-1 bg-surface-subtle border border-surface-border"
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto select-none overflow-visible font-mono text-[10px]"
            aria-hidden="true"
          >
            <defs>
              {/* AQI category bands clip */}
              <clipPath id="chart-area-clip">
                <rect x={padding.left} y={padding.top} width={chartW} height={chartH} />
              </clipPath>
            </defs>

            {/* AQI Category Background Bands with >= 3:1 dividing borders and category labels */}
            <g clipPath="url(#chart-area-clip)">
              {aqiBands.map((band, idx) => {
                const yTop = getY(band.high);
                const yBottom = getY(band.low);
                const bandH = Math.max(0, yBottom - yTop);
                return (
                  <g key={idx}>
                    <rect
                      x={padding.left}
                      y={yTop}
                      width={chartW}
                      height={bandH}
                      fill={band.color}
                    />
                    {/* Top border of band (>= 3:1 contrast against chart background) */}
                    {idx < aqiBands.length - 1 && (
                      <line
                        x1={padding.left}
                        x2={padding.left + chartW}
                        y1={yTop}
                        y2={yTop}
                        stroke="var(--text-muted)"
                        strokeDasharray="2 3"
                        strokeWidth={1}
                        opacity={0.65}
                      />
                    )}
                    {/* In-chart band category label */}
                    {bandH >= 14 && (
                      <text
                        x={padding.left + chartW - 6}
                        y={yTop + Math.min(14, bandH / 2 + 4)}
                        textAnchor="end"
                        fill="var(--text-muted)"
                        fontSize="9"
                        fontWeight="600"
                        opacity={0.85}
                      >
                        {band.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* 90 µg/m³ Poor Threshold Reference Line (Solid stroke with >= 3:1 contrast) */}
              <line
                x1={padding.left}
                x2={padding.left + chartW}
                y1={getY(90)}
                y2={getY(90)}
                stroke="var(--aqi-poor)"
                strokeDasharray="4 3"
                strokeWidth={1.5}
              />
            </g>

            {/* Y Axis Grid & Labels */}
            {[0, 60, 90, 150, 250, maxVal].map((tick) => {
              if (tick > maxVal) return null;
              const y = getY(tick);
              return (
                <g key={tick}>
                  <line
                    x1={padding.left}
                    x2={padding.left + chartW}
                    y1={y}
                    y2={y}
                    stroke="var(--border-subtle)"
                    strokeWidth={tick === 90 ? 0 : 0.8}
                  />
                  <text
                    x={padding.left - 6}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--text-muted)"
                    fontSize="9"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {/* Series Paths */}
            <path
              d={todayPath}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={1.2}
              opacity={0.7}
            />
            <path
              d={predPath}
              fill="none"
              stroke="var(--brand-500)"
              strokeWidth={2}
            />
            <path
              d={actualPath}
              fill="none"
              stroke="var(--text-primary)"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />

            {/* Alert Fired Beacons for Current Operating Point */}
            {currentStationDays.map((d, i) => {
              if (d.risk_score !== null && d.risk_score !== undefined && d.risk_score >= operatingPoint.threshold && d.pm25_today <= 90) {
                const x = getX(i);
                const y = getY(d.pm25_pred_tomorrow);
                return (
                  <circle
                    key={i}
                    cx={x}
                    cy={y}
                    r={3}
                    fill="var(--aqi-poor)"
                    stroke="var(--surface-card)"
                    strokeWidth={1}
                  />
                );
              }
              return null;
            })}

            {/* Selected Day Cursor */}
            {activeDay && (
              <g>
                <line
                  x1={getX(selectedDayIdx)}
                  x2={getX(selectedDayIdx)}
                  y1={padding.top}
                  y2={padding.top + chartH}
                  stroke="var(--brand-500)"
                  strokeWidth={1.5}
                />
                <circle
                  cx={getX(selectedDayIdx)}
                  cy={getY(activeDay.pm25_pred_tomorrow)}
                  r={4.5}
                  fill="var(--brand-500)"
                  stroke="var(--surface-card)"
                  strokeWidth={1.5}
                />
                <circle
                  cx={getX(selectedDayIdx)}
                  cy={getY(activeDay.pm25_actual_tomorrow)}
                  r={3.5}
                  fill="var(--text-primary)"
                  stroke="var(--surface-card)"
                  strokeWidth={1}
                />
              </g>
            )}

            {/* X Axis Month Labels */}
            {['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'].map((m, mIdx) => {
              const dayOffset = Math.min(numDays - 1, mIdx * 60 + 15);
              return (
                <text
                  key={m}
                  x={getX(dayOffset)}
                  y={height - 10}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="10"
                >
                  {m}
                </text>
              );
            })}
          </svg>

          {/* Interactive Click Overlay */}
          <div
            className="absolute inset-0 cursor-crosshair"
            onClick={(e) => {
              const rect = scrubContainerRef.current?.getBoundingClientRect();
              if (!rect) return;
              const clickX = e.clientX - rect.left - padding.left;
              const pct = Math.max(0, Math.min(1, clickX / chartW));
              const idx = Math.min(numDays - 1, Math.round(pct * (numDays - 1)));
              setSelectedDayIdx(idx);
            }}
          />
        </div>
      ) : (
        /* Accessible Table View */
        <div className="overflow-x-auto max-h-96 border border-surface-border rounded-lg">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 bg-surface-subtle border-b border-surface-border">
              <tr className="font-mono uppercase text-[10px] text-fg-muted">
                <th className="py-2 px-3">Date</th>
                <th className="py-2 px-3 text-right">PM2.5 Today</th>
                <th className="py-2 px-3 text-right">Model Forecast</th>
                <th className="py-2 px-3 text-right">Actual Next Day</th>
                <th className="py-2 px-3 text-right">Risk Score</th>
                <th className="py-2 px-3 text-center">Alert Fired</th>
                <th className="py-2 px-3">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {currentStationDays.map((d, i) => {
                const outcome = getDayOutcome(d, operatingPoint.threshold);
                const alertFired = d.risk_score !== null && d.risk_score !== undefined && d.risk_score >= operatingPoint.threshold && d.pm25_today <= 90;
                return (
                  <tr
                    key={d.date}
                    onClick={() => setSelectedDayIdx(i)}
                    className={`cursor-pointer transition-colors ${
                      i === selectedDayIdx ? 'bg-brand-500/10' : 'hover:bg-surface-subtle/50'
                    }`}
                  >
                    <td className="py-2 px-3 font-mono">{d.date}</td>
                    <td className="py-2 px-3 text-right font-mono">{d.pm25_today.toFixed(1)}</td>
                    <td className="py-2 px-3 text-right font-mono font-semibold text-brand-600 dark:text-brand-400">
                      {d.pm25_pred_tomorrow.toFixed(1)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">{d.pm25_actual_tomorrow.toFixed(1)}</td>
                    <td className="py-2 px-3 text-right font-mono">{d.risk_score !== null && d.risk_score !== undefined ? d.risk_score.toFixed(2) : '—'}</td>
                    <td className="py-2 px-3 text-center font-mono">
                      {alertFired ? 'YES' : 'No'}
                    </td>
                    <td className="py-2 px-3 font-medium capitalize">
                      {outcome.replace(/_/g, ' ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Scrub Controls & Day Outcome Details */}
      {activeDay && (
        <div className="p-3.5 rounded-lg bg-surface-subtle border border-surface-border flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
          {/* Day Scrub Steppers */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={selectedDayIdx === 0}
              onClick={() => setSelectedDayIdx(Math.max(0, selectedDayIdx - 1))}
              className="p-1 rounded border border-surface-border hover:bg-surface-card disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              aria-label="Previous day"
            >
              <ChevronLeft className="w-4 h-4 text-fg-primary" />
            </button>
            <div className="font-mono text-fg-primary font-semibold px-2 py-0.5 rounded bg-surface-card border border-surface-border">
              {activeDay.date}
            </div>
            <button
              type="button"
              disabled={selectedDayIdx === numDays - 1}
              onClick={() => setSelectedDayIdx(Math.min(numDays - 1, selectedDayIdx + 1))}
              className="p-1 rounded border border-surface-border hover:bg-surface-card disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              aria-label="Next day"
            >
              <ChevronRight className="w-4 h-4 text-fg-primary" />
            </button>
            <span className="text-[11px] font-mono text-fg-muted ml-2">
              (Use arrow keys to step, PgUp/PgDn for weeks)
            </span>
          </div>

          {/* Metric Readouts with explicit CPCB category text */}
          <div className="flex flex-wrap items-center gap-3 font-mono">
            <div>
              <span className="text-[10px] text-fg-muted block">Today PM2.5</span>
              <span className="font-semibold text-fg-primary">{activeDay.pm25_today.toFixed(1)} µg/m³</span>
              <span className="text-[10px] text-fg-muted block">({getCpcbBand(activeDay.pm25_today)})</span>
            </div>
            <div>
              <span className="text-[10px] text-fg-muted block">Model Forecast</span>
              <span className="font-semibold text-brand-600 dark:text-brand-400">
                {activeDay.pm25_pred_tomorrow.toFixed(1)} µg/m³
              </span>
              <span className="text-[10px] text-fg-muted block">({getCpcbBand(activeDay.pm25_pred_tomorrow)})</span>
            </div>
            <div>
              <span className="text-[10px] text-fg-muted block">Actual Tomorrow</span>
              <span className="font-semibold text-fg-primary">{activeDay.pm25_actual_tomorrow.toFixed(1)} µg/m³</span>
              <span className="text-[10px] text-fg-muted block">({getCpcbBand(activeDay.pm25_actual_tomorrow)})</span>
            </div>
            <div>
              <span className="text-[10px] text-fg-muted block">Risk Score</span>
              <span className="font-semibold text-fg-primary">{activeDay.risk_score !== null && activeDay.risk_score !== undefined ? activeDay.risk_score.toFixed(2) : '— (Already Poor)'}</span>
            </div>
          </div>

          {/* Selected Day Outcome Chip */}
          <div className="flex-shrink-0">
            {activeOutcome === 'caught' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-600 dark:border-emerald-400/50 font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Caught Spike</span>
              </span>
            )}
            {activeOutcome === 'missed' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/10 text-rose-800 dark:text-rose-300 border border-rose-600 dark:border-rose-400/60 font-medium">
                <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <span>Missed Spike</span>
              </span>
            )}
            {activeOutcome === 'false_alarm' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-600 dark:border-amber-400/60 font-medium">
                <AlertOctagon className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>False Alarm</span>
              </span>
            )}
            {activeOutcome === 'quiet_correctly' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-card text-slate-700 dark:text-slate-200 border border-slate-500 dark:border-slate-400/60 font-medium">
                <ShieldCheck className="w-4 h-4 text-fg-muted" />
                <span>Quiet, Correctly</span>
              </span>
            )}
            {activeOutcome === 'already_poor_today' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-card text-slate-700 dark:text-slate-200 border border-slate-500 dark:border-slate-400/60 font-medium">
                <span>Already Poor Today (Not scored)</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Legend & Monitoring Health Link */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 text-[11px] text-fg-muted border-t border-surface-border">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-fg-muted block" />
            <span>Today PM2.5</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-brand-500 block" />
            <span>Model Forecast (t+1)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-fg-primary block" />
            <span>Actual Next Day</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-aqi-poor block" />
            <span>Alert Issued</span>
          </div>
        </div>

        {onNavigateToMonitoring && (
          <button
            type="button"
            onClick={() => onNavigateToMonitoring(selectedStationId)}
            className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline cursor-pointer"
          >
            <span>View {selectedStationId} in Monitoring Health</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </section>
  );
};
