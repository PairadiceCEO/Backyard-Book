import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Firebase makes the bundle about 600 kB; that's expected for this app.
    chunkSizeWarningLimit: 1000,
  },
});
