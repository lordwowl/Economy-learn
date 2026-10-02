import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// base обязателен для GitHub Pages: сайт живёт в подпапке /Economy-learn/ (регистр важен).
export default defineConfig({
  base: '/Economy-learn/',
  plugins: [
    preact(),
    // Офлайн (GDD 12): сервис-воркер кэширует только файлы сайта; внешних запросов нет (CLAUDE.md, правило 6).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Цепочка — экономический симулятор',
        short_name: 'Цепочка',
        description: 'Обучающий экономический симулятор для школ',
        lang: 'ru',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#f4f1ea',
        theme_color: '#1f3a5f',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
