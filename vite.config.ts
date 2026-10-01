import './src/server/db/envLoader';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleLiveAirQualityRequest } from './src/server/liveApiHandler';
import { handleCitizenReportsRequest } from './src/server/citizenReportsHandler';
import { handleAlertDeliveryRequest } from './src/server/alertDeliveryHandler';

/**
 * Development & Preview API Boundary:
 * Mounts the /api/live/air-quality, /api/reports, and /api/alerts server-side handlers
 * on Vite's local dev server and preview server to keep tokens and storage secure.
 * NOTE: For full production deployment of the built static assets (dist/), an external
 * server or serverless function runtime (Node.js/Python/Edge) is required to execute these handlers.
 */
function liveAlertPlugin(): Plugin {
  const middlewareHandler = async (req: any, res: any, next: any) => {
    if (req.url && req.url.startsWith('/api/live/')) {
      try {
        await handleLiveAirQualityRequest(req, res);
      } catch (err) {
        next(err);
      }
      return;
    }
    if (req.url && req.url.startsWith('/api/reports')) {
      try {
        await handleCitizenReportsRequest(req, res);
      } catch (err) {
        next(err);
      }
      return;
    }
    if (req.url && req.url.startsWith('/api/alerts/')) {
      try {
        await handleAlertDeliveryRequest(req, res);
      } catch (err) {
        next(err);
      }
      return;
    }
    next();
  };

  return {
    name: 'live-alert-api',
    configureServer(server) {
      server.middlewares.use(middlewareHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middlewareHandler);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), liveAlertPlugin()],
  server: {
    port: 5173,
    open: false,
    watch: {
      ignored: ['**/.agents/**', '**/ERA5-Land/**', '**/MODIS_C/**', '**/NASA_VIIRS/**', '**/cpcb_data/**', '**/archive/**'],
    },
  },
});

