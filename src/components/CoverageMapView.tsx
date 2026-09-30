import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  getStations,
  getCities,
  getGapCities,
  getCoverageThresholds,
  getPopulationCells,
  getMeta,
} from '../data/loader';
import type {
  Station,
  City,
  GapCity,
  CoverageThreshold,
  PopulationCell,
  DashboardMeta,
} from '../types/dashboard';
import { CoverageScrollStory } from './CoverageScrollStory';
import { CoverageMap } from './CoverageMap';
import { CoverageRightPanel } from './CoverageRightPanel';

gsap.registerPlugin(useGSAP);

export const CoverageMapView: React.FC = () => {
  const [stations, setStations] = useState<Station[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [gapCities, setGapCities] = useState<GapCity[]>([]);
  const [thresholds, setThresholds] = useState<CoverageThreshold[]>([]);
  const [populationCells, setPopulationCells] = useState<PopulationCell[]>([]);
  const [meta, setMeta] = useState<DashboardMeta | null>(null);
  const [loading, setLoading] = useState(true);

  // User interactions
  const [selectedKm, setSelectedKm] = useState(10);
  const [selectedCity, setSelectedCity] = useState<City | GapCity | null>(null);
  const [isUnderservedMode, setIsUnderservedMode] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapSectionRef = useRef<HTMLDivElement>(null);

  // Load datasets from loader
  useEffect(() => {
    Promise.all([
      getStations(),
      getCities(),
      getGapCities(),
      getCoverageThresholds(),
      getPopulationCells(),
      getMeta(),
    ]).then(([st, ci, gap, th, pop, m]) => {
      setStations(st);
      setCities(ci);
      setGapCities(gap);
      setThresholds(th);
      setPopulationCells(pop);
      setMeta(m);
      setLoading(false);
    });
  }, []);

  // Filter cities with no working station
  const unmonitoredCities = React.useMemo(() => {
    return cities.filter((c) => c.city_status === 'no_working_station');
  }, [cities]);

  // GSAP Intro Sequence (gsap-timeline skill)
  useGSAP(
    () => {
      if (loading) return;

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

      tl.from('.map-viewport-wrapper', {
        opacity: 0,
        duration: 0.7,
      }).from(
        '.right-panel-wrapper',
        {
          x: 48,
          opacity: 0,
          duration: 0.6,
        },
        '-=0.4'
      );
    },
    { dependencies: [loading], scope: containerRef }
  );

  const handleJumpToMap = () => {
    mapSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[500px] text-fg-muted space-y-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-mono">Hydrating CPCB observatory datasets...</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col flex-1 w-full min-h-0">
      {/* 1. GSAP ScrollTrigger Narrative Briefing */}
      <CoverageScrollStory
        thresholds={thresholds}
        meta={meta}
        onExploreMap={handleJumpToMap}
      />

      {/* 2. Interactive Map + Right Panel Workspace */}
      <div
        ref={mapSectionRef}
        className="flex-1 flex flex-col lg:flex-row min-h-[640px] xl:min-h-[720px] border-t border-surface-border"
      >
        {/* Left Map Viewport */}
        <div className="map-viewport-wrapper flex-1 relative min-h-[460px] lg:min-h-full">
          <CoverageMap
            populationCells={populationCells}
            stations={stations}
            gapCities={gapCities}
            selectedCity={selectedCity}
            onSelectCity={setSelectedCity}
            selectedKm={selectedKm}
            isUnderservedMode={isUnderservedMode}
            onToggleUnderservedMode={setIsUnderservedMode}
          />
        </div>

        {/* Right Metric & City List Panel */}
        <div className="right-panel-wrapper w-full lg:w-96 xl:w-[420px] flex-shrink-0">
          <CoverageRightPanel
            thresholds={thresholds}
            selectedKm={selectedKm}
            onSelectKm={setSelectedKm}
            unmonitoredCities={unmonitoredCities}
            gapCities={gapCities}
            onSelectCity={setSelectedCity}
            meta={meta}
          />
        </div>
      </div>
    </div>
  );
};
