import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    watch: {
      ignored: ['**/.agents/**', '**/ERA5-Land/**', '**/MODIS_C/**', '**/NASA_VIIRS/**', '**/cpcb_data/**', '**/archive/**'],
    },
  },
});
