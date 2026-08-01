import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          if (id.includes('/firebase/')) {
            return 'vendor-firebase';
          }

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }

          if (id.includes('/@capacitor/') || id.includes('/@capgo/')) {
            return 'vendor-capacitor';
          }

          if (id.includes('/gsap/')) {
            return 'vendor-gsap';
          }

          if (id.includes('/pdf-lib/')) {
            return 'vendor-pdf-lib';
          }

          if (id.includes('/jszip/')) {
            return 'vendor-jszip';
          }

          return 'vendor-misc';
        }
      }
    }
  },
  server: {
    port: 5173 // You can keep your existing port or change it
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Only our own tests. Without this vitest walks node_modules and tries to
    // run every package's fixtures.
    include: ['{lib,utils,components,contexts}/**/*.test.{ts,tsx}'],
  }
})
