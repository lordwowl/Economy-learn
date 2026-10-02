import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };

// base обязателен для GitHub Pages: сайт живёт в подпапке /Economy-learn/ (регистр важен).
export default defineConfig({
  base: '/Economy-learn/',
  plugins: [preact()],
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
