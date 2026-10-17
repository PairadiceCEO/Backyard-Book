import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^firebase\/app$/, replacement: here('./harness-mocks/app.js') },
      { find: /^firebase\/auth$/, replacement: here('./harness-mocks/auth.js') },
      { find: /^firebase\/firestore$/, replacement: here('./harness-mocks/firestore.js') },
    ],
  },
  server: { port: 5199, strictPort: true },
});
