import React, { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowDown, AlertCircle, ShieldAlert, Compass } from 'lucide-react';
import type { CoverageThreshold, DashboardMeta } from '../types/dashboard';

gsap.registerPlugin(useGSAP, ScrollTrigger);

interface CoverageScrollStoryProps {
  thresholds: CoverageThreshold[];
  meta: DashboardMeta | null;
  onExploreMap: () => void;
}

export const CoverageScrollStory: React.FC<CoverageScrollStoryProps> = ({
  thresholds,
  meta,
  onExploreMap,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Dynamically compute every metric directly from coverage_thresholds & meta
  const t10 = thresholds.find((t) => t.within_km === 10);
  const t200 = thresholds.find((t) => t.within_km === 200);

  if (!t10 || !t200 || !meta?.india_population_m) {
    return (
      <section
        className="p-6 text-center text-xs text-fg-muted border-b border-surface-border bg-surface-subtle"
        aria-label="Coverage data unavailable"
      >
        <span className="font-semibold text-fg-secondary">Data unavailable:</span> Required coverage thresholds (10 km / 200 km) or national population metadata are missing from this dataset.
      </section>
    );
  }

  const totalPop = meta.india_population_m;
  const pct10km = t10.share_pct;
  const pop10km = t10.people_m;

  const pctBeyond200km = Number((100 - t200.share_pct).toFixed(1));
  const popBeyond200km = Number((totalPop - t200.people_m).toFixed(1));

  useGSAP(
    () => {
      // Respect prefers-reduced-motion
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      const cards = gsap.utils.toArray<HTMLElement>('.story-card');
      cards.forEach((card, index) => {
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: 'top 85%',
            toggleActions: 'play none none reverse',
          },
          opacity: 0,
          y: 20,
          duration: 0.5,
          ease: 'power2.out',
          delay: index * 0.06,
        });
      });
    },
    { dependencies: [thresholds], scope: containerRef }
  );

  return (
    <section
      ref={containerRef}
      className="border-b border-surface-border bg-surface-subtle px-4 sm:px-6 py-6 sm:py-8"
      aria-label="National monitoring coverage context and data narrative"
    >
      <div className="max-w-6xl mx-auto">
        {/* Story Intro Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono font-medium text-brand-600 dark:text-brand-500 mb-1">
              <Compass className="w-4 h-4" aria-hidden="true" />
              <span>National Air Quality Infrastructure Briefing</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-fg-primary [text-wrap:balance]">
              Where India Breathes Without Ground Truth
            </h2>
            <p className="text-xs sm:text-sm text-fg-secondary mt-1 max-w-2xl leading-relaxed">
              Three empirical baseline findings derived from the CPCB station extract and WorldPop spatial population layers.
            </p>
          </div>

          <button
            onClick={onExploreMap}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-surface-card hover:bg-surface-hover border border-surface-border text-fg-primary shadow-elevation1 transition-colors cursor-pointer self-start md:self-auto min-h-[44px]"
            aria-label="Skip story and jump directly to interactive map"
          >
            <span>Jump to Interactive Map</span>
            <ArrowDown className="w-3.5 h-3.5 text-brand-500" aria-hidden="true" />
          </button>
        </div>

        {/* 3 Narrative Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Card 1: Computed from threshold 10 km */}
          <div className="story-card p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs text-fg-muted mb-2">
                <span className="font-semibold text-fg-primary">Urban Catchment</span>
                <span className="px-2 py-0.5 rounded bg-brand-subtle text-brand-600 dark:text-brand-400 text-[10px] font-mono font-medium">
                  ≤ 10 km Buffer
                </span>
              </div>
              <div className="text-3xl font-bold font-mono text-fg-primary tracking-tight">
                {pct10km}%
              </div>
              <p className="text-xs font-medium text-fg-primary mt-1">
                Population Within 10 km of Station
              </p>
              <p className="text-xs text-fg-secondary mt-1.5 leading-relaxed">
                Only {pop10km} million citizens out of {totalPop} million live within 10 km of a monitoring station with usable data in this dataset.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-surface-border text-[11px] text-fg-muted font-mono">
              Urban Catchment Standard
            </div>
          </div>

          {/* Card 2: Computed from threshold 200 km (100% - share_pct) */}
          <div className="story-card p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs text-fg-muted mb-2">
                <span className="font-semibold text-fg-primary">Regional Periphery</span>
                <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px] font-mono font-medium">
                  &gt; 200 km Void
                </span>
              </div>
              <div className="text-3xl font-bold font-mono text-fg-primary tracking-tight">
                {pctBeyond200km}%
              </div>
              <p className="text-xs font-medium text-fg-primary mt-1">
                Beyond Regional Distance
              </p>
              <p className="text-xs text-fg-secondary mt-1.5 leading-relaxed">
                Over {popBeyond200km} million people live more than 200 km away from any reporting monitor in this historical dataset, relying on spatial interpolation.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-surface-border text-[11px] text-fg-muted font-mono">
              Unmonitored Regional Expanse
            </div>
          </div>

          {/* Card 3: Two Gaps with exact copy rules */}
          <div className="story-card p-4 rounded-xl border border-surface-border bg-surface-card shadow-elevation1 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs text-fg-muted mb-2">
                <span className="font-semibold text-fg-primary">Metropolitan Gaps</span>
                <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-fg-secondary text-[10px] font-mono font-medium">
                  Two Distinct Gaps
                </span>
              </div>
              <div className="text-xs font-semibold text-fg-primary mt-1 flex flex-col gap-1.5">
                <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                  No station listed in this dataset (Surat, Vadodara, Rajkot)
                </span>
                <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                  Listed in this dataset, but no usable data (Pune, Nagpur, Kanpur)
                </span>
              </div>
              <p className="text-xs text-fg-secondary mt-2 leading-relaxed">
                No station listed in this dataset for major cities, or listed in this dataset, but no usable data throughout the entire 2015-2020 dataset period.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-surface-border text-[11px] text-fg-muted font-mono">
              Critical Metropolitan Blind Spots
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
