import React from 'react';
import { BRAND } from '../brand';

interface BrandWordmarkProps {
  collapsed?: boolean;
  className?: string;
}

export const BrandWordmark: React.FC<BrandWordmarkProps> = ({ collapsed = false, className = '' }) => {
  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`} aria-label={BRAND.name}>
      {/* Sensor / Atmospheric Observatory Logo Icon */}
      <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-brand-500 text-white shadow-elevation1 flex-shrink-0 transition-transform duration-fast hover:scale-105">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5 text-white"
          aria-hidden="true"
        >
          {/* Central sensor node */}
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          {/* Spatial coverage pulse concentric rings */}
          <path d="M12 5a7 7 0 0 1 7 7" strokeWidth="2" strokeOpacity="0.8" />
          <path d="M5 12a7 7 0 0 1 7-7" strokeWidth="2" strokeOpacity="0.8" />
          <path d="M12 2a10 10 0 0 1 10 10" strokeWidth="1.5" strokeOpacity="0.4" strokeDasharray="2 2" />
          <path d="M2 12a10 10 0 0 1 10-10" strokeWidth="1.5" strokeOpacity="0.4" strokeDasharray="2 2" />
        </svg>
      </div>

      {!collapsed && (
        <div className="flex flex-col min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-bold text-lg tracking-tight text-fg-primary leading-none">
              {BRAND.name}
            </span>
            <span className="text-xs font-mono px-1 py-0.2 bg-brand-subtle text-brand-600 dark:text-brand-500 rounded border border-brand-500/20">
              {BRAND.hindiName}
            </span>
          </div>
          <span className="text-[11px] text-fg-muted font-normal truncate tracking-tight mt-0.5">
            {BRAND.tagline}
          </span>
        </div>
      )}
    </div>
  );
};
