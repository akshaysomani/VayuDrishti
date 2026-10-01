import React from 'react';
import { MapPin, Calendar, Eye, AlertCircle } from 'lucide-react';
import type { PublicCitizenReport } from '../../types/citizenReport';

interface ReportCardProps {
  report: PublicCitizenReport;
  onOpenPhoto: (report: PublicCitizenReport) => void;
}

const CATEGORY_STYLES: Record<string, { label: string; badgeClass: string }> = {
  smoke: {
    label: 'Smoke Plume',
    badgeClass: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700',
  },
  burning: {
    label: 'Biomass Burning',
    badgeClass: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200 border-amber-300 dark:border-amber-800',
  },
  dust: {
    label: 'Dust Storm',
    badgeClass: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950/60 dark:text-yellow-200 border-yellow-300 dark:border-yellow-800',
  },
  construction_dust: {
    label: 'Construction Dust',
    badgeClass: 'bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200 border-orange-300 dark:border-orange-800',
  },
  industrial_emission: {
    label: 'Industrial Emission',
    badgeClass: 'bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200 border-rose-300 dark:border-rose-800',
  },
  other: {
    label: 'Localized Haze',
    badgeClass: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700',
  },
};

export const ReportCard: React.FC<ReportCardProps> = ({ report, onOpenPhoto }) => {
  const catStyle = CATEGORY_STYLES[report.category] ?? CATEGORY_STYLES.other;
  const formattedDate = new Date(report.created_at).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden shadow-elevation1 flex flex-col hover:border-brand-500/50 transition-colors">
      {/* Photo Container */}
      <div
        onClick={() => onOpenPhoto(report)}
        className="relative h-44 sm:h-48 bg-surface-subtle overflow-hidden cursor-pointer group"
      >
        <img
          src={report.thumb_url}
          alt={`Observation of ${catStyle.label}`}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-slate-950/20 group-hover:bg-slate-950/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-slate-900/90 text-xs font-semibold text-fg-primary shadow-md backdrop-blur-sm">
            <Eye className="w-3.5 h-3.5" />
            <span>Enlarge Photo</span>
          </div>
        </div>

        {/* Category Pill Overlaid */}
        <div className="absolute top-2.5 left-2.5">
          <span
            className={`inline-block px-2.5 py-0.5 text-[11px] font-semibold rounded-full border shadow-sm backdrop-blur-md ${catStyle.badgeClass}`}
          >
            {catStyle.label}
          </span>
        </div>

        {/* Unverified Observation Pill */}
        <div className="absolute top-2.5 right-2.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded-md bg-amber-500/90 text-white shadow-sm">
            <AlertCircle className="w-3 h-3" />
            <span>Unverified Context</span>
          </span>
        </div>
      </div>

      {/* Card Content */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
        {report.description ? (
          <p className="text-xs text-fg-primary line-clamp-2 leading-relaxed">
            {report.description}
          </p>
        ) : (
          <p className="text-xs text-fg-muted italic">No text description provided.</p>
        )}

        <div className="pt-2 border-t border-surface-border text-[11px] text-fg-secondary space-y-1.5">
          {/* Nearest Ground Station */}
          <div className="flex items-center gap-1.5 truncate">
            <MapPin className="w-3.5 h-3.5 text-brand-500 flex-shrink-0" />
            <span className="truncate">
              {report.nearest_station_name ? (
                <>
                  Snapped to <strong>{report.nearest_station_name}</strong>
                  {report.nearest_station_distance_km != null && (
                    <span className="text-fg-muted ml-1">
                      ({report.nearest_station_distance_km} km)
                    </span>
                  )}
                </>
              ) : (
                <span>
                  {report.lat.toFixed(4)}, {report.lon.toFixed(4)}
                </span>
              )}
            </span>
          </div>

          {/* Timestamp */}
          <div className="flex items-center gap-1.5 text-fg-muted font-mono">
            <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{formattedDate}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
