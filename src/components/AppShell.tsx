import React, { useState, useEffect } from 'react';
import {
  Map,
  Activity,
  Bell,
  Sun,
  Moon,
  Menu,
  X,
  Layers,
  Keyboard,
} from 'lucide-react';
import { BrandWordmark } from './BrandWordmark';
import { getNetworkSummary } from '../data/loader';

export type CurrentRoute = 'coverage-map' | 'monitoring-health' | 'alerts';

interface AppShellProps {
  currentRoute: CurrentRoute;
  onRouteSelect: (route: CurrentRoute) => void;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  currentRoute,
  onRouteSelect,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('vayudrishti-theme');
      if (stored) return stored === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  const summary = getNetworkSummary();

  // Sync dark mode class with root html element
  useEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
      localStorage.setItem('vayudrishti-theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('vayudrishti-theme', 'light');
    }
  }, [isDarkMode]);

  // Keyboard navigation shortcuts with accessibility guards
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if any modifier key is held (Ctrl, Alt, Meta, Shift)
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
        return;
      }

      // Disable shortcuts while focus is in input, textarea, select, or contenteditable
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.getAttribute('contenteditable') === 'true')
      ) {
        return;
      }

      if (e.key === '1') {
        e.preventDefault();
        onRouteSelect('coverage-map');
        setAnnouncement('Navigated to Coverage map view');
      } else if (e.key === '2') {
        e.preventDefault();
        onRouteSelect('monitoring-health');
        setAnnouncement('Navigated to Monitoring health view');
      } else if (e.key === '3') {
        e.preventDefault();
        onRouteSelect('alerts');
        setAnnouncement('Navigated to Alerts view');
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        setIsDarkMode((prev) => {
          const next = !prev;
          setAnnouncement(`Switched to ${next ? 'dark' : 'light'} theme`);
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onRouteSelect]);

  const navItems = [
    {
      id: 'coverage-map' as CurrentRoute,
      label: 'Coverage map',
      icon: Map,
      badge: `${summary.reportingStations}/${summary.totalStations} reporting in dataset`,
      shortcut: '1',
      description: 'Geospatial monitor buffers and population catchment',
    },
    {
      id: 'monitoring-health' as CurrentRoute,
      label: 'Monitoring health',
      icon: Activity,
      badge: `${summary.noDataStations} no usable data`,
      shortcut: '2',
      description: 'Station uptime and monthly completeness records',
    },
    {
      id: 'alerts' as CurrentRoute,
      label: 'Alerts',
      icon: Bell,
      badge: 'Pilot',
      shortcut: '3',
      description: 'Forecast breach & station notification engine',
    },
  ];

  return (
    <div className="min-h-screen bg-surface-base text-fg-primary flex flex-col antialiased">
      {/* Accessible Live Region for Keyboard Announcements */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* Accessibility: Skip to Main Content Link */}
      <a href="#main-content" className="skip-link">
        Skip to main content (Press Enter)
      </a>

      {/* TOP BAR */}
      <header
        role="banner"
        className="sticky top-0 z-30 h-16 bg-surface-card/95 backdrop-blur-md border-b border-surface-border px-4 sm:px-6 flex items-center justify-between shadow-elevation1"
      >
        <div className="flex items-center gap-3">
          {/* Mobile menu hamburger toggle */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-lg text-fg-secondary hover:text-fg-primary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-500 cursor-pointer"
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
            aria-controls="primary-navigation"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          <BrandWordmark />
        </div>

        {/* Top Bar Center & Right Controls */}
        <div className="flex items-center gap-2.5 sm:gap-4">
          {/* Header pill: strictly historical dataset label */}
          <div className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-full bg-surface-subtle border border-surface-border text-xs text-fg-secondary">
            <span className="w-2 h-2 rounded-full bg-sky-500" aria-hidden="true" />
            <span className="font-medium text-fg-primary">Historical dataset | 2015-01 to 2020-07</span>
          </div>

          {/* Theme Toggle (Light / Dark) */}
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            aria-keyshortcuts="t"
            className="p-2 rounded-lg text-fg-secondary hover:text-fg-primary hover:bg-surface-hover border border-surface-border transition-colors cursor-pointer"
            title={`Switch to ${isDarkMode ? 'Light' : 'Dark'} Mode (Shortcut: T)`}
            aria-label={`Switch to ${isDarkMode ? 'Light' : 'Dark'} Mode. Shortcut: T`}
          >
            {isDarkMode ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-slate-600" />
            )}
          </button>
        </div>
      </header>

      {/* BODY LAYOUT: LEFT NAV + MAIN CONTENT */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        {/* LEFT NAVIGATION (Desktop) */}
        <aside
          id="primary-navigation"
          role="navigation"
          aria-label="Main Navigation"
          className="hidden md:flex flex-col w-64 lg:w-72 bg-surface-card border-r border-surface-border flex-shrink-0"
        >
          <div className="p-4 flex-1 flex flex-col justify-between overflow-y-auto">
            <div className="space-y-1.5">
              <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-muted">
                Observatory Views
              </div>

              {navItems.map((item) => {
                const Icon = item.icon;
                const isCurrent = currentRoute === item.id;

                return (
                  <button
                    key={item.id}
                    onClick={() => onRouteSelect(item.id)}
                    aria-keyshortcuts={item.shortcut}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left group cursor-pointer ${
                      isCurrent
                        ? 'bg-brand-500 text-white shadow-elevation1'
                        : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-hover'
                    }`}
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon
                        className={`w-4 h-4 flex-shrink-0 ${
                          isCurrent ? 'text-white' : 'text-fg-muted group-hover:text-fg-primary'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.label}</span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {item.badge && (
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                            isCurrent
                              ? 'bg-white/20 text-white'
                              : 'bg-surface-subtle text-fg-muted border border-surface-border'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                      <kbd
                        className={`hidden lg:inline-block text-[10px] font-mono px-1 rounded ${
                          isCurrent ? 'text-white/70' : 'text-fg-muted/60'
                        }`}
                        title={`Keyboard shortcut: ${item.shortcut}`}
                        aria-label={`Shortcut: ${item.shortcut}`}
                      >
                        {item.shortcut}
                      </kbd>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Bottom Panel: Strict Semantic Decoupling Guide & Keyboard Hints */}
            <div className="mt-8 pt-4 border-t border-surface-border space-y-3">
              <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border text-xs space-y-2">
                <div className="font-semibold text-fg-primary flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-brand-500" />
                  Semantic Color Rules
                </div>
                <div className="space-y-1.5 text-[11px] text-fg-muted">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-aqi-poor flex-shrink-0" />
                    <span><strong>AQI Severity:</strong> Green → Maroon</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-monitor-reporting flex-shrink-0" />
                    <span><strong>Reporting in Dataset:</strong> Sky Blue</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-monitor-nodata flex-shrink-0" />
                    <span><strong>No usable data:</strong> Slate Gray</span>
                  </div>
                </div>
                <p className="text-[10px] text-fg-muted italic pt-1 border-t border-surface-border">
                  Good monitoring coverage doesn't mean clean air, and missing data doesn't mean safe air.
                </p>
              </div>

              <div className="flex items-center justify-between text-[11px] text-fg-muted px-1">
                <span className="flex items-center gap-1">
                  <Keyboard className="w-3.5 h-3.5" />
                  Hotkeys: 1, 2, 3, T
                </span>
                <span className="text-[10px] font-mono">WCAG AA</span>
              </div>
            </div>
          </div>
        </aside>

        {/* MOBILE NAVIGATION DRAWER (Slide-over) */}
        {mobileMenuOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          >
            <div
              className="w-4/5 max-w-sm h-full bg-surface-card p-5 flex flex-col justify-between shadow-elevation3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-surface-border">
                  <BrandWordmark />
                  <button
                    onClick={() => setMobileMenuOpen(false)}
                    className="p-1 rounded text-fg-muted hover:text-fg-primary cursor-pointer"
                    aria-label="Close menu"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <nav className="space-y-1">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    const isCurrent = currentRoute === item.id;

                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          onRouteSelect(item.id);
                          setMobileMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-3 rounded-lg text-sm font-medium cursor-pointer ${
                          isCurrent
                            ? 'bg-brand-500 text-white'
                            : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-hover'
                        }`}
                        aria-current={isCurrent ? 'page' : undefined}
                      >
                        <div className="flex items-center gap-3">
                          <Icon className="w-4 h-4" />
                          <span>{item.label}</span>
                        </div>
                        {item.badge && (
                          <span
                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                              isCurrent ? 'bg-white/20 text-white' : 'bg-surface-subtle text-fg-muted'
                            }`}
                          >
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>

              <div className="pt-4 border-t border-surface-border text-xs text-fg-muted">
                <p className="font-semibold text-fg-primary">VayuDrishti</p>
                <p className="text-[11px] mt-0.5">National Air-Quality & Sensor Infrastructure Observatory</p>
              </div>
            </div>
          </div>
        )}

        {/* MAIN CONTENT AREA */}
        <main
          id="main-content"
          role="main"
          tabIndex={-1}
          className="flex-1 min-w-0 overflow-y-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
};
