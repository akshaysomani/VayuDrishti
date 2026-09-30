/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic background, text, borders from CSS variables
        surface: {
          base: 'var(--surface-base)',
          subtle: 'var(--surface-subtle)',
          card: 'var(--surface-card)',
          hover: 'var(--surface-hover)',
          selected: 'var(--surface-selected)',
          border: 'var(--border-subtle)',
          'border-strong': 'var(--border-strong)',
        },
        fg: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          inverse: 'var(--text-inverse)',
        },
        brand: {
          50: 'var(--brand-50)',
          100: 'var(--brand-100)',
          500: 'var(--brand-500)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
          subtle: 'var(--brand-subtle)',
        },
        // AQI Category Colors (CPCB India Standard)
        aqi: {
          good: 'var(--aqi-good)',
          'good-bg': 'var(--aqi-good-bg)',
          satisfactory: 'var(--aqi-satisfactory)',
          'satisfactory-bg': 'var(--aqi-satisfactory-bg)',
          moderate: 'var(--aqi-moderate)',
          'moderate-bg': 'var(--aqi-moderate-bg)',
          poor: 'var(--aqi-poor)',
          'poor-bg': 'var(--aqi-poor-bg)',
          verypoor: 'var(--aqi-verypoor)',
          'verypoor-bg': 'var(--aqi-verypoor-bg)',
          severe: 'var(--aqi-severe)',
          'severe-bg': 'var(--aqi-severe-bg)',
        },
        // Monitoring Infrastructure / Health Status (STRICTLY SEPARATED from AQI)
        monitor: {
          reporting: 'var(--monitor-reporting)',
          'reporting-bg': 'var(--monitor-reporting-bg)',
          partial: 'var(--monitor-partial)',
          'partial-bg': 'var(--monitor-partial-bg)',
          nodata: 'var(--monitor-nodata)',
          'nodata-bg': 'var(--monitor-nodata-bg)',
          gap: 'var(--monitor-gap)',
          'gap-bg': 'var(--monitor-gap-bg)',
          unmonitored: 'var(--monitor-unmonitored)',
          'unmonitored-bg': 'var(--monitor-unmonitored-bg)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        elevation1: 'var(--elevation-1)',
        elevation2: 'var(--elevation-2)',
        elevation3: 'var(--elevation-3)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        relaxed: 'var(--duration-relaxed)',
      },
      transitionTimingFunction: {
        standard: 'var(--easing-standard)',
        decelerate: 'var(--easing-decelerate)',
        accelerate: 'var(--easing-accelerate)',
      },
    },
  },
  plugins: [],
};
