import React, { useState, Suspense, lazy } from 'react';
import { AppShell, CurrentRoute } from './components/AppShell';
import { CoverageBanner } from './components/CoverageBanner';
import { CoverageMapView } from './components/CoverageMapView';
import { MonitoringHealthView } from './components/MonitoringHealthView';

// Code-split AlertsView so alert datasets are strictly excluded from the initial bundle
const AlertsView = lazy(() => import('./components/AlertsView'));

export const App: React.FC = () => {
  const [currentRoute, setCurrentRoute] = useState<CurrentRoute>('coverage-map');
  const [monitoringSearch, setMonitoringSearch] = useState<string | undefined>(undefined);

  const handleNavigateToMonitoring = (stationId: string) => {
    setMonitoringSearch(stationId);
    setCurrentRoute('monitoring-health');
  };

  return (
    <AppShell
      currentRoute={currentRoute}
      onRouteSelect={(route) => {
        // Clear specific station search if navigating via top menu
        if (route !== 'monitoring-health') {
          setMonitoringSearch(undefined);
        }
        setCurrentRoute(route);
      }}
    >
      {/* Slim header banner on home route (coverage-map) */}
      {currentRoute === 'coverage-map' && (
        <CoverageBanner onExploreCoverage={() => setCurrentRoute('coverage-map')} />
      )}

      {/* Main View Switching */}
      {currentRoute === 'coverage-map' && <CoverageMapView />}
      {currentRoute === 'monitoring-health' && (
        <MonitoringHealthView initialSearchTerm={monitoringSearch} />
      )}
      {currentRoute === 'alerts' && (
        <Suspense
          fallback={
            <div
              role="status"
              aria-label="Loading alert system view"
              className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6"
            >
              <div className="h-10 bg-surface-subtle animate-pulse rounded-lg border border-surface-border" />
              <div className="h-24 bg-surface-subtle animate-pulse rounded-xl border border-surface-border" />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="h-40 bg-surface-subtle animate-pulse rounded-xl border border-surface-border" />
                <div className="h-40 bg-surface-subtle animate-pulse rounded-xl border border-surface-border" />
                <div className="h-40 bg-surface-subtle animate-pulse rounded-xl border border-surface-border" />
              </div>
              <div className="h-96 bg-surface-subtle animate-pulse rounded-xl border border-surface-border" />
            </div>
          }
        >
          <AlertsView onNavigateToMonitoring={handleNavigateToMonitoring} />
        </Suspense>
      )}
    </AppShell>
  );
};

export default App;
