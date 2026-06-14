/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep the heavy 3D libraries in their own long-lived vendor chunks so
        // they stay cached when app code changes. They are only pulled in by
        // the lazily-imported WheelCanvas, so they still load on demand.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('node_modules/opentype.js')) return 'opentype'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
})
