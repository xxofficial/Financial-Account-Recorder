/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  // Relative assets keep the PWA deployable under GitHub Pages project paths.
  base: process.env.GITHUB_ACTIONS ? './' : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Stock Ledger',
        short_name: 'StockLedger',
        description: 'Local-first Stock Ledger PWA',
        theme_color: '#f7f7f8',
        background_color: '#f7f7f8',
        display: 'standalone',
        orientation: 'portrait',
        // Relative URLs keep installed PWAs inside a GitHub Pages project path.
        scope: './',
        start_url: './',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: 'icons.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        cleanupOutdatedCaches: true
      },
      // The Playwright suite exercises the PWA shell through Vite's dev server.
      // Enable the manifest and service worker there as well as in production.
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/e2e/**']
  }
});
